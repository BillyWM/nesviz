import {
  abstractByteFromParts,
  abstractByteFromSerializable,
  abstractByteToSerializable,
  exactByte,
  joinByte
} from './abstractByteDomain.js';
import { readByteAt } from './byteMemory.js';
import { rangeScalar, scalarToValues } from './byteScalarDomain.js';
import { FLAG_VALUE } from '../domains/flagsDomain.js';

function makeByteFromRange(min, max, step = 1) {
  const lo = min & 0xff;
  const hi = max & 0xff;
  if (lo > hi) return null;
  return abstractByteToSerializable(abstractByteFromParts({ scalar: rangeScalar(lo, hi, step) }));
}

function makeExactByte(value) {
  return abstractByteToSerializable(exactByte(value & 0xff));
}

function byteValues(byte, options = {}) {
  const normalized = abstractByteFromSerializable(byte);
  const scalarValues = scalarToValues(normalized.scalar, 256);
  if (!scalarValues) return null;
  if (normalized.bits?.kind === 'bottom') return [];
  const knownMask = normalized.bits?.knownMask ?? 0x00;
  const knownValue = normalized.bits?.knownValue ?? 0x00;
  return scalarValues.filter((value) => (value & knownMask) === (knownValue & knownMask));
}

function makeCounterBytes({ direction, control, limitValue }, initialValue) {
  const initial = initialValue & 0xff;
  const flag = control?.flag;
  const reentryValue = control?.reentryValue;
  const kind = control?.kind;
  const step = Math.max(1, Number.isInteger(control?.step) ? control.step : 1);

  if (kind === 'updateFlag') {
    if (direction === 'down' && flag === 'z' && reentryValue === FLAG_VALUE.FALSE) {
      if (initial <= 1) return null;
      return {
        headerByte: makeByteFromRange(0x01, initial),
        reentryByte: makeByteFromRange(0x01, (initial - 1) & 0xff),
        exitByte: makeExactByte(0x00)
      };
    }

    if (direction === 'down' && flag === 'n' && reentryValue === FLAG_VALUE.FALSE) {
      if (initial === 0x00 || initial > 0x7f) return null;
      return {
        headerByte: makeByteFromRange(0x00, initial),
        reentryByte: makeByteFromRange(0x00, (initial - 1) & 0xff),
        exitByte: makeExactByte(0xff)
      };
    }

    if (direction === 'down' && flag === 'n' && reentryValue === FLAG_VALUE.TRUE) {
      if (initial <= 0x80) return null;
      return {
        headerByte: makeByteFromRange(0x80, initial),
        reentryByte: makeByteFromRange(0x80, (initial - 1) & 0xff),
        exitByte: makeExactByte(0x7f)
      };
    }

    if (direction === 'up' && flag === 'z' && reentryValue === FLAG_VALUE.FALSE) {
      if (initial >= 0xff) return null;
      return {
        headerByte: makeByteFromRange(initial, 0xff),
        reentryByte: makeByteFromRange((initial + 1) & 0xff, 0xff),
        exitByte: makeExactByte(0x00)
      };
    }

    if (direction === 'up' && flag === 'n' && reentryValue === FLAG_VALUE.FALSE) {
      if (initial >= 0x7f) return null;
      return {
        headerByte: makeByteFromRange(initial, 0x7f),
        reentryByte: makeByteFromRange((initial + 1) & 0xff, 0x7f),
        exitByte: makeExactByte(0x80)
      };
    }

    if (direction === 'up' && flag === 'n' && reentryValue === FLAG_VALUE.TRUE) {
      if (initial < 0x7f || initial >= 0xff) return null;
      return {
        headerByte: makeByteFromRange(initial, 0xff),
        reentryByte: makeByteFromRange(Math.max((initial + 1) & 0xff, 0x80), 0xff),
        exitByte: makeExactByte(0x00)
      };
    }

    return null;
  }

  if (kind === 'compareImmediate') {
    const limit = limitValue & 0xff;
    if (direction === 'up' && flag === 'z' && reentryValue === FLAG_VALUE.FALSE) {
      if (limit <= initial) return null;
      const distance = limit - initial;
      if (distance % step !== 0) return null;
      const trips = distance / step;
      if (trips <= 1) return null;
      return {
        headerByte: makeByteFromRange(initial, limit - step, step),
        reentryByte: makeByteFromRange(initial + step, limit - step, step),
        exitByte: makeExactByte(limit)
      };
    }

    if (direction === 'up' && flag === 'c' && reentryValue === FLAG_VALUE.FALSE) {
      if (limit <= initial) return null;
      const trips = Math.ceil((limit - initial) / step);
      if (trips <= 1) return null;
      const exitValue = initial + trips * step;
      if (exitValue > 0xff) return null;
      return {
        headerByte: makeByteFromRange(initial, exitValue - step, step),
        reentryByte: makeByteFromRange(initial + step, exitValue - step, step),
        exitByte: makeExactByte(exitValue)
      };
    }

    if (direction === 'down' && flag === 'z' && reentryValue === FLAG_VALUE.FALSE) {
      if (initial <= limit) return null;
      const distance = initial - limit;
      if (distance % step !== 0) return null;
      const trips = distance / step;
      if (trips <= 1) return null;
      return {
        headerByte: makeByteFromRange(limit + step, initial, step),
        reentryByte: makeByteFromRange(limit + step, initial - step, step),
        exitByte: makeExactByte(limit)
      };
    }

    if (direction === 'down' && flag === 'c' && reentryValue === FLAG_VALUE.TRUE) {
      if (limit === 0x00 || initial < limit) return null;
      const trips = Math.floor((initial - limit) / step) + 1;
      if (trips <= 1) return null;
      const exitValue = initial - trips * step;
      if (exitValue < 0x00) return null;
      return {
        headerByte: makeByteFromRange(exitValue + step, initial, step),
        reentryByte: makeByteFromRange(exitValue + step, initial - step, step),
        exitByte: makeExactByte(exitValue)
      };
    }
  }

  return null;
}

function joinField(left, right, options) {
  if (!left) return right;
  if (!right) return left;
  return abstractByteToSerializable(joinByte(left, right, options));
}

function mergeInstantiation(left, right, options = {}) {
  if (!left) return right;
  if (!right) return left;
  return {
    headerByte: joinField(left.headerByte, right.headerByte, options),
    reentryByte: joinField(left.reentryByte, right.reentryByte, options),
    exitByte: joinField(left.exitByte, right.exitByte, options)
  };
}

function sourceByteFromState(state, source) {
  if (!state || state.kind === 'bottom' || !source) return null;
  if (source.kind === 'entryRamByte') return readByteAt(state.ramBytes, source.cpuAddr & 0xffff);
  return null;
}

export function instantiateParametricLoopSummary(summary, state, options = {}) {
  const counter = summary?.counter;
  if (!counter?.template || !counter?.initialSource) return null;
  const sourceByte = sourceByteFromState(state, counter.initialSource);
  if (!sourceByte) return null;
  const values = byteValues(sourceByte, options);
  if (!values || values.length === 0) return null;

  let merged = null;
  for (const value of values) {
    const fields = makeCounterBytes(counter, value);
    if (!fields || !fields.headerByte || !fields.reentryByte) return null;
    merged = mergeInstantiation(merged, fields, options);
  }
  return merged;
}

export function mergeParametricLoopInstantiation(left, right, options = {}) {
  return mergeInstantiation(left, right, options);
}

import { mapperStateToSerializable } from '../domains/mapper/mapperDomain.js';

function formatHex(value, width = 2) {
  const n = Number(value);
  if (!Number.isInteger(n)) return String(value);
  return `$${(n >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

function formatLatchPair(pair) {
  const count = Number(pair?.count);
  const bits = Number(pair?.bits);
  if (!Number.isInteger(count) || !Number.isInteger(bits)) return String(pair);
  const bitText = count <= 0 ? '0' : bits.toString(2).padStart(count, '0');
  return `(${count},%${bitText})`;
}

function formatFiniteValue(value, valueKind = 'number') {
  if (valueKind === 'latch') return formatLatchPair(value);
  if (valueKind === 'enum') return String(value);
  return formatHex(value);
}

export function formatFiniteSetForDebug(value, valueKind = 'number') {
  if (!value || value.kind === 'top') return '⊤';
  if (value.kind === 'bottom') return '⊥';
  if (value.kind !== 'set') return '?';
  const values = Array.isArray(value.values) ? value.values : [];
  return `{${values.map((item) => formatFiniteValue(item, valueKind)).join(',')}}`;
}

function serializedMapperState(state, options = {}) {
  return mapperStateToSerializable(state, options);
}

function isFixedMapperState(state) {
  return state?.kind === 'fixed';
}

function fieldKind(name) {
  if (name === 'latch') return 'latch';
  if (name === 'prgMode' || name === 'bankSelect') return 'enum';
  return 'number';
}

function fieldLabel(name) {
  if (name === 'prg32Bank') return 'prg32';
  if (name === 'prgMode') return 'mode';
  if (name === 'prgBank') return 'prg';
  if (name === 'bankSelect') return 'sel';
  return name;
}

function mapperLabel(state) {
  if (state?.prg32Bank) return '';
  if (state?.latch || state?.prgBank) return 'mmc1 ';
  if (state?.bankSelect || state?.r6 || state?.r7) return 'mmc3 ';
  return '';
}

function orderedFields(state) {
  if (state?.prg32Bank) return ['prg32Bank'];
  if (state?.latch || state?.prgBank) return ['prgMode', 'prgBank', 'latch'];
  if (state?.bankSelect || state?.r6 || state?.r7) return ['prgMode', 'bankSelect', 'r6', 'r7'];
  return Object.keys(state || {}).filter((key) => key !== 'kind').sort();
}

function fieldText(state, name) {
  return `${fieldLabel(name)}=${formatFiniteSetForDebug(state[name], fieldKind(name))}`;
}

export function formatMapperState(state, options = {}) {
  const serialized = serializedMapperState(state, options);
  if (!serialized || isFixedMapperState(serialized)) return '';
  if (serialized.kind === 'bottom') return 'MAP ⊥';
  if (serialized.kind === 'top') return 'MAP ⊤';
  if (serialized.kind !== 'state') return `MAP ${serialized.kind || '?'}`;
  const fields = orderedFields(serialized).filter((name) => serialized[name]);
  if (fields.length === 0) return '';
  return `MAP ${mapperLabel(serialized)}${fields.map((name) => fieldText(serialized, name)).join(' ')}`;
}

function finiteSetEqualsForDebug(a, b, valueKind) {
  return formatFiniteSetForDebug(a, valueKind) === formatFiniteSetForDebug(b, valueKind);
}

export function formatMapperDeltaDetails(before, after, options = {}) {
  const left = serializedMapperState(before?.mapperState, options);
  const right = serializedMapperState(after?.mapperState, options);
  if (isFixedMapperState(left) && isFixedMapperState(right)) return [];
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  if (!left || !right || left.kind !== 'state' || right.kind !== 'state') {
    return [`Mapper: ${formatMapperState(before?.mapperState, options) || 'MAP fixed'} -> ${formatMapperState(after?.mapperState, options) || 'MAP fixed'}`];
  }

  const names = Array.from(new Set([...orderedFields(left), ...orderedFields(right)])).filter((name) => name !== 'kind');
  const out = [];
  for (const name of names) {
    const kind = fieldKind(name);
    if (finiteSetEqualsForDebug(left[name], right[name], kind)) continue;
    out.push(`Mapper ${fieldLabel(name)}: ${formatFiniteSetForDebug(left[name], kind)} -> ${formatFiniteSetForDebug(right[name], kind)}`);
  }
  return out;
}

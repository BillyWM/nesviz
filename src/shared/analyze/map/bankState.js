function dedupeSorted(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((v) => Number.isFinite(v) && v >= 0)
    .map((v) => v | 0))).sort((a, b) => a - b);
}

export function unknownBankState() {
  return { kind: 'unknown' };
}

export function exactBankState(bank) {
  const n = typeof bank === 'number' ? bank : Number(bank);
  if (!Number.isFinite(n) || n < 0) return unknownBankState();
  return { kind: 'exact', bank: n | 0 };
}

export function bankSetState(banks) {
  const vals = dedupeSorted(banks);
  if (vals.length === 0) return unknownBankState();
  if (vals.length === 1) return exactBankState(vals[0]);
  return { kind: 'set', banks: vals };
}

export function isUnknownBankState(state) {
  return !state || state.kind === 'unknown';
}

export function isExactBankState(state) {
  return !!state && state.kind === 'exact' && Number.isFinite(state.bank);
}

export function isBankSetState(state) {
  return !!state && state.kind === 'set' && Array.isArray(state.banks);
}

export function bankStateValues(state) {
  if (isExactBankState(state)) return [state.bank & 0xffff];
  if (isBankSetState(state)) return dedupeSorted(state.banks);
  return [];
}

export function normalizeBankState(state, maxSetSize = 8) {
  if (isExactBankState(state)) return exactBankState(state.bank);
  if (isBankSetState(state)) {
    const vals = dedupeSorted(state.banks);
    if (vals.length === 0) return unknownBankState();
    if (vals.length === 1) return exactBankState(vals[0]);
    if (vals.length > maxSetSize) return unknownBankState();
    return bankSetState(vals);
  }
  return unknownBankState();
}

export function joinBankStates(a, b, maxSetSize = 8) {
  if (isUnknownBankState(a) || isUnknownBankState(b)) return unknownBankState();
  return normalizeBankState(bankSetState([...bankStateValues(a), ...bankStateValues(b)]), maxSetSize);
}

export function bankStateKey(state) {
  if (isExactBankState(state)) return String(state.bank | 0).padStart(2, '0');
  if (isBankSetState(state)) return `{${bankStateValues(state).map((v) => String(v | 0).padStart(2, '0')).join(',')}}`;
  return '?';
}

function clampBank(v, bankCount, mask) {
  let n = (typeof v === 'number' ? v : Number(v)) | 0;
  if (Number.isFinite(mask)) n &= mask | 0;
  if (!Number.isFinite(bankCount) || bankCount <= 0) return n & 0xffff;
  if (n < 0) return 0;
  return n % (bankCount | 0);
}

export function mapValueStateToBankState(valueState, { bankCount, mask = null, maxSetSize = 8 } = {}) {
  if (!valueState || valueState.kind === 'unknown') return unknownBankState();
  if (valueState.kind === 'exact') return exactBankState(clampBank(valueState.value, bankCount, mask));
  if (valueState.kind === 'set') {
    const vals = dedupeSorted((valueState.values || []).map((v) => clampBank(v, bankCount, mask)));
    return normalizeBankState(bankSetState(vals), maxSetSize);
  }
  return unknownBankState();
}

export function expandBankState(state, { maxForks = 4 } = {}) {
  const vals = bankStateValues(state);
  if (!vals.length) return { exactBanks: null, truncated: true };
  if (vals.length > maxForks) return { exactBanks: vals.slice(0, maxForks), truncated: true };
  return { exactBanks: vals, truncated: false };
}

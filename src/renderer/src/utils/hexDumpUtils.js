import { fmtHex } from '../../../shared/utils/hexUtils.js';

export function formatHexDump(bytes) {
  if (!Array.isArray(bytes) || bytes.length === 0) return '';
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push(bytes.slice(i, i + 16).map((b) => fmtHex(Number(b), 2)).join(' '));
  }
  return lines.join('\n');
}

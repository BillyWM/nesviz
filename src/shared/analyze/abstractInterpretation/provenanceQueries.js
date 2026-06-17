import { PROVENANCE_KIND, provenanceFromSerializable } from './provenanceDomain.js';

function nodes(value) {
  const provenance = provenanceFromSerializable(value);
  if (provenance.kind === PROVENANCE_KIND.UNKNOWN) return [];
  if (provenance.kind === PROVENANCE_KIND.NODE) return [provenance.node];
  return provenance.items || [];
}

function indexedRomReads(value) {
  return nodes(value).filter((node) => node && node.kind === 'indexedRomRead');
}

function sameValues(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if ((Number(a[index]) & 0xff) !== (Number(b[index]) & 0xff)) return false;
  }
  return true;
}

function candidateByIndex(read) {
  const out = new Map();
  for (const candidate of read.candidates || []) out.set(Number(candidate.index) & 0xff, candidate);
  return out;
}

export function provePairedIndexedRomReads(lowProvenance, highProvenance) {
  const lows = indexedRomReads(lowProvenance);
  const highs = indexedRomReads(highProvenance);

  for (const low of lows) {
    for (const high of highs) {
      if (!low.indexProvKey || low.indexProvKey !== high.indexProvKey) continue;
      if (!sameValues(low.indexValues, high.indexValues)) continue;
      const lowByIndex = candidateByIndex(low);
      const highByIndex = candidateByIndex(high);
      const entries = [];
      let ok = true;
      for (const rawIndex of low.indexValues || []) {
        const index = Number(rawIndex) & 0xff;
        const lowCandidate = lowByIndex.get(index);
        const highCandidate = highByIndex.get(index);
        if (!lowCandidate || !highCandidate) {
          ok = false;
          break;
        }
        entries.push({
          index,
          lowCpuAddr: Number(lowCandidate.cpuAddr) & 0xffff,
          highCpuAddr: Number(highCandidate.cpuAddr) & 0xffff,
          lowRomOff: Number(lowCandidate.romOff) >>> 0,
          highRomOff: Number(highCandidate.romOff) >>> 0,
          lowByte: Number(lowCandidate.byte) & 0xff,
          highByte: Number(highCandidate.byte) & 0xff
        });
      }
      if (!ok || !entries.length) continue;
      return {
        ok: true,
        indexProvKey: low.indexProvKey,
        indexValues: low.indexValues.slice(),
        lowRead: low,
        highRead: high,
        entries
      };
    }
  }

  return { ok: false };
}

import { hexRom } from '../identity.js';

function readU16le(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8)) & 0xffff;
}

function makeEntry(prgBytes, romOff, index) {
  return {
    index,
    entryRomOff: romOff >>> 0,
    value: readU16le(prgBytes, romOff)
  };
}

function makeTable(tableIndex, entries) {
  const first = entries[0];
  const last = entries[entries.length - 1];
  const startRomOff = first.entryRomOff >>> 0;
  const endRomOff = ((last.entryRomOff >>> 0) + 2) >>> 0;
  return {
    tableId: `monotone:le16:${hexRom(startRomOff)}:${entries.length}`,
    kind: 'monotoneTable',
    layout: 'le16Packed',
    monotonicity: 'strictlyIncreasing',
    tableIndex: tableIndex >>> 0,
    startRomOff,
    endRomOff,
    byteLength: endRomOff - startRomOff,
    entryCount: entries.length,
    entries: entries.map((entry, index) => ({
      index,
      entryRomOff: entry.entryRomOff >>> 0,
      value: entry.value & 0xffff
    })),
    pointerPromotion: {
      status: 'notTested'
    }
  };
}

export function createMonotoneTableScanner({ prgBytes }) {
  if (!(prgBytes instanceof Uint8Array)) throw new Error('createMonotoneTableScanner requires PRG bytes');

  const candidates = [];
  const counters = {
    wordsScanned: 0,
    tablesFound: 0,
    entriesFound: 0,
    longestTableEntries: 0,
    longestTableRomOff: null,
    twoEntryTables: 0,
    threePlusEntryTables: 0
  };

  let parity = 0;
  let romOff = 0;
  let run = [];
  let complete = false;

  function resetForParity(nextParity) {
    parity = nextParity;
    romOff = parity;
    run = [];
  }

  function flushRun() {
    if (run.length < 2) {
      run = [];
      return;
    }
    const table = makeTable(candidates.length, run);
    candidates.push(table);
    counters.tablesFound = candidates.length;
    counters.entriesFound += table.entryCount;
    if (table.entryCount > counters.longestTableEntries) {
      counters.longestTableEntries = table.entryCount;
      counters.longestTableRomOff = table.startRomOff >>> 0;
    }
    if (table.entryCount === 2) counters.twoEntryTables += 1;
    if (table.entryCount >= 3) counters.threePlusEntryTables += 1;
    run = [];
  }

  resetForParity(0);

  return {
    stepWords(maxWords) {
      if (complete) return { complete: true };
      const limit = Number.isInteger(maxWords) && maxWords > 0 ? maxWords : 1024;
      let scannedThisStep = 0;

      while (scannedThisStep < limit && !complete) {
        if (romOff + 1 >= prgBytes.length) {
          flushRun();
          if (parity === 0) {
            resetForParity(1);
            continue;
          }
          complete = true;
          break;
        }

        const entry = makeEntry(prgBytes, romOff, run.length);
        counters.wordsScanned += 1;
        scannedThisStep += 1;

        if (!run.length) {
          run.push(entry);
        } else {
          const previous = run[run.length - 1];
          if ((entry.value & 0xffff) > (previous.value & 0xffff)) {
            run.push(entry);
          } else {
            flushRun();
            run.push(entry);
          }
        }

        romOff += 2;
      }

      return { complete };
    },

    result() {
      return {
        kind: 'monotoneTables',
        scanner: {
          layout: 'le16Packed',
          monotonicity: 'strictlyIncreasing'
        },
        tables: candidates,
        counters: { ...counters }
      };
    },

    progress() {
      return {
        phase: 'findMonotoneTables',
        parity,
        romOff: Math.min(romOff >>> 0, prgBytes.length >>> 0),
        totalBytes: prgBytes.length >>> 0,
        ...counters
      };
    }
  };
}

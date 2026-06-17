function makeInfo({
  mapperFamily,
  boardFamily,
  boardName,
  mapperName,
  prgWindowModel,
  prgSwapUnitBytes,
  busConflicts,
  busConflictSource,
  prgFetchLayout = null
}) {
  return {
    mapperFamily,
    boardFamily,
    boardName,
    mapperName,
    prgWindowModel,
    prgSwapUnitBytes,
    busConflicts,
    busConflictSource,
    prgFetchLayout
  };
}

function defaultInfo(mapperNumber) {
  return makeInfo({
    mapperFamily: `MAPPER_${mapperNumber}`,
    boardFamily: `MAPPER_${mapperNumber}`,
    boardName: `Mapper ${mapperNumber}`,
    mapperName: `MAPPER ${mapperNumber}`,
    prgWindowModel: 'unknown',
    prgSwapUnitBytes: null,
    busConflicts: 'unknown',
    busConflictSource: 'unknown'
  });
}

function setBusConflict(info, busConflicts, busConflictSource) {
  return {
    ...info,
    busConflicts,
    busConflictSource
  };
}

function withDerivedFetchLayout(info) {
  if (info?.prgFetchLayout) return info;

  switch (info?.prgWindowModel) {
    case 'fixed-32k':
      return {
        ...info,
        prgFetchLayout: {
          contextKind: 'fixed',
          slots: [
            { id: 'prg32', cpuStart: 0x8000, cpuEnd: 0xffff, sizeBytes: 32 * 1024, source: 'fixed' }
          ]
        }
      };

    case 'fixed-32k-or-16k-mirror':
      return {
        ...info,
        prgFetchLayout: {
          contextKind: 'fixed',
          slots: [
            { id: 'lo', cpuStart: 0x8000, cpuEnd: 0xbfff, sizeBytes: 16 * 1024, source: 'fixed_or_mirror' },
            { id: 'hi', cpuStart: 0xc000, cpuEnd: 0xffff, sizeBytes: 16 * 1024, source: 'fixed_or_mirror' }
          ]
        }
      };

    case 'switch-16k+fixed-16k':
      return {
        ...info,
        prgFetchLayout: {
          contextKind: 'slot_mapped',
          slots: [
            { id: 'switch', cpuStart: 0x8000, cpuEnd: 0xbfff, sizeBytes: 16 * 1024, source: 'switchable' },
            { id: 'fixed', cpuStart: 0xc000, cpuEnd: 0xffff, sizeBytes: 16 * 1024, source: 'fixed_last' }
          ]
        }
      };

    case 'fixed-16k+switch-16k':
      return {
        ...info,
        prgFetchLayout: {
          contextKind: 'slot_mapped',
          slots: [
            { id: 'fixed', cpuStart: 0x8000, cpuEnd: 0xbfff, sizeBytes: 16 * 1024, source: 'fixed_last' },
            { id: 'switch', cpuStart: 0xc000, cpuEnd: 0xffff, sizeBytes: 16 * 1024, source: 'switchable' }
          ]
        }
      };

    case 'switch-32k':
      return {
        ...info,
        prgFetchLayout: {
          contextKind: 'slot_mapped',
          slots: [
            { id: 'prg32', cpuStart: 0x8000, cpuEnd: 0xffff, sizeBytes: 32 * 1024, source: 'switchable' }
          ]
        }
      };

    case 'switch-8k-mixed':
      return {
        ...info,
        prgFetchLayout: {
          contextKind: 'slot_mapped',
          slots: [
            { id: 'slot0', cpuStart: 0x8000, cpuEnd: 0x9fff, sizeBytes: 8 * 1024, source: 'variable' },
            { id: 'slot1', cpuStart: 0xa000, cpuEnd: 0xbfff, sizeBytes: 8 * 1024, source: 'variable' },
            { id: 'slot2', cpuStart: 0xc000, cpuEnd: 0xdfff, sizeBytes: 8 * 1024, source: 'variable' },
            { id: 'slot3', cpuStart: 0xe000, cpuEnd: 0xffff, sizeBytes: 8 * 1024, source: 'fixed_or_variable' }
          ]
        }
      };

    case 'mmc1-variable':
      return {
        ...info,
        prgFetchLayout: {
          contextKind: 'variable_slot_mapped',
          slots: [
            { id: 'mmc1', cpuStart: 0x8000, cpuEnd: 0xffff, sizeBytes: 32 * 1024, source: 'variable_mode' }
          ]
        }
      };

    default:
      return {
        ...info,
        prgFetchLayout: {
          contextKind: 'unknown',
          slots: []
        }
      };
  }
}

function boardFamilyFromBoardName(boardName) {
  if (!boardName) return null;

  if (boardName.includes('AN1ROM')) return 'AN1ROM';
  if (boardName.includes('ANROM')) return 'ANROM';
  if (boardName.includes('AMROM')) return 'AMROM';
  if (boardName.includes('AOROM')) return 'AOROM';
  if (boardName.includes('BNROM')) return 'BNROM';
  if (boardName.includes('NINA')) return 'NINA-001';
  return null;
}

function applyRomOverride(info, romOverride) {
  if (!romOverride) return info;

  const next = { ...info };

  if (romOverride.boardName) {
    next.boardName = romOverride.boardName;
    next.boardFamily = boardFamilyFromBoardName(romOverride.boardName) || next.boardFamily;
  }

  if (romOverride.busConflicts) {
    next.busConflicts = romOverride.busConflicts;
    next.busConflictSource = 'mesen-db';
  }

  return next;
}

const MAPPER_DISPLAY_NAMES = Object.freeze({
  0: 'NROM',
  1: 'MMC1',
  2: 'UxROM',
  3: 'CNROM',
  4: 'MMC3',
  5: 'MMC5',
  7: 'AxROM',
  9: 'MMC2',
  10: 'MMC4',
  13: 'CPROM',
  34: 'BNROM / NINA-001',
  66: 'GxROM',
  94: 'UN1ROM',
  180: 'UNROM-180',
  185: 'CNROM'
});

export function getMapperDisplayName(mapperNumber) {
  const key = mapperNumber | 0;
  return MAPPER_DISPLAY_NAMES[key] || `MAPPER ${key}`;
}

function infoForMapper34(header) {
  const submapper = header?.submapperNumber | 0;
  const chrSize = header?.chrSize | 0;

  if (submapper === 1) {
    return makeInfo({
      mapperFamily: 'NINA-001',
      boardFamily: 'NINA-001',
      boardName: 'NINA-001/NINA-002',
      mapperName: 'BNROM / NINA-001',
      prgWindowModel: 'switch-32k',
      prgSwapUnitBytes: 32 * 1024,
      busConflicts: 'none',
      busConflictSource: 'explicit-submapper'
    });
  }

  if (submapper === 2) {
    return makeInfo({
      mapperFamily: 'BNROM',
      boardFamily: 'BNROM',
      boardName: 'BNROM',
      mapperName: 'BNROM / NINA-001',
      prgWindowModel: 'switch-32k',
      prgSwapUnitBytes: 32 * 1024,
      busConflicts: 'and',
      busConflictSource: 'explicit-submapper'
    });
  }

  if (chrSize > 8 * 1024) {
    return makeInfo({
      mapperFamily: 'NINA-001',
      boardFamily: 'NINA-001',
      boardName: 'NINA-001/NINA-002',
      mapperName: 'BNROM / NINA-001',
      prgWindowModel: 'switch-32k',
      prgSwapUnitBytes: 32 * 1024,
      busConflicts: 'none',
      busConflictSource: 'board-heuristic'
    });
  }

  return makeInfo({
    mapperFamily: 'BNROM',
    boardFamily: 'BNROM',
    boardName: 'BNROM',
    mapperName: 'BNROM / NINA-001',
    prgWindowModel: 'switch-32k',
    prgSwapUnitBytes: 32 * 1024,
    busConflicts: 'and',
    busConflictSource: 'board-heuristic'
  });
}

function isFixedPrgMmc1(header, submapper) {
  return submapper === 5 || (header?.prgSize | 0) === 32 * 1024;
}

function classifyMapperFromHeaderBase(header) {
  const mapperNumber = header?.mapperNumber | 0;
  const submapper = header?.submapperNumber | 0;

  switch (mapperNumber) {
    case 0:
      return makeInfo({
        mapperFamily: 'NROM',
        boardFamily: 'NROM',
        boardName: 'NROM',
        mapperName: 'NROM',
        prgWindowModel: 'fixed-32k-or-16k-mirror',
        prgSwapUnitBytes: 0,
        busConflicts: 'not_applicable',
        busConflictSource: 'not-applicable'
      });

    case 1: {
      const fixedPrg = isFixedPrgMmc1(header, submapper);
      return makeInfo({
        mapperFamily: 'MMC1',
        boardFamily: fixedPrg ? 'MMC1-fixed-32k' : 'MMC1',
        boardName: fixedPrg
          ? (submapper === 5 ? 'SEROM/SHROM/SH1ROM' : 'MMC1 32K fixed PRG')
          : 'MMC1',
        mapperName: 'MMC1',
        prgWindowModel: fixedPrg ? 'fixed-32k' : 'mmc1-variable',
        prgSwapUnitBytes: fixedPrg ? 0 : null,
        busConflicts: 'none',
        busConflictSource: 'family-default'
      });
    }

    case 2: {
      let info = makeInfo({
        mapperFamily: 'UxROM',
        boardFamily: 'UxROM',
        boardName: 'UxROM',
        mapperName: 'UxROM',
        prgWindowModel: 'switch-16k+fixed-16k',
        prgSwapUnitBytes: 16 * 1024,
        busConflicts: 'and',
        busConflictSource: 'family-default'
      });
      if (submapper === 1) info = setBusConflict(info, 'none', 'explicit-submapper');
      else if (submapper === 2) info = setBusConflict(info, 'and', 'explicit-submapper');
      return info;
    }

    case 3: {
      let info = makeInfo({
        mapperFamily: 'CNROM',
        boardFamily: 'CNROM',
        boardName: 'CNROM',
        mapperName: 'CNROM',
        prgWindowModel: 'fixed-32k',
        prgSwapUnitBytes: 0,
        busConflicts: 'and',
        busConflictSource: 'family-default'
      });
      if (submapper === 1) info = setBusConflict(info, 'none', 'explicit-submapper');
      else if (submapper === 2) info = setBusConflict(info, 'and', 'explicit-submapper');
      return info;
    }

    case 4:
      return makeInfo({
        mapperFamily: 'MMC3',
        boardFamily: submapper === 1 ? 'MMC6' : 'MMC3',
        boardName: submapper === 1 ? 'MMC6' : 'MMC3',
        mapperName: submapper === 1 ? 'MMC6' : 'MMC3',
        prgWindowModel: 'switch-8k-mixed',
        prgSwapUnitBytes: 8 * 1024,
        busConflicts: 'none',
        busConflictSource: 'family-default'
      });

    case 5:
      return makeInfo({
        mapperFamily: 'MMC5',
        boardFamily: 'MMC5',
        boardName: 'MMC5',
        mapperName: 'MMC5',
        prgWindowModel: 'unknown',
        prgSwapUnitBytes: null,
        busConflicts: 'none',
        busConflictSource: 'family-default'
      });

    case 7: {
      let info = makeInfo({
        mapperFamily: 'AxROM',
        boardFamily: 'AxROM',
        boardName: 'AxROM',
        mapperName: 'AxROM',
        prgWindowModel: 'switch-32k',
        prgSwapUnitBytes: 32 * 1024,
        busConflicts: 'unknown',
        busConflictSource: 'unknown'
      });
      if (submapper === 1) info = setBusConflict(info, 'none', 'explicit-submapper');
      else if (submapper === 2) info = setBusConflict(info, 'and', 'explicit-submapper');
      return info;
    }

    case 9:
      return makeInfo({
        mapperFamily: 'MMC2',
        boardFamily: 'MMC2',
        boardName: 'MMC2',
        mapperName: 'MMC2',
        prgWindowModel: 'unknown',
        prgSwapUnitBytes: null,
        busConflicts: 'none',
        busConflictSource: 'family-default'
      });

    case 10:
      return makeInfo({
        mapperFamily: 'MMC4',
        boardFamily: 'MMC4',
        boardName: 'MMC4',
        mapperName: 'MMC4',
        prgWindowModel: 'unknown',
        prgSwapUnitBytes: null,
        busConflicts: 'none',
        busConflictSource: 'family-default'
      });

    case 13:
      return makeInfo({
        mapperFamily: 'CPROM',
        boardFamily: 'CPROM',
        boardName: 'CPROM',
        mapperName: 'CPROM',
        prgWindowModel: 'fixed-32k',
        prgSwapUnitBytes: 0,
        busConflicts: 'not_applicable',
        busConflictSource: 'not-applicable'
      });

    case 34:
      return infoForMapper34(header);

    case 66:
      return makeInfo({
        mapperFamily: 'GxROM',
        boardFamily: 'GxROM',
        boardName: 'GNROM/MHROM',
        mapperName: 'GxROM',
        prgWindowModel: 'switch-32k',
        prgSwapUnitBytes: 32 * 1024,
        busConflicts: 'and',
        busConflictSource: 'family-default'
      });

    case 94:
      return makeInfo({
        mapperFamily: 'UN1ROM',
        boardFamily: 'UN1ROM',
        boardName: 'UN1ROM',
        mapperName: 'UN1ROM',
        prgWindowModel: 'switch-16k+fixed-16k',
        prgSwapUnitBytes: 16 * 1024,
        busConflicts: 'and',
        busConflictSource: 'family-default'
      });

    case 180:
      return makeInfo({
        mapperFamily: 'UNROM-180',
        boardFamily: 'UNROM-180',
        boardName: 'UNROM-180',
        mapperName: 'UNROM-180',
        prgWindowModel: 'fixed-16k+switch-16k',
        prgSwapUnitBytes: 16 * 1024,
        busConflicts: 'and',
        busConflictSource: 'family-default'
      });

    case 185:
      return makeInfo({
        mapperFamily: 'CNROM-185',
        boardFamily: 'CNROM-185',
        boardName: 'CNROM with security diodes',
        mapperName: 'CNROM',
        prgWindowModel: 'fixed-32k',
        prgSwapUnitBytes: 0,
        busConflicts: 'and',
        busConflictSource: 'family-default'
      });

    default:
      return defaultInfo(mapperNumber);
  }
}

export function resolveMapperInfo(header, romOverride = null) {
  const effectiveHeader = romOverride?.submapperNumber != null
    ? { ...header, submapperNumber: romOverride.submapperNumber }
    : header;

  const baseInfo = classifyMapperFromHeaderBase(effectiveHeader);
  return withDerivedFetchLayout(applyRomOverride(baseInfo, romOverride));
}

export function classifyMapperFromHeader(header) {
  return resolveMapperInfo(header, null);
}

const LISTABLE_MAPPER_FAMILIES = new Set([
  'NROM',
  'MMC1',
  'UxROM',
  'CNROM',
  'CNROM-185',
  'MMC2',
  'MMC3',
  'MMC4',
  'MMC5',
  'AxROM',
  'CPROM',
  'BNROM',
  'NINA-001',
  'GxROM',
  'UN1ROM'
]);

const ANALYZABLE_MAPPER_KIND_BY_FAMILY = Object.freeze({
  NROM: 'NROM',
  MMC1: 'MMC1',
  UxROM: 'UxROM',
  CNROM: 'CNROM',
  'CNROM-185': 'CNROM',
  AxROM: 'AxROM',
  CPROM: 'CPROM',
  BNROM: 'BNROM',
  GxROM: 'GxROM',
  UN1ROM: 'UN1ROM'
});

export function getStaticAnalysisSupportInfo(analysisMapper) {
  const mapperFamily = analysisMapper?.mapperFamily || null;
  const boardFamily = analysisMapper?.boardFamily || null;

  if (!mapperFamily) {
    return { listable: false, isAnalyzable: false, analysisKind: null };
  }

  if (mapperFamily === 'MMC3') {
    if (boardFamily === 'MMC3') {
      return { listable: true, isAnalyzable: true, analysisKind: 'MMC3' };
    }
    return { listable: true, isAnalyzable: false, analysisKind: null };
  }

  const analysisKind = ANALYZABLE_MAPPER_KIND_BY_FAMILY[mapperFamily] || null;
  const listable = LISTABLE_MAPPER_FAMILIES.has(mapperFamily);
  return {
    listable,
    isAnalyzable: !!analysisKind,
    analysisKind
  };
}

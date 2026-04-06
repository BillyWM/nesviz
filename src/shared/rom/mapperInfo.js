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

export function getMapperDisplayName(mapperNumber) {
  switch (mapperNumber | 0) {
    case 0: return 'NROM';
    case 1: return 'MMC1';
    case 2: return 'UxROM';
    case 3: return 'CNROM';
    case 4: return 'MMC3';
    case 7: return 'AxROM';
    case 13: return 'CPROM';
    case 34: return 'BNROM / NINA-001';
    case 66: return 'GxROM';
    case 94: return 'UN1ROM';
    case 180: return 'UNROM-180';
    case 185: return 'CNROM';
    default: return `MAPPER ${mapperNumber | 0}`;
  }
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

    case 1:
      return makeInfo({
        mapperFamily: 'MMC1',
        boardFamily: submapper === 5 ? 'MMC1-fixed-32k' : 'MMC1',
        boardName: submapper === 5 ? 'SEROM/SHROM/SH1ROM' : 'MMC1',
        mapperName: 'MMC1',
        prgWindowModel: submapper === 5 ? 'fixed-32k' : 'mmc1-variable',
        prgSwapUnitBytes: submapper === 5 ? 0 : null,
        busConflicts: 'none',
        busConflictSource: 'family-default'
      });

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
        mapperName: 'MMC3',
        prgWindowModel: 'switch-8k-mixed',
        prgSwapUnitBytes: 8 * 1024,
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

export function isCurrentStaticAnalysisTargetMapper(mapperNumber) {
  const m = mapperNumber | 0;
  return m === 0 || m === 1 || m === 2 || m === 3 || m === 4 || m === 7 || m === 13 || m === 34 || m === 66 || m === 94 || m === 185;
}

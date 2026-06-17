export const ANALYSIS_ENGINE_ID = 'staticAnalysis';

export const ANALYSIS_PHASE_IDS = Object.freeze({
  INITIALIZE: 'initialize',
  VECTOR_CHECKING: 'vectorChecking',
  SEED_VECTORS: 'seedVectors',
  FIND_MONOTONE_TABLES: 'findMonotoneTables',
  FIND_SPLIT_POINTER_TABLES: 'findSplitPointerTables',
  PROMOTE_POINTERS: 'promotePointers',
  FUNCTION_EXCAVATION: 'functionExcavation',
  EXPAND_CFG: 'expandCfg',
  STRICT_CFG: 'strictCfg',
  MAPPING_SPECULATION: 'mappingSpeculation',
  MAPPED_CFG_EXPANSION: 'mappedCfgExpansion',
  FUNCTION_SUMMARIZATION: 'functionSummarization',
  CFG_TOPOLOGY: 'cfgTopology',
  LOOP_SUMMARIZATION: 'loopSummarization',
  ABSTRACT_INTERPRETATION: 'abstractInterpretation',
  DETECT_LOOPS: 'detectLoops',
  POPULATE_MEMORY_MAP: 'populateMemoryMap',
  DECORATE_LOOPS: 'decorateLoops',
  COALESCE: 'coalesce',
  GENERATE_SUMMARY: 'generateSummary',
  FINALIZE: 'finalize'
});

export const ANALYSIS_PHASE_LABELS = Object.freeze({
  [ANALYSIS_PHASE_IDS.INITIALIZE]: 'Initialize',
  [ANALYSIS_PHASE_IDS.VECTOR_CHECKING]: 'Vector Checking',
  [ANALYSIS_PHASE_IDS.SEED_VECTORS]: 'Seed Vectors',
  [ANALYSIS_PHASE_IDS.FIND_MONOTONE_TABLES]: 'Find Monotone Tables',
  [ANALYSIS_PHASE_IDS.FIND_SPLIT_POINTER_TABLES]: 'Find Split Pointer Tables',
  [ANALYSIS_PHASE_IDS.PROMOTE_POINTERS]: 'Promote Pointers',
  [ANALYSIS_PHASE_IDS.FUNCTION_EXCAVATION]: 'Function Excavation',
  [ANALYSIS_PHASE_IDS.EXPAND_CFG]: 'Expand CFG',
  [ANALYSIS_PHASE_IDS.STRICT_CFG]: 'Strict CFG',
  [ANALYSIS_PHASE_IDS.MAPPING_SPECULATION]: 'Mapping Speculation',
  [ANALYSIS_PHASE_IDS.MAPPED_CFG_EXPANSION]: 'Mapped CFG Expansion',
  [ANALYSIS_PHASE_IDS.FUNCTION_SUMMARIZATION]: 'Function Summarization',
  [ANALYSIS_PHASE_IDS.CFG_TOPOLOGY]: 'CFG Topology',
  [ANALYSIS_PHASE_IDS.LOOP_SUMMARIZATION]: 'Loop Summarization',
  [ANALYSIS_PHASE_IDS.ABSTRACT_INTERPRETATION]: 'Abstract Interpretation',
  [ANALYSIS_PHASE_IDS.DETECT_LOOPS]: 'Detect Loops',
  [ANALYSIS_PHASE_IDS.POPULATE_MEMORY_MAP]: 'Populate Memory Map',
  [ANALYSIS_PHASE_IDS.DECORATE_LOOPS]: 'Decorate Loops',
  [ANALYSIS_PHASE_IDS.COALESCE]: 'Coalesce',
  [ANALYSIS_PHASE_IDS.GENERATE_SUMMARY]: 'Generate Summary',
  [ANALYSIS_PHASE_IDS.FINALIZE]: 'Finalize'
});

export const ANALYSIS_PHASE_GROUP_IDS = Object.freeze({
  PRIMING: 'priming',
  CORE_ANALYSIS: 'coreAnalysis',
  MAPPED_EXPANSION: 'mappedExpansion',
  SEMANTIC_FACTS: 'semanticFacts',
  DECORATE_UI: 'decorateUi'
});

export const ANALYSIS_PHASE_GROUP_LABELS = Object.freeze({
  [ANALYSIS_PHASE_GROUP_IDS.PRIMING]: 'Priming',
  [ANALYSIS_PHASE_GROUP_IDS.CORE_ANALYSIS]: 'Core Analysis',
  [ANALYSIS_PHASE_GROUP_IDS.MAPPED_EXPANSION]: 'Mapped Expansion',
  [ANALYSIS_PHASE_GROUP_IDS.SEMANTIC_FACTS]: 'Semantic Facts',
  [ANALYSIS_PHASE_GROUP_IDS.DECORATE_UI]: 'Decorate UI'
});

export const ANALYSIS_GROUP_TERMINATION = Object.freeze({
  NO_NEW_CFG_WORKLIST: 'noNewCfgWorklist',
  ONE_SHOT: 'oneShot'
});

export const ANALYSIS_PHASE_GROUPS = Object.freeze({
  [ANALYSIS_PHASE_GROUP_IDS.PRIMING]: Object.freeze({
    id: ANALYSIS_PHASE_GROUP_IDS.PRIMING,
    termination: ANALYSIS_GROUP_TERMINATION.ONE_SHOT,
    phases: Object.freeze([
      Object.freeze({ id: ANALYSIS_PHASE_IDS.VECTOR_CHECKING }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.FIND_MONOTONE_TABLES }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.FIND_SPLIT_POINTER_TABLES }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.PROMOTE_POINTERS }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.FUNCTION_EXCAVATION })
    ])
  }),
  [ANALYSIS_PHASE_GROUP_IDS.CORE_ANALYSIS]: Object.freeze({
    id: ANALYSIS_PHASE_GROUP_IDS.CORE_ANALYSIS,
    termination: ANALYSIS_GROUP_TERMINATION.NO_NEW_CFG_WORKLIST,
    phases: Object.freeze([
      Object.freeze({ id: ANALYSIS_PHASE_IDS.EXPAND_CFG }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.STRICT_CFG }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.FUNCTION_SUMMARIZATION }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.COALESCE }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.CFG_TOPOLOGY }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.LOOP_SUMMARIZATION }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.ABSTRACT_INTERPRETATION })
    ])
  }),
  [ANALYSIS_PHASE_GROUP_IDS.MAPPED_EXPANSION]: Object.freeze({
    id: ANALYSIS_PHASE_GROUP_IDS.MAPPED_EXPANSION,
    requiresMappedGame: true,
    termination: ANALYSIS_GROUP_TERMINATION.NO_NEW_CFG_WORKLIST,
    phases: Object.freeze([
      Object.freeze({ id: ANALYSIS_PHASE_IDS.MAPPED_CFG_EXPANSION }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.EXPAND_CFG }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.STRICT_CFG }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.FUNCTION_SUMMARIZATION }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.COALESCE }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.CFG_TOPOLOGY }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.LOOP_SUMMARIZATION }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.ABSTRACT_INTERPRETATION })
    ])
  }),
  [ANALYSIS_PHASE_GROUP_IDS.SEMANTIC_FACTS]: Object.freeze({
    id: ANALYSIS_PHASE_GROUP_IDS.SEMANTIC_FACTS,
    termination: ANALYSIS_GROUP_TERMINATION.NO_NEW_CFG_WORKLIST,
    phases: Object.freeze([
      Object.freeze({ id: ANALYSIS_PHASE_IDS.DETECT_LOOPS }),
      Object.freeze({ id: ANALYSIS_PHASE_IDS.POPULATE_MEMORY_MAP })
    ])
  }),
  [ANALYSIS_PHASE_GROUP_IDS.DECORATE_UI]: Object.freeze({
    id: ANALYSIS_PHASE_GROUP_IDS.DECORATE_UI,
    termination: ANALYSIS_GROUP_TERMINATION.ONE_SHOT,
    phases: Object.freeze([
      Object.freeze({ id: ANALYSIS_PHASE_IDS.DECORATE_LOOPS })
    ])
  })
});

export const ANALYSIS_PROGRESS_MESSAGE_KINDS = Object.freeze({
  ANALYSIS_RESET: 'analysisReset',
  PHASE_STARTED: 'phaseStarted',
  PHASE_COMPLETE: 'phaseComplete',
  PHASE_PROGRESS: 'phaseProgress'
});

export const ANALYSIS_PROGRESS_DETAIL_KINDS = Object.freeze({
  FUNCTION_EXCAVATION: 'functionExcavation',
  FUNCTION_SUMMARIZATION: 'functionSummarization',
  ABSTRACT_INTERPRETATION: 'abstractInterpretation',
  DETECT_LOOPS: 'detectLoops',
  POPULATE_MEMORY_MAP: 'populateMemoryMap',
  FIND_MONOTONE_TABLES: 'findMonotoneTables',
  FIND_SPLIT_POINTER_TABLES: 'findSplitPointerTables',
  PROMOTE_POINTERS: 'promotePointers'
});

export const FUNCTION_EXCAVATION_PROGRESS_CHUNK_BYTES = 256;

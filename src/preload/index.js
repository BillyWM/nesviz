import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('nesviz', {
  openRom: () => ipcRenderer.invoke('nesviz:openRom'),
  openRomPath: (filepath) => ipcRenderer.invoke('nesviz:openRomPath', { filepath }),
  getStartupRomPath: () => ipcRenderer.invoke('nesviz:getStartupRomPath'),
  selectRomFolder: () => ipcRenderer.invoke('nesviz:selectRomFolder'),
  startRomFolderScan: (folderPaths, opts = null) => ipcRenderer.invoke('nesviz:startRomFolderScan', {
    folderPaths,
    force: !!opts?.force
  }),
  getRomFolderCache: () => ipcRenderer.invoke('nesviz:getRomFolderCache'),
  getRomListUiState: () => ipcRenderer.invoke('nesviz:romlist:getUiState'),
  setRomListUiState: (state) => ipcRenderer.invoke('nesviz:romlist:setUiState', state),
  openCdl: () => ipcRenderer.invoke('nesviz:openCdl'),
  runStaticAnalysis: () => ipcRenderer.invoke('nesviz:runStaticAnalysis'),
  loadActiveAnalysisCache: () => ipcRenderer.invoke('nesviz:loadActiveAnalysisCache'),
  getTimeline: () => ipcRenderer.invoke('nesviz:getTimeline'),
  getBlock: (blockId) => ipcRenderer.invoke('nesviz:getBlock', { blockId }),
  getBlockVsaDebug: (blockId) => ipcRenderer.invoke('nesviz:getBlockVsaDebug', { blockId }),
  getBlocks: (blockIds) => ipcRenderer.invoke('nesviz:getBlocks', { blockIds }),
  getArtifacts: () => ipcRenderer.invoke('nesviz:getArtifacts'),
  getPrgBytes: (romStart, romEnd) => ipcRenderer.invoke('nesviz:getPrgBytes', { romStart, romEnd }),
  getAnalysisLog: () => ipcRenderer.invoke('nesviz:getAnalysisLog'),
  copyText: (text) => ipcRenderer.invoke('nesviz:copyText', { text }),
  getMemoryMapData: () => ipcRenderer.invoke('nesviz:getMemoryMapData'),
  getHeatmapData: () => ipcRenderer.invoke('nesviz:getHeatmapData'),
  getMarkovMapData: (options) => ipcRenderer.invoke('nesviz:getMarkovMapData', options),
  getGraphData: () => ipcRenderer.invoke('nesviz:getGraphData'),
  getGraphLayoutCache: () => ipcRenderer.invoke('nesviz:getGraphLayoutCache'),
  saveGraphLayoutCache: (payload) => ipcRenderer.invoke('nesviz:saveGraphLayoutCache', payload),
  getPreferencesAnalysisCacheStats: () => ipcRenderer.invoke('nesviz:preferences:getAnalysisCacheStats'),
  clearPreferencesAnalysisCache: () => ipcRenderer.invoke('nesviz:preferences:clearAnalysisCache'),

  getTuningState: () => ipcRenderer.invoke('nesviz:getTuningState'),
  setTuningState: (patch) => ipcRenderer.invoke('nesviz:setTuningState', { patch }),
  resetTuningState: () => ipcRenderer.invoke('nesviz:resetTuningState'),
  markovTrainOpcodeModel: (options) => ipcRenderer.invoke('nesviz:markovTrainOpcodeModel', options),

  onTuningUpdated: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('nesviz:tuningUpdated', listener);
    return () => ipcRenderer.removeListener('nesviz:tuningUpdated', listener);
  },

  // Trace Streamer (BwMesen) connection + status
  traceStreamerGetStatus: () => ipcRenderer.invoke('nesviz:traceStreamer:getStatus'),
  traceStreamerConnect: () => ipcRenderer.invoke('nesviz:traceStreamer:connect'),
  traceStreamerDisconnect: () => ipcRenderer.invoke('nesviz:traceStreamer:disconnect'),
  onTraceStreamerStatus: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('nesviz:traceStreamer:status', listener);
    return () => ipcRenderer.removeListener('nesviz:traceStreamer:status', listener);
  },

  // Labels window needs to read the current ROM's labels.
  getActiveLabels: () => ipcRenderer.invoke('nesviz:getActiveLabels'),

  setBookmarkAtRomOff: (romOff, set) => ipcRenderer.invoke('nesviz:setBookmarkAtRomOff', {
    romOff,
    set: !!set
  }),

  setRomLabel: (romOff, label) => ipcRenderer.invoke('nesviz:setRomLabel', {
    romOff,
    label
  }),

  setAddrLabel: (cpuAddr, label) => ipcRenderer.invoke('nesviz:setAddrLabel', {
    cpuAddr,
    label
  }),

  // Menu event hooks
  onMenuOpenRom: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('nesviz:menuOpenRom', listener);
    return () => ipcRenderer.removeListener('nesviz:menuOpenRom', listener);
  },

  onMenuOpenRecentRom: (callback) => {
    const listener = (_evt, payload) => callback(payload?.filepath);
    ipcRenderer.on('nesviz:menuOpenRecentRom', listener);
    return () => ipcRenderer.removeListener('nesviz:menuOpenRecentRom', listener);
  },
  onMenuOpenRomFolder: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('nesviz:menuOpenRomFolder', listener);
    return () => ipcRenderer.removeListener('nesviz:menuOpenRomFolder', listener);
  },
  onMenuViewRomList: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('nesviz:menuViewRomList', listener);
    return () => ipcRenderer.removeListener('nesviz:menuViewRomList', listener);
  },
  onMenuOpenCdl: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('nesviz:menuOpenCdl', listener);
    return () => ipcRenderer.removeListener('nesviz:menuOpenCdl', listener);
  },
  onMenuShowAbout: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('nesviz:menuShowAbout', listener);
    return () => ipcRenderer.removeListener('nesviz:menuShowAbout', listener);
  },

  onMenuSetShowDebugInfo: (callback) => {
    const listener = (_evt, payload) => callback(!!payload?.checked);
    ipcRenderer.on('nesviz:menuSetShowDebugInfo', listener);
    return () => ipcRenderer.removeListener('nesviz:menuSetShowDebugInfo', listener);
  },

  onAnalysisLogUpdated: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('nesviz:analysisLogUpdated', listener);
    return () => ipcRenderer.removeListener('nesviz:analysisLogUpdated', listener);
  },

  onMemoryMapDataChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('nesviz:memoryMapDataChanged', listener);
    return () => ipcRenderer.removeListener('nesviz:memoryMapDataChanged', listener);
  },

  onHeatmapDataChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('nesviz:heatmapDataChanged', listener);
    return () => ipcRenderer.removeListener('nesviz:heatmapDataChanged', listener);
  },

  onMarkovMapDataChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('nesviz:markovMapDataChanged', listener);
    return () => ipcRenderer.removeListener('nesviz:markovMapDataChanged', listener);
  },

  onGraphDataChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('nesviz:graphDataChanged', listener);
    return () => ipcRenderer.removeListener('nesviz:graphDataChanged', listener);
  },

  // Main process -> main window: navigation requests from the Labels window.
  onLabelsNavigate: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('nesviz:labelsNavigate', listener);
    return () => ipcRenderer.removeListener('nesviz:labelsNavigate', listener);
  },

  // Streamed scan events from the main process.
  onRomFolderScan: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('nesviz:romFolderScan', listener);
    return () => ipcRenderer.removeListener('nesviz:romFolderScan', listener);
  },

  // Streamed VSA progress updates from the analysis worker.
  onVsaProgress: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('nesviz:vsaProgress', listener);
    return () => ipcRenderer.removeListener('nesviz:vsaProgress', listener);
  },

  // ROM list secondary window -> main process
  romListOpenRom: (filepath) => {
    if (!filepath) return;
    ipcRenderer.send('nesviz:romlist:openRom', { filepath });
  },

  // Labels secondary window -> main process
  labelsNavigate: (payload) => {
    if (!payload || typeof payload !== 'object') return;
    ipcRenderer.send('nesviz:labels:navigate', payload);
  },

  // Main process -> ROM list secondary window
  onRomListCommand: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('nesviz:romlist:command', listener);
    return () => ipcRenderer.removeListener('nesviz:romlist:command', listener);
  }
});

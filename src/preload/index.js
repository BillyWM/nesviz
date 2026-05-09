import { contextBridge, ipcRenderer } from 'electron';

let nextRomFolderScanToken = 1;
const activeRomFolderScans = new Map();

function closeRomFolderScan(token) {
  const scan = activeRomFolderScans.get(token);
  if (!scan) return;
  activeRomFolderScans.delete(token);
  try { scan.port.close(); } catch {}
  try { ipcRenderer.send('nesviz:romFolderScan:cancel', { token }); } catch {}
}

function startRomFolderScan(folderPaths, opts = null, callback = null) {
  if (typeof callback !== 'function') {
    return { ok: false, error: 'ROM folder scan callback is required' };
  }

  const token = `romFolderScan:${nextRomFolderScanToken++}`;
  const channel = new MessageChannel();
  let finished = false;

  function finish() {
    if (finished) return;
    finished = true;
    activeRomFolderScans.delete(token);
    try { channel.port1.close(); } catch {}
  }

  channel.port1.onmessage = (event) => {
    const payload = event?.data;
    callback(payload);
    if (payload?.type === 'done' || payload?.type === 'error') finish();
  };
  channel.port1.start();

  activeRomFolderScans.set(token, { port: channel.port1 });
  ipcRenderer.postMessage('nesviz:romFolderScan:start', {
    token,
    folderPaths,
    force: !!opts?.force
  }, [channel.port2]);

  return { ok: true, token };
}

contextBridge.exposeInMainWorld('nesviz', {
  openRom: () => ipcRenderer.invoke('nesviz:openRom'),
  openRomPath: (filepath) => ipcRenderer.invoke('nesviz:openRomPath', { filepath }),
  getStartupRomPath: () => ipcRenderer.invoke('nesviz:getStartupRomPath'),
  selectRomFolder: () => ipcRenderer.invoke('nesviz:selectRomFolder'),
  startRomFolderScan,
  cancelRomFolderScan: (token) => closeRomFolderScan(token),
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
  getViewSettings: () => ipcRenderer.invoke('nesviz:getViewSettings'),
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
  onMenuSetShowNamedConstants: (callback) => {
    const listener = (_evt, payload) => callback(payload?.checked !== false);
    ipcRenderer.on('nesviz:menuSetShowNamedConstants', listener);
    return () => ipcRenderer.removeListener('nesviz:menuSetShowNamedConstants', listener);
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

  // Main process -> main window: navigation requests from secondary windows.
  onLabelsNavigate: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('nesviz:labelsNavigate', listener);
    return () => ipcRenderer.removeListener('nesviz:labelsNavigate', listener);
  },

  onMemoryMapNavigate: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('nesviz:memoryMapNavigate', listener);
    return () => ipcRenderer.removeListener('nesviz:memoryMapNavigate', listener);
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

  // Secondary windows -> main process
  labelsNavigate: (payload) => {
    if (!payload || typeof payload !== 'object') return;
    ipcRenderer.send('nesviz:labels:navigate', payload);
  },

  memoryMapNavigate: (payload) => {
    if (!payload || typeof payload !== 'object') return;
    ipcRenderer.send('nesviz:memoryMap:navigate', payload);
  },

  // Main process -> ROM list secondary window
  onRomListCommand: (callback) => {
    const listener = (_evt, payload) => callback(payload);
    ipcRenderer.on('nesviz:romlist:command', listener);
    return () => ipcRenderer.removeListener('nesviz:romlist:command', listener);
  }
});

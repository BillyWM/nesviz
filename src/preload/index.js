import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('nesviz', {
  openRom: () => ipcRenderer.invoke('nesviz:openRom'),
  openRomPath: (filepath) => ipcRenderer.invoke('nesviz:openRomPath', { filepath }),
  selectRomFolder: () => ipcRenderer.invoke('nesviz:selectRomFolder'),
  startRomFolderScan: (folderPath, opts = null) => ipcRenderer.invoke('nesviz:startRomFolderScan', {
    folderPath,
    force: !!opts?.force
  }),
  getRomFolderCache: () => ipcRenderer.invoke('nesviz:getRomFolderCache'),
  openCdl: () => ipcRenderer.invoke('nesviz:openCdl'),
  runStaticNrom: () => ipcRenderer.invoke('nesviz:runStaticNrom'),
  getTimeline: () => ipcRenderer.invoke('nesviz:getTimeline'),
  getBlock: (blockId) => ipcRenderer.invoke('nesviz:getBlock', { blockId }),
  getBlocks: (blockIds) => ipcRenderer.invoke('nesviz:getBlocks', { blockIds }),
  getArtifacts: () => ipcRenderer.invoke('nesviz:getArtifacts'),

  // Labels window needs to read the current ROM's labels.
  getActiveLabels: () => ipcRenderer.invoke('nesviz:getActiveLabels'),

  setBookmark: (romOff, cpuAddr, set) => ipcRenderer.invoke('nesviz:setBookmark', {
    romOff,
    cpuAddr,
    set: !!set
  }),

  setLabel: (romOff, label) => ipcRenderer.invoke('nesviz:setLabel', {
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

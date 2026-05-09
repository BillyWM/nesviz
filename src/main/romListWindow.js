import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from './windowState.js';
import { loadRendererWindow } from './utils/windowLoaderUtils.js';
import { showAndFocusWindow } from './utils/windowFocusUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let romListWindow = null;
let pendingCommand = null;

const DEFAULT_ROM_LIST_UI_STATE = Object.freeze({
  filterState: {
    nameQuery: ''
  },
  sort: {
    key: null,
    dir: 'asc'
  }
});

let romListUiState = {
  filterState: { ...DEFAULT_ROM_LIST_UI_STATE.filterState },
  sort: { ...DEFAULT_ROM_LIST_UI_STATE.sort }
};

export function setMainWindow(win) {
  mainWindow = win;
}

function sendCommand(cmd) {
  if (!romListWindow || romListWindow.isDestroyed()) return;
  try {
    romListWindow.webContents.send('nesviz:romlist:command', cmd);
  } catch {
    // Ignore send failures.
  }
}

function normalizeRomListFilterState(raw) {
  const nameQuery = typeof raw?.nameQuery === 'string' ? raw.nameQuery : '';
  return { nameQuery };
}

function normalizeRomListSort(raw) {
  const allowedKeys = new Set(['filename', 'mapperName', 'prgBytes', 'chrBytes']);
  const key = allowedKeys.has(raw?.key) ? raw.key : null;
  const dir = raw?.dir === 'desc' ? 'desc' : 'asc';
  return { key, dir };
}

function normalizeRomListUiState(raw) {
  return {
    filterState: normalizeRomListFilterState(raw?.filterState),
    sort: normalizeRomListSort(raw?.sort)
  };
}

function cloneRomListUiState() {
  return {
    filterState: { ...romListUiState.filterState },
    sort: { ...romListUiState.sort }
  };
}

export function showRomListWindow({ selectFolder = false } = {}) {
  if (romListWindow && !romListWindow.isDestroyed()) {
    romListWindow.show();
    romListWindow.focus();
    if (selectFolder) sendCommand({ type: 'selectFolderAndScan' });
    return;
  }

  const { bounds, maximized } = getInitialWindowStateSync('romList', { width: 760, height: 820 });
  romListWindow = new BrowserWindow({
    ...bounds,
    parent: mainWindow || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  });

  applyMaximizedIfNeeded(romListWindow, maximized);
  attachSaveOnClose(romListWindow, 'romList');

  // Hide menu bar on Windows/Linux. (macOS uses a global app menu.)
  try {
    romListWindow.setMenu(null);
    romListWindow.setMenuBarVisibility(false);
  } catch {
    // Ignore if not supported on the platform/electron version.
  }

  romListWindow.on('closed', () => {
    romListWindow = null;
    pendingCommand = null;
  });

  pendingCommand = selectFolder ? { type: 'selectFolderAndScan' } : null;
  romListWindow.webContents.on('did-finish-load', () => {
    if (pendingCommand) {
      sendCommand(pendingCommand);
      pendingCommand = null;
    }
  });

  loadRendererWindow(romListWindow, 'romlist.html', __dirname);
}

export function registerRomListIpc() {
  ipcMain.handle('nesviz:romlist:getUiState', () => {
    return cloneRomListUiState();
  });

  ipcMain.handle('nesviz:romlist:setUiState', (_evt, payload) => {
    romListUiState = normalizeRomListUiState(payload);
    return { ok: true, state: cloneRomListUiState() };
  });

  ipcMain.on('nesviz:romlist:openRom', (_evt, { filepath }) => {
    if (!filepath) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        showAndFocusWindow(mainWindow);
        mainWindow.webContents.send('nesviz:menuOpenRecentRom', { filepath });
      } catch {
        // Ignore.
      }
    }
    if (romListWindow && !romListWindow.isDestroyed()) {
      try {
        romListWindow.close();
      } catch {
        // Ignore.
      }
    }
  });
}

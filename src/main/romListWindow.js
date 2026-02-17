import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let romListWindow = null;
let pendingCommand = null;

export function setMainWindow(win) {
  mainWindow = win;
}

function getDevRendererUrl() {
  return (
    process.env.VITE_DEV_SERVER_URL ||
    process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL ||
    process.env.ELECTRON_RENDERER_URL ||
    null
  );
}

function loadRomListWindow(win) {
  const devUrl = getDevRendererUrl();
  if (devUrl) {
    const base = devUrl.replace(/\/+$/, '');
    win.loadURL(`${base}/romlist.html`);
    return;
  }

  // In production builds, electron-vite outputs renderer assets under ../renderer.
  const htmlPath = path.join(__dirname, '../renderer/romlist.html');
  win.loadFile(htmlPath);
}

function sendCommand(cmd) {
  if (!romListWindow || romListWindow.isDestroyed()) return;
  try {
    romListWindow.webContents.send('nesviz:romlist:command', cmd);
  } catch {
    // Ignore send failures.
  }
}

export function showRomListWindow({ selectFolder = false } = {}) {
  if (romListWindow && !romListWindow.isDestroyed()) {
    romListWindow.show();
    romListWindow.focus();
    if (selectFolder) sendCommand({ type: 'selectFolderAndScan' });
    return;
  }

  romListWindow = new BrowserWindow({
    width: 760,
    height: 820,
    parent: mainWindow || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  });

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

  loadRomListWindow(romListWindow);
}

export function registerRomListIpc() {
  ipcMain.on('nesviz:romlist:openRom', (_evt, { filepath }) => {
    if (!filepath) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.show();
        mainWindow.focus();
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

import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let labelsWindow = null;

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

function loadLabelsWindow(win) {
  const devUrl = getDevRendererUrl();
  if (devUrl) {
    const base = devUrl.replace(/\/+$/, '');
    win.loadURL(`${base}/labels.html`);
    return;
  }

  // In production builds, electron-vite outputs renderer assets under ../renderer.
  const htmlPath = path.join(__dirname, '../renderer/labels.html');
  win.loadFile(htmlPath);
}

export function showLabelsWindow() {
  if (labelsWindow && !labelsWindow.isDestroyed()) {
    labelsWindow.show();
    labelsWindow.focus();
    return;
  }

  labelsWindow = new BrowserWindow({
    width: 560,
    height: 720,
    parent: mainWindow || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  });

  // Hide menu bar on Windows/Linux. (macOS uses a global app menu.)
  try {
    labelsWindow.setMenu(null);
    labelsWindow.setMenuBarVisibility(false);
  } catch {
    // Ignore if not supported on the platform/electron version.
  }

  labelsWindow.on('closed', () => {
    labelsWindow = null;
  });

  loadLabelsWindow(labelsWindow);
}

export function registerLabelsIpc() {
  ipcMain.on('nesviz:labels:navigate', (_evt, payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('nesviz:labelsNavigate', payload);
    } catch {
      // Ignore.
    }
  });
}

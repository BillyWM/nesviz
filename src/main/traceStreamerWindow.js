import { BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from './windowState.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let traceStreamerWindow = null;

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

function loadTraceStreamerWindow(win) {
  const devUrl = getDevRendererUrl();
  if (devUrl) {
    const base = devUrl.replace(/\/+$/, '');
    win.loadURL(`${base}/tracestreamer.html`);
    return;
  }

  // In production builds, electron-vite outputs renderer assets under ../renderer.
  const htmlPath = path.join(__dirname, '../renderer/tracestreamer.html');
  win.loadFile(htmlPath);
}

export function showTraceStreamerWindow() {
  if (traceStreamerWindow && !traceStreamerWindow.isDestroyed()) {
    traceStreamerWindow.show();
    traceStreamerWindow.focus();
    return;
  }

  const { bounds, maximized } = getInitialWindowStateSync('traceStreamer', { width: 520, height: 360 });

  traceStreamerWindow = new BrowserWindow({
    ...bounds,
    parent: mainWindow || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  });

  applyMaximizedIfNeeded(traceStreamerWindow, maximized);
  attachSaveOnClose(traceStreamerWindow, 'traceStreamer');

  // Hide menu bar on Windows/Linux. (macOS uses a global app menu.)
  try {
    traceStreamerWindow.setMenu(null);
    traceStreamerWindow.setMenuBarVisibility(false);
  } catch {
    // Ignore if not supported.
  }

  traceStreamerWindow.on('closed', () => {
    traceStreamerWindow = null;
  });

  loadTraceStreamerWindow(traceStreamerWindow);
}

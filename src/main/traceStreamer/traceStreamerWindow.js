import { BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from '../windowState.js';
import { loadRendererWindow } from '../utils/windowLoaderUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mainDirname = path.basename(__dirname) === 'traceStreamer' ? path.dirname(__dirname) : __dirname;

let mainWindow = null;
let traceStreamerWindow = null;

export function setMainWindow(win) {
  mainWindow = win;
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
      preload: path.join(mainDirname, '../preload/index.js'),
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

  loadRendererWindow(traceStreamerWindow, 'tracestreamer.html', mainDirname);
}

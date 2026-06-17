import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerAnalysisIpc, getActiveAnalysisState } from './analyze/analysisIpc.js';
import { registerCodeViewIpc } from './codeView/codeViewIpc.js';
import { registerRomFeaturesIpc } from './romFeaturesIpc.js';
import { registerTraceStreamerIpc } from './traceStreamer/traceStreamerIpc.js';
import { installAppMenu, registerMenuSettingsIpc } from './menu.js';
import { ensureUserDataLoaded, getRecentRomPaths } from './userDataStore.js';
import { registerRomListIpc, setMainWindow as setMainWindowForRomList } from './romListWindow.js';
import { registerPreferencesIpc, setMainWindow as setMainWindowForPreferences } from './preferencesWindow.js';
import { registerLabelsIpc, setMainWindow as setMainWindowForLabels } from './labelsWindow.js';
import { setMainWindow as setMainWindowForTraceStreamer } from './traceStreamer/traceStreamerWindow.js';
import { registerAnalysisLogIpc, setMainWindow as setMainWindowForAnalysisLog } from './analysisLogWindow.js';
import { registerTuningIpc } from './tuningState.js';
import { registerGraphIpc } from './graph/graphIpc.js';
import { registerMemoryMapIpc } from './memoryMap/memoryMapIpc.js';
import { registerRomFolderIpc } from './romFolder/romFolderIpc.js';
import { setMainWindow as setMainWindowForTuning } from './tuningWindow.js';
import { registerMemoryMapWindowIpc, setMainWindow as setMainWindowForMemoryMap } from './memoryMapWindow.js';
import { setMainWindow as setMainWindowForGraph } from './graphWindow.js';
import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowState } from './windowState.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let win;

async function createWindow() {
  const { bounds, maximized } = await getInitialWindowState('main', { width: 1100, height: 800 });

  win = new BrowserWindow({
    ...bounds,
    title: 'Nesviz',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  });

  applyMaximizedIfNeeded(win, maximized);
  attachSaveOnClose(win, 'main');

  const devUrl = process.env.VITE_DEV_SERVER_URL || process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    const htmlPath = path.join(__dirname, '../renderer/index.html');
    win.loadFile(htmlPath).catch((err) => {
      console.error('Failed to load renderer HTML:', htmlPath, err);
      dialog.showErrorBox(
        'Renderer build not found',
        'Could not load the renderer HTML. If you are developing, run: npm run dev. If you are running a production build, run: npm run build then npm start.'
      );
    });
  }
}

app.whenReady().then(async () => {
  await ensureUserDataLoaded();
  const recentRoms = await getRecentRomPaths();
  ipcMain.handle('nesviz:copyText', async (_evt, { text }) => {
    const value = typeof text === 'string' ? text : String(text ?? '');
    clipboard.writeText(value);
    return { ok: true };
  });
  registerAnalysisIpc();
  registerCodeViewIpc({ getActiveState: getActiveAnalysisState });
  registerRomFeaturesIpc({ getActiveState: getActiveAnalysisState });
  registerTraceStreamerIpc();
  registerRomListIpc();
  registerPreferencesIpc();
  registerLabelsIpc();
  registerMemoryMapWindowIpc();
  registerAnalysisLogIpc();
  registerTuningIpc();
  // Markov is parked for now; leave its handlers unregistered until the feature is reworked.
  // registerMarkovIpc({ getActiveState: getActiveAnalysisState });
  registerGraphIpc({ getActiveState: getActiveAnalysisState });
  // Heatmap is parked for now; leave its handlers unregistered until the feature is reworked.
  // registerHeatmapIpc({ getActiveState: getActiveAnalysisState });
  registerMemoryMapIpc({ getActiveState: getActiveAnalysisState });
  registerRomFolderIpc();
  registerMenuSettingsIpc();
  await createWindow();
  setMainWindowForRomList(win);
  setMainWindowForPreferences(win);
  setMainWindowForLabels(win);
  setMainWindowForTraceStreamer(win);
  setMainWindowForAnalysisLog(win);
  setMainWindowForTuning(win);
  // setMainWindowForMarkov(win);
  // setMainWindowForMarkovMap(win);
  setMainWindowForMemoryMap(win);
  // setMainWindowForHeatmap(win);
  setMainWindowForGraph(win);
  installAppMenu({ win, recentRoms });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

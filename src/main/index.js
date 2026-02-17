import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerAnalysisIpc } from './analysisIpc.js';
import { installAppMenu } from './menu.js';
import { ensureUserDataLoaded, getRecentRomPaths } from './userDataStore.js';
import { registerRomListIpc, setMainWindow as setMainWindowForRomList } from './romListWindow.js';
import { registerLabelsIpc, setMainWindow as setMainWindowForLabels } from './labelsWindow.js';
import { setMainWindow as setMainWindowForTraceStreamer } from './traceStreamerWindow.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  });

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
  registerAnalysisIpc();
  registerRomListIpc();
  registerLabelsIpc();
  createWindow();
  setMainWindowForRomList(win);
  setMainWindowForLabels(win);
  setMainWindowForTraceStreamer(win);
  installAppMenu({ win, recentRoms });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

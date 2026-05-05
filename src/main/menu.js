import { Menu } from 'electron';
import path from 'node:path';
import { showRomListWindow } from './romListWindow.js';
import { showPreferencesWindow } from './preferencesWindow.js';
import { showLabelsWindow } from './labelsWindow.js';
import { showTraceStreamerWindow } from './traceStreamer/traceStreamerWindow.js';
import { showAnalysisLogWindow } from './analysisLogWindow.js';
import { showTuningWindow } from './tuningWindow.js';
import { showMemoryMapWindow } from './memoryMapWindow.js';
import { showHeatmapWindow } from './heatmapWindow.js';
import { showGraphWindow } from './graphWindow.js';
import { showMarkovWindow } from './markov/markovWindow.js';
import { showMarkovMapWindow } from './markov/markovMapWindow.js';

let currentWin = null;
let currentRecentRoms = [];
let currentShowDebugInfo = false;

function buildTemplate({ win, recentRoms }) {
  const devUrl = process.env.VITE_DEV_SERVER_URL || process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL;
  const isDev = !!devUrl;
  const openRecentSubmenu = (recentRoms && recentRoms.length)
    ? recentRoms.slice(0, 10).map((filepath) => ({
        label: path.basename(filepath),
        click: () => {
          if (!win || win.isDestroyed()) return;
          win.webContents.send('nesviz:menuOpenRecentRom', { filepath });
        }
      }))
    : [{ label: '(No recent ROMs)', enabled: false }];

  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open ROM…',
          accelerator: 'CommandOrControl+O',
          click: () => {
            if (!win || win.isDestroyed()) return;
            win.webContents.send('nesviz:menuOpenRom');
          }
        },
        {
          label: 'Open recent',
          submenu: openRecentSubmenu
        },
        {
          label: 'Open ROM Folder…',
          accelerator: 'CommandOrControl+Shift+F',
          click: () => {
            showRomListWindow({ selectFolder: true });
          }
        },
        {
          label: 'Open CDL…',
          accelerator: 'CommandOrControl+Shift+O',
          click: () => {
            if (!win || win.isDestroyed()) return;
            win.webContents.send('nesviz:menuOpenCdl');
          }
        },
        {
          label: 'Preferences…',
          click: () => {
            showPreferencesWindow();
          }
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: []
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'ROM List',
          accelerator: 'CommandOrControl+L',
          click: () => {
            showRomListWindow();
          }
        },
        {
          label: 'Labels',
          click: () => {
            showLabelsWindow();
          }
        },
        {
          label: 'Memory Map',
          click: () => {
            showMemoryMapWindow();
          }
        },
        {
          label: 'Graph',
          click: () => {
            showGraphWindow();
          }
        },
        {
          label: 'Heatmap',
          click: () => {
            showHeatmapWindow();
          }
        }
      ]
    },
    {
      label: 'Connect',
      submenu: [
        {
          label: 'Connect to emulator',
          click: () => {
            showTraceStreamerWindow();
          }
        }
      ]
    },
  ];

  const debugSubmenu = [
    {
      label: 'Show debug info',
      type: 'checkbox',
      checked: !!currentShowDebugInfo,
      click: (menuItem) => {
        currentShowDebugInfo = !!menuItem?.checked;
        if (!win || win.isDestroyed()) return;
        win.webContents.send('nesviz:menuSetShowDebugInfo', { checked: currentShowDebugInfo });
      }
    },
    {
      label: 'Analysis log',
      click: () => {
        showAnalysisLogWindow();
      }
    },
    {
      label: 'Tuning',
      click: () => {
        showTuningWindow();
      }
    },
    {
      label: 'Markov',
      click: () => {
        showMarkovWindow();
      }
    },
    {
      label: 'Markov map',
      click: () => {
        showMarkovMapWindow();
      }
    }
  ];

  if (isDev) {
    debugSubmenu.push({ type: 'separator' });
    debugSubmenu.push({
      label: 'Open DevTools',
      accelerator: 'CommandOrControl+Shift+I',
      click: () => {
        if (!win || win.isDestroyed()) return;
        // Keep devtools in a separate window so it doesn't steal layout space.
        win.webContents.openDevTools({ mode: 'detach' });
      }
    });
  }

  template.push({
    label: 'Debug',
    submenu: debugSubmenu
  });

  // On macOS, add the application menu to match platform conventions.
  if (process.platform === 'darwin') {
    template.unshift({
      label: 'NesViz',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  return template;
}

function rebuildMenu() {
  if (!currentWin || currentWin.isDestroyed()) return;
  const template = buildTemplate({ win: currentWin, recentRoms: currentRecentRoms });
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

export function installAppMenu({ win, recentRoms = [] }) {
  currentWin = win;
  currentRecentRoms = Array.isArray(recentRoms) ? recentRoms.slice(0, 10) : [];
  rebuildMenu();
}

export function updateRecentRoms(recentRoms) {
  currentRecentRoms = Array.isArray(recentRoms) ? recentRoms.slice(0, 10) : [];
  rebuildMenu();
}

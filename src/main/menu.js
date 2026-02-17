import { Menu } from 'electron';
import path from 'node:path';
import { showRomListWindow } from './romListWindow.js';
import { showLabelsWindow } from './labelsWindow.js';
import { showTraceStreamerWindow } from './traceStreamerWindow.js';

let currentWin = null;
let currentRecentRoms = [];

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
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'View ROM list',
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
    {
      role: 'help',
      submenu: [
        {
          label: 'About NesViz',
          click: () => {
            // Keep it simple for now; macOS uses the standard app menu About item.
            if (!win || win.isDestroyed()) return;
            win.webContents.send('nesviz:menuShowAbout');
          }
        }
      ]
    }
  ];

  // Dev-only Debug menu (shown only when running via the dev server URL).
  if (isDev) {
    template.push({
      label: 'Debug',
      submenu: [
        {
          label: 'Open DevTools',
          accelerator: 'CommandOrControl+Shift+I',
          click: () => {
            if (!win || win.isDestroyed()) return;
            // Keep devtools in a separate window so it doesn't steal layout space.
            win.webContents.openDevTools({ mode: 'detach' });
          }
        }
      ]
    });
  }

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

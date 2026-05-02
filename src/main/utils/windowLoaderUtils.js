import path from 'node:path';

export function getDevRendererUrl() {
  return (
    process.env.VITE_DEV_SERVER_URL
    || process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL
    || process.env.ELECTRON_RENDERER_URL
    || null
  );
}

export function loadRendererWindow(win, htmlFile, dirname) {
  const devUrl = getDevRendererUrl();
  if (devUrl) {
    const base = devUrl.replace(/\/+$/, '');
    win.loadURL(`${base}/${htmlFile}`);
    return;
  }

  const htmlPath = path.join(dirname, '../renderer', htmlFile);
  win.loadFile(htmlPath);
}

export function attachDevToolsShortcut(win) {
  const isDev = !!getDevRendererUrl();
  if (!isDev) return;

  win.webContents.on('before-input-event', (event, input) => {
    const key = String(input?.key || '').toLowerCase();
    const hasPrimaryModifier = process.platform === 'darwin' ? !!input?.meta : !!input?.control;
    const hasShift = !!input?.shift;

    if (hasPrimaryModifier && hasShift && key === 'i') {
      event.preventDefault();
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });
}

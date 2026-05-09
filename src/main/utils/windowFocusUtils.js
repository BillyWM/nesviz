export function showAndFocusWindow(win) {
  if (!win || win.isDestroyed()) return false;

  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();

    if (win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.focus();
    }

    return true;
  } catch {
    return false;
  }
}

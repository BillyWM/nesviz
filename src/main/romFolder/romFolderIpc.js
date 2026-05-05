import { dialog, ipcMain } from 'electron';

import { normalizeFolderPaths } from '../utils/folderPathUtils.js';
import { registerRomFolderScanIpc } from './romFolderScanIpc.js';

export function registerRomFolderIpc() {
  ipcMain.handle('nesviz:selectRomFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select ROM Folders',
      properties: ['openDirectory', 'multiSelections']
    });
    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, canceled: true };
    }
    const folderPaths = normalizeFolderPaths(result.filePaths);
    if (!folderPaths.length) return { ok: false, canceled: true };
    return { ok: true, folderPaths };
  });

  registerRomFolderScanIpc();
}

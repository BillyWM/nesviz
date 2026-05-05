import { ipcMain } from 'electron';

import { getRomFolderCacheForRenderer, scanRomFolders } from './romFolderScan.js';

const activeScans = new Map();

function closePort(port) {
  try { port?.close?.(); } catch {}
}

function abortScan(token) {
  const scan = activeScans.get(token);
  if (!scan) return;
  activeScans.delete(token);
  try { scan.controller.abort(); } catch {}
  closePort(scan.port);
}

function postToPort(port, payload) {
  try {
    port.postMessage(payload);
    return true;
  } catch {
    return false;
  }
}

export function registerRomFolderScanIpc() {
  ipcMain.handle('nesviz:getRomFolderCache', async () => getRomFolderCacheForRenderer());

  ipcMain.on('nesviz:romFolderScan:start', (evt, payload = {}) => {
    const port = evt.ports?.[0];
    const token = typeof payload?.token === 'string' ? payload.token : '';
    if (!port || !token) {
      closePort(port);
      return;
    }

    abortScan(token);

    const controller = new AbortController();
    activeScans.set(token, { controller, port });

    port.on('close', () => {
      const active = activeScans.get(token);
      if (!active || active.port !== port) return;
      activeScans.delete(token);
      try { controller.abort(); } catch {}
    });
    port.start();

    void (async () => {
      try {
        for await (const event of scanRomFolders({
          folderPaths: payload.folderPaths,
          force: !!payload.force,
          signal: controller.signal
        })) {
          if (controller.signal.aborted) return;
          if (!postToPort(port, event)) return;
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          postToPort(port, { type: 'error', message: err?.message ?? String(err) });
        }
      } finally {
        const active = activeScans.get(token);
        if (active?.port === port) activeScans.delete(token);
        closePort(port);
      }
    })();
  });

  ipcMain.on('nesviz:romFolderScan:cancel', (_evt, payload = {}) => {
    const token = typeof payload?.token === 'string' ? payload.token : '';
    if (!token) return;
    abortScan(token);
  });
}

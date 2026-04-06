import { BrowserWindow, ipcMain } from 'electron';
import { createTraceStreamerClient } from './traceStreamerClient.js';

let registered = false;
let latestStatus = null;

function broadcastStatus(status) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win || win.isDestroyed()) continue;
      win.webContents.send('nesviz:traceStreamer:status', status);
    } catch {
      // Ignore windows without a webContents, or in the middle of teardown.
    }
  }
}

const client = createTraceStreamerClient({
  onStatus: (status) => {
    latestStatus = status;
    broadcastStatus(status);
  }
});

export function registerTraceStreamerIpc() {
  if (registered) return;
  registered = true;

  latestStatus = client.getStatus();

  ipcMain.handle('nesviz:traceStreamer:getStatus', () => {
    return latestStatus || client.getStatus();
  });

  ipcMain.handle('nesviz:traceStreamer:connect', async () => {
    const res = await client.connect();
    return res;
  });

  ipcMain.handle('nesviz:traceStreamer:disconnect', () => {
    return client.disconnect();
  });
}

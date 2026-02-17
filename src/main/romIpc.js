import { dialog } from 'electron';
import fs from 'node:fs/promises';
import { parseInes, readVectorsFromLastPrgBank } from '../shared/rom/ines.js';

export function registerRomIpc(ipcMain) {
  ipcMain.handle('rom:openAndAnalyze', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Open NES ROM',
      properties: ['openFile'],
      filters: [
        { name: 'NES ROMs', extensions: ['nes'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });

    if (res.canceled || !res.filePaths?.[0]) return { canceled: true };

    const path = res.filePaths[0];
    const buf = await fs.readFile(path);

    const rom = parseInes(buf);
    const vectors = readVectorsFromLastPrgBank(rom.prg);

    return {
      canceled: false,
      path,
      rom: {
        format: rom.format,
        prgBanks16k: rom.prgBanks16k,
        chrBanks8k: rom.chrBanks8k,
        mapper: rom.mapper,
        mirroring: rom.mirroring,
        hasTrainer: rom.hasTrainer,
        prgSize: rom.prgSize,
        chrSize: rom.chrSize
      },
      vectors
    };
  });
}

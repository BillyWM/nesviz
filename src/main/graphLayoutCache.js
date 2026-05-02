import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import v8 from 'node:v8';

import { getSafeRomHash } from '../shared/utils/cacheKeyUtils.js';

function getGraphLayoutCacheDir() {
  return path.join(app.getPath('userData'), 'graph-layout-cache');
}

export function getGraphLayoutCachePath(romHash) {
  return path.join(getGraphLayoutCacheDir(), `${getSafeRomHash(romHash, 'graph layout cache')}.bin`);
}

export async function loadGraphLayoutCache(romHash) {
  const filePath = getGraphLayoutCachePath(romHash);
  const buf = await fs.readFile(filePath);
  return v8.deserialize(buf);
}

export async function saveGraphLayoutCache(romHash, payload) {
  const dir = getGraphLayoutCacheDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = getGraphLayoutCachePath(romHash);
  const buf = v8.serialize(payload);
  await fs.writeFile(filePath, buf);
  return filePath;
}

export async function deleteGraphLayoutCache(romHash) {
  const filePath = getGraphLayoutCachePath(romHash);
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

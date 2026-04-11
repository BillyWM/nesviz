import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import v8 from 'node:v8';

function getAnalysisCacheDir() {
  return path.join(app.getPath('userData'), 'analysis-cache');
}

function getSafeRomHash(romHash) {
  const hash = String(romHash || '').trim();
  if (!hash) throw new Error('Missing ROM hash for analysis cache');
  return hash.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function getAnalysisCachePath(romHash) {
  return path.join(getAnalysisCacheDir(), `${getSafeRomHash(romHash)}.bin`);
}

export async function loadAnalysisCache(romHash) {
  const filePath = getAnalysisCachePath(romHash);
  const buf = await fs.readFile(filePath);
  return v8.deserialize(buf);
}

export async function saveAnalysisCache(romHash, payload) {
  const dir = getAnalysisCacheDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = getAnalysisCachePath(romHash);
  const buf = v8.serialize(payload);
  await fs.writeFile(filePath, buf);
  return filePath;
}

import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import v8 from 'node:v8';
import { gzip, gunzip } from 'node:zlib';

import { getSafeRomHash } from '../shared/utils/cacheKeyUtils.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

function getAnalysisCacheDir() {
  return path.join(app.getPath('userData'), 'analysis-cache');
}

export function getAnalysisCachePath(romHash) {
  return path.join(getAnalysisCacheDir(), `${getSafeRomHash(romHash, 'analysis cache')}.bin.gz`);
}

export async function hasAnalysisCache(romHash) {
  const filePath = getAnalysisCachePath(romHash);
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

export async function loadAnalysisCache(romHash) {
  const filePath = getAnalysisCachePath(romHash);
  const compressed = await fs.readFile(filePath);
  const buf = await gunzipAsync(compressed);
  return v8.deserialize(buf);
}

export async function saveAnalysisCache(romHash, payload) {
  const dir = getAnalysisCacheDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = getAnalysisCachePath(romHash);
  const buf = v8.serialize(payload);
  const compressed = await gzipAsync(buf);
  await fs.writeFile(filePath, compressed);
  return filePath;
}

export async function deleteAnalysisCache(romHash) {
  const filePath = getAnalysisCachePath(romHash);
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}


export async function listAnalysisCacheFiles() {
  const dir = getAnalysisCacheDir();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry?.isFile?.() && entry.name.toLowerCase().endsWith('.bin.gz'))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

export async function loadAnalysisCacheFromPath(filePath) {
  const compressed = await fs.readFile(filePath);
  const buf = await gunzipAsync(compressed);
  return v8.deserialize(buf);
}

export async function getAnalysisCacheStats() {
  const files = await listAnalysisCacheFiles();
  let bytes = 0;

  for (const filePath of files) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) bytes += stat.size;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  return {
    gameCount: files.length,
    bytes,
    mb: bytes / (1024 * 1024)
  };
}

export async function clearAnalysisCache() {
  const files = await listAnalysisCacheFiles();

  for (const filePath of files) {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  return getAnalysisCacheStats();
}

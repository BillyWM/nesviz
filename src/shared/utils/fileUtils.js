import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzip as gzipBuffer, gunzip as gunzipBuffer } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzipBuffer);
const gunzipAsync = promisify(gunzipBuffer);

export function pathExists(p) {
  return fs.access(p).then(() => true).catch(() => false);
}

export async function resolveProjectRoot() {
  const candidates = [];
  const appPath = app.getAppPath();
  if (appPath) candidates.push(appPath);
  candidates.push(process.cwd());

  for (const base of candidates) {
    if (!base) continue;
    let current = path.resolve(base);
    for (let depth = 0; depth < 6; depth += 1) {
      const packageJson = path.join(current, 'package.json');
      const srcDir = path.join(current, 'src', 'shared', 'analyze');
      if ((await pathExists(packageJson)) && (await pathExists(srcDir))) {
        return current;
      }
      const parent = path.dirname(current);
      if (!parent || parent === current) break;
      current = parent;
    }
  }

  return path.resolve(process.cwd());
}

export function buildGzipJsonPath(dir, basename) {
  return path.join(dir, `${basename}.json.gz`);
}

export function buildPlainJsonPath(dir, basename) {
  return path.join(dir, `${basename}.json`);
}

export async function writeGzipJson(filePath, value) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  const compressed = await gzipAsync(Buffer.from(json, 'utf8'));
  await fs.writeFile(filePath, compressed);
}

export async function readMaybeGzipJson(gzipPath, plainPath) {
  if (await pathExists(gzipPath)) {
    const compressed = await fs.readFile(gzipPath);
    const txt = (await gunzipAsync(compressed)).toString('utf8');
    return JSON.parse(txt);
  }
  const txt = await fs.readFile(plainPath, 'utf8');
  return JSON.parse(txt);
}

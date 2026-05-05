import fs from 'node:fs/promises';
import path from 'node:path';

import { buildGzipJsonPath, buildPlainJsonPath, readMaybeGzipJson, resolveProjectRoot, writeGzipJson } from '../../shared/utils/fileUtils.js';

function normalizeSource(source) {
  return source === 'probablePlus' ? 'probable-plus' : 'confirmed';
}

function normalizeFamily(family) {
  if (family === 'mnemonic') return 'mnemonic';
  if (family === 'addressing') return 'addressing';
  return 'opcode';
}

export async function getMarkovArtifactDir() {
  const root = await resolveProjectRoot();
  const dir = path.join(root, 'src', 'shared', 'analyze', 'markov', 'trained');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function saveMarkovModel(model, source, family) {
  const dir = await getMarkovArtifactDir();
  const basename = `${normalizeFamily(family)}-markov.${normalizeSource(source)}`;
  const filePath = buildGzipJsonPath(dir, basename);
  await writeGzipJson(filePath, model);
  return filePath;
}

export async function getMarkovModelPath(source, family) {
  const dir = await getMarkovArtifactDir();
  const basename = `${normalizeFamily(family)}-markov.${normalizeSource(source)}`;
  return buildGzipJsonPath(dir, basename);
}

export async function loadMarkovModel(source, family) {
  const dir = await getMarkovArtifactDir();
  const basename = `${normalizeFamily(family)}-markov.${normalizeSource(source)}`;
  return readMaybeGzipJson(buildGzipJsonPath(dir, basename), buildPlainJsonPath(dir, basename));
}

export async function saveCombinedCodeProfile(profile, source) {
  const dir = await getMarkovArtifactDir();
  const basename = `combined-code-profile.${normalizeSource(source)}`;
  const filePath = buildGzipJsonPath(dir, basename);
  await writeGzipJson(filePath, profile);
  return filePath;
}

export async function getCombinedCodeProfilePath(source) {
  const dir = await getMarkovArtifactDir();
  const basename = `combined-code-profile.${normalizeSource(source)}`;
  return buildGzipJsonPath(dir, basename);
}

export async function loadCombinedCodeProfile(source) {
  const dir = await getMarkovArtifactDir();
  const basename = `combined-code-profile.${normalizeSource(source)}`;
  return readMaybeGzipJson(buildGzipJsonPath(dir, basename), buildPlainJsonPath(dir, basename));
}

export async function saveOpcodeMarkovModel(model, source) {
  return saveMarkovModel(model, source, 'opcode');
}
export async function getOpcodeMarkovModelPath(source) {
  return getMarkovModelPath(source, 'opcode');
}
export async function loadOpcodeMarkovModel(source) {
  return loadMarkovModel(source, 'opcode');
}
export async function saveOpcodeCodeProfile(profile, source) {
  return saveCombinedCodeProfile(profile, source);
}
export async function getOpcodeCodeProfilePath(source) {
  return getCombinedCodeProfilePath(source);
}
export async function loadOpcodeCodeProfile(source) {
  return loadCombinedCodeProfile(source);
}

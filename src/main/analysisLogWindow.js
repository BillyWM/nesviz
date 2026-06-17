import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analysisLogGroupKey,
  analysisLogPhaseKey,
  buildAnalysisLogOutline
} from '../shared/analyze2/analysisLogOutline.js';
import {
  ANALYSIS_PHASE_GROUPS,
  ANALYSIS_PROGRESS_DETAIL_KINDS,
  ANALYSIS_PROGRESS_MESSAGE_KINDS
} from '../shared/analyze2/analysisConstants.js';
import { createDefaultAnalysisPlan } from './analyze2/analysisPlan.js';
import { applyMaximizedIfNeeded, attachSaveOnClose, getInitialWindowStateSync } from './windowState.js';
import { loadRendererWindow } from './utils/windowLoaderUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let analysisLogWindow = null;
let analysisLogProgressState = createEmptyProgressState();

function createEmptyProgressState() {
  return {
    phaseStates: {},
    phaseElapsedMs: {},
    phaseRounds: {},
    phaseDetails: {},
    currentKey: null,
    currentGroupId: null
  };
}

function cloneProgressState() {
  return {
    phaseStates: { ...analysisLogProgressState.phaseStates },
    phaseElapsedMs: { ...analysisLogProgressState.phaseElapsedMs },
    phaseRounds: { ...analysisLogProgressState.phaseRounds },
    phaseDetails: { ...analysisLogProgressState.phaseDetails },
    currentKey: analysisLogProgressState.currentKey,
    currentGroupId: analysisLogProgressState.currentGroupId
  };
}

function sendToAnalysisLogWindow(message) {
  if (!analysisLogWindow || analysisLogWindow.isDestroyed()) return;
  try { analysisLogWindow.webContents.send('nesviz:vsaProgress', message); } catch {}
}

function phaseMessageLogKey(message) {
  const phaseId = typeof message?.phaseId === 'string' && message.phaseId ? message.phaseId : null;
  if (!phaseId) return null;

  const groupId = typeof message.groupId === 'string' && message.groupId ? message.groupId : null;
  if (groupId) return analysisLogPhaseKey(phaseId, groupId);
  if (ANALYSIS_PHASE_GROUPS[phaseId]) return analysisLogGroupKey(phaseId);
  return analysisLogPhaseKey(phaseId);
}

function groupMessageLogKey(message) {
  const groupId = typeof message?.groupId === 'string' && message.groupId ? message.groupId : null;
  return groupId ? analysisLogGroupKey(groupId) : null;
}

function normalizeProgressMessage(message) {
  if (!message || typeof message !== 'object') return message;
  const kind = message.kind;
  if (
    kind !== ANALYSIS_PROGRESS_MESSAGE_KINDS.PHASE_STARTED &&
    kind !== ANALYSIS_PROGRESS_MESSAGE_KINDS.PHASE_COMPLETE &&
    kind !== ANALYSIS_PROGRESS_MESSAGE_KINDS.PHASE_PROGRESS
  ) {
    return message;
  }

  const logKey = phaseMessageLogKey(message);
  if (!logKey) return message;
  const groupLogKey = groupMessageLogKey(message);
  return groupLogKey ? { ...message, logKey, groupLogKey } : { ...message, logKey };
}

function applyElapsed(logKey, elapsedMs) {
  if (!logKey || typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) return;
  analysisLogProgressState.phaseElapsedMs[logKey] = elapsedMs;
}

function applyRound(logKey, message) {
  if (!logKey || !message || typeof message !== 'object') return;
  if (typeof message.groupId !== 'string' || !message.groupId) return;
  if (!Number.isInteger(message.groupIteration) || message.groupIteration <= 0) return;
  analysisLogProgressState.phaseRounds[logKey] = message.groupIteration;
}

function mergeAbstractInterpretationDetails(previous, details) {
  const mode = typeof details.mode === 'string' && details.mode ? details.mode : null;
  const next = previous && typeof previous === 'object' ? { ...previous } : {};
  next.current = { ...details };
  if (mode === 'widening') next.widening = { ...details };
  if (mode === 'narrowing') next.narrowing = { ...details };
  return next;
}

function applyDetails(logKey, message) {
  if (!logKey || !message || typeof message !== 'object') return;
  if (typeof message.detailKind !== 'string' || !message.detailKind) return;
  if (!message.details || typeof message.details !== 'object') return;

  const previous = analysisLogProgressState.phaseDetails[logKey];
  if (message.detailKind === ANALYSIS_PROGRESS_DETAIL_KINDS.ABSTRACT_INTERPRETATION) {
    analysisLogProgressState.phaseDetails[logKey] = {
      detailKind: message.detailKind,
      details: mergeAbstractInterpretationDetails(previous?.details, message.details)
    };
    return;
  }

  analysisLogProgressState.phaseDetails[logKey] = {
    detailKind: message.detailKind,
    details: { ...message.details }
  };
}

function applyGroupProgress(message) {
  const groupLogKey = typeof message.groupLogKey === 'string' && message.groupLogKey ? message.groupLogKey : groupMessageLogKey(message);
  if (!groupLogKey) return;
  if (message.kind === ANALYSIS_PROGRESS_MESSAGE_KINDS.PHASE_STARTED) {
    analysisLogProgressState.phaseStates[groupLogKey] = 'running';
  }
  if (typeof message.groupElapsedMs === 'number') applyElapsed(groupLogKey, message.groupElapsedMs);
}

function applyProgressMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.kind === ANALYSIS_PROGRESS_MESSAGE_KINDS.ANALYSIS_RESET) {
    analysisLogProgressState = createEmptyProgressState();
    return;
  }

  const logKey = typeof message.logKey === 'string' && message.logKey ? message.logKey : phaseMessageLogKey(message);
  if (!logKey) return;

  applyGroupProgress(message);
  applyElapsed(logKey, message.elapsedMs);
  applyRound(logKey, message);
  applyDetails(logKey, message);

  if (message.kind === ANALYSIS_PROGRESS_MESSAGE_KINDS.PHASE_STARTED) {
    analysisLogProgressState.phaseStates[logKey] = 'running';
    analysisLogProgressState.currentKey = logKey;
    analysisLogProgressState.currentGroupId = typeof message.groupId === 'string' && message.groupId ? message.groupId : null;
    return;
  }

  if (message.kind === ANALYSIS_PROGRESS_MESSAGE_KINDS.PHASE_PROGRESS) {
    return;
  }

  if (message.kind === ANALYSIS_PROGRESS_MESSAGE_KINDS.PHASE_COMPLETE) {
    analysisLogProgressState.phaseStates[logKey] = 'complete';
    if (analysisLogProgressState.currentKey === logKey) analysisLogProgressState.currentKey = null;
    if (!message.groupId && ANALYSIS_PHASE_GROUPS[message.phaseId]) analysisLogProgressState.currentGroupId = null;
  }
}

export function setMainWindow(win) {
  mainWindow = win;
}

export function resetAnalysisLogProgressState() {
  const message = { kind: ANALYSIS_PROGRESS_MESSAGE_KINDS.ANALYSIS_RESET };
  applyProgressMessage(message);
  sendToAnalysisLogWindow(message);
  return message;
}

export function receiveAnalysisProgressMessage(message) {
  const normalized = normalizeProgressMessage(message || {});
  applyProgressMessage(normalized);
  sendToAnalysisLogWindow(normalized);
  return normalized;
}

export function showAnalysisLogWindow() {
  if (analysisLogWindow && !analysisLogWindow.isDestroyed()) {
    analysisLogWindow.show();
    analysisLogWindow.focus();
    return;
  }

  const { bounds, maximized } = getInitialWindowStateSync('analysislog', { width: 760, height: 560 });

  analysisLogWindow = new BrowserWindow({
    ...bounds,
    parent: mainWindow || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true
    }
  });

  analysisLogWindow.setTitle('Analysis Log');
  applyMaximizedIfNeeded(analysisLogWindow, maximized);
  attachSaveOnClose(analysisLogWindow, 'analysislog');

  try {
    analysisLogWindow.setMenu(null);
    analysisLogWindow.setMenuBarVisibility(false);
  } catch {
    // Ignore.
  }

  analysisLogWindow.on('closed', () => {
    analysisLogWindow = null;
  });

  loadRendererWindow(analysisLogWindow, 'analysislog.html', __dirname);
}

export function registerAnalysisLogIpc() {
  ipcMain.handle('nesviz:showAnalysisLog', async () => {
    showAnalysisLogWindow();
    return { ok: true };
  });

  ipcMain.handle('nesviz:getAnalysisLogOutline', async () => {
    const plan = createDefaultAnalysisPlan();
    return {
      ok: true,
      outline: buildAnalysisLogOutline(plan),
      progressState: cloneProgressState()
    };
  });
}

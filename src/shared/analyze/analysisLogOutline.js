import {
  ANALYSIS_PHASE_GROUP_LABELS,
  ANALYSIS_PHASE_GROUPS,
  ANALYSIS_PHASE_LABELS
} from './analysisConstants.js';
import { requireArray, requireObject, requireString } from './dataShape.js';

export function analysisLogGroupKey(groupId) {
  const id = requireString(groupId, 'analysis log group id');
  return `group:${id}`;
}

export function analysisLogPhaseKey(phaseId, groupId = null) {
  const id = requireString(phaseId, 'analysis log phase id');
  if (groupId === null || groupId === undefined) return `phase:${id}`;
  const group = requireString(groupId, 'analysis log phase group id');
  return `group:${group}:phase:${id}`;
}

function explicitLabel(value, label) {
  if (value === undefined) return null;
  const text = requireString(value, label).trim();
  if (!text) throw new Error(`${label} must not be empty`);
  return text;
}

function phaseLabelFor(entry, label) {
  const id = requireString(entry.id, `${label}.id`);
  const customLabel = explicitLabel(entry.label, `${label}.label`);
  if (customLabel) return customLabel;

  const displayLabel = ANALYSIS_PHASE_LABELS[id];
  if (!displayLabel) throw new Error(`Analysis phase ${id} is missing a display label`);
  return displayLabel;
}

function groupLabelFor(entry, label) {
  const id = requireString(entry.group, `${label}.group`);
  const customLabel = explicitLabel(entry.label, `${label}.label`);
  if (customLabel) return customLabel;

  const displayLabel = ANALYSIS_PHASE_GROUP_LABELS[id];
  if (!displayLabel) throw new Error(`Analysis phase group ${id} is missing a display label`);
  return displayLabel;
}

function buildPhaseOutline(entry, label, groupId = null) {
  requireObject(entry, label);
  const id = requireString(entry.id, `${label}.id`);
  return {
    kind: 'phase',
    id,
    key: analysisLogPhaseKey(id, groupId),
    label: phaseLabelFor(entry, label)
  };
}

function buildGroupOutline(entry, label) {
  requireObject(entry, label);
  const id = requireString(entry.group, `${label}.group`);
  const groupSpec = ANALYSIS_PHASE_GROUPS[id];
  if (!groupSpec) throw new Error(`Unknown analysis phase group: ${id}`);

  const phases = requireArray(groupSpec.phases, `analysis phase group ${id}.phases`)
    .map((phaseEntry, index) => buildPhaseOutline(phaseEntry, `analysis phase group ${id}.phases[${index}]`, id));

  return {
    kind: 'group',
    id,
    key: analysisLogGroupKey(id),
    label: groupLabelFor(entry, label),
    phases
  };
}

export function buildAnalysisLogOutline(plan) {
  requireObject(plan, 'analysis plan');
  const entries = requireArray(plan.phases, 'analysis plan.phases');

  return entries.map((entry, index) => {
    requireObject(entry, `analysis plan.phases[${index}]`);
    const hasId = Object.prototype.hasOwnProperty.call(entry, 'id');
    const hasGroup = Object.prototype.hasOwnProperty.call(entry, 'group');
    if (hasId === hasGroup) throw new Error(`analysis plan.phases[${index}] must specify exactly one of id or group`);

    if (hasId) return buildPhaseOutline(entry, `analysis plan.phases[${index}]`);
    return buildGroupOutline(entry, `analysis plan.phases[${index}]`);
  });
}

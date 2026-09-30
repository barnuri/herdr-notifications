'use strict';

const { resolveNotifyRule } = require('./notify-rules');

// Named notifyOn combinations, exposed as a single cycling herdr action so the
// common cases don't require hand-editing config.json. Order is the cycle order.
const PRESETS = Object.freeze([
  Object.freeze({
    id: 'all',
    title: 'All notifications',
    summary: 'blocked 🔴 + idle 🟡 + done 🟢',
    notifyOn: Object.freeze({ idle: true, blocked: true, done: true }),
  }),
  Object.freeze({
    id: 'needs-me',
    title: 'Only when I am needed',
    summary: 'blocked 🔴 + idle 🟡',
    notifyOn: Object.freeze({ idle: true, blocked: true, done: false }),
  }),
  Object.freeze({
    id: 'blocked-only',
    title: 'Only blocked',
    summary: 'blocked 🔴',
    notifyOn: Object.freeze({ idle: false, blocked: true, done: false }),
  }),
]);

const CUSTOM_PRESET_ID = 'custom';

function findPreset(id) {
  return PRESETS.find((preset) => preset.id === id) || null;
}

// Returns the preset id whose notifyOn matches, or 'custom' for any hand-edited
// combination that isn't one of the presets (including all-off). A preset only
// describes which statuses are on, so the duration/focus rules a status also
// carries are deliberately not part of the match.
function matchPresetId(notifyOn) {
  const match = PRESETS.find((preset) =>
    Object.keys(preset.notifyOn).every((key) => resolveNotifyRule(notifyOn, key).enabled === preset.notifyOn[key]),
  );
  return match ? match.id : CUSTOM_PRESET_ID;
}

// Applies a preset to a *raw* config's notifyOn block. A preset toggles
// `enabled` and nothing else, so a status configured with the object form keeps
// its minWorkingMs / skipWhenFocused across a cycle — replacing the block
// outright would silently reset every threshold the user set.
function applyPresetToNotifyOn(rawNotifyOn, preset) {
  const raw = rawNotifyOn !== null && typeof rawNotifyOn === 'object' && !Array.isArray(rawNotifyOn) ? rawNotifyOn : {};
  const next = { ...raw };
  for (const [status, enabled] of Object.entries(preset.notifyOn)) {
    const existing = raw[status];
    const isDetailed = existing !== null && typeof existing === 'object' && !Array.isArray(existing);
    next[status] = isDetailed ? { ...existing, enabled } : enabled;
  }
  return next;
}

// A custom combination cycles back to the first preset rather than being
// nudged into an arbitrary neighbour.
function nextPreset(currentId) {
  const index = PRESETS.findIndex((preset) => preset.id === currentId);
  if (index === -1) {
    return PRESETS[0];
  }
  return PRESETS[(index + 1) % PRESETS.length];
}

module.exports = { PRESETS, CUSTOM_PRESET_ID, findPreset, matchPresetId, nextPreset, applyPresetToNotifyOn };

'use strict';

// Resolves a normalized `notifyOn` block into the per-status decision the
// notifier actually applies, and answers the one question it asks: should this
// event be sent?
//
// Tolerates the legacy flat shape (`{ idle: true }`) so a caller holding a
// hand-built or pre-migration config still works — a bare boolean carries no
// duration or focus rule, so it means "send it", exactly as it did before
// those knobs existed. Only the object shape opts into filtering.

const UNFILTERED_MIN_WORKING_MS = 0;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveNotifyRule(notifyOn, status) {
  const source = isPlainObject(notifyOn) ? notifyOn[status] : undefined;
  if (!isPlainObject(source)) {
    return {
      enabled: Boolean(source),
      minWorkingMs: UNFILTERED_MIN_WORKING_MS,
      skipWhenFocused: false,
    };
  }
  return {
    enabled: Boolean(source.enabled),
    minWorkingMs: Number.isFinite(source.minWorkingMs) ? source.minWorkingMs : UNFILTERED_MIN_WORKING_MS,
    skipWhenFocused: Boolean(source.skipWhenFocused),
  };
}

function isPaneFocused(event) {
  return Boolean(event && event.agent && event.agent.focused);
}

// A run shorter than the threshold is one the user is presumably still
// watching, so it is not worth a message. The span compared is the pane's most
// recent finished `working` run (`workingMs`), not the status it happened to
// pass through immediately before — `done` reached via `idle` must still be
// judged on the work that preceded the idle gap. An unmeasurable span (a pane
// first seen after the watcher's baseline, or one that never worked) is
// treated as "not long enough" rather than as zero-or-infinite, so a brand-new
// pane never produces a spurious ping the moment the watcher notices it.
function meetsDurationRule(rule, event) {
  if (rule.minWorkingMs <= UNFILTERED_MIN_WORKING_MS) {
    return true;
  }
  const workedMs = event ? event.workingMs : null;
  if (!Number.isFinite(workedMs)) {
    return false;
  }
  return workedMs >= rule.minWorkingMs;
}

function shouldNotify(notifyOn, event) {
  const rule = resolveNotifyRule(notifyOn, event && event.type);
  if (!rule.enabled) {
    return false;
  }
  if (rule.skipWhenFocused && isPaneFocused(event)) {
    return false;
  }
  return meetsDurationRule(rule, event);
}

module.exports = { UNFILTERED_MIN_WORKING_MS, resolveNotifyRule, shouldNotify };

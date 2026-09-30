'use strict';

class StateWatcher {
  static STATUS_IDLE = 'idle';
  static STATUS_WORKING = 'working';
  static STATUS_BLOCKED = 'blocked';
  static STATUS_DONE = 'done';

  // "from" sentinel for a pane seen for the first time AFTER the watcher
  // already has an established baseline — distinct from both `null` (used
  // only for the watcher's cold start / explicit reset(), which blanket-
  // suppresses everything to avoid a notification storm for pre-existing
  // agents) and from any real agent_status. This lets e.g. `blocked`/`done`
  // fire for a genuinely new pane that launches straight into that state
  // before its first poll — e.g. an agent whose very first blocked prompt is
  // a trust-folder dialog — while `idle` (which requires from===working)
  // still correctly stays silent for a pane that simply starts out idle.
  static UNKNOWN_PRIOR_STATUS = '__unknown__';

  // `previousStatusMs` on an event when the watcher never observed the pane
  // enter its previous status, so no span can be measured: a pane seen for
  // the first time after the baseline. Callers that filter on duration must
  // treat this as "unknown", never as zero — zero would read as an
  // instantaneous run and silently suppress every brand-new pane.
  static UNKNOWN_DURATION_MS = null;

  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this._lastByPane = new Map();
    this._hasBaseline = false;
  }

  // Explicit cold-start reset, distinct from an empty update([]) poll result:
  // the next update() call is treated exactly like the watcher's very first
  // one, blanket-suppressing events for every pane regardless of status —
  // this is what notifier.js calls while disabled/unconfigured, so
  // transitions during that window don't fire retroactively on re-enable.
  reset() {
    this._lastByPane = new Map();
    this._hasBaseline = false;
  }

  update(agents) {
    if (!Array.isArray(agents)) {
      return [];
    }
    const events = [];
    const observedAt = this._now();
    // Rebuild from scratch so panes that disappeared are dropped.
    const nextByPane = new Map();
    for (const agent of agents) {
      if (!agent || !agent.pane_id || !agent.agent_status) {
        continue;
      }
      const previous = this._previousEntry(agent.pane_id);
      const isSameStatus = previous !== null && previous.status === agent.agent_status;
      const previousStatusMs = StateWatcher._spanMs(previous, observedAt);
      const workingMs = StateWatcher._workingMs(previous, previousStatusMs, isSameStatus);
      // A pane that did not change status keeps its original entry time, so a
      // long `working` span is measured from when it actually started, not
      // from the most recent poll.
      nextByPane.set(agent.pane_id, {
        status: agent.agent_status,
        since: isSameStatus ? previous.since : observedAt,
        workingMs,
      });

      const from = previous === null ? null : previous.status;
      const type = StateWatcher.transitionType(from, agent.agent_status);
      if (type) {
        events.push({
          paneId: agent.pane_id,
          type,
          agent,
          previousStatus: from,
          previousStatusMs,
          workingMs,
        });
      }
    }
    this._lastByPane = nextByPane;
    this._hasBaseline = true;
    return events;
  }

  // Normalizes "what did this watcher last know about the pane" into either a
  // real entry, an unknown-prior placeholder, or null for a cold start.
  _previousEntry(paneId) {
    if (this._lastByPane.has(paneId)) {
      return this._lastByPane.get(paneId);
    }
    if (this._hasBaseline) {
      return { status: StateWatcher.UNKNOWN_PRIOR_STATUS, since: null, workingMs: StateWatcher.UNKNOWN_DURATION_MS };
    }
    return null;
  }

  // How long the pane's most recent finished `working` run lasted. Carried
  // across whatever the pane does next, because `done` does not have to follow
  // `working` directly — a pane that works for an hour, goes `idle`, then goes
  // `done` must still report the hour. Measuring only the immediately
  // preceding status would report the idle gap instead and suppress exactly
  // the long run a duration filter exists to surface.
  static _workingMs(previous, previousStatusMs, isSameStatus) {
    if (previous === null) {
      return StateWatcher.UNKNOWN_DURATION_MS;
    }
    if (previous.status !== StateWatcher.STATUS_WORKING) {
      return previous.workingMs === undefined ? StateWatcher.UNKNOWN_DURATION_MS : previous.workingMs;
    }
    // Still working: the run has not finished, so there is no span to report yet.
    return isSameStatus ? StateWatcher.UNKNOWN_DURATION_MS : previousStatusMs;
  }

  static _spanMs(previous, observedAt) {
    if (previous === null || previous.since === null) {
      return StateWatcher.UNKNOWN_DURATION_MS;
    }
    return observedAt - previous.since;
  }

  static transitionType(from, to) {
    if (from === null || from === to) {
      return null;
    }
    if (to === StateWatcher.STATUS_IDLE && from === StateWatcher.STATUS_WORKING) {
      return StateWatcher.STATUS_IDLE;
    }
    if (to === StateWatcher.STATUS_BLOCKED) {
      return StateWatcher.STATUS_BLOCKED;
    }
    if (to === StateWatcher.STATUS_DONE) {
      return StateWatcher.STATUS_DONE;
    }
    return null;
  }
}

module.exports = { StateWatcher };

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

  constructor() {
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
    // Rebuild from scratch so panes that disappeared are dropped.
    const nextByPane = new Map();
    for (const agent of agents) {
      if (!agent || !agent.pane_id || !agent.agent_status) {
        continue;
      }
      nextByPane.set(agent.pane_id, agent.agent_status);
      let from;
      if (this._lastByPane.has(agent.pane_id)) {
        from = this._lastByPane.get(agent.pane_id);
      } else if (this._hasBaseline) {
        from = StateWatcher.UNKNOWN_PRIOR_STATUS;
      } else {
        from = null;
      }
      const type = StateWatcher.transitionType(from, agent.agent_status);
      if (type) {
        events.push({ paneId: agent.pane_id, type, agent });
      }
    }
    this._lastByPane = nextByPane;
    this._hasBaseline = true;
    return events;
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

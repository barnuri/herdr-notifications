'use strict';

class StateWatcher {
  static STATUS_IDLE = 'idle';
  static STATUS_WORKING = 'working';
  static STATUS_BLOCKED = 'blocked';
  static STATUS_DONE = 'done';

  constructor() {
    this._lastByPane = new Map();
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
      const from = this._lastByPane.has(agent.pane_id)
        ? this._lastByPane.get(agent.pane_id)
        : null;
      const type = StateWatcher.transitionType(from, agent.agent_status);
      if (type) {
        events.push({ paneId: agent.pane_id, type, agent });
      }
    }
    this._lastByPane = nextByPane;
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

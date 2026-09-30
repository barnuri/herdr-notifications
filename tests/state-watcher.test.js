'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { StateWatcher } = require('../lib/state-watcher.js');

function agent(paneId, status) {
  return {
    pane_id: paneId,
    agent_status: status,
    agent: 'claude',
    terminal_title_stripped: `pane ${paneId}`,
  };
}

test('first sighting of a pane emits nothing', () => {
  const watcher = new StateWatcher();
  const events = watcher.update([agent('p1', 'working'), agent('p2', 'blocked')]);
  assert.deepEqual(events, []);
});

test('working -> idle emits an idle event', () => {
  const watcher = new StateWatcher();
  watcher.update([agent('p1', 'working')]);
  const events = watcher.update([agent('p1', 'idle')]);
  assert.equal(events.length, 1);
  assert.equal(events[0].paneId, 'p1');
  assert.equal(events[0].type, 'idle');
  assert.equal(events[0].agent.agent_status, 'idle');
});

test('idle -> working emits nothing', () => {
  const watcher = new StateWatcher();
  watcher.update([agent('p1', 'idle')]);
  const events = watcher.update([agent('p1', 'working')]);
  assert.deepEqual(events, []);
});

test('idle -> idle repeat emits nothing', () => {
  const watcher = new StateWatcher();
  watcher.update([agent('p1', 'idle')]);
  const events = watcher.update([agent('p1', 'idle')]);
  assert.deepEqual(events, []);
});

test('working -> blocked emits a blocked event', () => {
  const watcher = new StateWatcher();
  watcher.update([agent('p1', 'working')]);
  const events = watcher.update([agent('p1', 'blocked')]);
  assert.equal(events.length, 1);
  assert.equal(events[0].paneId, 'p1');
  assert.equal(events[0].type, 'blocked');
});

test('blocked -> blocked repeat emits nothing', () => {
  const watcher = new StateWatcher();
  watcher.update([agent('p1', 'working')]);
  watcher.update([agent('p1', 'blocked')]);
  const events = watcher.update([agent('p1', 'blocked')]);
  assert.deepEqual(events, []);
});

test('any -> done emits a done event', () => {
  const watcher = new StateWatcher();
  watcher.update([agent('p1', 'working'), agent('p2', 'idle')]);
  const events = watcher.update([agent('p1', 'done'), agent('p2', 'done')]);
  assert.deepEqual(
    events.map((event) => [event.paneId, event.type]),
    [['p1', 'done'], ['p2', 'done']]
  );
});

test('blocked -> idle emits nothing', () => {
  const watcher = new StateWatcher();
  watcher.update([agent('p1', 'blocked')]);
  const events = watcher.update([agent('p1', 'idle')]);
  assert.deepEqual(events, []);
});

test('transition into unknown emits nothing', () => {
  const watcher = new StateWatcher();
  watcher.update([agent('p1', 'working')]);
  const events = watcher.update([agent('p1', 'unknown')]);
  assert.deepEqual(events, []);
});

test('a brand-new pane that appears already blocked (after the watcher has a baseline) emits a blocked event', () => {
  const watcher = new StateWatcher();
  watcher.update([agent('p1', 'working')]); // establishes the baseline
  const events = watcher.update([agent('p1', 'working'), agent('p2', 'blocked')]);
  assert.equal(events.length, 1);
  assert.equal(events[0].paneId, 'p2');
  assert.equal(events[0].type, 'blocked');
});

test('a brand-new pane that appears already done (after the watcher has a baseline) emits a done event', () => {
  const watcher = new StateWatcher();
  watcher.update([]); // establishes an (empty) baseline
  const events = watcher.update([agent('p1', 'done')]);
  assert.equal(events.length, 1);
  assert.equal(events[0].paneId, 'p1');
  assert.equal(events[0].type, 'done');
});

test('a brand-new pane that appears already idle (after the watcher has a baseline) emits nothing', () => {
  const watcher = new StateWatcher();
  watcher.update([]); // establishes an (empty) baseline
  const events = watcher.update([agent('p1', 'idle')]);
  assert.deepEqual(events, []);
});

test('reset() makes the next update() a fresh cold start: even a blocked pane emits nothing', () => {
  const watcher = new StateWatcher();
  watcher.update([agent('p1', 'working')]);
  watcher.reset();
  const events = watcher.update([agent('p1', 'blocked'), agent('p2', 'done')]);
  assert.deepEqual(events, []);
});

test('disappeared pane is pruned; reappearing idle (needs from===working) emits nothing', () => {
  const watcher = new StateWatcher();
  watcher.update([agent('p1', 'working')]);
  watcher.update([]);
  const events = watcher.update([agent('p1', 'idle')]);
  assert.deepEqual(events, []);
});

test('disappeared pane is pruned; reappearing blocked emits a blocked event (this is a live agent again, worth surfacing)', () => {
  const watcher = new StateWatcher();
  watcher.update([agent('p1', 'working')]);
  watcher.update([]);
  const events = watcher.update([agent('p1', 'blocked')]);
  assert.equal(events.length, 1);
  assert.equal(events[0].paneId, 'p1');
  assert.equal(events[0].type, 'blocked');
});

test('non-array input returns no events and keeps state', () => {
  const watcher = new StateWatcher();
  watcher.update([agent('p1', 'working')]);
  assert.deepEqual(watcher.update(null), []);
});

test('entries missing pane_id or agent_status are ignored', () => {
  const watcher = new StateWatcher();
  watcher.update([{ agent_status: 'working' }, { pane_id: 'p1' }, null]);
  const events = watcher.update([agent('p1', 'idle')]);
  assert.deepEqual(events, []);
});

function fakeClock(startMs = 1000) {
  const clock = {
    now: startMs,
    advance(ms) {
      clock.now += ms;
    },
    read: () => clock.now,
  };
  return clock;
}

test('a working -> idle transition reports how long the pane was working', () => {
  const clock = fakeClock();
  const watcher = new StateWatcher({ now: clock.read });
  watcher.update([agent('p1', 'working')]);
  clock.advance(90_000);
  const [event] = watcher.update([agent('p1', 'idle')]);
  assert.equal(event.previousStatus, 'working');
  assert.equal(event.previousStatusMs, 90_000);
});

test('a pane that stays in one status keeps its original entry time across polls', () => {
  const clock = fakeClock();
  const watcher = new StateWatcher({ now: clock.read });
  watcher.update([agent('p1', 'working')]);
  clock.advance(60_000);
  watcher.update([agent('p1', 'working')]);
  clock.advance(60_000);
  const [event] = watcher.update([agent('p1', 'done')]);
  assert.equal(event.previousStatusMs, 120_000);
});

test('a pane seen for the first time after the baseline reports an unknown duration', () => {
  const clock = fakeClock();
  const watcher = new StateWatcher({ now: clock.read });
  watcher.update([agent('p1', 'working')]);
  clock.advance(5_000);
  const [event] = watcher.update([agent('p1', 'working'), agent('p2', 'blocked')]);
  assert.equal(event.paneId, 'p2');
  assert.equal(event.previousStatus, StateWatcher.UNKNOWN_PRIOR_STATUS);
  assert.equal(event.previousStatusMs, StateWatcher.UNKNOWN_DURATION_MS);
});

test('a pane that disappears and comes back is timed from its reappearance, not its first life', () => {
  const clock = fakeClock();
  const watcher = new StateWatcher({ now: clock.read });
  watcher.update([agent('p1', 'working')]);
  clock.advance(600_000);
  watcher.update([]);
  clock.advance(1_000);
  watcher.update([agent('p1', 'working')]);
  clock.advance(30_000);
  const [event] = watcher.update([agent('p1', 'done')]);
  assert.equal(event.previousStatusMs, 30_000);
});

test('each status span is measured separately: working time does not leak into blocked time', () => {
  const clock = fakeClock();
  const watcher = new StateWatcher({ now: clock.read });
  watcher.update([agent('p1', 'working')]);
  clock.advance(300_000);
  const [blockedEvent] = watcher.update([agent('p1', 'blocked')]);
  assert.equal(blockedEvent.previousStatusMs, 300_000);
  clock.advance(10_000);
  const [doneEvent] = watcher.update([agent('p1', 'done')]);
  assert.equal(doneEvent.previousStatus, 'blocked');
  assert.equal(doneEvent.previousStatusMs, 10_000);
});

test('the default clock is wall time and produces a non-negative span', () => {
  const watcher = new StateWatcher();
  watcher.update([agent('p1', 'working')]);
  const [event] = watcher.update([agent('p1', 'done')]);
  assert.ok(event.previousStatusMs >= 0);
});

test('a done reached through idle still reports the working run that preceded it', () => {
  const clock = fakeClock();
  const watcher = new StateWatcher({ now: clock.read });
  watcher.update([agent('p1', 'working')]);
  clock.advance(3_600_000);
  const [idleEvent] = watcher.update([agent('p1', 'idle')]);
  assert.equal(idleEvent.workingMs, 3_600_000);
  clock.advance(2_000);
  const [doneEvent] = watcher.update([agent('p1', 'done')]);
  assert.equal(doneEvent.previousStatus, 'idle');
  assert.equal(doneEvent.previousStatusMs, 2_000);
  assert.equal(doneEvent.workingMs, 3_600_000);
});

test('a done reached through blocked reports the working run, not the blocked wait', () => {
  const clock = fakeClock();
  const watcher = new StateWatcher({ now: clock.read });
  watcher.update([agent('p1', 'working')]);
  clock.advance(5_000);
  watcher.update([agent('p1', 'blocked')]);
  clock.advance(7_200_000);
  const [doneEvent] = watcher.update([agent('p1', 'done')]);
  assert.equal(doneEvent.previousStatusMs, 7_200_000);
  assert.equal(doneEvent.workingMs, 5_000);
});

test('a second working run replaces the previously recorded span', () => {
  const clock = fakeClock();
  const watcher = new StateWatcher({ now: clock.read });
  watcher.update([agent('p1', 'working')]);
  clock.advance(3_600_000);
  watcher.update([agent('p1', 'idle')]);
  clock.advance(1_000);
  watcher.update([agent('p1', 'working')]);
  clock.advance(30_000);
  const [event] = watcher.update([agent('p1', 'done')]);
  assert.equal(event.workingMs, 30_000);
});

test('a pane that never worked reports an unknown working span', () => {
  const clock = fakeClock();
  const watcher = new StateWatcher({ now: clock.read });
  watcher.update([agent('p1', 'idle')]);
  clock.advance(600_000);
  const [event] = watcher.update([agent('p1', 'done')]);
  assert.equal(event.workingMs, StateWatcher.UNKNOWN_DURATION_MS);
});

test('a still-running pane has no finished working span to report', () => {
  const clock = fakeClock();
  const watcher = new StateWatcher({ now: clock.read });
  watcher.update([agent('p1', 'working')]);
  clock.advance(600_000);
  const [event] = watcher.update([agent('p1', 'blocked')]);
  assert.equal(event.workingMs, 600_000);
});

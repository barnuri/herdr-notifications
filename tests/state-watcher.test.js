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

test('disappeared pane is pruned; reappearing counts as first sighting', () => {
  const watcher = new StateWatcher();
  watcher.update([agent('p1', 'working')]);
  watcher.update([]);
  const events = watcher.update([agent('p1', 'idle')]);
  assert.deepEqual(events, []);
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

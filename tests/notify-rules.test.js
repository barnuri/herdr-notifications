'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { resolveNotifyRule, shouldNotify } = require('../lib/notify-rules');

function event(type, { workingMs = null, focused = false } = {}) {
  return { type, paneId: 'p1', workingMs, agent: { agent: 'claude', focused } };
}

test('a legacy boolean status resolves to an unfiltered rule', () => {
  assert.deepEqual(resolveNotifyRule({ done: true }, 'done'), {
    enabled: true,
    minWorkingMs: 0,
    skipWhenFocused: false,
  });
});

test('a missing status resolves to disabled', () => {
  assert.equal(resolveNotifyRule({}, 'idle').enabled, false);
  assert.equal(resolveNotifyRule(null, 'idle').enabled, false);
});

test('an object status keeps its duration and focus rule', () => {
  assert.deepEqual(resolveNotifyRule({ idle: { enabled: true, minWorkingMs: 1000, skipWhenFocused: true } }, 'idle'), {
    enabled: true,
    minWorkingMs: 1000,
    skipWhenFocused: true,
  });
});

test('a non-finite minWorkingMs is treated as unfiltered', () => {
  assert.equal(resolveNotifyRule({ done: { enabled: true, minWorkingMs: 'later' } }, 'done').minWorkingMs, 0);
});

test('a disabled status is never sent, however long the run was', () => {
  const notifyOn = { done: { enabled: false, minWorkingMs: 0, skipWhenFocused: false } };
  assert.equal(shouldNotify(notifyOn, event('done', { workingMs: 3_600_000 })), false);
});

test('a run shorter than the threshold is suppressed', () => {
  const notifyOn = { done: { enabled: true, minWorkingMs: 900000, skipWhenFocused: false } };
  assert.equal(shouldNotify(notifyOn, event('done', { workingMs: 60_000 })), false);
});

test('a run at or over the threshold is sent', () => {
  const notifyOn = { done: { enabled: true, minWorkingMs: 900000, skipWhenFocused: false } };
  assert.equal(shouldNotify(notifyOn, event('done', { workingMs: 900000 })), true);
  assert.equal(shouldNotify(notifyOn, event('done', { workingMs: 900001 })), true);
});

test('an unmeasurable working span is suppressed when a threshold is set', () => {
  const notifyOn = { idle: { enabled: true, minWorkingMs: 900000, skipWhenFocused: false } };
  assert.equal(shouldNotify(notifyOn, event('idle', { workingMs: null })), false);
});

test('an unmeasurable span is still sent when no threshold is set', () => {
  const notifyOn = { blocked: { enabled: true, minWorkingMs: 0, skipWhenFocused: false } };
  assert.equal(shouldNotify(notifyOn, event('blocked', { workingMs: null })), true);
});

test('a focused pane is suppressed only when the status opts in', () => {
  const watching = { idle: { enabled: true, minWorkingMs: 0, skipWhenFocused: true } };
  const ignoring = { idle: { enabled: true, minWorkingMs: 0, skipWhenFocused: false } };
  assert.equal(shouldNotify(watching, event('idle', { focused: true })), false);
  assert.equal(shouldNotify(watching, event('idle', { focused: false })), true);
  assert.equal(shouldNotify(ignoring, event('idle', { focused: true })), true);
});

test('focus suppression wins over a satisfied duration rule', () => {
  const notifyOn = { done: { enabled: true, minWorkingMs: 1000, skipWhenFocused: true } };
  assert.equal(shouldNotify(notifyOn, event('done', { workingMs: 3_600_000, focused: true })), false);
});

test('each status is filtered by its own rule', () => {
  const notifyOn = {
    blocked: { enabled: true, minWorkingMs: 0, skipWhenFocused: false },
    done: { enabled: true, minWorkingMs: 900000, skipWhenFocused: false },
  };
  assert.equal(shouldNotify(notifyOn, event('blocked', { workingMs: 500 })), true);
  assert.equal(shouldNotify(notifyOn, event('done', { workingMs: 500 })), false);
});

test('a long run is still sent when the pane passed through another status first', () => {
  const notifyOn = { done: { enabled: true, minWorkingMs: 900000, skipWhenFocused: false } };
  const viaIdle = { type: 'done', paneId: 'p1', previousStatus: 'idle', previousStatusMs: 2_000, workingMs: 3_600_000, agent: {} };
  assert.equal(shouldNotify(notifyOn, viaIdle), true);
});

test('a long wait in another status does not substitute for working time', () => {
  const notifyOn = { done: { enabled: true, minWorkingMs: 900000, skipWhenFocused: false } };
  const longBlock = { type: 'done', paneId: 'p1', previousStatus: 'blocked', previousStatusMs: 7_200_000, workingMs: 5_000, agent: {} };
  assert.equal(shouldNotify(notifyOn, longBlock), false);
});

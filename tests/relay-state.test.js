'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

const { RelayStateStore } = require('../lib/relay-state');

let tempConfigDir;
let previousConfigDirEnv;

function writeStateFile(contents) {
  const serialized = typeof contents === 'string' ? contents : JSON.stringify(contents);
  fs.writeFileSync(path.join(tempConfigDir, 'relay-state.json'), serialized, 'utf8');
}

beforeEach(() => {
  previousConfigDirEnv = process.env.HERDR_PLUGIN_CONFIG_DIR;
  tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-telegram-relay-state-'));
  process.env.HERDR_PLUGIN_CONFIG_DIR = tempConfigDir;
});

afterEach(() => {
  if (previousConfigDirEnv === undefined) {
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  } else {
    process.env.HERDR_PLUGIN_CONFIG_DIR = previousConfigDirEnv;
  }
  fs.rmSync(tempConfigDir, { recursive: true, force: true });
});

test('fresh store with no existing relay-state.json starts empty', () => {
  const store = new RelayStateStore();
  assert.equal(store.getOffset(), 0);
  assert.deepEqual(store.getBlockedPanes(), []);
});

test('setOffset persists across a new RelayStateStore instance (survives a process restart)', () => {
  const store = new RelayStateStore();
  store.setOffset(42);

  const restarted = new RelayStateStore();
  assert.equal(restarted.getOffset(), 42);
});

test('trackBlocked makes resolveByMessageId and resolveByToken resolve the pane', () => {
  const store = new RelayStateStore();
  const token = RelayStateStore.generateToken();
  store.trackBlocked('pane1', { messageId: 'm1', token, options: ['yes', 'no'] });

  assert.equal(store.resolveByMessageId('m1'), 'pane1');
  assert.deepEqual(store.resolveByToken(token), { paneId: 'pane1', options: ['yes', 'no'] });
});

test('getBlockedPanes reflects trackBlocked and expirePane', () => {
  const store = new RelayStateStore();
  store.trackBlocked('pane1', { messageId: 'm1', token: 't1', options: ['a'] });
  assert.deepEqual(store.getBlockedPanes(), ['pane1']);

  store.expirePane('pane1');
  assert.deepEqual(store.getBlockedPanes(), []);
});

test('expirePane removes only the entries pointing at that pane, leaving other panes untouched', () => {
  const store = new RelayStateStore();
  store.trackBlocked('pane1', { messageId: 'm1', token: 't1', options: ['a'] });
  store.trackBlocked('pane2', { messageId: 'm2', token: 't2', options: ['b'] });

  store.expirePane('pane1');

  assert.equal(store.resolveByMessageId('m1'), null);
  assert.equal(store.resolveByToken('t1'), null);
  assert.deepEqual(store.getBlockedPanes(), ['pane2']);

  assert.equal(store.resolveByMessageId('m2'), 'pane2');
  assert.deepEqual(store.resolveByToken('t2'), { paneId: 'pane2', options: ['b'] });
});

test('re-blocking the same pane supersedes the previous mapping', () => {
  const store = new RelayStateStore();
  store.trackBlocked('pane1', { messageId: 'm1', token: 't1', options: ['a'] });
  store.trackBlocked('pane1', { messageId: 'm2', token: 't2', options: ['b'] });

  assert.equal(store.resolveByMessageId('m1'), null);
  assert.equal(store.resolveByToken('t1'), null);

  assert.equal(store.resolveByMessageId('m2'), 'pane1');
  assert.deepEqual(store.resolveByToken('t2'), { paneId: 'pane1', options: ['b'] });

  assert.deepEqual(store.getBlockedPanes(), ['pane1']);
});

test('trackBlocked stores text on the token entry only when passed, preserving the existing shape otherwise', () => {
  const store = new RelayStateStore();
  store.trackBlocked('pane1', { messageId: 'm1', token: 't1', options: ['a'] });
  assert.deepEqual(store.resolveByToken('t1'), { paneId: 'pane1', options: ['a'] });

  store.trackBlocked('pane2', { messageId: 'm2', token: 't2', options: ['b'], text: 'body text' });
  assert.deepEqual(store.resolveByToken('t2'), { paneId: 'pane2', options: ['b'], text: 'body text' });
});

test('resolveOptionsByPane returns the tracked options for a blocked pane, or null when none/untracked', () => {
  const store = new RelayStateStore();
  store.trackBlocked('pane1', { messageId: 'm1', token: 't1', options: ['a', 'b'] });
  store.trackBlocked('pane2', { messageId: 'm2', token: 't2', options: [] });

  assert.deepEqual(store.resolveOptionsByPane('pane1'), ['a', 'b']);
  assert.equal(store.resolveOptionsByPane('pane2'), null);
  assert.equal(store.resolveOptionsByPane('unknown-pane'), null);

  store.expirePane('pane1');
  assert.equal(store.resolveOptionsByPane('pane1'), null);
});

test('corrupt JSON on disk falls back to the empty default state without throwing', () => {
  writeStateFile('{ not valid json');

  const store = new RelayStateStore();
  assert.equal(store.getOffset(), 0);
  assert.deepEqual(store.getBlockedPanes(), []);
});

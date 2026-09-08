'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

const { RelayStateStore } = require('../lib/relay-state');

let tempConfigDir;
let previousConfigDirEnv;

function statePath() {
  return path.join(tempConfigDir, RelayStateStore.FILE_NAME);
}

function writeStateFile(contents) {
  const serialized = typeof contents === 'string' ? contents : JSON.stringify(contents);
  fs.writeFileSync(statePath(), serialized, 'utf8');
}

function telegramDelivery(messageId = 10, baseText = 'tg base') {
  return { providerId: 'telegram', messageId, baseText };
}

beforeEach(() => {
  previousConfigDirEnv = process.env.HERDR_PLUGIN_CONFIG_DIR;
  tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-notifications-relay-'));
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

test('cursors are tracked per provider and never overwrite each other', () => {
  const store = new RelayStateStore();

  store.setCursor('telegram', 120, 'chat-1');
  store.setCursor('discord', '900000000000000001', 'C1');
  store.setCursor('slack', '1750000000.000100', 'C2');

  assert.equal(store.getCursor('telegram', 'chat-1'), 120);
  assert.equal(store.getCursor('discord', 'C1'), '900000000000000001');
  assert.equal(store.getCursor('slack', 'C2'), '1750000000.000100');
});

test('an unset cursor reads as undefined so a provider can bootstrap', () => {
  assert.equal(new RelayStateStore().getCursor('discord', 'C1'), undefined);
});

test('cursors survive a reload from disk', () => {
  new RelayStateStore().setCursor('slack', '1.5', 'C1');
  assert.equal(new RelayStateStore().getCursor('slack', 'C1'), '1.5');
});

test('a pre-multi-provider flat offset is dropped, sending telegram through its bootstrap', () => {
  writeStateFile({ offset: 777, blockedPanes: [], messages: {}, tokens: {}, awaitingText: {} });

  const store = new RelayStateStore();

  assert.equal(
    store.getCursor('telegram', '602646882'),
    undefined,
    'it records no chat id, so it cannot be trusted against the configured one',
  );
});

test('a target-scoped cursor wins over a legacy flat offset', () => {
  writeStateFile({ offset: 777, cursors: { telegram: { cursor: 999, target: '602646882' } } });

  assert.equal(new RelayStateStore().getCursor('telegram', '602646882'), 999);
});

test('trackBlocked routes every provider message id back to the pane', () => {
  const store = new RelayStateStore();

  store.trackBlocked('pane-1', {
    deliveries: [
      telegramDelivery(10, 'tg base'),
      { providerId: 'discord', messageId: '900', baseText: 'dc base' },
      { providerId: 'slack', messageId: '1.1', baseText: 'sl base' },
    ],
    token: 'tok',
    options: [{ label: '1. Yes', value: '1' }],
  });

  assert.equal(store.resolveByMessageId('telegram', 10), 'pane-1');
  assert.equal(store.resolveByMessageId('discord', '900'), 'pane-1');
  assert.equal(store.resolveByMessageId('slack', '1.1'), 'pane-1');
  assert.deepEqual(store.getBlockedPanes(), ['pane-1']);
});

test('an identical message id on two providers resolves independently', () => {
  const store = new RelayStateStore();

  store.trackBlocked('pane-1', { deliveries: [{ providerId: 'telegram', messageId: '5', baseText: 'a' }] });
  store.trackBlocked('pane-2', { deliveries: [{ providerId: 'discord', messageId: '5', baseText: 'b' }] });

  assert.equal(store.resolveByMessageId('telegram', '5'), 'pane-1');
  assert.equal(store.resolveByMessageId('discord', '5'), 'pane-2');
});

test('getDeliveries returns each provider message id with the text it rendered', () => {
  const store = new RelayStateStore();

  store.trackBlocked('pane-1', {
    deliveries: [telegramDelivery(10, 'tg base'), { providerId: 'slack', messageId: '1.1', baseText: 'sl base' }],
  });

  assert.deepEqual(store.getDeliveries('pane-1'), [
    { providerId: 'telegram', messageId: 10, baseText: 'tg base' },
    { providerId: 'slack', messageId: '1.1', baseText: 'sl base' },
  ]);
});

test('getDeliveries is empty for an untracked pane', () => {
  assert.deepEqual(new RelayStateStore().getDeliveries('pane-x'), []);
});

test('re-blocking the same pane replaces its previous delivery set', () => {
  const store = new RelayStateStore();

  store.trackBlocked('pane-1', { deliveries: [telegramDelivery(10)] });
  store.trackBlocked('pane-1', { deliveries: [telegramDelivery(11)] });

  assert.equal(store.resolveByMessageId('telegram', 10), null);
  assert.equal(store.resolveByMessageId('telegram', 11), 'pane-1');
  assert.equal(store.getDeliveries('pane-1').length, 1);
  assert.deepEqual(store.getBlockedPanes(), ['pane-1']);
});

test('a token resolves to the pane and the options it was offered', () => {
  const store = new RelayStateStore();
  const options = [
    { label: '1. Yes', value: '1' },
    { label: '2. No', value: '2' },
  ];

  store.trackBlocked('pane-1', { deliveries: [telegramDelivery()], token: 'tok', options });

  assert.deepEqual(store.resolveByToken('tok'), { paneId: 'pane-1', options });
  assert.deepEqual(store.resolveOptionsByPane('pane-1'), options);
});

test('no token is stored when the pane had no detected options', () => {
  const store = new RelayStateStore();

  store.trackBlocked('pane-1', { deliveries: [telegramDelivery()], token: 'tok', options: [] });

  assert.equal(store.resolveByToken('tok'), null);
  assert.equal(store.resolveOptionsByPane('pane-1'), null);
});

test('an unknown token resolves to null', () => {
  assert.equal(new RelayStateStore().resolveByToken('nope'), null);
});

test('registerMessage maps a follow-up prompt to its pane per provider', () => {
  const store = new RelayStateStore();

  store.trackBlocked('pane-1', { deliveries: [telegramDelivery()] });
  store.registerMessage('telegram', 20, 'pane-1');

  assert.equal(store.resolveByMessageId('telegram', 20), 'pane-1');
  assert.equal(store.resolveByMessageId('discord', 20), null);
});

test('setAwaitingText drops the menu options but keeps the pane routable', () => {
  const store = new RelayStateStore();

  store.trackBlocked('pane-1', {
    deliveries: [telegramDelivery()],
    token: 'tok',
    options: [{ label: '1. Type something', value: '1', expectsText: true }],
  });
  store.setAwaitingText('pane-1');

  assert.equal(store.isAwaitingText('pane-1'), true);
  assert.equal(store.resolveByToken('tok'), null);
  assert.equal(store.resolveOptionsByPane('pane-1'), null);
  assert.equal(store.resolveByMessageId('telegram', 10), 'pane-1');
  assert.deepEqual(store.getBlockedPanes(), ['pane-1']);
});

test('isAwaitingText is false for a pane that never selected a free-text option', () => {
  assert.equal(new RelayStateStore().isAwaitingText('pane-1'), false);
});

test('expirePane clears every trace of the pane across all providers', () => {
  const store = new RelayStateStore();

  store.trackBlocked('pane-1', {
    deliveries: [telegramDelivery(), { providerId: 'discord', messageId: '900', baseText: 'dc' }],
    token: 'tok',
    options: [{ label: '1. Yes', value: '1' }],
  });
  store.setAwaitingText('pane-1');
  store.expirePane('pane-1');

  assert.deepEqual(store.getBlockedPanes(), []);
  assert.equal(store.resolveByMessageId('telegram', 10), null);
  assert.equal(store.resolveByMessageId('discord', '900'), null);
  assert.deepEqual(store.getDeliveries('pane-1'), []);
  assert.equal(store.isAwaitingText('pane-1'), false);
});

test('expiring one pane leaves another blocked pane untouched', () => {
  const store = new RelayStateStore();

  store.trackBlocked('pane-1', { deliveries: [telegramDelivery(10)] });
  store.trackBlocked('pane-2', { deliveries: [telegramDelivery(11)] });
  store.expirePane('pane-1');

  assert.deepEqual(store.getBlockedPanes(), ['pane-2']);
  assert.equal(store.resolveByMessageId('telegram', 11), 'pane-2');
});

test('state is persisted so a restarted watcher can still route answers', () => {
  const first = new RelayStateStore();
  first.trackBlocked('pane-1', { deliveries: [telegramDelivery(10, 'base')], token: 'tok', options: [{ label: '1. Yes', value: '1' }] });

  const reloaded = new RelayStateStore();

  assert.deepEqual(reloaded.getBlockedPanes(), ['pane-1']);
  assert.equal(reloaded.resolveByMessageId('telegram', 10), 'pane-1');
  assert.deepEqual(reloaded.getDeliveries('pane-1'), [{ providerId: 'telegram', messageId: 10, baseText: 'base' }]);
  assert.deepEqual(reloaded.resolveByToken('tok').options, [{ label: '1. Yes', value: '1' }]);
});

test('the state file is not group or world readable', () => {
  new RelayStateStore().setCursor('telegram', 1, 'chat-1');

  const mode = fs.statSync(statePath()).mode & 0o777;
  assert.equal(mode, RelayStateStore.FILE_MODE);
});

test('invalid JSON falls back to empty state instead of throwing', () => {
  writeStateFile('{ not json');

  const store = new RelayStateStore();

  assert.deepEqual(store.getBlockedPanes(), []);
  assert.equal(store.getCursor('telegram', 'chat-1'), undefined);
});

test('a non-object state file falls back to empty state', () => {
  writeStateFile('[1,2,3]');

  assert.deepEqual(new RelayStateStore().getBlockedPanes(), []);
});

test('a state file with the wrong types for its fields falls back per field', () => {
  writeStateFile({ cursors: 'nope', blockedPanes: 'nope', messages: 7, deliveries: [], tokens: null });

  const store = new RelayStateStore();

  assert.deepEqual(store.getBlockedPanes(), []);
  assert.equal(store.getCursor('telegram', 'chat-1'), undefined);
  assert.equal(store.resolveByMessageId('telegram', 1), null);
  assert.deepEqual(store.getDeliveries('pane-1'), []);
});

test('a pre-multi-provider flat message map is dropped rather than stranded', () => {
  writeStateFile({ offset: 5, blockedPanes: ['pane-1'], messages: { 100: 'pane-1' } });

  const store = new RelayStateStore();

  assert.equal(store.getCursor('telegram', 'any-chat'), undefined, 'an untargeted offset is not reused');
  assert.equal(store.resolveByMessageId('telegram', 100), null);
  store.expirePane('pane-1');
  assert.deepEqual(store.getBlockedPanes(), []);
});

test('a non-object provider bucket in messages is discarded', () => {
  writeStateFile({ messages: { telegram: 'nope', slack: { '1.1': 'pane-2' } } });

  const store = new RelayStateStore();

  assert.equal(store.resolveByMessageId('telegram', 1), null);
  assert.equal(store.resolveByMessageId('slack', '1.1'), 'pane-2');
});

test('a cursor is only returned for the target it was recorded against', () => {
  const store = new RelayStateStore();

  store.setCursor('slack', '100.5', 'C_OLD');

  assert.equal(store.getCursor('slack', 'C_OLD'), '100.5');
  assert.equal(
    store.getCursor('slack', 'C_NEW'),
    undefined,
    're-pointing a provider at another channel must not replay that channel from a foreign timestamp',
  );
});

test('re-pointing a provider overwrites the cursor rather than keeping both', () => {
  const store = new RelayStateStore();

  store.setCursor('slack', '100.5', 'C_OLD');
  store.setCursor('slack', '200.1', 'C_NEW');

  assert.equal(store.getCursor('slack', 'C_NEW'), '200.1');
  assert.equal(store.getCursor('slack', 'C_OLD'), undefined);
});

test('target scoping compares loosely so a numeric chat id matches its string form', () => {
  const store = new RelayStateStore();

  store.setCursor('telegram', 120, 602646882);

  assert.equal(store.getCursor('telegram', '602646882'), 120);
});

test('a target-scoped cursor survives a reload', () => {
  new RelayStateStore().setCursor('discord', '900', 'C1');

  const reloaded = new RelayStateStore();

  assert.equal(reloaded.getCursor('discord', 'C1'), '900');
  assert.equal(reloaded.getCursor('discord', 'C2'), undefined);
});

test('a pre-target-scoping bare cursor is discarded, not trusted', () => {
  writeStateFile({ cursors: { telegram: 777 } });

  const store = new RelayStateStore();

  assert.equal(store.getCursor('telegram', 'any-chat'), undefined);
});

test('an untargeted cursor from any source is discarded rather than guessed at', () => {
  writeStateFile({ offset: 555, cursors: { slack: '100.5' } });

  const store = new RelayStateStore();

  assert.equal(store.getCursor('telegram', 'any-chat'), undefined);
  assert.equal(store.getCursor('slack', 'C1'), undefined);
});

test('an unset cursor reads as undefined regardless of target', () => {
  assert.equal(new RelayStateStore().getCursor('slack', 'C1'), undefined);
});

test('optionsKey is stable for the same question and empty for no options', () => {
  const options = [{ label: '1. Yes', value: '1' }];

  assert.equal(RelayStateStore.optionsKey(options), RelayStateStore.optionsKey([{ label: '1. Yes', value: '1' }]));
  assert.equal(RelayStateStore.optionsKey([]), '');
  assert.equal(RelayStateStore.optionsKey(undefined), '');
});

test('optionsKey distinguishes two questions that share their option values', () => {
  // Nearly every menu is numbered 1..n, so a values-only key would report the
  // second question of a multi-question prompt as unchanged and drop it.
  const layout = [
    { label: '1. Sectioned + link button', value: '1' },
    { label: '2. Compact with fields', value: '2' },
  ];
  const link = [
    { label: '1. Inline link', value: '1' },
    { label: '2. Attach the file', value: '2' },
  ];

  assert.notEqual(RelayStateStore.optionsKey(layout), RelayStateStore.optionsKey(link));
});

test('trackBlocked records the event and the question fingerprint', () => {
  const store = new RelayStateStore();
  const event = { type: 'blocked', paneId: 'pane-1', agent: { agent: 'agent-a' } };

  store.trackBlocked('pane-1', {
    deliveries: [telegramDelivery()],
    token: 'tok',
    options: [{ label: '1. Yes', value: '1' }],
    event,
  });

  assert.deepEqual(store.getQuestion('pane-1'), {
    event,
    optionsKey: RelayStateStore.optionsKey([{ label: '1. Yes', value: '1' }]),
  });
});

test('getQuestion is null for an untracked pane', () => {
  assert.equal(new RelayStateStore().getQuestion('pane-x'), null);
});

test('expirePane clears the recorded question', () => {
  const store = new RelayStateStore();
  store.trackBlocked('pane-1', { deliveries: [telegramDelivery()], event: { type: 'blocked', paneId: 'pane-1' } });

  store.expirePane('pane-1');

  assert.equal(store.getQuestion('pane-1'), null);
});

test('the recorded question survives a reload so a restart can still follow up', () => {
  const event = { type: 'blocked', paneId: 'pane-1', agent: { agent: 'agent-a' } };
  new RelayStateStore().trackBlocked('pane-1', {
    deliveries: [telegramDelivery()],
    options: [{ value: '1' }, { value: '2' }],
    token: 'tok',
    event,
  });

  assert.deepEqual(new RelayStateStore().getQuestion('pane-1'), {
    event,
    optionsKey: RelayStateStore.optionsKey([{ value: '1' }, { value: '2' }]),
  });
});

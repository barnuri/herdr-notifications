'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { Notifier } = require('../lib/notifier');

const BLOCKED_EVENT = { type: 'blocked', paneId: 'pane-1', agent: { agent: 'agent-a' } };
const DONE_EVENT = { type: 'done', paneId: 'pane-2', agent: { agent: 'agent-b' } };

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    pollMs: 2000,
    notifyOn: { idle: true, blocked: true, done: true },
    relay: { enabled: false, contextLines: 40, pollMs: 1000 },
    providers: {},
    ...overrides,
  };
}

function fakeProvider(id, { failWith = null } = {}) {
  const sent = [];
  return {
    id,
    sent,
    supportsButtons: false,
    isConfigured: () => true,
    async sendStatus(event) {
      if (failWith) {
        throw new Error(failWith);
      }
      sent.push(event);
      return { messageId: `${id}-1` };
    },
  };
}

function fakeWatcher(events) {
  const state = { resets: 0 };
  return {
    state,
    update: () => events,
    reset: () => {
      state.resets += 1;
    },
  };
}

function build({ events = [], providers = [], unconfigured = [], config = baseConfig(), relay = null } = {}) {
  const logs = [];
  const desktop = [];
  const watcher = fakeWatcher(events);
  const notifier = new Notifier({
    loadConfig: () => config,
    listAgents: async () => [],
    createProviders: () => ({ providers, unconfigured }),
    notifyDesktop: async (title, body) => desktop.push({ title, body }),
    watcher,
    log: (line) => logs.push(line),
    relay,
  });
  return { notifier, logs, desktop, watcher };
}

test('a disabled config sends nothing and drops watcher state', async () => {
  const provider = fakeProvider('telegram');
  const { notifier, watcher } = build({
    events: [DONE_EVENT],
    providers: [provider],
    config: baseConfig({ enabled: false }),
  });

  const result = await notifier.tick();

  assert.deepEqual(result, { sent: 0, filtered: 0, failed: 0 });
  assert.deepEqual(provider.sent, []);
  assert.equal(watcher.state.resets, 1);
});

test('no enabled provider sends nothing, drops watcher state, and warns', async () => {
  const { notifier, logs, watcher } = build({ events: [DONE_EVENT] });

  const result = await notifier.tick();

  assert.deepEqual(result, { sent: 0, filtered: 0, failed: 0 });
  assert.equal(watcher.state.resets, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /no notification provider is enabled and configured/);
});

test('the unconfigured-provider warning is emitted once, not on every tick', async () => {
  const { notifier, logs } = build({ providers: [fakeProvider('telegram')], unconfigured: ['slack'] });

  await notifier.tick();
  await notifier.tick();

  const warnings = logs.filter((line) => line.includes('slack enabled but missing credentials'));
  assert.equal(warnings.length, 1);
});

test('an enabled but unconfigured provider does not stop the configured ones', async () => {
  const telegram = fakeProvider('telegram');
  const { notifier } = build({ events: [DONE_EVENT], providers: [telegram], unconfigured: ['discord'] });

  const result = await notifier.tick();

  assert.equal(result.sent, 1);
  assert.equal(telegram.sent.length, 1);
});

test('one event fans out to every enabled provider', async () => {
  const telegram = fakeProvider('telegram');
  const discord = fakeProvider('discord');
  const slack = fakeProvider('slack');
  const { notifier } = build({ events: [DONE_EVENT], providers: [telegram, discord, slack] });

  const result = await notifier.tick();

  assert.deepEqual(result, { sent: 1, filtered: 0, failed: 0 });
  assert.deepEqual(telegram.sent, [DONE_EVENT]);
  assert.deepEqual(discord.sent, [DONE_EVENT]);
  assert.deepEqual(slack.sent, [DONE_EVENT]);
});

test('events the user switched off are filtered before any provider is called', async () => {
  const provider = fakeProvider('telegram');
  const { notifier } = build({
    events: [DONE_EVENT, BLOCKED_EVENT],
    providers: [provider],
    config: baseConfig({ notifyOn: { idle: true, blocked: true, done: false } }),
  });

  const result = await notifier.tick();

  assert.equal(result.sent, 1);
  assert.equal(result.filtered, 1);
  assert.deepEqual(provider.sent, [BLOCKED_EVENT]);
});

test('one failing provider does not silence the others', async () => {
  const telegram = fakeProvider('telegram');
  const slack = fakeProvider('slack', { failWith: 'slack chat.postMessage failed: invalid_auth' });
  const { notifier, logs, desktop } = build({ events: [DONE_EVENT], providers: [telegram, slack] });

  const result = await notifier.tick();

  assert.deepEqual(result, { sent: 1, filtered: 0, failed: 0 });
  assert.deepEqual(telegram.sent, [DONE_EVENT]);
  assert.ok(logs.some((line) => line.includes('slack send failed: slack chat.postMessage failed: invalid_auth')));
  assert.equal(desktop.length, 1);
  assert.match(desktop[0].title, /slack/);
});

test('an event that reaches no provider is counted as failed', async () => {
  const telegram = fakeProvider('telegram', { failWith: 'boom' });
  const slack = fakeProvider('slack', { failWith: 'boom' });
  const { notifier, desktop } = build({ events: [DONE_EVENT], providers: [telegram, slack] });

  const result = await notifier.tick();

  assert.deepEqual(result, { sent: 0, filtered: 0, failed: 1 });
  assert.equal(desktop.length, 1);
  assert.match(desktop[0].title, /telegram, slack|slack, telegram/);
});

test('a blocked event goes through the relay when the relay is enabled', async () => {
  const provider = fakeProvider('telegram');
  const relayCalls = [];
  const relay = {
    async notifyBlocked(event, currentConfig, providers) {
      relayCalls.push({ event, providers });
      return [];
    },
  };
  const { notifier } = build({
    events: [BLOCKED_EVENT],
    providers: [provider],
    config: baseConfig({ relay: { enabled: true, contextLines: 40, pollMs: 1000 } }),
    relay,
  });

  const result = await notifier.tick();

  assert.equal(result.sent, 1);
  assert.equal(relayCalls.length, 1);
  assert.deepEqual(relayCalls[0].providers, [provider]);
  assert.deepEqual(provider.sent, [], 'the plain status message is replaced, not duplicated');
});

test('a non-blocked event never goes through the relay', async () => {
  const provider = fakeProvider('telegram');
  let relayCalled = false;
  const relay = {
    async notifyBlocked() {
      relayCalled = true;
      return [];
    },
  };
  const { notifier } = build({
    events: [DONE_EVENT],
    providers: [provider],
    config: baseConfig({ relay: { enabled: true, contextLines: 40, pollMs: 1000 } }),
    relay,
  });

  await notifier.tick();

  assert.equal(relayCalled, false);
  assert.deepEqual(provider.sent, [DONE_EVENT]);
});

test('a blocked event uses the plain path when the relay is disabled', async () => {
  const provider = fakeProvider('telegram');
  let relayCalled = false;
  const relay = {
    async notifyBlocked() {
      relayCalled = true;
      return [];
    },
  };
  const { notifier } = build({ events: [BLOCKED_EVENT], providers: [provider], relay });

  await notifier.tick();

  assert.equal(relayCalled, false);
  assert.deepEqual(provider.sent, [BLOCKED_EVENT]);
});

test('relay failures are reported the same way as plain send failures', async () => {
  const provider = fakeProvider('telegram');
  const relay = {
    async notifyBlocked() {
      return [{ providerId: 'telegram', message: 'telegram sendMessage failed: chat not found' }];
    },
  };
  const { notifier, logs, desktop } = build({
    events: [BLOCKED_EVENT],
    providers: [provider],
    config: baseConfig({ relay: { enabled: true, contextLines: 40, pollMs: 1000 } }),
    relay,
  });

  const result = await notifier.tick();

  assert.deepEqual(result, { sent: 0, filtered: 0, failed: 1 });
  assert.ok(logs.some((line) => line.includes('telegram send failed: telegram sendMessage failed: chat not found')));
  assert.equal(desktop.length, 1);
});

test('a relay that throws is contained: the event is reported failed, not the whole tick', async () => {
  const provider = fakeProvider('telegram');
  const relay = {
    async notifyBlocked() {
      throw new Error('herdr agent output read failed');
    },
  };
  const { notifier, logs, desktop } = build({
    events: [BLOCKED_EVENT, DONE_EVENT],
    providers: [provider],
    config: baseConfig({ relay: { enabled: true, contextLines: 40, pollMs: 1000 } }),
    relay,
  });

  const result = await notifier.tick();

  assert.deepEqual(result, { sent: 1, filtered: 0, failed: 1 });
  assert.deepEqual(provider.sent, [DONE_EVENT], 'the events after the failing one still go out');
  assert.ok(logs.some((line) => line.includes('telegram send failed: herdr agent output read failed')));
  assert.equal(desktop.length, 1);
});

function statusRule({ enabled = true, minWorkingMs = 0, skipWhenFocused = false } = {}) {
  return { enabled, minWorkingMs, skipWhenFocused };
}

test('a short run is filtered, not failed, and no provider is called', async () => {
  const provider = fakeProvider('slack');
  const { notifier } = build({
    events: [{ type: 'done', paneId: 'pane-1', workingMs: 60_000, agent: { agent: 'a' } }],
    providers: [provider],
    config: baseConfig({ notifyOn: { done: statusRule({ minWorkingMs: 900000 }) } }),
  });

  const result = await notifier.tick();
  assert.deepEqual(result, { sent: 0, filtered: 1, failed: 0 });
  assert.equal(provider.sent.length, 0);
});

test('a long run is delivered', async () => {
  const provider = fakeProvider('slack');
  const { notifier } = build({
    events: [{ type: 'done', paneId: 'pane-1', workingMs: 1_800_000, agent: { agent: 'a' } }],
    providers: [provider],
    config: baseConfig({ notifyOn: { done: statusRule({ minWorkingMs: 900000 }) } }),
  });

  const result = await notifier.tick();
  assert.deepEqual(result, { sent: 1, filtered: 0, failed: 0 });
  assert.equal(provider.sent.length, 1);
});

test('a focused pane is filtered when its status opts into focus suppression', async () => {
  const provider = fakeProvider('slack');
  const { notifier } = build({
    events: [{ type: 'idle', paneId: 'pane-1', workingMs: 1_800_000, agent: { agent: 'a', focused: true } }],
    providers: [provider],
    config: baseConfig({ notifyOn: { idle: statusRule({ skipWhenFocused: true }) } }),
  });

  const result = await notifier.tick();
  assert.deepEqual(result, { sent: 0, filtered: 1, failed: 0 });
  assert.equal(provider.sent.length, 0);
});

test('one status being filtered does not suppress another in the same tick', async () => {
  const provider = fakeProvider('slack');
  const { notifier } = build({
    events: [
      { type: 'done', paneId: 'pane-1', workingMs: 5_000, agent: { agent: 'a' } },
      { type: 'blocked', paneId: 'pane-2', workingMs: 5_000, agent: { agent: 'b' } },
    ],
    providers: [provider],
    config: baseConfig({
      notifyOn: { done: statusRule({ minWorkingMs: 900000 }), blocked: statusRule() },
    }),
  });

  const result = await notifier.tick();
  assert.deepEqual(result, { sent: 1, filtered: 1, failed: 0 });
  assert.deepEqual(provider.sent.map((event) => event.type), ['blocked']);
});

test('a pane with no measurable run time is filtered when a threshold is set', async () => {
  const provider = fakeProvider('slack');
  const { notifier } = build({
    events: [{ type: 'done', paneId: 'pane-1', workingMs: null, agent: { agent: 'a' } }],
    providers: [provider],
    config: baseConfig({ notifyOn: { done: statusRule({ minWorkingMs: 900000 }) } }),
  });

  assert.deepEqual(await notifier.tick(), { sent: 0, filtered: 1, failed: 0 });
});

test('a done event reached through idle is judged on the working run, not the idle gap', async () => {
  const provider = fakeProvider('slack');
  const { notifier } = build({
    events: [
      {
        type: 'done',
        paneId: 'pane-1',
        previousStatus: 'idle',
        previousStatusMs: 3_000,
        workingMs: 3_600_000,
        agent: { agent: 'a' },
      },
    ],
    providers: [provider],
    config: baseConfig({ notifyOn: { done: statusRule({ minWorkingMs: 900000 }) } }),
  });

  assert.deepEqual(await notifier.tick(), { sent: 1, filtered: 0, failed: 0 });
});

function delayedBuild({ events, agents, clock, notifyOn, providers, relay = null }) {
  let index = 0;
  const watcher = {
    update: () => events[index++] || [],
    reset: () => {},
  };
  const config = baseConfig({ notifyOn, providers: {}, relay: { enabled: relay !== null, contextLines: 40, pollMs: 1000 } });
  return new Notifier({
    loadConfig: () => config,
    listAgents: async () => agents,
    createProviders: () => ({ providers, unconfigured: [] }),
    notifyDesktop: async () => {},
    watcher,
    log: () => {},
    relay,
    now: () => clock.value,
  });
}

const DELAYED = { enabled: true, minWorkingMs: 0, skipWhenFocused: false, delaySeconds: 300 };

test('a delayed event is held until its delay elapses, then sent', async () => {
  const clock = { value: 0 };
  const provider = fakeProvider('telegram');
  const agents = [{ pane_id: 'pane-2', agent_status: 'done' }];
  const notifier = delayedBuild({
    events: [[DONE_EVENT], [], []],
    agents,
    clock,
    notifyOn: { done: DELAYED },
    providers: [provider],
  });

  assert.equal((await notifier.tick()).sent, 0);
  clock.value = 299_999;
  assert.equal((await notifier.tick()).sent, 0);
  clock.value = 300_000;
  assert.equal((await notifier.tick()).sent, 1);
  assert.equal(provider.sent.length, 1);
});

test('a delayed event is dropped when the pane is no longer in that status', async () => {
  const clock = { value: 0 };
  const provider = fakeProvider('telegram');
  const notifier = delayedBuild({
    events: [[DONE_EVENT], []],
    agents: [{ pane_id: 'pane-2', agent_status: 'working' }],
    clock,
    notifyOn: { done: DELAYED },
    providers: [provider],
  });

  await notifier.tick();
  clock.value = 300_000;
  const result = await notifier.tick();

  assert.equal(result.sent, 0);
  assert.deepEqual(provider.sent, []);
});

test('a zero delay sends on the same tick', async () => {
  const provider = fakeProvider('telegram');
  const notifier = delayedBuild({
    events: [[DONE_EVENT]],
    agents: [],
    clock: { value: 0 },
    notifyOn: { done: { ...DELAYED, delaySeconds: 0 } },
    providers: [provider],
  });

  assert.equal((await notifier.tick()).sent, 1);
});

test('a blocked event routed through the relay is never held back', async () => {
  const provider = fakeProvider('telegram');
  const relayCalls = [];
  const relay = {
    async notifyBlocked(event) {
      relayCalls.push(event);
      return [];
    },
  };
  const notifier = delayedBuild({
    events: [[BLOCKED_EVENT]],
    agents: [],
    clock: { value: 0 },
    notifyOn: { blocked: { ...DELAYED, minWorkingMs: 0 } },
    providers: [provider],
    relay,
  });

  await notifier.tick();

  assert.equal(relayCalls.length, 1);
});

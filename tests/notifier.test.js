'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Notifier } = require('../lib/notifier');

const ENABLED_CONFIG = Object.freeze({
  enabled: true,
  botToken: 'token',
  chatId: '1',
  pollMs: 2000,
  notifyOn: Object.freeze({ idle: true, blocked: true, done: true }),
});

function agentRow(paneId, status, title) {
  return { pane_id: paneId, agent_status: status, terminal_title_stripped: title };
}

function buildNotifier(overrides = {}) {
  const calls = { sent: [], toasts: [], logs: [], listCalls: 0 };
  const notifier = new Notifier({
    loadConfig: overrides.loadConfig || (() => ENABLED_CONFIG),
    listAgents:
      overrides.listAgents ||
      (async () => {
        calls.listCalls += 1;
        return overrides.agents || [];
      }),
    sendMessage:
      overrides.sendMessage ||
      (async (args) => {
        calls.sent.push(args);
      }),
    notifyDesktop: async (title, body) => {
      calls.toasts.push({ title, body });
      return true;
    },
    log: (line) => calls.logs.push(line),
    relay: overrides.relay,
  });
  return { notifier, calls };
}

test('sends a message when an agent transitions working -> idle', async () => {
  const { notifier, calls } = buildNotifier();
  const states = [[agentRow('p1', 'working', 'my-agent')], [agentRow('p1', 'idle', 'my-agent')]];
  notifier._listAgents = async () => states.shift();

  const first = await notifier.tick();
  const second = await notifier.tick();

  assert.equal(first.sent, 0);
  assert.equal(second.sent, 1);
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0].botToken, 'token');
  assert.equal(calls.sent[0].chatId, '1');
  assert.match(calls.sent[0].text, /🟡/);
  assert.match(calls.sent[0].text, /my-agent<\/b> is idle/);
});

test('filters out notification types disabled in config', async () => {
  const config = { ...ENABLED_CONFIG, notifyOn: { idle: true, blocked: false, done: true } };
  const { notifier, calls } = buildNotifier({ loadConfig: () => config });
  const states = [[agentRow('p1', 'working', 't')], [agentRow('p1', 'blocked', 't')]];
  notifier._listAgents = async () => states.shift();

  await notifier.tick();
  const result = await notifier.tick();

  assert.equal(result.sent, 0);
  assert.equal(result.filtered, 1);
  assert.equal(calls.sent.length, 0);
});

test('missing botToken/chatId skips polling, sends nothing, warns once, no toast', async () => {
  const config = { ...ENABLED_CONFIG, botToken: '', chatId: '' };
  const { notifier, calls } = buildNotifier({ loadConfig: () => config });

  await notifier.tick();
  const result = await notifier.tick();

  assert.equal(result.sent, 0);
  assert.equal(calls.listCalls, 0);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.toasts.length, 0);
  assert.equal(calls.logs.length, 1);
  assert.match(calls.logs[0], /not configured/);
});

test('master enabled=false skips polling entirely', async () => {
  const config = { ...ENABLED_CONFIG, enabled: false };
  const { notifier, calls } = buildNotifier({ loadConfig: () => config });

  const result = await notifier.tick();

  assert.equal(result.sent, 0);
  assert.equal(calls.listCalls, 0);
});

test('transitions during a disabled window do not fire on re-enable', async () => {
  let enabled = true;
  const loadConfig = () => ({ ...ENABLED_CONFIG, enabled });
  const { notifier, calls } = buildNotifier({ loadConfig });
  const states = [
    [agentRow('p1', 'working', 't')],
    [agentRow('p1', 'idle', 't')],
    [agentRow('p1', 'idle', 't')],
  ];
  notifier._listAgents = async () => states.shift();

  await notifier.tick();
  enabled = false;
  await notifier.tick();
  enabled = true;
  await notifier.tick();

  assert.equal(calls.sent.length, 0);
});

test('a pane appearing already blocked in a disabled window does not fire retroactively on re-enable either', async () => {
  // Regression guard for the StateWatcher fix that lets a brand-new pane's
  // first-ever "blocked"/"done" sighting notify (mid-session): the
  // disabled-window reset must still fully suppress it, not just for idle.
  let enabled = true;
  const loadConfig = () => ({ ...ENABLED_CONFIG, enabled });
  const { notifier, calls } = buildNotifier({ loadConfig });
  const states = [
    [], // nothing running yet
    [agentRow('p1', 'blocked', 't')], // p1 appears already blocked, but disabled
    [agentRow('p1', 'blocked', 't')], // re-enabled, same status: not a fresh event either way
  ];
  notifier._listAgents = async () => states.shift();

  await notifier.tick();
  enabled = false;
  await notifier.tick();
  enabled = true;
  await notifier.tick();

  assert.equal(calls.sent.length, 0);
});

test('send failure logs, falls back to desktop toast, and keeps going', async () => {
  const { notifier, calls } = buildNotifier({
    sendMessage: async () => {
      throw new Error('Telegram sendMessage failed: HTTP 401');
    },
  });
  const states = [
    [agentRow('p1', 'working', 'a'), agentRow('p2', 'working', 'b')],
    [agentRow('p1', 'idle', 'a'), agentRow('p2', 'done', 'b')],
  ];
  notifier._listAgents = async () => states.shift();

  await notifier.tick();
  const result = await notifier.tick();

  assert.equal(result.sent, 0);
  assert.equal(calls.toasts.length, 2);
  assert.equal(calls.logs.length, 2);
});

test('blocked transition with relay enabled delegates to relay.notifyBlocked instead of sendMessage', async () => {
  const config = { ...ENABLED_CONFIG, relay: { enabled: true } };
  const relayCalls = [];
  const relay = {
    notifyBlocked: async (event, currentConfig) => {
      relayCalls.push({ event, currentConfig });
    },
  };
  const { notifier, calls } = buildNotifier({ loadConfig: () => config, relay });
  const states = [[agentRow('p1', 'working', 't')], [agentRow('p1', 'blocked', 't')]];
  notifier._listAgents = async () => states.shift();

  await notifier.tick();
  const result = await notifier.tick();

  assert.equal(result.sent, 1);
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].event.type, 'blocked');
  assert.equal(relayCalls[0].currentConfig, config);
  assert.equal(calls.sent.length, 0);
});

test('relay.notifyBlocked rejection logs and toasts exactly like a sendMessage failure', async () => {
  const config = { ...ENABLED_CONFIG, relay: { enabled: true } };
  const relay = {
    notifyBlocked: async () => {
      throw new Error('relay delivery failed: HTTP 500');
    },
  };
  const { notifier, calls } = buildNotifier({ loadConfig: () => config, relay });
  const states = [[agentRow('p1', 'working', 't')], [agentRow('p1', 'blocked', 't')]];
  notifier._listAgents = async () => states.shift();

  await notifier.tick();
  const result = await notifier.tick();

  assert.equal(result.sent, 0);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.toasts.length, 1);
  assert.equal(calls.logs.length, 1);
  assert.match(calls.logs[0], /send failed/);
  assert.match(calls.logs[0], /relay delivery failed/);
});

test('blocked transition with relay omitted still calls plain sendMessage as before', async () => {
  const config = { ...ENABLED_CONFIG, relay: { enabled: true } };
  const { notifier, calls } = buildNotifier({ loadConfig: () => config });
  const states = [[agentRow('p1', 'working', 't')], [agentRow('p1', 'blocked', 't')]];
  notifier._listAgents = async () => states.shift();

  await notifier.tick();
  const result = await notifier.tick();

  assert.equal(result.sent, 1);
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0].text, Notifier.formatMessage({ paneId: 'p1', type: 'blocked', agent: agentRow('p1', 'blocked', 't') }));
});

test('blocked transition with relay.enabled false calls plain sendMessage and never touches the relay', async () => {
  const config = { ...ENABLED_CONFIG, relay: { enabled: false } };
  const relayCalls = [];
  const relay = {
    notifyBlocked: async (event) => {
      relayCalls.push(event);
    },
  };
  const { notifier, calls } = buildNotifier({ loadConfig: () => config, relay });
  const states = [[agentRow('p1', 'working', 't')], [agentRow('p1', 'blocked', 't')]];
  notifier._listAgents = async () => states.shift();

  await notifier.tick();
  const result = await notifier.tick();

  assert.equal(result.sent, 1);
  assert.equal(relayCalls.length, 0);
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0].text, Notifier.formatMessage({ paneId: 'p1', type: 'blocked', agent: agentRow('p1', 'blocked', 't') }));
});

test('formatMessage falls back through title, agent name, then pane id', () => {
  assert.match(
    Notifier.formatMessage({ paneId: 'p1', type: 'idle', agent: { terminal_title_stripped: 'title' } }),
    /^🟡 <b>title<\/b> is idle/
  );
  assert.match(
    Notifier.formatMessage({ paneId: 'p1', type: 'blocked', agent: { agent: 'claude' } }),
    /^🔴 .*claude<\/b> is blocked \(waiting for input\)/
  );
  assert.match(
    Notifier.formatMessage({ paneId: 'p1', type: 'done', agent: {} }),
    /^🟢 .*p1<\/b> is done/
  );
});

test('formatMessage falls back to the default icon for an unrecognized type', () => {
  assert.match(
    Notifier.formatMessage({ paneId: 'p1', type: 'unknown-status', agent: {} }),
    /^⚪ .*changed to unknown-status/
  );
});

test('formatMessage escapes HTML-significant characters in the agent label', () => {
  const text = Notifier.formatMessage({
    paneId: 'p1',
    type: 'done',
    agent: { terminal_title_stripped: '<script>&fake</script>' },
  });
  assert.ok(!text.includes('<script>'));
  assert.match(text, /&lt;script&gt;&amp;fake&lt;\/script&gt;/);
});

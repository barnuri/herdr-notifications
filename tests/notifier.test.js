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
  assert.match(calls.sent[0].text, /my-agent is idle/);
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

test('formatMessage falls back through title, agent name, then pane id', () => {
  assert.match(
    Notifier.formatMessage({ paneId: 'p1', type: 'idle', agent: { terminal_title_stripped: 'title' } }),
    /^herdr: title is idle/
  );
  assert.match(
    Notifier.formatMessage({ paneId: 'p1', type: 'blocked', agent: { agent: 'claude' } }),
    /claude is blocked \(waiting for input\)/
  );
  assert.match(Notifier.formatMessage({ paneId: 'p1', type: 'done', agent: {} }), /p1 is done/);
});

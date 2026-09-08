'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { NotificationEvent } = require('../lib/notification-event');

test('agentLabel prefers the stripped terminal title', () => {
  const label = NotificationEvent.agentLabel({
    paneId: 'pane-1',
    agent: { terminal_title_stripped: 'auth refactor', agent: 'claude' },
  });
  assert.equal(label, 'auth refactor');
});

test('agentLabel falls back to the agent name, then the pane id', () => {
  assert.equal(NotificationEvent.agentLabel({ paneId: 'pane-1', agent: { agent: 'claude' } }), 'claude');
  assert.equal(NotificationEvent.agentLabel({ paneId: 'pane-1', agent: {} }), 'pane-1');
  assert.equal(NotificationEvent.agentLabel({ paneId: 7 }), '7');
});

test('describe returns the icon, label and status for each known state', () => {
  assert.deepEqual(NotificationEvent.describe({ type: 'blocked', paneId: 'p', agent: { agent: 'a' } }), {
    icon: '🔴',
    label: 'a',
    status: 'is blocked (waiting for input)',
  });
  assert.equal(NotificationEvent.describe({ type: 'idle', paneId: 'p' }).icon, '🟡');
  assert.equal(NotificationEvent.describe({ type: 'done', paneId: 'p' }).icon, '🟢');
});

test('describe degrades gracefully for an unknown state', () => {
  const described = NotificationEvent.describe({ type: 'restarting', paneId: 'p' });
  assert.equal(described.icon, NotificationEvent.DEFAULT_ICON);
  assert.equal(described.status, 'changed to restarting');
});

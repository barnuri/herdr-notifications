'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Relay } = require('../lib/relay');

const CONFIG = Object.freeze({
  botToken: 'tok',
  chatId: '555',
  relay: Object.freeze({ enabled: true, contextLines: 40, pollMs: 2000 }),
});

function buildStateStore(overrides = {}) {
  const calls = { setOffset: [], expirePane: [], trackBlocked: [] };
  return {
    calls,
    getOffset: () => 0,
    setOffset: (offset) => calls.setOffset.push(offset),
    resolveByToken: overrides.resolveByToken || (() => null),
    resolveByMessageId: overrides.resolveByMessageId || (() => null),
    resolveOptionsByPane: overrides.resolveOptionsByPane || (() => null),
    getBlockedPanes: overrides.getBlockedPanes || (() => []),
    expirePane: (paneId) => calls.expirePane.push(paneId),
    trackBlocked: (paneId, args) => calls.trackBlocked.push({ paneId, args }),
  };
}

// Builds a Relay with a plain recording stub for every constructor-DI
// collaborator, matching lib/relay.js's constructor destructuring exactly.
// Overrides let individual tests swap in the collaborator(s) they're driving.
function buildRelay(overrides = {}) {
  const calls = {
    readAgentOutput: [],
    answerBlockedAgent: [],
    notifyDesktop: [],
    sendMessage: [],
    getUpdates: [],
    answerCallbackQuery: [],
    editMessageText: [],
    detectOptions: [],
    log: [],
  };
  const stateStore = overrides.stateStore || buildStateStore();
  const relay = new Relay({
    loadConfig: overrides.loadConfig || (() => CONFIG),
    readAgentOutput:
      overrides.readAgentOutput ||
      (async (paneId, opts) => {
        calls.readAgentOutput.push({ paneId, opts });
        return '';
      }),
    answerBlockedAgent:
      overrides.answerBlockedAgent ||
      (async (paneId, text) => {
        calls.answerBlockedAgent.push({ paneId, text });
      }),
    notifyDesktop:
      overrides.notifyDesktop ||
      (async (title, body) => {
        calls.notifyDesktop.push({ title, body });
        return true;
      }),
    sendMessage:
      overrides.sendMessage ||
      (async (args) => {
        calls.sendMessage.push(args);
        return { message_id: 999 };
      }),
    getUpdates:
      overrides.getUpdates ||
      (async (botToken, opts) => {
        calls.getUpdates.push({ botToken, opts });
        return [];
      }),
    answerCallbackQuery:
      overrides.answerCallbackQuery ||
      (async (botToken, id, opts) => {
        calls.answerCallbackQuery.push({ botToken, id, opts });
      }),
    editMessageText:
      overrides.editMessageText ||
      (async (args) => {
        calls.editMessageText.push(args);
      }),
    detectOptions:
      overrides.detectOptions ||
      ((text) => {
        calls.detectOptions.push(text);
        return [];
      }),
    stateStore,
    log: overrides.log || ((line) => calls.log.push(line)),
  });
  return { relay, calls, stateStore };
}

function callbackUpdate({ updateId, chatId = '555', data = 'r:abc123:0' } = {}) {
  return {
    update_id: updateId,
    callback_query: {
      id: 'cbq1',
      data,
      message: { message_id: 5, chat: { id: chatId } },
    },
  };
}

function messageUpdate({ updateId, chatId = '555', text = 'hello', replyToMessageId } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: 6,
      chat: { id: chatId },
      text,
      ...(replyToMessageId !== undefined ? { reply_to_message: { message_id: replyToMessageId } } : {}),
    },
  };
}

test('pollUpdates drops a callback_query update from an unconfigured chat but still advances the offset', async () => {
  const update = callbackUpdate({ updateId: 1, chatId: 'someone-else' });
  const { relay, calls, stateStore } = buildRelay({
    getUpdates: async () => [update],
  });

  await relay.pollUpdates();

  assert.equal(calls.answerBlockedAgent.length, 0);
  assert.equal(calls.answerCallbackQuery.length, 0);
  assert.equal(calls.sendMessage.length, 0);
  assert.deepEqual(stateStore.calls.setOffset, [2]);
});

test('pollUpdates drops a plain message update from an unconfigured chat but still advances the offset', async () => {
  const update = messageUpdate({ updateId: 1, chatId: 'someone-else' });
  const { relay, calls, stateStore } = buildRelay({
    getUpdates: async () => [update],
  });

  await relay.pollUpdates();

  assert.equal(calls.answerBlockedAgent.length, 0);
  assert.equal(calls.answerCallbackQuery.length, 0);
  assert.equal(calls.sendMessage.length, 0);
  assert.deepEqual(stateStore.calls.setOffset, [2]);
});

test('pollUpdates resolves a callback_query with a valid token: answers the callback, relays the option value, then expires the pane', async () => {
  const stateStore = buildStateStore({
    resolveByToken: (token) => (token === 'abc123' ? { paneId: 'p1', options: [{ label: 'Yes', value: 'y' }] } : null),
  });
  const update = callbackUpdate({ updateId: 1, data: 'r:abc123:0' });
  const { relay, calls } = buildRelay({ stateStore, getUpdates: async () => [update] });

  await relay.pollUpdates();

  assert.deepEqual(calls.answerCallbackQuery, [{ botToken: 'tok', id: 'cbq1', opts: { text: 'Sent.' } }]);
  assert.deepEqual(calls.answerBlockedAgent, [{ paneId: 'p1', text: 'y' }]);
  assert.deepEqual(stateStore.calls.expirePane, ['p1']);
  // No `text` was tracked for this entry (older/partial state) — the edit
  // step is skipped rather than editing with an incomplete message body.
  assert.equal(calls.editMessageText.length, 0);
});

test('a successful callback_query edits the original message to show the selection and remove the buttons', async () => {
  const stateStore = buildStateStore({
    resolveByToken: (token) =>
      (token === 'abc123' ? { paneId: 'p1', options: [{ label: '2. No, exit', value: '2' }], text: '🔴 <b>agent</b> is blocked' } : null),
  });
  const update = callbackUpdate({ updateId: 1, data: 'r:abc123:0' });
  const { relay, calls } = buildRelay({ stateStore, getUpdates: async () => [update] });

  await relay.pollUpdates();

  assert.equal(calls.editMessageText.length, 1);
  const edit = calls.editMessageText[0];
  assert.equal(edit.chatId, CONFIG.chatId);
  assert.equal(edit.messageId, 5); // callbackUpdate()'s fixed message.message_id
  assert.match(edit.text, /🔴 <b>agent<\/b> is blocked/);
  assert.match(edit.text, /✅ Selected: <b>2\. No, exit<\/b>/);
  assert.deepEqual(edit.replyMarkup, { inline_keyboard: [] });
});

test('a callback_query edit failure is logged, not surfaced as a relay failure (the answer was already delivered)', async () => {
  const stateStore = buildStateStore({
    resolveByToken: (token) => (token === 'abc123' ? { paneId: 'p1', options: [{ label: 'Yes', value: 'y' }], text: 'body' } : null),
  });
  const update = callbackUpdate({ updateId: 1, data: 'r:abc123:0' });
  const { relay, calls } = buildRelay({
    stateStore,
    getUpdates: async () => [update],
    editMessageText: async () => {
      throw new Error('message to edit not found');
    },
  });

  await relay.pollUpdates();

  assert.equal(calls.sendMessage.length, 0); // no user-facing "Failed to relay" message
  assert.equal(calls.log.length, 1);
  assert.match(calls.log[0], /failed to update the answered message/);
});

test('pollUpdates routes a reply-to-notification message to the replied-to pane', async () => {
  const stateStore = buildStateStore({
    resolveByMessageId: (messageId) => (messageId === 5 ? 'p2' : null),
  });
  const update = messageUpdate({ updateId: 1, text: 'my answer', replyToMessageId: 5 });
  const { relay, calls } = buildRelay({ stateStore, getUpdates: async () => [update] });

  await relay.pollUpdates();

  assert.deepEqual(calls.answerBlockedAgent, [{ paneId: 'p2', text: 'my answer' }]);
  assert.deepEqual(stateStore.calls.expirePane, ['p2']);
  assert.equal(calls.sendMessage.length, 0);
});

test('pollUpdates routes a non-reply message to the single blocked pane when exactly one is blocked', async () => {
  const stateStore = buildStateStore({ getBlockedPanes: () => ['p3'] });
  const update = messageUpdate({ updateId: 1, text: 'my answer' });
  const { relay, calls } = buildRelay({ stateStore, getUpdates: async () => [update] });

  await relay.pollUpdates();

  assert.deepEqual(calls.answerBlockedAgent, [{ paneId: 'p3', text: 'my answer' }]);
  assert.deepEqual(stateStore.calls.expirePane, ['p3']);
  assert.equal(calls.sendMessage.length, 0);
});

test('pollUpdates rejects a non-reply message with no blocked panes: sends an explanatory error, never relays', async () => {
  const stateStore = buildStateStore({ getBlockedPanes: () => [] });
  const update = messageUpdate({ updateId: 1, text: 'my answer' });
  const { relay, calls, stateStore: store } = buildRelay({ stateStore, getUpdates: async () => [update] });

  await relay.pollUpdates();

  assert.equal(calls.answerBlockedAgent.length, 0);
  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.sendMessage[0].chatId, CONFIG.chatId);
  assert.match(calls.sendMessage[0].text, /reply directly/);
  assert.equal(store.calls.expirePane.length, 0);
});

test('pollUpdates rejects a non-reply message with two-or-more blocked panes: sends an explanatory error, never relays', async () => {
  const stateStore = buildStateStore({ getBlockedPanes: () => ['p1', 'p2'] });
  const update = messageUpdate({ updateId: 1, text: 'my answer' });
  const { relay, calls, stateStore: store } = buildRelay({ stateStore, getUpdates: async () => [update] });

  await relay.pollUpdates();

  assert.equal(calls.answerBlockedAgent.length, 0);
  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.sendMessage[0].chatId, CONFIG.chatId);
  assert.match(calls.sendMessage[0].text, /reply directly/);
  assert.equal(store.calls.expirePane.length, 0);
});

test('pollUpdates advances the offset to (max update_id + 1) exactly once, regardless of how many updates were processed or dropped', async () => {
  const stateStore = buildStateStore({ getBlockedPanes: () => ['p1'] });
  const updates = [
    callbackUpdate({ updateId: 3, chatId: 'someone-else' }), // dropped: wrong chat
    messageUpdate({ updateId: 7, text: 'my answer' }), // processed: routes to the sole blocked pane
    messageUpdate({ updateId: 5, chatId: 'someone-else' }), // dropped: wrong chat, lower id than max
  ];
  const { relay, stateStore: store } = buildRelay({ stateStore, getUpdates: async () => updates });

  await relay.pollUpdates();

  assert.deepEqual(store.calls.setOffset, [8]);
});

test('pollUpdates advances the offset past the whole batch even when processing one update throws', async () => {
  const stateStore = buildStateStore({
    resolveByToken: (token) => (token === 'abc123' ? { paneId: 'p1', options: [{ label: 'Yes', value: 'y' }] } : null),
  });
  const updates = [
    callbackUpdate({ updateId: 1, data: 'r:abc123:0' }),
    callbackUpdate({ updateId: 2, data: 'r:abc123:0' }),
  ];
  let calls = 0;
  const { relay, stateStore: store } = buildRelay({
    stateStore,
    getUpdates: async () => updates,
    answerCallbackQuery: async () => {
      calls += 1;
      if (calls === 2) {
        throw new Error('Telegram: query is too old and response timeout expired');
      }
    },
  });

  await relay.pollUpdates();

  assert.deepEqual(store.calls.setOffset, [3]);
});

test('_handleCallbackQuery answers "expired" and does not relay when the token is unresolvable', async () => {
  const update = callbackUpdate({ updateId: 1, data: 'r:unknown:0' });
  const { relay, calls } = buildRelay({ getUpdates: async () => [update] });

  await relay.pollUpdates();

  assert.deepEqual(calls.answerCallbackQuery, [{ botToken: 'tok', id: 'cbq1', opts: { text: 'This question has expired.' } }]);
  assert.equal(calls.answerBlockedAgent.length, 0);
});

test('_handleCallbackQuery ignores malformed callback_data without answering or relaying', async () => {
  const update = callbackUpdate({ updateId: 1, data: 'not-the-expected-shape' });
  const { relay, calls } = buildRelay({ getUpdates: async () => [update] });

  await relay.pollUpdates();

  assert.equal(calls.answerCallbackQuery.length, 0);
  assert.equal(calls.answerBlockedAgent.length, 0);
});

test('_handleCallbackQuery reports failure back to the chat when answerBlockedAgent throws, and still expires the pane', async () => {
  const stateStore = buildStateStore({
    resolveByToken: (token) => (token === 'abc123' ? { paneId: 'p1', options: [{ label: 'Yes', value: 'y' }] } : null),
  });
  const update = callbackUpdate({ updateId: 1, data: 'r:abc123:0' });
  const { relay, calls, stateStore: store } = buildRelay({
    stateStore,
    getUpdates: async () => [update],
    answerBlockedAgent: async () => {
      throw new Error('herdr pane send-text failed');
    },
  });

  await relay.pollUpdates();

  assert.equal(calls.sendMessage.length, 1);
  assert.match(calls.sendMessage[0].text, /Failed to relay your answer/);
  assert.deepEqual(store.calls.expirePane, ['p1']);
});

test('_handleMessage reports failure back to the chat when answerBlockedAgent throws, and still expires the pane', async () => {
  const stateStore = buildStateStore({ getBlockedPanes: () => ['p3'] });
  const update = messageUpdate({ updateId: 1, text: 'my answer' });
  const { relay, calls, stateStore: store } = buildRelay({
    stateStore,
    getUpdates: async () => [update],
    answerBlockedAgent: async () => {
      throw new Error('herdr pane send-text failed');
    },
  });

  await relay.pollUpdates();

  assert.equal(calls.sendMessage.length, 1);
  assert.match(calls.sendMessage[0].text, /Failed to relay your answer/);
  assert.deepEqual(store.calls.expirePane, ['p3']);
});

test('pollUpdates resolves a free-text reply that matches a detected option label to that option\'s value', async () => {
  const stateStore = buildStateStore({
    getBlockedPanes: () => ['p1'],
    resolveOptionsByPane: (paneId) => (paneId === 'p1' ? [{ label: '1. Yes, I trust this folder', value: '1' }, { label: '2. No, exit', value: '2' }] : null),
  });
  const update = messageUpdate({ updateId: 1, text: 'no, exit' });
  const { relay, calls } = buildRelay({ stateStore, getUpdates: async () => [update] });

  await relay.pollUpdates();

  assert.deepEqual(calls.answerBlockedAgent, [{ paneId: 'p1', text: '2' }]);
});

test('pollUpdates relays free text unchanged when it matches no detected option', async () => {
  const stateStore = buildStateStore({
    getBlockedPanes: () => ['p1'],
    resolveOptionsByPane: (paneId) => (paneId === 'p1' ? [{ label: '1. Yes', value: '1' }, { label: '2. No', value: '2' }] : null),
  });
  const update = messageUpdate({ updateId: 1, text: 'actually, do something else entirely' });
  const { relay, calls } = buildRelay({ stateStore, getUpdates: async () => [update] });

  await relay.pollUpdates();

  assert.deepEqual(calls.answerBlockedAgent, [{ paneId: 'p1', text: 'actually, do something else entirely' }]);
});

test('pollUpdates relays free text unchanged when the blocked pane has no detected options', async () => {
  const stateStore = buildStateStore({
    getBlockedPanes: () => ['p1'],
    resolveOptionsByPane: () => null,
  });
  const update = messageUpdate({ updateId: 1, text: 'y' });
  const { relay, calls } = buildRelay({ stateStore, getUpdates: async () => [update] });

  await relay.pollUpdates();

  assert.deepEqual(calls.answerBlockedAgent, [{ paneId: 'p1', text: 'y' }]);
});

test('notifyBlocked sends a text-only message and tracks it when no options are detected', async () => {
  const { relay, calls, stateStore } = buildRelay({
    readAgentOutput: async () => 'plain agent output with no menu',
    detectOptions: () => [],
  });

  await relay.notifyBlocked({ paneId: 'p1', agent: {} }, CONFIG);

  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.sendMessage[0].replyMarkup, undefined);
  assert.equal(stateStore.calls.trackBlocked.length, 1);
  const { args } = stateStore.calls.trackBlocked[0];
  assert.equal(stateStore.calls.trackBlocked[0].paneId, 'p1');
  assert.equal(args.messageId, 999);
  assert.equal(args.token, undefined);
  assert.deepEqual(args.options, []);
});

test('notifyBlocked builds an inline keyboard and tracks the token when options are detected', async () => {
  const options = [
    { label: '1. Yes', value: 'Yes' },
    { label: '2. No', value: 'No' },
  ];
  const { relay, calls, stateStore } = buildRelay({
    readAgentOutput: async () => '1. Yes\n2. No',
    detectOptions: () => options,
  });

  await relay.notifyBlocked({ paneId: 'p1', agent: {} }, CONFIG);

  assert.equal(calls.sendMessage.length, 1);
  const { replyMarkup, text } = calls.sendMessage[0];
  assert.equal(replyMarkup.inline_keyboard.length, 1);
  assert.equal(replyMarkup.inline_keyboard[0].length, 2);
  assert.equal(replyMarkup.inline_keyboard[0][0].text, '1. Yes');
  assert.match(replyMarkup.inline_keyboard[0][0].callback_data, /^r:[0-9a-f]{8}:0$/);
  assert.match(text, /reply with your own answer/);
  assert.equal(stateStore.calls.trackBlocked.length, 1);
  assert.equal(stateStore.calls.trackBlocked[0].paneId, 'p1');
  assert.deepEqual(stateStore.calls.trackBlocked[0].args.options, options);
});

test('notifyBlocked HTML-escapes agent output before embedding it in the message', async () => {
  const { relay, calls } = buildRelay({
    readAgentOutput: async () => 'Run <script>alert(1)</script> & continue?',
    detectOptions: () => [],
  });

  await relay.notifyBlocked({ paneId: 'p1', agent: {} }, CONFIG);

  const { text } = calls.sendMessage[0];
  assert.doesNotMatch(text, /<script>/);
  assert.match(text, /&lt;script&gt;/);
  assert.match(text, /&amp;/);
});

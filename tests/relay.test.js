'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { Relay } = require('../lib/relay');
const { RelayStateStore } = require('../lib/relay-state');

const BLOCKED_EVENT = { type: 'blocked', paneId: 'pane-1', agent: { agent: 'agent-a' } };
const MENU_OPTIONS = [
  { label: '1. Yes, proceed', value: '1' },
  { label: '2. No', value: '2' },
];

function relayConfig(overrides = {}) {
  return {
    enabled: true,
    pollMs: 2000,
    notifyOn: { idle: true, blocked: true, done: true },
    relay: { enabled: true, contextLines: 40, pollMs: 1000 },
    providers: {},
    ...overrides,
  };
}

// A provider double that records every outbound call and replays a queue of
// inbound batches, one per fetchInbound call.
function fakeProvider(id, { inbound = [], failSendBlocked = null, failMarkAnswered = false } = {}) {
  const batches = [...inbound];
  return {
    id,
    targetId: `target-${id}`,
    supportsButtons: id === 'telegram',
    blocked: [],
    texts: [],
    prompts: [],
    answered: [],
    acknowledged: [],
    fetched: [],
    isConfigured: () => true,
    async sendBlocked({ event, context, options, token }) {
      if (failSendBlocked) {
        throw new Error(failSendBlocked);
      }
      this.blocked.push({ event, context, options, token });
      return { messageId: `${id}-msg-${this.blocked.length}`, baseText: `${id} base` };
    },
    async sendText(text) {
      this.texts.push(text);
      return { messageId: `${id}-text-${this.texts.length}` };
    },
    async sendTextPrompt(text) {
      this.prompts.push(text);
      return { messageId: `${id}-prompt-${this.prompts.length}` };
    },
    async markAnswered(payload) {
      if (failMarkAnswered) {
        throw new Error('too old to edit');
      }
      this.answered.push(payload);
    },
    async acknowledgeAction(actionId, text) {
      this.acknowledged.push({ actionId, text });
    },
    async fetchInbound(cursor) {
      this.fetched.push(cursor);
      const batch = batches.shift() || { events: [], cursor };
      return batch;
    },
  };
}

// An in-memory stand-in for RelayStateStore with the same surface, so relay
// behaviour is tested without touching the filesystem.
function fakeStore() {
  const state = { cursors: {}, blockedPanes: [], messages: {}, deliveries: {}, questions: {}, tokens: {}, awaitingText: {} };
  const store = {
    state,
    getCursor: (providerId, targetId) => {
      const entry = state.cursors[providerId];
      if (!entry) {
        return undefined;
      }
      return entry.target === null || String(entry.target) === String(targetId) ? entry.cursor : undefined;
    },
    setCursor: (providerId, cursor, targetId) => {
      state.cursors[providerId] = { cursor, target: targetId === undefined ? null : String(targetId) };
    },
    trackBlocked: (paneId, { deliveries = [], token, options, event } = {}) => {
      // The real store expires the pane first, dropping the previous
      // question's token and message routing.
      store.expirePane(paneId);
      state.blockedPanes = state.blockedPanes.filter((pane) => pane !== paneId).concat(paneId);
      state.deliveries[paneId] = deliveries;
      state.questions[paneId] = { event, optionsKey: RelayStateStore.optionsKey(options) };
      for (const { providerId, messageId } of deliveries) {
        state.messages[`${providerId}:${messageId}`] = paneId;
      }
      if (Array.isArray(options) && options.length > 0 && token !== undefined) {
        state.tokens[token] = { paneId, options };
      }
    },
    registerMessage: (providerId, messageId, paneId) => {
      state.messages[`${providerId}:${messageId}`] = paneId;
    },
    setAwaitingText: (paneId) => {
      state.awaitingText[paneId] = true;
    },
    isAwaitingText: (paneId) => state.awaitingText[paneId] === true,
    resolveByMessageId: (providerId, messageId) => state.messages[`${providerId}:${messageId}`] || null,
    resolveByToken: (token) => state.tokens[token] || null,
    resolveOptionsByPane: (paneId) => {
      const entry = Object.values(state.tokens).find((candidate) => candidate.paneId === paneId);
      return entry ? entry.options : null;
    },
    getBlockedPanes: () => [...state.blockedPanes],
    getQuestion: (paneId) => state.questions[paneId] || null,
    getDeliveries: (paneId) => state.deliveries[paneId] || [],
    expirePane: (paneId) => {
      state.blockedPanes = state.blockedPanes.filter((pane) => pane !== paneId);
      delete state.deliveries[paneId];
      delete state.questions[paneId];
      delete state.awaitingText[paneId];
      for (const [key, mapped] of Object.entries(state.messages)) {
        if (mapped === paneId) {
          delete state.messages[key];
        }
      }
      for (const [token, entry] of Object.entries(state.tokens)) {
        if (entry.paneId === paneId) {
          delete state.tokens[token];
        }
      }
    },
  };
  return store;
}

function build({
  providers = [],
  options = MENU_OPTIONS,
  context = 'waiting for input',
  answerFails = null,
  config = relayConfig(),
  store = fakeStore(),
} = {}) {
  const logs = [];
  const answers = [];
  // Arrays let a test make the pane's *second* read (after an answer) differ
  // from the first, which is what a multi-question prompt does.
  const contexts = Array.isArray(context) ? [...context] : [context];
  const optionSets = Array.isArray(options) && Array.isArray(options[0]) ? [...options] : [options];
  const nextOf = (queue) => (queue.length > 1 ? queue.shift() : queue[0]);

  const relay = new Relay({
    loadConfig: () => config,
    createProviders: () => ({ providers, unconfigured: [] }),
    readAgentOutput: async () => nextOf(contexts),
    answerBlockedAgent: async (paneId, text) => {
      if (answerFails) {
        throw new Error(answerFails);
      }
      answers.push({ paneId, text });
    },
    detectOptions: () => nextOf(optionSets),
    stateStore: store,
    log: (line) => logs.push(line),
    settle: async () => {},
  });
  return { relay, logs, answers, store };
}

test('a blocked event is delivered to every enabled provider with the same token', async () => {
  const telegram = fakeProvider('telegram');
  const discord = fakeProvider('discord');
  const slack = fakeProvider('slack');
  const { relay } = build({ providers: [telegram, discord, slack] });

  const failures = await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [telegram, discord, slack]);

  assert.deepEqual(failures, []);
  assert.equal(telegram.blocked.length, 1);
  assert.equal(discord.blocked.length, 1);
  assert.equal(slack.blocked.length, 1);
  assert.equal(telegram.blocked[0].token, discord.blocked[0].token);
  assert.equal(telegram.blocked[0].context, 'waiting for input');
  assert.deepEqual(telegram.blocked[0].options, MENU_OPTIONS);
});

test('every provider message id is tracked so an answer can arrive on any of them', async () => {
  const telegram = fakeProvider('telegram');
  const slack = fakeProvider('slack');
  const { relay, store } = build({ providers: [telegram, slack] });

  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [telegram, slack]);

  assert.deepEqual(store.getBlockedPanes(), ['pane-1']);
  assert.equal(store.resolveByMessageId('telegram', 'telegram-msg-1'), 'pane-1');
  assert.equal(store.resolveByMessageId('slack', 'slack-msg-1'), 'pane-1');
  assert.equal(store.getDeliveries('pane-1').length, 2);
});

test('no token is generated when the pane has no detected options', async () => {
  const telegram = fakeProvider('telegram');
  const { relay } = build({ providers: [telegram], options: [] });

  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [telegram]);

  assert.equal(telegram.blocked[0].token, undefined);
});

test('one failing provider is reported while the others still deliver and get tracked', async () => {
  const telegram = fakeProvider('telegram');
  const slack = fakeProvider('slack', { failSendBlocked: 'slack chat.postMessage failed: channel_not_found' });
  const { relay, store } = build({ providers: [telegram, slack] });

  const failures = await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [telegram, slack]);

  assert.deepEqual(failures, [
    { providerId: 'slack', message: 'slack chat.postMessage failed: channel_not_found' },
  ]);
  assert.deepEqual(store.getBlockedPanes(), ['pane-1']);
  assert.equal(store.getDeliveries('pane-1').length, 1);
});

test('a pane no provider could be told about is left untracked', async () => {
  const telegram = fakeProvider('telegram', { failSendBlocked: 'boom' });
  const { relay, store } = build({ providers: [telegram] });

  const failures = await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [telegram]);

  assert.equal(failures.length, 1);
  assert.deepEqual(store.getBlockedPanes(), []);
});

test('pollUpdates does nothing while the relay is disabled', async () => {
  const telegram = fakeProvider('telegram');
  const { relay } = build({ providers: [telegram], config: relayConfig({ relay: { enabled: false } }) });

  await relay.pollUpdates();

  assert.deepEqual(telegram.fetched, []);
});

test('pollUpdates polls every enabled provider and stores each cursor separately', async () => {
  const telegram = fakeProvider('telegram', { inbound: [{ events: [], cursor: 120 }] });
  const slack = fakeProvider('slack', { inbound: [{ events: [], cursor: '1.5' }] });
  const { relay, store } = build({ providers: [telegram, slack] });

  await relay.pollUpdates();

  assert.deepEqual(telegram.fetched, [undefined]);
  assert.equal(store.getCursor('telegram', 'target-telegram'), 120);
  assert.equal(store.getCursor('slack', 'target-slack'), '1.5');
});

test('one provider failing to poll does not stop the others', async () => {
  const telegram = {
    ...fakeProvider('telegram'),
    async fetchInbound() {
      throw new Error('network down');
    },
  };
  const slack = fakeProvider('slack', { inbound: [{ events: [], cursor: '1.5' }] });
  const { relay, logs, store } = build({ providers: [telegram, slack] });

  await relay.pollUpdates();

  assert.ok(logs.some((line) => line.includes('telegram relay poll failed: network down')));
  assert.equal(store.getCursor('slack', 'target-slack'), '1.5');
});

test('a button press answers the pane with the selected option value', async () => {
  const telegram = fakeProvider('telegram');
  const { relay, store, answers } = build({ providers: [telegram] });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [telegram]);
  const token = telegram.blocked[0].token;

  telegram.fetchInbound = async () => ({
    events: [{ kind: 'action', id: '1', actionId: 'cb-1', data: `r:${token}:1`, messageId: 'telegram-msg-1' }],
    cursor: 5,
  });
  await relay.pollUpdates();

  assert.deepEqual(answers, [{ paneId: 'pane-1', text: '2' }]);
  assert.deepEqual(telegram.acknowledged, [{ actionId: 'cb-1', text: 'Sent.' }]);
  assert.deepEqual(store.getBlockedPanes(), []);
});

test('an answered question is marked answered on every provider that received it', async () => {
  const telegram = fakeProvider('telegram');
  const discord = fakeProvider('discord');
  const store = fakeStore();
  const { relay } = build({ providers: [telegram, discord], store });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [telegram, discord]);
  const token = telegram.blocked[0].token;

  telegram.fetchInbound = async () => ({
    events: [{ kind: 'action', id: '1', actionId: 'cb-1', data: `r:${token}:0`, messageId: 'telegram-msg-1' }],
    cursor: 5,
  });
  discord.fetchInbound = async () => ({ events: [], cursor: '1' });
  await relay.pollUpdates();

  assert.deepEqual(telegram.answered, [
    { messageId: 'telegram-msg-1', baseText: 'telegram base', selectedLabel: '1. Yes, proceed' },
  ]);
  assert.deepEqual(discord.answered, [
    { messageId: 'discord-msg-1', baseText: 'discord base', selectedLabel: '1. Yes, proceed' },
  ]);
});

test('a failure to edit the answered message is logged, not surfaced as a relay failure', async () => {
  const telegram = fakeProvider('telegram', { failMarkAnswered: true });
  const store = fakeStore();
  const { relay, logs, answers } = build({ providers: [telegram], store });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [telegram]);
  const token = telegram.blocked[0].token;

  telegram.fetchInbound = async () => ({
    events: [{ kind: 'action', id: '1', actionId: 'cb-1', data: `r:${token}:0`, messageId: 'telegram-msg-1' }],
    cursor: 5,
  });
  await relay.pollUpdates();

  assert.equal(answers.length, 1);
  assert.ok(logs.some((line) => line.includes('failed to update the answered message: too old to edit')));
  assert.deepEqual(telegram.texts, [], 'the user is not told the relay failed');
});

test('a button press for an expired token is acknowledged as expired and answers nothing', async () => {
  const telegram = fakeProvider('telegram', {
    inbound: [{ events: [{ kind: 'action', id: '1', actionId: 'cb-1', data: 'r:gone:0' }], cursor: 5 }],
  });
  const { relay, answers } = build({ providers: [telegram] });

  await relay.pollUpdates();

  assert.deepEqual(answers, []);
  assert.deepEqual(telegram.acknowledged, [{ actionId: 'cb-1', text: 'This question has expired.' }]);
});

test('callback data that is not ours is ignored entirely', async () => {
  const telegram = fakeProvider('telegram', {
    inbound: [{ events: [{ kind: 'action', id: '1', actionId: 'cb-1', data: 'other:plugin:0' }], cursor: 5 }],
  });
  const { relay, answers } = build({ providers: [telegram] });

  await relay.pollUpdates();

  assert.deepEqual(answers, []);
  assert.deepEqual(telegram.acknowledged, []);
});

test('a reply on Discord answers the pane the Discord message belongs to', async () => {
  const discord = fakeProvider('discord');
  const store = fakeStore();
  const { relay, answers } = build({ providers: [discord], store });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [discord]);

  discord.fetchInbound = async () => ({
    events: [{ kind: 'text', id: '400', text: '2', replyToMessageId: 'discord-msg-1' }],
    cursor: '400',
  });
  await relay.pollUpdates();

  assert.deepEqual(answers, [{ paneId: 'pane-1', text: '2' }]);
});

test('a reply matching an option label is sent as the option value the widget expects', async () => {
  const slack = fakeProvider('slack');
  const store = fakeStore();
  const { relay, answers } = build({ providers: [slack], store });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [slack]);

  slack.fetchInbound = async () => ({
    events: [{ kind: 'text', id: '1.2', text: 'no', replyToMessageId: 'slack-msg-1' }],
    cursor: '1.2',
  });
  await relay.pollUpdates();

  assert.deepEqual(answers, [{ paneId: 'pane-1', text: '2' }]);
});

test('free text that matches no option is relayed verbatim', async () => {
  const slack = fakeProvider('slack');
  const store = fakeStore();
  const { relay, answers } = build({ providers: [slack], store });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [slack]);

  slack.fetchInbound = async () => ({
    events: [{ kind: 'text', id: '1.2', text: 'use the other branch', replyToMessageId: 'slack-msg-1' }],
    cursor: '1.2',
  });
  await relay.pollUpdates();

  assert.deepEqual(answers, [{ paneId: 'pane-1', text: 'use the other branch' }]);
});

test('a bare reply is accepted when exactly one pane is blocked', async () => {
  const slack = fakeProvider('slack');
  const store = fakeStore();
  const { relay, answers } = build({ providers: [slack], store });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [slack]);

  slack.fetchInbound = async () => ({
    events: [{ kind: 'text', id: '1.2', text: '1', replyToMessageId: null }],
    cursor: '1.2',
  });
  await relay.pollUpdates();

  assert.deepEqual(answers, [{ paneId: 'pane-1', text: '1' }]);
});

test('a bare reply with several panes blocked asks the user to reply to a specific one', async () => {
  const slack = fakeProvider('slack');
  const store = fakeStore();
  const { relay, answers } = build({ providers: [slack], store });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [slack]);
  await relay.notifyBlocked({ ...BLOCKED_EVENT, paneId: 'pane-2' }, relayConfig(), [slack]);

  slack.fetchInbound = async () => ({
    events: [{ kind: 'text', id: '1.9', text: '1', replyToMessageId: null }],
    cursor: '1.9',
  });
  await relay.pollUpdates();

  assert.deepEqual(answers, []);
  assert.ok(slack.texts.some((text) => text.includes('reply directly to the specific blocked-agent notification')));
});

test('selecting a free-text option keeps the pane open and asks for the text', async () => {
  const telegram = fakeProvider('telegram');
  const store = fakeStore();
  const freeTextOptions = [{ label: '1. Type something', value: '1', expectsText: true }];
  const { relay, answers } = build({ providers: [telegram], options: freeTextOptions, store });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [telegram]);
  const token = telegram.blocked[0].token;

  telegram.fetchInbound = async () => ({
    events: [{ kind: 'action', id: '1', actionId: 'cb-1', data: `r:${token}:0`, messageId: 'telegram-msg-1' }],
    cursor: 5,
  });
  await relay.pollUpdates();

  assert.deepEqual(answers, [{ paneId: 'pane-1', text: '1' }]);
  assert.equal(store.isAwaitingText('pane-1'), true);
  assert.deepEqual(store.getBlockedPanes(), ['pane-1']);
  assert.ok(telegram.prompts[0].includes('now reply with the text to send'));
  assert.equal(store.resolveByMessageId('telegram', 'telegram-prompt-1'), 'pane-1');
});

test('the follow-up text is relayed verbatim and closes the exchange', async () => {
  const telegram = fakeProvider('telegram');
  const store = fakeStore();
  store.trackBlocked('pane-1', {
    deliveries: [{ providerId: 'telegram', messageId: 'telegram-msg-1', baseText: 'base' }],
  });
  store.setAwaitingText('pane-1');
  const { relay, answers } = build({ providers: [telegram], store });

  telegram.fetchInbound = async () => ({
    events: [{ kind: 'text', id: '2', text: '2', replyToMessageId: 'telegram-msg-1' }],
    cursor: 6,
  });
  await relay.pollUpdates();

  assert.deepEqual(answers, [{ paneId: 'pane-1', text: '2' }], 'a digit is not re-matched against the old menu');
  assert.deepEqual(store.getBlockedPanes(), []);
});

test('a failure to type the answer into the pane is reported back in the same chat', async () => {
  const discord = fakeProvider('discord');
  const store = fakeStore();
  const { relay } = build({ providers: [discord], store });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [discord]);

  const { relay: failingRelay } = build({
    providers: [discord],
    store,
    answerFails: 'pane pane-1 is gone',
  });
  discord.fetchInbound = async () => ({
    events: [{ kind: 'text', id: '401', text: '1', replyToMessageId: 'discord-msg-1' }],
    cursor: '401',
  });
  await failingRelay.pollUpdates();

  assert.ok(discord.texts.some((text) => text.includes('Failed to relay your answer: pane pane-1 is gone')));
  assert.deepEqual(store.getBlockedPanes(), []);
});

test('a cursor advances even when the event it carried could not be processed', async () => {
  const telegram = fakeProvider('telegram');
  const store = fakeStore();
  const { relay } = build({ providers: [telegram], store });
  telegram.fetchInbound = async () => ({
    events: [{ kind: 'action', id: '1', actionId: 'cb-1', data: 'r:tok:0' }],
    cursor: 77,
  });
  telegram.acknowledgeAction = async () => {
    throw new Error('query is too old');
  };

  await relay.pollUpdates();

  assert.equal(store.getCursor('telegram', 'target-telegram'), 77, 'a stuck event must not stall the relay forever');
});

test('several inbound answers in one batch are all processed', async () => {
  const slack = fakeProvider('slack');
  const store = fakeStore();
  const { relay, answers } = build({ providers: [slack], store });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [slack]);
  await relay.notifyBlocked({ ...BLOCKED_EVENT, paneId: 'pane-2' }, relayConfig(), [slack]);

  slack.fetchInbound = async () => ({
    events: [
      { kind: 'text', id: '1.3', text: '1', replyToMessageId: 'slack-msg-1' },
      { kind: 'text', id: '1.4', text: '2', replyToMessageId: 'slack-msg-2' },
    ],
    cursor: '1.4',
  });
  await relay.pollUpdates();

  assert.deepEqual(answers, [
    { paneId: 'pane-1', text: '1' },
    { paneId: 'pane-2', text: '2' },
  ]);
});

test('the inbound cursor is scoped to the channel the provider points at', async () => {
  const slack = fakeProvider('slack', { inbound: [{ events: [], cursor: '200.1' }] });
  slack.targetId = 'C_NEW';
  const store = fakeStore();
  // A cursor left behind by the same provider pointed at a different channel.
  store.setCursor('slack', '100.5', 'C_OLD');
  const { relay } = build({ providers: [slack], store });

  await relay.pollUpdates();

  assert.deepEqual(slack.fetched, [undefined], 'a foreign channel cursor must not be replayed as oldest=');
  assert.equal(store.getCursor('slack', 'C_NEW'), '200.1');
});

test('the cursor is reused when the provider still points at the same channel', async () => {
  const slack = fakeProvider('slack', { inbound: [{ events: [], cursor: '100.9' }] });
  slack.targetId = 'C_SAME';
  const store = fakeStore();
  store.setCursor('slack', '100.5', 'C_SAME');
  const { relay } = build({ providers: [slack], store });

  await relay.pollUpdates();

  assert.deepEqual(slack.fetched, ['100.5']);
});

// --- multi-question prompts: answering one advances the pane to the next ---

const SECOND_QUESTION = [
  { label: '1. Inline link', value: '1' },
  { label: '2. Attach the file', value: '2' },
];

test('the next question of a multi-question prompt is announced after an answer', async () => {
  const slack = fakeProvider('slack');
  const store = fakeStore();
  const { relay, answers } = build({
    providers: [slack],
    options: [MENU_OPTIONS, SECOND_QUESTION],
    context: ['Report layout?', 'Report link?'],
    store,
  });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [slack]);

  slack.fetchInbound = async () => ({
    events: [{ kind: 'text', id: '1.2', text: '1', replyToMessageId: 'slack-msg-1' }],
    cursor: '1.2',
  });
  await relay.pollUpdates();

  assert.deepEqual(answers, [{ paneId: 'pane-1', text: '1' }]);
  assert.equal(slack.blocked.length, 2, 'the second question is sent as its own blocked message');
  assert.deepEqual(slack.blocked[1].options, SECOND_QUESTION);
  assert.equal(slack.blocked[1].context, 'Report link?');
});

test('the pane stays tracked so the next question can be answered too', async () => {
  const slack = fakeProvider('slack');
  const store = fakeStore();
  const { relay } = build({
    providers: [slack],
    options: [MENU_OPTIONS, SECOND_QUESTION],
    context: ['Report layout?', 'Report link?'],
    store,
  });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [slack]);

  slack.fetchInbound = async () => ({
    events: [{ kind: 'text', id: '1.2', text: '1', replyToMessageId: 'slack-msg-1' }],
    cursor: '1.2',
  });
  await relay.pollUpdates();

  assert.deepEqual(store.getBlockedPanes(), ['pane-1']);
  assert.equal(store.resolveByMessageId('slack', 'slack-msg-2'), 'pane-1', 'the new message routes to the pane');
  assert.deepEqual(store.resolveOptionsByPane('pane-1'), SECOND_QUESTION);
});

test('the follow-up reuses the agent label from the original event', async () => {
  const slack = fakeProvider('slack');
  const store = fakeStore();
  const { relay } = build({
    providers: [slack],
    options: [MENU_OPTIONS, SECOND_QUESTION],
    context: ['Report layout?', 'Report link?'],
    store,
  });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [slack]);

  slack.fetchInbound = async () => ({
    events: [{ kind: 'text', id: '1.2', text: '1', replyToMessageId: 'slack-msg-1' }],
    cursor: '1.2',
  });
  await relay.pollUpdates();

  assert.deepEqual(slack.blocked[1].event, BLOCKED_EVENT);
});

test('an answered prompt with no menu left expires the pane', async () => {
  const slack = fakeProvider('slack');
  const store = fakeStore();
  const { relay } = build({
    providers: [slack],
    options: [MENU_OPTIONS, []],
    context: ['Report layout?', 'all done'],
    store,
  });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [slack]);

  slack.fetchInbound = async () => ({
    events: [{ kind: 'text', id: '1.2', text: '1', replyToMessageId: 'slack-msg-1' }],
    cursor: '1.2',
  });
  await relay.pollUpdates();

  assert.deepEqual(store.getBlockedPanes(), []);
  assert.equal(slack.blocked.length, 1);
});

test('an unchanged menu is not re-announced, so a slow redraw cannot loop', async () => {
  const slack = fakeProvider('slack');
  const store = fakeStore();
  const { relay } = build({ providers: [slack], options: MENU_OPTIONS, store });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [slack]);

  slack.fetchInbound = async () => ({
    events: [{ kind: 'text', id: '1.2', text: '1', replyToMessageId: 'slack-msg-1' }],
    cursor: '1.2',
  });
  await relay.pollUpdates();

  assert.equal(slack.blocked.length, 1, 'the same question must not be sent again');
  assert.deepEqual(store.getBlockedPanes(), []);
});

test('a menu whose values changed is treated as a new question', async () => {
  const slack = fakeProvider('slack');
  const store = fakeStore();
  const relabelled = [
    { label: '1. Yes, proceed', value: '1' },
    { label: '2. No', value: '2' },
    { label: '3. Ask me later', value: '3' },
  ];
  const { relay } = build({
    providers: [slack],
    options: [MENU_OPTIONS, relabelled],
    context: ['first', 'second'],
    store,
  });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [slack]);

  slack.fetchInbound = async () => ({
    events: [{ kind: 'text', id: '1.2', text: '1', replyToMessageId: 'slack-msg-1' }],
    cursor: '1.2',
  });
  await relay.pollUpdates();

  assert.equal(slack.blocked.length, 2);
});

test('a free-text option still asks for the follow-up text instead of the next question', async () => {
  const slack = fakeProvider('slack');
  const store = fakeStore();
  const freeText = [{ label: '1. Type something', value: '1', expectsText: true }];
  const { relay } = build({
    providers: [slack],
    options: [freeText, SECOND_QUESTION],
    context: ['q1', 'q2'],
    store,
  });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [slack]);

  slack.fetchInbound = async () => ({
    events: [{ kind: 'text', id: '1.2', text: '1', replyToMessageId: 'slack-msg-1' }],
    cursor: '1.2',
  });
  await relay.pollUpdates();

  assert.equal(slack.prompts.length, 1, 'the text prompt takes priority over a next-question scan');
  assert.equal(slack.blocked.length, 1);
  assert.equal(store.isAwaitingText('pane-1'), true);
});

test('a failed re-read expires the pane rather than leaving it half-tracked', async () => {
  const slack = fakeProvider('slack');
  const store = fakeStore();
  const { relay, logs } = build({ providers: [slack], store });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [slack]);

  relay._readAgentOutput = async () => {
    throw new Error('pane is gone');
  };
  slack.fetchInbound = async () => ({
    events: [{ kind: 'text', id: '1.2', text: '1', replyToMessageId: 'slack-msg-1' }],
    cursor: '1.2',
  });
  await relay.pollUpdates();

  assert.deepEqual(store.getBlockedPanes(), []);
  assert.ok(logs.some((line) => line.includes('could not re-read pane-1 after answering: pane is gone')));
});

test('a button tap also advances to the next question', async () => {
  const telegram = fakeProvider('telegram');
  const store = fakeStore();
  const { relay } = build({
    providers: [telegram],
    options: [MENU_OPTIONS, SECOND_QUESTION],
    context: ['q1', 'q2'],
    store,
  });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [telegram]);
  const token = telegram.blocked[0].token;

  telegram.fetchInbound = async () => ({
    events: [{ kind: 'action', id: '1', actionId: 'cb-1', data: `r:${token}:0`, messageId: 'telegram-msg-1' }],
    cursor: 5,
  });
  await relay.pollUpdates();

  assert.equal(telegram.blocked.length, 2);
  assert.deepEqual(telegram.blocked[1].options, SECOND_QUESTION);
});

test('the next question gets its own token so the old buttons cannot answer it', async () => {
  const telegram = fakeProvider('telegram');
  const store = fakeStore();
  const { relay } = build({
    providers: [telegram],
    options: [MENU_OPTIONS, SECOND_QUESTION],
    context: ['q1', 'q2'],
    store,
  });
  await relay.notifyBlocked(BLOCKED_EVENT, relayConfig(), [telegram]);
  const firstToken = telegram.blocked[0].token;

  telegram.fetchInbound = async () => ({
    events: [{ kind: 'action', id: '1', actionId: 'cb-1', data: `r:${firstToken}:0`, messageId: 'telegram-msg-1' }],
    cursor: 5,
  });
  await relay.pollUpdates();

  assert.notEqual(telegram.blocked[1].token, firstToken);
  assert.equal(store.resolveByToken(firstToken), null, 'the answered question is no longer routable');
});

// --- auto-approve -----------------------------------------------------------

const PERMISSION_OPTIONS = [
  { label: 'Run (once)', value: 'y' },
  { label: 'Skip & tell the agent what to do instead', value: 'n', expectsText: true },
];
const PERMISSION_CONTEXT = [
  ' $  git status --short in /repo',
  '',
  ' Run this command?',
  '  → Run (once) (y)',
  '    Skip & tell the agent what to do instead (esc or n)',
].join('\n');

function autoApproveConfig(autoApprove = {}) {
  return relayConfig({
    autoApprove: { enabled: true, notify: true, globs: ['git status*'], regexes: [], ...autoApprove },
  });
}

test('a matching permission prompt is answered in the pane instead of announced', async () => {
  const telegram = fakeProvider('telegram');
  const { relay, answers, store } = build({
    providers: [telegram],
    options: PERMISSION_OPTIONS,
    context: PERMISSION_CONTEXT,
    config: autoApproveConfig(),
  });

  const failures = await relay.notifyBlocked(BLOCKED_EVENT, autoApproveConfig(), [telegram]);

  assert.deepEqual(failures, []);
  assert.deepEqual(answers, [{ paneId: 'pane-1', text: 'y' }], 'the affirmative key reaches the pane');
  assert.equal(telegram.blocked.length, 0, 'no question is posted for an auto-approved prompt');
  assert.deepEqual(store.getBlockedPanes(), [], 'nothing is left tracked — there is no question to answer');
});

test('the auto-approval notice names the command, the rule, and what was sent', async () => {
  const telegram = fakeProvider('telegram');
  const { relay } = build({
    providers: [telegram],
    options: PERMISSION_OPTIONS,
    context: PERMISSION_CONTEXT,
    config: autoApproveConfig(),
  });

  await relay.notifyBlocked(BLOCKED_EVENT, autoApproveConfig(), [telegram]);

  assert.equal(telegram.texts.length, 1);
  assert.match(telegram.texts[0], /git status --short/);
  assert.match(telegram.texts[0], /glob "git status\*"/);
  assert.match(telegram.texts[0], /Run \(once\)/);
});

test('notify:false auto-approves silently', async () => {
  const telegram = fakeProvider('telegram');
  const config = autoApproveConfig({ notify: false });
  const { relay, answers } = build({
    providers: [telegram],
    options: PERMISSION_OPTIONS,
    context: PERMISSION_CONTEXT,
    config,
  });

  await relay.notifyBlocked(BLOCKED_EVENT, config, [telegram]);

  assert.deepEqual(answers, [{ paneId: 'pane-1', text: 'y' }]);
  assert.equal(telegram.texts.length, 0, 'nothing is posted');
  assert.equal(telegram.blocked.length, 0);
});

test('a command matching no rule is announced normally', async () => {
  const telegram = fakeProvider('telegram');
  const config = autoApproveConfig({ globs: ['npm test'] });
  const { relay, answers } = build({
    providers: [telegram],
    options: PERMISSION_OPTIONS,
    context: PERMISSION_CONTEXT,
    config,
  });

  await relay.notifyBlocked(BLOCKED_EVENT, config, [telegram]);

  assert.deepEqual(answers, [], 'nothing is typed into the pane');
  assert.equal(telegram.blocked.length, 1, 'the normal question is posted');
});

test('autoApprove disabled leaves the existing behaviour untouched', async () => {
  const telegram = fakeProvider('telegram');
  const config = autoApproveConfig({ enabled: false });
  const { relay, answers } = build({
    providers: [telegram],
    options: PERMISSION_OPTIONS,
    context: PERMISSION_CONTEXT,
    config,
  });

  await relay.notifyBlocked(BLOCKED_EVENT, config, [telegram]);

  assert.deepEqual(answers, []);
  assert.equal(telegram.blocked.length, 1);
});

test('a multi-choice menu is never auto-approved, even under a catch-all rule', async () => {
  const telegram = fakeProvider('telegram');
  const config = autoApproveConfig({ globs: ['*'] });
  const { relay, answers } = build({
    providers: [telegram],
    options: [
      { label: '1. Use the main branch', value: '1' },
      { label: '2. Use the feature branch', value: '2' },
    ],
    context: PERMISSION_CONTEXT,
    config,
  });

  await relay.notifyBlocked(BLOCKED_EVENT, config, [telegram]);

  assert.deepEqual(answers, [], 'picking one of several real choices is not a permission grant');
  assert.equal(telegram.blocked.length, 1);
});

test('a prompt naming no command is announced, even under a catch-all rule', async () => {
  const telegram = fakeProvider('telegram');
  const config = autoApproveConfig({ globs: ['*'] });
  const { relay, answers } = build({
    providers: [telegram],
    options: PERMISSION_OPTIONS,
    context: ' Do you trust the contents of this directory?',
    config,
  });

  await relay.notifyBlocked(BLOCKED_EVENT, config, [telegram]);

  assert.deepEqual(answers, [], 'no extractable command means no auto-approve');
  assert.equal(telegram.blocked.length, 1);
});

test('a pane that cannot be answered falls back to announcing the question', async () => {
  const telegram = fakeProvider('telegram');
  const config = autoApproveConfig();
  const { relay, logs } = build({
    providers: [telegram],
    options: PERMISSION_OPTIONS,
    context: PERMISSION_CONTEXT,
    answerFails: 'pane is gone',
    config,
  });

  await relay.notifyBlocked(BLOCKED_EVENT, config, [telegram]);

  assert.equal(telegram.blocked.length, 1, 'the user must still see a pane that is still blocked');
  assert.ok(logs.some((line) => /auto-approve could not answer pane-1: pane is gone/.test(line)));
});

test('an invalid regex is reported and the valid rules still auto-approve', async () => {
  const telegram = fakeProvider('telegram');
  const config = autoApproveConfig({ globs: [], regexes: ['(unclosed', 'git status.*'] });
  const { relay, answers, logs } = build({
    providers: [telegram],
    options: PERMISSION_OPTIONS,
    context: PERMISSION_CONTEXT,
    config,
  });

  await relay.notifyBlocked(BLOCKED_EVENT, config, [telegram]);

  assert.deepEqual(answers, [{ paneId: 'pane-1', text: 'y' }]);
  assert.ok(logs.some((line) => /invalid autoApprove regex/.test(line)));
});

test('a provider that cannot post the notice does not fail the auto-approval', async () => {
  const telegram = fakeProvider('telegram');
  telegram.sendText = async () => {
    throw new Error('slack is down');
  };
  const config = autoApproveConfig();
  const { relay, answers, logs } = build({
    providers: [telegram],
    options: PERMISSION_OPTIONS,
    context: PERMISSION_CONTEXT,
    config,
  });

  const failures = await relay.notifyBlocked(BLOCKED_EVENT, config, [telegram]);

  assert.deepEqual(failures, [], 'the command already ran; a failed notice is not a failed notification');
  assert.deepEqual(answers, [{ paneId: 'pane-1', text: 'y' }]);
  assert.ok(logs.some((line) => /slack is down/.test(line)));
});

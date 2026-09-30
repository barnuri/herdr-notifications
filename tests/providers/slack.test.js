'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { SlackProvider } = require('../../lib/providers/slack');
const { stubHttp } = require('./stub-http');

function okResponse(body) {
  return { status: 200, ok: true, body: { ok: true, ...body } };
}

// The conversations.history throttle is static (providers are rebuilt every
// watcher tick), so it has to be cleared between tests or the first test in the
// file starves every later one of its history call.
function provider(httpClient, providerConfig = { botToken: 'xoxb-token', channelId: 'C1' }) {
  SlackProvider.resetHistoryGates();
  return new SlackProvider({ providerConfig, httpClient, log: () => {} });
}

test('isConfigured requires both a bot token and a channel id', () => {
  assert.equal(new SlackProvider({ providerConfig: { botToken: 't', channelId: 'C1' } }).isConfigured(), true);
  assert.equal(new SlackProvider({ providerConfig: { botToken: 't', channelId: '' } }).isConfigured(), false);
  assert.equal(new SlackProvider({ providerConfig: {} }).isConfigured(), false);
});

test('buttons are not offered — Block Kit actions need a public request URL', () => {
  assert.equal(provider(stubHttp(okResponse({})).client).supportsButtons, false);
});

test('sendStatus posts mrkdwn with a bearer authorization header', async () => {
  const http = stubHttp(okResponse({ ts: '1750000000.000100' }));
  const result = await provider(http.client).sendStatus({ type: 'done', paneId: 'p1', agent: { agent: 'agent-a' } });

  assert.equal(http.calls[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(http.calls[0].options.headers.authorization, 'Bearer xoxb-token');
  assert.equal(http.calls[0].payload.channel, 'C1');
  assert.equal(http.calls[0].payload.text, '🟢 *agent-a* is done');
  assert.deepEqual(result, { messageId: '1750000000.000100' });
});

test("Slack's reserved entity characters are escaped in the agent label", () => {
  const formatted = SlackProvider.formatStatus({ type: 'idle', paneId: 'p', agent: { agent: 'a<b>&c' } });
  assert.equal(formatted, '🟡 *a&lt;b&gt;&amp;c* is idle (finished working)');
});

test('sendBlocked wraps the context in a fenced block', async () => {
  const http = stubHttp(okResponse({ ts: '1.1' }));
  const result = await provider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context: 'waiting for input',
    options: [],
  });

  assert.match(http.calls[0].payload.text, /```\nwaiting for input\n```/);
  assert.equal(result.messageId, '1.1');
  assert.equal(result.baseText, http.calls[0].payload.text);
});

test('sendBlocked lists each option keyed by the value to reply with', async () => {
  const http = stubHttp(okResponse({ ts: '1.2' }));
  await provider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context: 'ctx',
    options: [
      { label: '1. Proceed', value: '1' },
      { label: '2. Chat about this', value: '2', expectsText: true },
    ],
  });

  const text = http.calls[0].payload.text;
  assert.match(text, /`1` — Proceed/);
  assert.match(text, /`2` — Chat about this ✏️/);
});

test('the first inbound poll adopts the newest ts without replaying the backlog', async () => {
  const http = stubHttp(okResponse({ messages: [{ ts: '100.1', text: 'old chatter', user: 'U1' }] }));
  const { events, cursor } = await provider(http.client).fetchInbound(undefined);

  assert.deepEqual(events, []);
  assert.equal(cursor, '100.1');
  assert.equal(http.calls[0].payload.oldest, undefined);
});

test('subsequent polls pass the cursor as oldest and return messages oldest-first', async () => {
  const http = stubHttp(
    okResponse({
      messages: [
        { ts: '100.3', text: 'second', user: 'U1' },
        { ts: '100.2', text: 'first', user: 'U1' },
      ],
    }),
  );
  const { events, cursor } = await provider(http.client).fetchInbound('100.1');

  assert.equal(http.calls[0].payload.oldest, '100.1');
  assert.equal(http.calls[0].payload.limit, 100);
  assert.deepEqual(
    events.map((event) => event.text),
    ['first', 'second'],
  );
  assert.equal(cursor, '100.3');
});

test('app-posted messages are dropped so the relay never reads its own notification back', async () => {
  const http = stubHttp(
    okResponse({
      messages: [
        { ts: '100.5', text: '🔴 *a* is blocked', bot_id: 'B1' },
        { ts: '100.4', text: 'a human answer', user: 'U1' },
      ],
    }),
  );
  const { events } = await provider(http.client).fetchInbound('100.1');

  assert.equal(events.length, 1);
  assert.equal(events[0].text, 'a human answer');
});

test('subtyped messages such as channel joins are not treated as answers', async () => {
  const http = stubHttp(
    okResponse({ messages: [{ ts: '100.6', text: 'has joined the channel', subtype: 'channel_join', user: 'U1' }] }),
  );
  const { events } = await provider(http.client).fetchInbound('100.1');

  assert.deepEqual(events, []);
});

test('a thread reply is normalized into replyToMessageId', async () => {
  const http = stubHttp(
    okResponse({ messages: [{ ts: '100.7', thread_ts: '1.1', text: '2', user: 'U1' }] }),
  );
  const { events } = await provider(http.client).fetchInbound('100.1');

  assert.deepEqual(events[0], { kind: 'text', id: '100.7', text: '2', replyToMessageId: '1.1' });
});

test('a thread parent is not mistaken for a reply to itself', async () => {
  const http = stubHttp(
    okResponse({ messages: [{ ts: '100.8', thread_ts: '100.8', text: 'parent', user: 'U1' }] }),
  );
  const { events } = await provider(http.client).fetchInbound('100.1');

  assert.equal(events[0].replyToMessageId, null);
});

test('an empty channel keeps the cursor unchanged', async () => {
  const http = stubHttp(okResponse({ messages: [] }));
  const { events, cursor } = await provider(http.client).fetchInbound('100.1');

  assert.deepEqual(events, []);
  assert.equal(cursor, '100.1');
});

test('markAnswered updates the original message by ts', async () => {
  const http = stubHttp(okResponse({}));
  await provider(http.client).markAnswered({ messageId: '1.1', baseText: 'base', selectedLabel: 'Yes' });

  assert.equal(http.calls[0].url, 'https://slack.com/api/chat.update');
  assert.equal(http.calls[0].payload.ts, '1.1');
  assert.match(http.calls[0].payload.text, /✅ Selected: \*Yes\*/);
});

test('acknowledgeAction is a no-op because answers arrive as ordinary messages', async () => {
  const http = stubHttp(okResponse({}));
  await provider(http.client).acknowledgeAction('unused');

  assert.equal(http.calls.length, 0);
});

test('a Slack ok:false response becomes an error naming the method and error string', async () => {
  const http = stubHttp({ status: 200, ok: true, body: { ok: false, error: 'channel_not_found' } });

  await assert.rejects(
    () => provider(http.client).sendText('hi'),
    /slack chat.postMessage failed: channel_not_found/,
  );
});

test('a missing body falls back to reporting the HTTP status', async () => {
  const http = stubHttp({ status: 500, ok: false, body: null });

  await assert.rejects(() => provider(http.client).sendText('hi'), /slack chat.postMessage failed: HTTP 500/);
});

test('the bot token never appears in an error message', async () => {
  const http = stubHttp({ status: 200, ok: true, body: { ok: false, error: 'invalid_auth' } });

  await assert.rejects(
    () => provider(http.client).sendText('hi'),
    (error) => !error.message.includes('xoxb-token'),
  );
});

// --- Socket Mode buttons (only when an app-level token is configured) ---

function fakeSocket(events = []) {
  return {
    starts: 0,
    // Exposed so a test can queue a click between two polls, the way a real
    // connection receives one while the history poll is paused.
    queue: [...events],
    async start() {
      this.starts += 1;
    },
    drainEvents() {
      const drained = [...this.queue];
      this.queue.length = 0;
      return drained;
    },
  };
}

function buttonProvider(httpClient, socket = fakeSocket()) {
  SlackProvider.resetHistoryGates();
  return new SlackProvider({
    providerConfig: { botToken: 'xoxb-token', channelId: 'C1', appToken: 'xapp-token' },
    httpClient,
    socket,
    log: () => {},
  });
}

test('buttons are offered only when an app-level token gives it a socket', () => {
  const http = stubHttp(okResponse({}));
  assert.equal(provider(http.client).supportsButtons, false, 'no app token means no way to receive a click');
  assert.equal(buttonProvider(http.client).supportsButtons, true);
});

test('sendBlocked renders one Block Kit button per option', async () => {
  const http = stubHttp(okResponse({ ts: '2.1' }));
  await buttonProvider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context: 'ctx',
    options: [
      { label: '1. Proceed', value: '1' },
      { label: '2. Cancel', value: '2' },
    ],
    token: 'tok',
  });

  const [section, actions] = http.calls[0].payload.blocks;
  assert.equal(section.type, 'section');
  assert.equal(actions.type, 'actions');
  assert.equal(actions.elements.length, 2);
  assert.equal(actions.elements[0].type, 'button');
  assert.equal(actions.elements[0].text.text, '1. Proceed');
});

test('button routing data matches the format the relay already parses', async () => {
  const http = stubHttp(okResponse({ ts: '2.2' }));
  await buttonProvider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context: 'ctx',
    options: [{ label: '1. Proceed', value: '1' }],
    token: 'abcd1234',
  });

  const [, actions] = http.calls[0].payload.blocks;
  assert.equal(actions.elements[0].action_id, 'r:abcd1234:0');
  assert.equal(actions.elements[0].value, 'r:abcd1234:0');
});

test('a free-text option is marked so the follow-up reply is expected', async () => {
  const http = stubHttp(okResponse({ ts: '2.3' }));
  await buttonProvider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context: 'ctx',
    options: [{ label: '2. Type something', value: '2', expectsText: true }],
    token: 'tok',
  });

  const [, actions] = http.calls[0].payload.blocks;
  assert.equal(actions.elements[0].text.text, '2. Type something ✏️');
});

test('a button label longer than Slack allows is truncated', async () => {
  const http = stubHttp(okResponse({ ts: '2.4' }));
  await buttonProvider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context: 'ctx',
    options: [{ label: `1. ${'x'.repeat(200)}`, value: '1' }],
    token: 'tok',
  });

  const [, actions] = http.calls[0].payload.blocks;
  assert.equal(actions.elements[0].text.text.length, SlackProvider.MAX_BUTTON_TEXT_CHARS);
});

test('the button message still invites a typed answer', async () => {
  const http = stubHttp(okResponse({ ts: '2.5' }));
  await buttonProvider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context: 'ctx',
    options: [{ label: '1. Proceed', value: '1' }],
    token: 'tok',
  });

  assert.match(http.calls[0].payload.text, /Tap a button, or reply with your own answer\./);
});

test('a blocked pane with no options sends no blocks even with buttons available', async () => {
  const http = stubHttp(okResponse({ ts: '2.6' }));
  await buttonProvider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context: 'ctx',
    options: [],
  });

  assert.equal(http.calls[0].payload.blocks, undefined);
});

test('without an app token the numbered list is still used', async () => {
  const http = stubHttp(okResponse({ ts: '2.7' }));
  await provider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context: 'ctx',
    options: [{ label: '1. Proceed', value: '1' }],
    token: 'tok',
  });

  assert.equal(http.calls[0].payload.blocks, undefined);
  assert.match(http.calls[0].payload.text, /`1` — Proceed/);
});

test('fetchInbound returns socket button clicks alongside typed replies', async () => {
  const http = stubHttp(okResponse({ messages: [{ ts: '100.2', text: 'typed answer', user: 'U1' }] }));
  const socket = fakeSocket([
    { kind: 'action', id: 'a1', actionId: 'trigger-1', data: 'r:tok:0', messageId: '1.1', channelId: 'C1' },
  ]);
  const { events, cursor } = await buttonProvider(http.client, socket).fetchInbound('100.1');

  assert.equal(socket.starts, 1, 'the connection is (re)started on every poll');
  assert.deepEqual(
    events.map((event) => event.kind),
    ['action', 'text'],
    'a tap is processed before a typed message',
  );
  assert.equal(cursor, '100.2');
});

test('a click from another channel is dropped', async () => {
  const http = stubHttp(okResponse({ messages: [] }));
  const socket = fakeSocket([
    { kind: 'action', id: 'a1', actionId: 't', data: 'r:tok:0', messageId: '1.1', channelId: 'C_OTHER' },
  ]);
  const { events } = await buttonProvider(http.client, socket).fetchInbound('100.1');

  assert.deepEqual(events, []);
});

test('markAnswered replaces the blocks so the buttons stop being tappable', async () => {
  const http = stubHttp(okResponse({}));
  await buttonProvider(http.client).markAnswered({ messageId: '2.1', baseText: 'base', selectedLabel: 'Proceed' });

  assert.equal(http.calls[0].url, 'https://slack.com/api/chat.update');
  assert.equal(http.calls[0].payload.blocks.length, 1);
  assert.equal(http.calls[0].payload.blocks[0].type, 'section');
  assert.match(http.calls[0].payload.text, /✅ Selected: \*Proceed\*/);
});

// --- Button clicks must survive a failing or throttled history poll ---
//
// Regression guard for the reason Slack buttons mostly did nothing: the socket
// queue was drained first and conversations.history was called second, so any
// failure there threw out of fetchInbound and took the already-drained clicks
// with it. conversations.history is Tier 3 (~50/min) and the relay polls every
// second, so that failure was the normal case, not the edge case.

function clockedProvider(httpClient, { socket = fakeSocket(), now = () => 0 } = {}) {
  SlackProvider.resetHistoryGates();
  return new SlackProvider({
    providerConfig: { botToken: 'xoxb-token', channelId: 'C1', appToken: 'xapp-token' },
    httpClient,
    socket,
    now,
    log: () => {},
  });
}

function throwingHttp(message) {
  const calls = [];
  return {
    calls,
    client: {
      async postJson(url, payload, options) {
        calls.push({ url, payload, options });
        throw new Error(message);
      },
    },
  };
}

test('a button click is still delivered when conversations.history throws', async () => {
  const http = throwingHttp('slack conversations.history failed: ratelimited');
  const socket = fakeSocket([{ kind: 'action', id: 'a1', data: 'r:tok:0', channelId: 'C1' }]);

  const { events, cursor } = await clockedProvider(http.client, { socket }).fetchInbound('100.1');

  assert.equal(events.length, 1, 'the drained click must not be lost with the failed history poll');
  assert.equal(events[0].data, 'r:tok:0');
  assert.equal(cursor, '100.1', 'a failed history poll must not advance the cursor');
});

test('a button click is still delivered when conversations.history is rate limited', async () => {
  const http = stubHttp({ status: 429, ok: false, body: { ok: false, error: 'ratelimited' }, retryAfterMs: 30000 });
  const socket = fakeSocket([{ kind: 'action', id: 'a1', data: 'r:tok:1', channelId: 'C1' }]);

  const { events, cursor } = await clockedProvider(http.client, { socket }).fetchInbound('100.1');

  assert.deepEqual(
    events.map((event) => event.data),
    ['r:tok:1'],
  );
  assert.equal(cursor, '100.1');
});

test('a rate limit pauses history polls for the window Slack named, not the socket drain', async () => {
  const http = stubHttp({ status: 429, ok: false, body: { ok: false, error: 'ratelimited' }, retryAfterMs: 30000 });
  let nowMs = 0;
  const socket = fakeSocket([{ kind: 'action', id: 'a1', data: 'r:tok:0', channelId: 'C1' }]);
  const slack = clockedProvider(http.client, { socket, now: () => nowMs });

  await slack.fetchInbound('100.1');
  assert.equal(http.calls.length, 1);

  // Still inside the Retry-After window: no further history call, but a click
  // that arrived meanwhile is handed over regardless.
  nowMs = 29000;
  socket.queue.push({ kind: 'action', id: 'a2', data: 'r:tok:1', channelId: 'C1' });
  const during = await slack.fetchInbound('100.1');
  assert.equal(http.calls.length, 1, 'retrying inside the window only earns another 429');
  assert.deepEqual(
    during.events.map((event) => event.data),
    ['r:tok:1'],
  );

  nowMs = 31000;
  await slack.fetchInbound('100.1');
  assert.equal(http.calls.length, 2, 'the history poll resumes once the window has passed');
});

test('history polls are throttled below the relay poll interval to stay inside Slack Tier 3', async () => {
  const http = stubHttp(okResponse({ messages: [] }));
  let nowMs = 0;
  const slack = clockedProvider(http.client, { now: () => nowMs });

  await slack.fetchInbound('100.1');
  nowMs = SlackProvider.MIN_HISTORY_INTERVAL_MS - 1;
  await slack.fetchInbound('100.1');
  assert.equal(http.calls.length, 1, 'a second poll inside the interval is skipped');

  nowMs = SlackProvider.MIN_HISTORY_INTERVAL_MS;
  await slack.fetchInbound('100.1');
  assert.equal(http.calls.length, 2);
});

test('a history failure is logged once per distinct reason, not once per poll', async () => {
  const http = throwingHttp('slack conversations.history failed: ratelimited');
  const lines = [];
  SlackProvider.resetHistoryGates();
  let nowMs = 0;
  const slack = new SlackProvider({
    providerConfig: { botToken: 'xoxb-token', channelId: 'C1', appToken: 'xapp-token' },
    httpClient: http.client,
    socket: fakeSocket(),
    now: () => nowMs,
    log: (line) => lines.push(line),
  });

  await slack.fetchInbound('100.1');
  nowMs = 10000;
  await slack.fetchInbound('100.1');

  assert.equal(http.calls.length, 2);
  assert.equal(lines.length, 1, 'a sustained failure must not grow the log without bound');
  assert.match(lines[0], /ratelimited/);
});

test('an unroutable click is reported in the channel, since Socket Mode has no toast', async () => {
  const http = stubHttp(okResponse({ ts: '9.9' }));
  await provider(http.client).acknowledgeAction('trigger', 'This question has expired.', { failed: true });

  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(http.calls[0].payload.text, 'This question has expired.');
});

test('a click that worked posts nothing, because markAnswered already shows it', async () => {
  const http = stubHttp(okResponse({ ts: '9.9' }));
  await provider(http.client).acknowledgeAction('trigger', 'Sent.');

  assert.equal(http.calls.length, 0);
});

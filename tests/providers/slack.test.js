'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { SlackProvider } = require('../../lib/providers/slack');
const { stubHttp } = require('./stub-http');

function okResponse(body) {
  return { status: 200, ok: true, body: { ok: true, ...body } };
}

function provider(httpClient, providerConfig = { botToken: 'xoxb-token', channelId: 'C1' }) {
  return new SlackProvider({ providerConfig, httpClient });
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
  const queue = [...events];
  return {
    starts: 0,
    async start() {
      this.starts += 1;
    },
    drainEvents() {
      const drained = [...queue];
      queue.length = 0;
      return drained;
    },
  };
}

function buttonProvider(httpClient, socket = fakeSocket()) {
  return new SlackProvider({
    providerConfig: { botToken: 'xoxb-token', channelId: 'C1', appToken: 'xapp-token' },
    httpClient,
    socket,
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

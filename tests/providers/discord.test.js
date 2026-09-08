'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { DiscordProvider } = require('../../lib/providers/discord');
const { stubHttp } = require('./stub-http');

const CHANNEL_URL = 'https://discord.com/api/v10/channels/C1/messages';

function okResponse(body) {
  return { status: 200, ok: true, body };
}

function provider(httpClient, providerConfig = { botToken: 'bot-token', channelId: 'C1' }) {
  return new DiscordProvider({ providerConfig, httpClient });
}

test('isConfigured requires both a bot token and a channel id', () => {
  assert.equal(new DiscordProvider({ providerConfig: { botToken: 't', channelId: 'C1' } }).isConfigured(), true);
  assert.equal(new DiscordProvider({ providerConfig: { botToken: '', channelId: 'C1' } }).isConfigured(), false);
  assert.equal(new DiscordProvider({ providerConfig: {} }).isConfigured(), false);
});

test('buttons are not offered — Discord components need a public interactions endpoint', () => {
  assert.equal(provider(stubHttp(okResponse({})).client).supportsButtons, false);
});

test('sendStatus posts markdown with a bot authorization header', async () => {
  const http = stubHttp(okResponse({ id: '900' }));
  const result = await provider(http.client).sendStatus({ type: 'idle', paneId: 'p1', agent: { agent: 'agent-a' } });

  assert.equal(http.calls[0].url, CHANNEL_URL);
  assert.equal(http.calls[0].options.headers.authorization, 'Bot bot-token');
  assert.equal(http.calls[0].payload.content, '🟡 **agent-a** is idle (finished working)');
  assert.deepEqual(result, { messageId: '900' });
});

test('formatting characters in an agent label are escaped', () => {
  const formatted = DiscordProvider.formatStatus({ type: 'done', paneId: 'p', agent: { agent: 'fix_*thing*' } });
  assert.equal(formatted, '🟢 **fix\\_\\*thing\\*** is done');
});

test('sendBlocked wraps the context in a fenced block', async () => {
  const http = stubHttp(okResponse({ id: '901' }));
  const result = await provider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context: 'waiting for input',
    options: [],
  });

  assert.match(http.calls[0].payload.content, /```\nwaiting for input\n```/);
  assert.equal(result.messageId, '901');
  assert.equal(result.baseText, http.calls[0].payload.content);
});

test('a fence inside the context cannot break out of the code block', async () => {
  const http = stubHttp(okResponse({ id: '902' }));
  await provider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context: 'before ``` after',
    options: [],
  });

  const fenceCount = http.calls[0].payload.content.split('```').length - 1;
  assert.equal(fenceCount, 2, 'only the opening and closing fences remain');
});

test('sendBlocked lists each option keyed by the value to reply with', async () => {
  const http = stubHttp(okResponse({ id: '903' }));
  await provider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context: 'ctx',
    options: [
      { label: '1. Proceed', value: '1' },
      { label: '2. Type something', value: '2', expectsText: true },
    ],
  });

  const content = http.calls[0].payload.content;
  assert.match(content, /Reply with one of these, or your own answer:/);
  assert.match(content, /`1` — Proceed/);
  assert.match(content, /`2` — Type something ✏️/);
});

test('a yes/no option keeps its label because it carries no number prefix', async () => {
  const http = stubHttp(okResponse({ id: '904' }));
  await provider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context: 'ctx',
    options: [
      { label: 'Yes', value: 'y' },
      { label: 'No', value: 'n' },
    ],
  });

  assert.match(http.calls[0].payload.content, /`y` — Yes/);
});

test('the context is truncated to keep the message under the Discord cap', async () => {
  const http = stubHttp(okResponse({ id: '905' }));
  await provider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context: `head${'x'.repeat(5000)}tail`,
    options: [],
  });

  const content = http.calls[0].payload.content;
  assert.ok(content.length < 2000);
  assert.ok(content.includes('tail'));
  assert.ok(!content.includes('head'));
});

test('the first inbound poll adopts the newest message id without replaying the backlog', async () => {
  const http = stubHttp(okResponse([{ id: '300', content: 'old chatter', author: { bot: false } }]));
  const { events, cursor } = await provider(http.client).fetchInbound(undefined);

  assert.deepEqual(events, []);
  assert.equal(cursor, '300');
  assert.ok(!http.calls[0].url.includes('after='));
});

test('subsequent polls request messages after the cursor and return them oldest-first', async () => {
  const http = stubHttp(
    okResponse([
      { id: '302', content: 'second', author: { bot: false } },
      { id: '301', content: 'first', author: { bot: false } },
    ]),
  );
  const { events, cursor } = await provider(http.client).fetchInbound('300');

  assert.match(http.calls[0].url, /after=300/);
  assert.match(http.calls[0].url, /limit=100/);
  assert.deepEqual(
    events.map((event) => event.text),
    ['first', 'second'],
  );
  assert.equal(cursor, '302');
});

test('messages from bots are dropped so the relay never reads its own notification back', async () => {
  const http = stubHttp(
    okResponse([
      { id: '311', content: '🔴 **a** is blocked', author: { bot: true } },
      { id: '310', content: 'a human answer', author: { bot: false } },
    ]),
  );
  const { events } = await provider(http.client).fetchInbound('300');

  assert.equal(events.length, 1);
  assert.equal(events[0].text, 'a human answer');
});

test('an empty-content message is ignored', async () => {
  const http = stubHttp(okResponse([{ id: '320', content: '', author: { bot: false } }]));
  const { events } = await provider(http.client).fetchInbound('300');

  assert.deepEqual(events, []);
});

test('a reply is normalized into replyToMessageId', async () => {
  const http = stubHttp(
    okResponse([
      { id: '330', content: '2', author: { bot: false }, message_reference: { message_id: '901' } },
    ]),
  );
  const { events } = await provider(http.client).fetchInbound('300');

  assert.deepEqual(events[0], { kind: 'text', id: '330', text: '2', replyToMessageId: '901' });
});

test('an empty channel keeps the cursor unchanged', async () => {
  const http = stubHttp(okResponse([]));
  const { events, cursor } = await provider(http.client).fetchInbound('300');

  assert.deepEqual(events, []);
  assert.equal(cursor, '300');
});

test('markAnswered patches the original message', async () => {
  const http = stubHttp(okResponse({}));
  await provider(http.client).markAnswered({ messageId: '901', baseText: 'base', selectedLabel: '1. Proceed' });

  assert.equal(http.calls[0].method, 'PATCH');
  assert.equal(http.calls[0].url, `${CHANNEL_URL}/901`);
  assert.match(http.calls[0].payload.content, /✅ Selected: \*\*1\. Proceed\*\*/);
});

test('acknowledgeAction is a no-op because answers arrive as ordinary messages', async () => {
  const http = stubHttp(okResponse({}));
  await provider(http.client).acknowledgeAction('unused');

  assert.equal(http.calls.length, 0);
});

test('a Discord error body becomes an error naming the method, code and message', async () => {
  const http = stubHttp({ status: 403, ok: false, body: { code: 50013, message: 'Missing Permissions' } });

  await assert.rejects(
    () => provider(http.client).sendText('hi'),
    /discord createMessage failed: HTTP 403, code 50013: Missing Permissions/,
  );
});

test('the bot token never appears in an error message', async () => {
  const http = stubHttp({ status: 401, ok: false, body: { code: 0, message: '401: Unauthorized' } });

  await assert.rejects(
    () => provider(http.client).sendText('hi'),
    (error) => !error.message.includes('bot-token'),
  );
});

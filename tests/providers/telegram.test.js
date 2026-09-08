'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { TelegramProvider } = require('../../lib/providers/telegram');
const { stubHttp } = require('./stub-http');

function okResponse(result) {
  return { status: 200, ok: true, body: { ok: true, result } };
}

function provider(httpClient, providerConfig = { botToken: 'bot-token', chatId: '4242' }) {
  return new TelegramProvider({ providerConfig, httpClient });
}

test('isConfigured requires both a bot token and a chat id', () => {
  assert.equal(new TelegramProvider({ providerConfig: { botToken: 't', chatId: '1' } }).isConfigured(), true);
  assert.equal(new TelegramProvider({ providerConfig: { botToken: 't', chatId: '' } }).isConfigured(), false);
  assert.equal(new TelegramProvider({ providerConfig: {} }).isConfigured(), false);
});

test('sendStatus posts HTML to the configured chat and returns the message id', async () => {
  const http = stubHttp(okResponse({ message_id: 99 }));
  const result = await provider(http.client).sendStatus({ type: 'done', paneId: 'p1', agent: { agent: 'agent-a' } });

  assert.equal(http.calls[0].url, 'https://api.telegram.org/botbot-token/sendMessage');
  assert.equal(http.calls[0].payload.chat_id, '4242');
  assert.equal(http.calls[0].payload.parse_mode, 'HTML');
  assert.equal(http.calls[0].payload.text, '🟢 <b>agent-a</b> is done');
  assert.deepEqual(result, { messageId: 99 });
});

test('sendBlocked renders the context in a pre block and returns the base text', async () => {
  const http = stubHttp(okResponse({ message_id: 5 }));
  const result = await provider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'agent-a' } },
    context: 'line one\n<script>',
    options: [],
  });

  assert.equal(http.calls[0].payload.reply_markup, undefined);
  assert.match(http.calls[0].payload.text, /<pre>line one\n&lt;script&gt;<\/pre>/);
  assert.equal(result.messageId, 5);
  assert.equal(result.baseText, http.calls[0].payload.text);
});

test('sendBlocked builds one callback button per option with the relay token', async () => {
  const http = stubHttp(okResponse({ message_id: 6 }));
  await provider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context: 'ctx',
    options: [
      { label: '1. Proceed', value: '1' },
      { label: '2. Type something', value: '2', expectsText: true },
    ],
    token: 'abcd1234',
  });

  const [row] = http.calls[0].payload.reply_markup.inline_keyboard;
  assert.deepEqual(row[0], { text: '1. Proceed', callback_data: 'r:abcd1234:0' });
  assert.equal(row[1].text, '2. Type something ✏️');
  assert.equal(row[1].callback_data, 'r:abcd1234:1');
  assert.match(http.calls[0].payload.text, /Tap a button, or reply with your own answer\./);
});

test('the base text excludes the button hint so a marked-answered message stays clean', async () => {
  const http = stubHttp(okResponse({ message_id: 6 }));
  const result = await provider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context: 'ctx',
    options: [{ label: '1. Proceed', value: '1' }],
    token: 'tok',
  });

  assert.ok(!result.baseText.includes('Tap a button'));
});

test('context longer than the cap is truncated from the front', async () => {
  const http = stubHttp(okResponse({ message_id: 7 }));
  const context = `head${'x'.repeat(TelegramProvider.MAX_CONTEXT_CHARS)}tail`;
  await provider(http.client).sendBlocked({
    event: { type: 'blocked', paneId: 'p1', agent: { agent: 'a' } },
    context,
    options: [],
  });

  const text = http.calls[0].payload.text;
  assert.ok(text.includes('tail'));
  assert.ok(!text.includes('head'));
});

test('sendTextPrompt asks Telegram to pre-focus the reply box', async () => {
  const http = stubHttp(okResponse({ message_id: 8 }));
  await provider(http.client).sendTextPrompt('reply with the text');

  assert.deepEqual(http.calls[0].payload.reply_markup, { force_reply: true });
});

test('fetchInbound passes the cursor as the offset and advances past the last update', async () => {
  const http = stubHttp(
    okResponse([
      { update_id: 10, message: { text: 'first', chat: { id: 4242 } } },
      { update_id: 11, message: { text: 'second', chat: { id: 4242 } } },
    ]),
  );
  const { events, cursor } = await provider(http.client).fetchInbound(10);

  assert.equal(http.calls[0].payload.offset, 10);
  assert.equal(cursor, 12);
  assert.deepEqual(
    events.map((event) => event.text),
    ['first', 'second'],
  );
});

test('fetchInbound keeps the cursor when there is nothing new', async () => {
  const http = stubHttp(okResponse([]));
  const { events, cursor } = await provider(http.client).fetchInbound(42);

  assert.deepEqual(events, []);
  assert.equal(cursor, 42);
});

test('fetchInbound drops messages from any chat other than the configured one', async () => {
  const http = stubHttp(
    okResponse([
      { update_id: 1, message: { text: 'intruder', chat: { id: 999 } } },
      { update_id: 2, message: { text: 'mine', chat: { id: 4242 } } },
    ]),
  );
  const { events } = await provider(http.client).fetchInbound(1);

  assert.equal(events.length, 1);
  assert.equal(events[0].text, 'mine');
});

test('fetchInbound normalizes a reply into replyToMessageId', async () => {
  const http = stubHttp(
    okResponse([
      { update_id: 3, message: { text: 'my answer', chat: { id: 4242 }, reply_to_message: { message_id: 77 } } },
    ]),
  );
  const { events } = await provider(http.client).fetchInbound(3);

  assert.equal(events[0].kind, 'text');
  assert.equal(events[0].replyToMessageId, 77);
});

test('fetchInbound normalizes a button press into an action event', async () => {
  const http = stubHttp(
    okResponse([
      {
        update_id: 4,
        callback_query: { id: 'cb-1', data: 'r:tok:2', message: { message_id: 55, chat: { id: 4242 } } },
      },
    ]),
  );
  const { events } = await provider(http.client).fetchInbound(4);

  assert.deepEqual(events[0], {
    kind: 'action',
    id: '4',
    actionId: 'cb-1',
    data: 'r:tok:2',
    messageId: 55,
  });
});

test('fetchInbound drops a button press from a foreign chat', async () => {
  const http = stubHttp(
    okResponse([
      { update_id: 5, callback_query: { id: 'cb-2', data: 'r:tok:0', message: { message_id: 1, chat: { id: 7 } } } },
    ]),
  );
  const { events, cursor } = await provider(http.client).fetchInbound(5);

  assert.deepEqual(events, []);
  assert.equal(cursor, 6, 'the cursor still advances so the dropped update is not redelivered forever');
});

test('fetchInbound ignores non-text messages such as photos', async () => {
  const http = stubHttp(okResponse([{ update_id: 6, message: { photo: [{}], chat: { id: 4242 } } }]));
  const { events } = await provider(http.client).fetchInbound(6);

  assert.deepEqual(events, []);
});

test('acknowledgeAction answers the callback query', async () => {
  const http = stubHttp(okResponse(true));
  await provider(http.client).acknowledgeAction('cb-9', 'Sent.');

  assert.equal(http.calls[0].url, 'https://api.telegram.org/botbot-token/answerCallbackQuery');
  assert.deepEqual(http.calls[0].payload, { callback_query_id: 'cb-9', text: 'Sent.' });
});

test('markAnswered edits the message and clears the keyboard', async () => {
  const http = stubHttp(okResponse({}));
  await provider(http.client).markAnswered({ messageId: 5, baseText: 'base', selectedLabel: '1. Yes & go' });

  assert.equal(http.calls[0].url, 'https://api.telegram.org/botbot-token/editMessageText');
  assert.equal(http.calls[0].payload.message_id, 5);
  assert.match(http.calls[0].payload.text, /✅ Selected: <b>1\. Yes &amp; go<\/b>/);
  assert.deepEqual(http.calls[0].payload.reply_markup, { inline_keyboard: [] });
});

test('a Telegram error envelope becomes an error naming the method, code and description', async () => {
  const http = stubHttp({ status: 400, ok: false, body: { ok: false, error_code: 400, description: 'chat not found' } });

  await assert.rejects(
    () => provider(http.client).sendText('hello'),
    /telegram sendMessage failed: HTTP 400, error_code 400: chat not found/,
  );
});

test('an HTTP 200 carrying ok:false is still treated as a failure', async () => {
  const http = stubHttp({ status: 200, ok: true, body: { ok: false } });

  await assert.rejects(
    () => provider(http.client).sendText('hello'),
    /telegram sendMessage failed: HTTP 200, error_code unknown: no description/,
  );
});

test('the bot token never appears in an error message', async () => {
  const http = stubHttp({ status: 401, ok: false, body: { ok: false, error_code: 401, description: 'Unauthorized' } });

  await assert.rejects(
    () => provider(http.client).sendText('hello'),
    (error) => !error.message.includes('bot-token'),
  );
});

test('the first inbound poll adopts the newest update without replaying the queue', async () => {
  const http = stubHttp(
    okResponse([{ update_id: 500, message: { text: 'stale answer', chat: { id: 4242 } } }]),
  );
  const { events, cursor } = await provider(http.client).fetchInbound(undefined);

  assert.equal(http.calls[0].payload.offset, -1);
  assert.deepEqual(events, []);
  assert.equal(cursor, 501);
});

test('the first inbound poll on an empty queue leaves the cursor unset', async () => {
  const http = stubHttp(okResponse([]));
  const { events, cursor } = await provider(http.client).fetchInbound(undefined);

  assert.deepEqual(events, []);
  assert.equal(cursor, undefined);
});

test('a non-array getUpdates result is tolerated', async () => {
  const http = stubHttp(okResponse(null));
  const { events, cursor } = await provider(http.client).fetchInbound(9);

  assert.deepEqual(events, []);
  assert.equal(cursor, 9);
});

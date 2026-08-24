'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sendMessage, getUpdates, answerCallbackQuery, editMessageText } = require('../lib/telegram.js');

const FAKE_TOKEN = '123456:FAKE-TEST-TOKEN';
const FAKE_CHAT_ID = '987654321';

function fakeFetch({ status = 200, jsonBody = { ok: true, result: {} } } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => jsonBody,
    };
  };
  return { impl, calls };
}

test('sendMessage posts JSON to the Telegram sendMessage endpoint', async () => {
  const { impl, calls } = fakeFetch({
    jsonBody: { ok: true, result: { message_id: 1 } },
  });

  await sendMessage({ botToken: FAKE_TOKEN, chatId: FAKE_CHAT_ID, text: 'hello', fetchImpl: impl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    chat_id: FAKE_CHAT_ID,
    text: 'hello',
    parse_mode: 'HTML',
  });
});

test('sendMessage omits parse_mode when parseMode is falsy', async () => {
  const { impl, calls } = fakeFetch();

  await sendMessage({
    botToken: FAKE_TOKEN,
    chatId: FAKE_CHAT_ID,
    text: 'hello',
    parseMode: null,
    fetchImpl: impl,
  });

  assert.deepEqual(JSON.parse(calls[0].options.body), { chat_id: FAKE_CHAT_ID, text: 'hello' });
});

test('sendMessage returns the parsed result on success', async () => {
  const messageResult = { message_id: 42, chat: { id: 987654321 } };
  const { impl } = fakeFetch({ jsonBody: { ok: true, result: messageResult } });

  const result = await sendMessage({
    botToken: FAKE_TOKEN,
    chatId: FAKE_CHAT_ID,
    text: 'hi',
    fetchImpl: impl,
  });

  assert.deepEqual(result, messageResult);
});

test('sendMessage throws on HTTP 401 without leaking the token', async () => {
  const { impl } = fakeFetch({
    status: 401,
    jsonBody: { ok: false, error_code: 401, description: 'Unauthorized' },
  });

  await assert.rejects(
    sendMessage({ botToken: FAKE_TOKEN, chatId: FAKE_CHAT_ID, text: 'hi', fetchImpl: impl }),
    (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.match(error.message, /401/);
      assert.ok(!error.message.includes(FAKE_TOKEN));
      assert.ok(!error.message.includes('api.telegram.org'));
      return true;
    }
  );
});

test('sendMessage throws when body.ok is false, including the description', async () => {
  const { impl } = fakeFetch({
    status: 200,
    jsonBody: { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
  });

  await assert.rejects(
    sendMessage({ botToken: FAKE_TOKEN, chatId: FAKE_CHAT_ID, text: 'hi', fetchImpl: impl }),
    (error) => {
      assert.match(error.message, /error_code 400/);
      assert.match(error.message, /Bad Request: chat not found/);
      assert.ok(!error.message.includes(FAKE_TOKEN));
      return true;
    }
  );
});

test('sendMessage rejects a missing botToken before fetching', async () => {
  const { impl, calls } = fakeFetch();

  await assert.rejects(
    sendMessage({ botToken: '', chatId: FAKE_CHAT_ID, text: 'hi', fetchImpl: impl }),
    (error) => {
      assert.match(error.message, /botToken/);
      assert.ok(!error.message.includes(FAKE_TOKEN));
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

test('sendMessage rejects a missing chatId before fetching', async () => {
  const { impl, calls } = fakeFetch();

  await assert.rejects(
    sendMessage({ botToken: FAKE_TOKEN, chatId: '', text: 'hi', fetchImpl: impl }),
    (error) => {
      assert.match(error.message, /chatId/);
      assert.ok(!error.message.includes(FAKE_TOKEN));
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

test('sendMessage includes reply_markup when replyMarkup is passed', async () => {
  const { impl, calls } = fakeFetch();
  const replyMarkup = { inline_keyboard: [[{ text: 'Yes', callback_data: 'yes' }]] };

  await sendMessage({
    botToken: FAKE_TOKEN,
    chatId: FAKE_CHAT_ID,
    text: 'hello',
    replyMarkup,
    fetchImpl: impl,
  });

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    chat_id: FAKE_CHAT_ID,
    text: 'hello',
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
  });
});

test('sendMessage omits reply_markup when replyMarkup is not passed', async () => {
  const { impl, calls } = fakeFetch();

  await sendMessage({ botToken: FAKE_TOKEN, chatId: FAKE_CHAT_ID, text: 'hello', fetchImpl: impl });

  const body = JSON.parse(calls[0].options.body);
  assert.ok(!('reply_markup' in body));
});

test('getUpdates posts offset/timeout/allowed_updates to the getUpdates endpoint', async () => {
  const { impl, calls } = fakeFetch({ jsonBody: { ok: true, result: [] } });

  await getUpdates(FAKE_TOKEN, { offset: 100, timeout: 30, allowedUpdates: ['message'], fetchImpl: impl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    offset: 100,
    timeout: 30,
    allowed_updates: ['message'],
  });
});

test('getUpdates returns the parsed result on success', async () => {
  const updates = [{ update_id: 1 }];
  const { impl } = fakeFetch({ jsonBody: { ok: true, result: updates } });

  const result = await getUpdates(FAKE_TOKEN, { fetchImpl: impl });

  assert.deepEqual(result, updates);
});

test('getUpdates throws on a non-ok response without leaking the token', async () => {
  const { impl } = fakeFetch({
    status: 409,
    jsonBody: { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' },
  });

  await assert.rejects(getUpdates(FAKE_TOKEN, { fetchImpl: impl }), (error) => {
    assert.match(error.message, /HTTP 409/);
    assert.match(error.message, /Conflict/);
    assert.ok(!error.message.includes(FAKE_TOKEN));
    assert.ok(!error.message.includes('api.telegram.org'));
    return true;
  });
});

test('getUpdates rejects a missing botToken before fetching', async () => {
  const { impl, calls } = fakeFetch();

  await assert.rejects(
    getUpdates('', { fetchImpl: impl }),
    (error) => {
      assert.match(error.message, /botToken/);
      assert.ok(!error.message.includes(FAKE_TOKEN));
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

test('answerCallbackQuery posts callback_query_id and text to the endpoint', async () => {
  const { impl, calls } = fakeFetch();

  await answerCallbackQuery(FAKE_TOKEN, 'cbq-1', { text: 'Got it', fetchImpl: impl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${FAKE_TOKEN}/answerCallbackQuery`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    callback_query_id: 'cbq-1',
    text: 'Got it',
  });
});

test('answerCallbackQuery omits text when not passed', async () => {
  const { impl, calls } = fakeFetch();

  await answerCallbackQuery(FAKE_TOKEN, 'cbq-1', { fetchImpl: impl });

  assert.deepEqual(JSON.parse(calls[0].options.body), { callback_query_id: 'cbq-1' });
});

test('answerCallbackQuery throws on a non-ok response without leaking the token', async () => {
  const { impl } = fakeFetch({
    status: 400,
    jsonBody: { ok: false, error_code: 400, description: 'Bad Request: query is too old' },
  });

  await assert.rejects(answerCallbackQuery(FAKE_TOKEN, 'cbq-1', { fetchImpl: impl }), (error) => {
    assert.match(error.message, /HTTP 400/);
    assert.match(error.message, /query is too old/);
    assert.ok(!error.message.includes(FAKE_TOKEN));
    assert.ok(!error.message.includes('api.telegram.org'));
    return true;
  });
});

test('answerCallbackQuery rejects a missing botToken before fetching', async () => {
  const { impl, calls } = fakeFetch();

  await assert.rejects(
    answerCallbackQuery('', 'cbq-1', { fetchImpl: impl }),
    (error) => {
      assert.match(error.message, /botToken/);
      assert.ok(!error.message.includes(FAKE_TOKEN));
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

test('editMessageText posts chat_id/message_id/text/reply_markup to the editMessageText endpoint', async () => {
  const { impl, calls } = fakeFetch({ jsonBody: { ok: true, result: { message_id: 5 } } });
  const replyMarkup = { inline_keyboard: [] };

  await editMessageText({
    botToken: FAKE_TOKEN,
    chatId: FAKE_CHAT_ID,
    messageId: 5,
    text: 'updated',
    replyMarkup,
    fetchImpl: impl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${FAKE_TOKEN}/editMessageText`);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    chat_id: FAKE_CHAT_ID,
    message_id: 5,
    text: 'updated',
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
  });
});

test('editMessageText omits parse_mode and reply_markup when not passed', async () => {
  const { impl, calls } = fakeFetch();

  await editMessageText({
    botToken: FAKE_TOKEN,
    chatId: FAKE_CHAT_ID,
    messageId: 5,
    text: 'updated',
    parseMode: null,
    fetchImpl: impl,
  });

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    chat_id: FAKE_CHAT_ID,
    message_id: 5,
    text: 'updated',
  });
});

test('editMessageText returns the parsed result on success', async () => {
  const messageResult = { message_id: 5, chat: { id: 987654321 } };
  const { impl } = fakeFetch({ jsonBody: { ok: true, result: messageResult } });

  const result = await editMessageText({
    botToken: FAKE_TOKEN,
    chatId: FAKE_CHAT_ID,
    messageId: 5,
    text: 'updated',
    fetchImpl: impl,
  });

  assert.deepEqual(result, messageResult);
});

test('editMessageText throws on a non-ok response without leaking the token', async () => {
  const { impl } = fakeFetch({
    status: 400,
    jsonBody: { ok: false, error_code: 400, description: "Bad Request: message can't be edited" },
  });

  await assert.rejects(
    editMessageText({ botToken: FAKE_TOKEN, chatId: FAKE_CHAT_ID, messageId: 5, text: 'updated', fetchImpl: impl }),
    (error) => {
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /message can't be edited/);
      assert.ok(!error.message.includes(FAKE_TOKEN));
      assert.ok(!error.message.includes('api.telegram.org'));
      return true;
    }
  );
});

test('editMessageText rejects a missing botToken/chatId before fetching', async () => {
  const { impl, calls } = fakeFetch();

  await assert.rejects(
    editMessageText({ botToken: '', chatId: FAKE_CHAT_ID, messageId: 5, text: 'updated', fetchImpl: impl }),
    (error) => {
      assert.match(error.message, /botToken/);
      return true;
    }
  );
  await assert.rejects(
    editMessageText({ botToken: FAKE_TOKEN, chatId: '', messageId: 5, text: 'updated', fetchImpl: impl }),
    (error) => {
      assert.match(error.message, /chatId/);
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sendMessage } = require('../lib/telegram.js');

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

'use strict';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Telegram config error: ${label} is missing or empty`);
  }
}

async function sendMessage({
  botToken,
  chatId,
  text,
  parseMode = 'HTML',
  replyMarkup,
  fetchImpl = globalThis.fetch,
} = {}) {
  assertNonEmptyString(botToken, 'botToken');
  assertNonEmptyString(chatId, 'chatId');

  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
  const requestBody = { chat_id: chatId, text };
  if (parseMode) {
    requestBody.parse_mode = parseMode;
  }
  if (replyMarkup) {
    requestBody.reply_markup = replyMarkup;
  }
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok || !body || body.ok === false) {
    const errorCode = body && body.error_code !== undefined ? body.error_code : 'unknown';
    const description = body && body.description ? body.description : 'no description';
    throw new Error(
      `Telegram sendMessage failed: HTTP ${response.status}, error_code ${errorCode}: ${description}`
    );
  }

  return body.result;
}

async function getUpdates(
  botToken,
  { offset, timeout = 0, allowedUpdates = ['message', 'callback_query'], fetchImpl = globalThis.fetch } = {}
) {
  assertNonEmptyString(botToken, 'botToken');

  const url = `${TELEGRAM_API_BASE}/bot${botToken}/getUpdates`;
  const requestBody = { offset, timeout, allowed_updates: allowedUpdates };
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok || !body || body.ok === false) {
    const errorCode = body && body.error_code !== undefined ? body.error_code : 'unknown';
    const description = body && body.description ? body.description : 'no description';
    throw new Error(
      `Telegram getUpdates failed: HTTP ${response.status}, error_code ${errorCode}: ${description}`
    );
  }

  return body.result;
}

async function answerCallbackQuery(botToken, callbackQueryId, { text, fetchImpl = globalThis.fetch } = {}) {
  assertNonEmptyString(botToken, 'botToken');

  const url = `${TELEGRAM_API_BASE}/bot${botToken}/answerCallbackQuery`;
  const requestBody = { callback_query_id: callbackQueryId };
  if (text) {
    requestBody.text = text;
  }
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok || !body || body.ok === false) {
    const errorCode = body && body.error_code !== undefined ? body.error_code : 'unknown';
    const description = body && body.description ? body.description : 'no description';
    throw new Error(
      `Telegram answerCallbackQuery failed: HTTP ${response.status}, error_code ${errorCode}: ${description}`
    );
  }

  return body.result;
}

async function editMessageText({
  botToken,
  chatId,
  messageId,
  text,
  parseMode = 'HTML',
  replyMarkup,
  fetchImpl = globalThis.fetch,
} = {}) {
  assertNonEmptyString(botToken, 'botToken');
  assertNonEmptyString(chatId, 'chatId');

  const url = `${TELEGRAM_API_BASE}/bot${botToken}/editMessageText`;
  const requestBody = { chat_id: chatId, message_id: messageId, text };
  if (parseMode) {
    requestBody.parse_mode = parseMode;
  }
  if (replyMarkup) {
    requestBody.reply_markup = replyMarkup;
  }
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok || !body || body.ok === false) {
    const errorCode = body && body.error_code !== undefined ? body.error_code : 'unknown';
    const description = body && body.description ? body.description : 'no description';
    throw new Error(
      `Telegram editMessageText failed: HTTP ${response.status}, error_code ${errorCode}: ${description}`
    );
  }

  return body.result;
}

module.exports = { sendMessage, getUpdates, answerCallbackQuery, editMessageText };

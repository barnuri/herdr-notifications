'use strict';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Telegram config error: ${label} is missing or empty`);
  }
}

async function sendMessage({ botToken, chatId, text, fetchImpl = globalThis.fetch } = {}) {
  assertNonEmptyString(botToken, 'botToken');
  assertNonEmptyString(chatId, 'chatId');

  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
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

module.exports = { sendMessage };

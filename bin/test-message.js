'use strict';

const { loadConfig } = require('../lib/config');
const { sendMessage } = require('../lib/telegram');
const { notifyDesktop } = require('../lib/herdr');

async function main() {
  // Deliberately ignores the master `enabled` flag — this is an explicit manual test.
  const { botToken, chatId } = loadConfig();
  await sendMessage({
    botToken,
    chatId,
    text: 'herdr: test notification — your Telegram notifications are working',
  });
  await notifyDesktop('Telegram test sent', 'Check your Telegram chat');
}

main().catch(async (error) => {
  await notifyDesktop('Telegram test failed', error.message);
  process.stderr.write(`herdr-telegram-notifications: test failed: ${error.message}\n`);
  process.exit(1);
});

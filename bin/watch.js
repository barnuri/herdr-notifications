'use strict';

const { loadConfig } = require('../lib/config');
const { Notifier } = require('../lib/notifier');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const notifier = new Notifier();
  let running = true;
  const stop = () => {
    running = false;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (running) {
    try {
      await notifier.tick();
    } catch (error) {
      process.stderr.write(`herdr-telegram-notifications: poll failed: ${error.message}\n`);
    }
    await sleep(loadConfig().pollMs);
  }
}

main().catch((error) => {
  process.stderr.write(`herdr-telegram-notifications: fatal: ${error.message}\n`);
  process.exit(1);
});

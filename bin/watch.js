'use strict';

const { loadConfig } = require('../lib/config');
const { Notifier } = require('../lib/notifier');
const { Relay } = require('../lib/relay');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const relay = new Relay();
  const notifier = new Notifier({ relay });
  let running = true;
  const stop = () => {
    running = false;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  let lastAgentPoll = 0;
  let lastRelayPoll = 0;

  while (running) {
    const currentConfig = loadConfig();
    const now = Date.now();

    if (now - lastAgentPoll >= currentConfig.pollMs) {
      lastAgentPoll = now;
      try {
        await notifier.tick();
      } catch (error) {
        process.stderr.write(`herdr-telegram-notifications: poll failed: ${error.message}\n`);
      }
    }

    if (currentConfig.relay.enabled && now - lastRelayPoll >= currentConfig.relay.pollMs) {
      lastRelayPoll = now;
      try {
        await relay.pollUpdates();
      } catch (error) {
        process.stderr.write(`herdr-telegram-notifications: relay poll failed: ${error.message}\n`);
      }
    }

    await sleep(Math.min(currentConfig.pollMs, currentConfig.relay.enabled ? currentConfig.relay.pollMs : currentConfig.pollMs));
  }
}

main().catch((error) => {
  process.stderr.write(`herdr-telegram-notifications: fatal: ${error.message}\n`);
  process.exit(1);
});

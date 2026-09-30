'use strict';

const { loadConfig } = require('../lib/config');
const { Notifier } = require('../lib/notifier');
const { SocketModeConnection } = require('../lib/providers/slack-socket');
const { Relay } = require('../lib/relay');
const { SingleInstanceLock } = require('../lib/single-instance');

const LOG_PREFIX = 'herdr-notifications';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // A second watcher against the same config is worse than useless: it opens a
  // second Slack Socket Mode connection, and Slack hands each button click to
  // exactly one connection, so half of them land in a process holding a stale
  // snapshot of the relay state and are rejected as expired.
  const releaseLock = SingleInstanceLock.acquire();
  if (!releaseLock) {
    process.stderr.write(`${LOG_PREFIX}: another watcher already holds ${SingleInstanceLock.path()}; exiting\n`);
    return;
  }

  const relay = new Relay();
  const notifier = new Notifier({ relay });
  let running = true;
  const stop = () => {
    running = false;
    releaseLock();
    // Closed here rather than only after the loop: an open Slack Socket Mode
    // WebSocket keeps the event loop alive, so leaving it until the loop
    // unwinds delays shutdown by however long the in-flight polls take.
    SocketModeConnection.resetShared();
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
        process.stderr.write(`${LOG_PREFIX}: poll failed: ${error.message}\n`);
      }
    }

    if (currentConfig.relay.enabled && now - lastRelayPoll >= currentConfig.relay.pollMs) {
      lastRelayPoll = now;
      try {
        await relay.pollUpdates();
      } catch (error) {
        process.stderr.write(`${LOG_PREFIX}: relay poll failed: ${error.message}\n`);
      }
    }

    await sleep(
      Math.min(currentConfig.pollMs, currentConfig.relay.enabled ? currentConfig.relay.pollMs : currentConfig.pollMs),
    );
  }

  // Backstop: a tick that ran after `stop()` will have rebuilt its provider,
  // and with it a fresh connection, so close again on the way out. Without
  // either call the process ignores SIGTERM entirely and lingers, accumulating
  // copies across herdr restarts that each double-handle every button click.
  SocketModeConnection.resetShared();
  releaseLock();
}

main().catch((error) => {
  process.stderr.write(`${LOG_PREFIX}: fatal: ${error.message}\n`);
  process.exit(1);
});

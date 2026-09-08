'use strict';

const { loadConfig } = require('../lib/config');
const { createProviders } = require('../lib/providers');
const { notifyDesktop } = require('../lib/herdr');

const LOG_PREFIX = 'herdr-notifications';
const NOTIFICATION_TITLE = 'Notification test';
const TEST_TEXT = 'herdr: test notification — your notifications are working';

// Deliberately ignores the master `enabled` flag: this is an explicit manual
// test. Every enabled provider is attempted so one broken token doesn't hide
// the fact that the others work.
async function main() {
  const { providers, unconfigured } = createProviders(loadConfig());

  if (providers.length === 0) {
    const detail =
      unconfigured.length > 0
        ? `${unconfigured.join(', ')} enabled but missing credentials`
        : 'no provider is enabled';
    await notifyDesktop('Notification test skipped', `${detail} — run the edit-config action`);
    process.stderr.write(`${LOG_PREFIX}: nothing to test: ${detail}\n`);
    process.exit(1);
  }

  const succeeded = [];
  const failures = [];
  await Promise.all(
    providers.map(async (provider) => {
      try {
        await provider.sendText(TEST_TEXT);
        succeeded.push(provider.displayName);
      } catch (error) {
        failures.push({ providerId: provider.id, message: error.message });
      }
    }),
  );

  for (const failure of failures) {
    process.stderr.write(`${LOG_PREFIX}: ${failure.providerId} test failed: ${failure.message}\n`);
  }

  if (succeeded.length === 0) {
    await notifyDesktop('Notification test failed', failures[0].message);
    process.exit(1);
  }

  const failureSummary = failures.length > 0 ? ` (failed: ${failures.map((f) => f.providerId).join(', ')})` : '';
  await notifyDesktop(NOTIFICATION_TITLE, `Sent to ${succeeded.join(', ')}${failureSummary}`);
  process.stdout.write(`sent to ${succeeded.join(', ')}${failureSummary}\n`);
}

main().catch(async (error) => {
  await notifyDesktop('Notification test failed', error.message);
  process.stderr.write(`${LOG_PREFIX}: test failed: ${error.message}\n`);
  process.exit(1);
});

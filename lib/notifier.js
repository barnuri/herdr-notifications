'use strict';

const config = require('./config');
const herdr = require('./herdr');
const providerRegistry = require('./providers');

const { StateWatcher } = require('./state-watcher');

class Notifier {
  static LOG_PREFIX = 'herdr-notifications';
  static BLOCKED_EVENT_TYPE = 'blocked';

  constructor({
    loadConfig = config.loadConfig,
    listAgents = herdr.listAgents,
    createProviders = providerRegistry.createProviders,
    notifyDesktop = herdr.notifyDesktop,
    watcher = new StateWatcher(),
    log = (line) => process.stderr.write(`${line}\n`),
    relay = null,
  } = {}) {
    this._loadConfig = loadConfig;
    this._listAgents = listAgents;
    this._createProviders = createProviders;
    this._notifyDesktop = notifyDesktop;
    this._watcher = watcher;
    this._log = log;
    this._relay = relay;
    this._warnedMessages = new Set();
  }

  async tick() {
    const currentConfig = this._loadConfig();
    if (!currentConfig.enabled) {
      // Drop watcher state so transitions during the disabled window
      // don't fire retroactively on re-enable.
      this._watcher.reset();
      return { sent: 0, filtered: 0, failed: 0 };
    }

    const { providers, unconfigured } = this._createProviders(currentConfig);
    if (unconfigured.length > 0) {
      this._warnOnce(
        `${unconfigured.join(', ')} enabled but missing credentials; not sending to it (run the edit-config action)`,
      );
    }
    if (providers.length === 0) {
      this._watcher.reset();
      this._warnOnce('no notification provider is enabled and configured; not sending');
      return { sent: 0, filtered: 0, failed: 0 };
    }

    const agents = await this._listAgents();
    const events = this._watcher.update(agents);
    const wanted = events.filter((event) => currentConfig.notifyOn[event.type]);

    let sent = 0;
    let failed = 0;
    for (const event of wanted) {
      const failures = await this._deliver(event, currentConfig, providers);
      if (failures.length < providers.length) {
        sent += 1;
      } else {
        failed += 1;
      }
      await this._reportFailures(failures);
    }
    return { sent, filtered: events.length - wanted.length, failed };
  }

  // Every provider is attempted, in parallel, regardless of what the others do:
  // a revoked Slack token must not silence Telegram.
  async _deliver(event, currentConfig, providers) {
    const useRelay = event.type === Notifier.BLOCKED_EVENT_TYPE && currentConfig.relay.enabled && this._relay;
    if (useRelay) {
      try {
        return await this._relay.notifyBlocked(event, currentConfig, providers);
      } catch (error) {
        // notifyBlocked reports per-provider send failures in its return value,
        // but it still throws for everything around the fan-out (reading the
        // pane, writing relay state). Without this, one unreadable pane would
        // reject tick() and drop every remaining event in the batch.
        return providers.map((provider) => ({ providerId: provider.id, message: error.message }));
      }
    }

    const failures = [];
    await Promise.all(
      providers.map(async (provider) => {
        try {
          await provider.sendStatus(event);
        } catch (error) {
          failures.push({ providerId: provider.id, message: error.message });
        }
      }),
    );
    return failures;
  }

  async _reportFailures(failures) {
    if (failures.length === 0) {
      return;
    }
    for (const failure of failures) {
      this._log(`${Notifier.LOG_PREFIX}: ${failure.providerId} send failed: ${failure.message}`);
    }
    const providerList = failures.map((failure) => failure.providerId).join(', ');
    await this._notifyDesktop(`Notification failed: ${providerList}`, failures[0].message);
  }

  _warnOnce(message) {
    if (this._warnedMessages.has(message)) {
      return;
    }
    this._warnedMessages.add(message);
    this._log(`${Notifier.LOG_PREFIX}: ${message}`);
  }
}

module.exports = { Notifier };

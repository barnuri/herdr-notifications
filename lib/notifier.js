'use strict';

const config = require('./config');
const herdr = require('./herdr');
const providerRegistry = require('./providers');

const { StateWatcher } = require('./state-watcher');
const { resolveNotifyRule, shouldNotify } = require('./notify-rules');

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
    now = () => Date.now(),
  } = {}) {
    this._loadConfig = loadConfig;
    this._listAgents = listAgents;
    this._createProviders = createProviders;
    this._notifyDesktop = notifyDesktop;
    this._watcher = watcher;
    this._log = log;
    this._relay = relay;
    this._warnedMessages = new Set();
    this._now = now;
    // Delayed sends, keyed by pane: at most one per pane, since a newer event
    // for the pane supersedes the one still waiting.
    this._pending = new Map();
  }

  async tick() {
    const currentConfig = this._loadConfig();
    if (!currentConfig.enabled) {
      // Drop watcher state so transitions during the disabled window
      // don't fire retroactively on re-enable.
      this._watcher.reset();
      this._pending.clear();
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
      this._pending.clear();
      this._warnOnce('no notification provider is enabled and configured; not sending');
      return { sent: 0, filtered: 0, failed: 0 };
    }

    const agents = await this._listAgents();
    const events = this._watcher.update(agents);
    // Any new event means the pane moved on, so a send still waiting on its
    // previous status is stale whether or not the new event is notified.
    for (const event of events) {
      this._pending.delete(event.paneId);
    }
    await this._resolveAnsweredElsewhere(events, currentConfig);
    const wanted = events.filter((event) => shouldNotify(currentConfig.notifyOn, event));

    const now = this._now();
    const due = [];
    let sent = 0;
    for (const event of wanted) {
      // Auto-approval answers the prompt at once, so it runs before any delay.
      if (await this._autoApproved(event, currentConfig, providers)) {
        sent += 1;
        continue;
      }
      const { delayMs } = resolveNotifyRule(currentConfig.notifyOn, event.type);
      if (delayMs > 0) {
        this._pending.set(event.paneId, { event, dueAt: now + delayMs });
      } else {
        due.push(event);
      }
    }
    for (const [paneId, pending] of this._pending) {
      if (pending.dueAt > now) {
        continue;
      }
      this._pending.delete(paneId);
      // Sent only if the pane is still in the status that triggered it.
      if (Notifier._isStillIn(agents, pending.event)) {
        due.push(pending.event);
      }
    }

    let failed = 0;
    for (const event of due) {
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

  // Resolves true when auto-approval answered a relay-routed blocked prompt.
  // A pane-read failure resolves false, so the event falls through to the normal
  // send path rather than being lost.
  async _autoApproved(event, currentConfig, providers) {
    if (!this._isRelayBlocked(event, currentConfig)) {
      return false;
    }
    try {
      return await this._relay.tryAutoApprove(event, currentConfig, providers);
    } catch (error) {
      this._log(`${Notifier.LOG_PREFIX}: auto-approve check failed for ${event.paneId}: ${error.message}`);
      return false;
    }
  }

  _isRelayBlocked(event, currentConfig) {
    return Boolean(event.type === Notifier.BLOCKED_EVENT_TYPE && currentConfig.relay.enabled && this._relay);
  }

  // A `resolved` event means a relay-routed prompt left `blocked` without the
  // relay answering it. Its chat message is updated so the buttons stop working.
  async _resolveAnsweredElsewhere(events, currentConfig) {
    if (!currentConfig.relay.enabled || !this._relay) {
      return;
    }
    for (const event of events) {
      if (event.type !== StateWatcher.STATUS_RESOLVED) {
        continue;
      }
      try {
        await this._relay.resolvePane(event.paneId);
      } catch (error) {
        this._log(`${Notifier.LOG_PREFIX}: resolve failed for ${event.paneId}: ${error.message}`);
      }
    }
  }

  static _isStillIn(agents, event) {
    const agent = agents.find((candidate) => candidate && candidate.pane_id === event.paneId);
    return Boolean(agent) && agent.agent_status === event.type;
  }

  // Every provider is attempted, in parallel, regardless of what the others do:
  // a revoked Slack token must not silence Telegram.
  async _deliver(event, currentConfig, providers) {
    if (this._isRelayBlocked(event, currentConfig)) {
      try {
        return await this._relay.announceBlocked(event, currentConfig, providers);
      } catch (error) {
        // announceBlocked reports per-provider send failures in its return value,
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

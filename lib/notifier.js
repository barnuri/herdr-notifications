'use strict';

const config = require('./config');
const herdr = require('./herdr');
const providerRegistry = require('./providers');

const { StateWatcher } = require('./state-watcher');
const { attachTargetFromArgv, findAttachedAgent } = require('./hc');
const { resolveNotifyRule, shouldNotify } = require('./notify-rules');

class Notifier {
  static LOG_PREFIX = 'herdr-notifications';
  static BLOCKED_EVENT_TYPE = 'blocked';

  constructor({
    loadConfig = config.loadConfig,
    listAgents = herdr.listAgents,
    paneForegroundArgvs = herdr.paneForegroundArgvs,
    createProviders = providerRegistry.createProviders,
    notifyDesktop = herdr.notifyDesktop,
    watcher = new StateWatcher(),
    log = (line) => process.stderr.write(`${line}\n`),
    relay = null,
    hcSource = null,
    now = () => Date.now(),
  } = {}) {
    this._loadConfig = loadConfig;
    this._listAgents = listAgents;
    this._paneForegroundArgvs = paneForegroundArgvs;
    this._createProviders = createProviders;
    this._notifyDesktop = notifyDesktop;
    this._watcher = watcher;
    // hc terminals get their own watcher: each update() rebuilds the pane map,
    // so sharing one would make every herdr pane look new on each hc poll.
    this._hcSource = hcSource;
    this._hcWatcher = new StateWatcher();
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
      this._hcWatcher.reset();
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

    const hcAgents = this._pollHc(currentConfig);
    const agents = await this._listHerdrAgents(this._hcOn(currentConfig));
    const herdrEvents = await this._dropHcAttached(this._watcher.update(agents), hcAgents);
    const events = [
      ...herdrEvents,
      ...this._hcWatcher.update(hcAgents).map((event) => ({ ...event, source: 'hc' })),
    ];
    const allAgents = [...agents, ...hcAgents];
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
      if (Notifier._isStillIn(allAgents, pending.event)) {
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

  _hcOn(currentConfig) {
    return Boolean(this._hcSource && currentConfig.hc && currentConfig.hc.enabled);
  }

  // hc terminals are only read here; a hc source that fails to start must not
  // stop the herdr poll, so it yields no agents.
  _pollHc(currentConfig) {
    if (!this._hcOn(currentConfig)) {
      this._hcWatcher.reset();
      return [];
    }
    return this._hcSource.listAgents();
  }

  // With hc on, the herdr TUI server may simply not run (herdr-app only), so a
  // failed herdr listing yields no panes instead of failing the whole tick.
  async _listHerdrAgents(tolerateFailure) {
    if (!tolerateFailure) {
      return this._listAgents();
    }
    try {
      return await this._listAgents();
    } catch (error) {
      this._warnOnce(`herdr panes unavailable, watching hc only: ${error.message}`);
      return [];
    }
  }

  // A herdr pane running `hc attach <t>` shows a hc terminal the hc source
  // already reports, so its herdr event is dropped: one message per agent.
  // Only panes with an event are inspected, which keeps process lookups rare.
  async _dropHcAttached(events, hcAgents) {
    if (events.length === 0 || hcAgents.length === 0) {
      return events;
    }
    const kept = [];
    for (const event of events) {
      let argvs = [];
      try {
        argvs = await this._paneForegroundArgvs(event.paneId);
      } catch {
        // Unknown foreground: keep the event rather than lose a notification.
      }
      const attached = argvs.some((argv) => {
        const target = attachTargetFromArgv(argv);
        return target !== null && findAttachedAgent(hcAgents, target) !== null;
      });
      if (!attached) {
        kept.push(event);
      }
    }
    return kept;
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

  // The relay reads and types into herdr panes only, so hc events never route
  // through it.
  _isRelayBlocked(event, currentConfig) {
    return Boolean(
      event.type === Notifier.BLOCKED_EVENT_TYPE &&
        event.source !== 'hc' &&
        currentConfig.relay.enabled &&
        this._relay,
    );
  }

  // A `resolved` event means a relay-routed prompt left `blocked` without the
  // relay answering it. Its chat message is updated so the buttons stop working.
  async _resolveAnsweredElsewhere(events, currentConfig) {
    if (!currentConfig.relay.enabled || !this._relay) {
      return;
    }
    for (const event of events) {
      if (event.type !== StateWatcher.STATUS_RESOLVED || event.source === 'hc') {
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

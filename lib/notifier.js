'use strict';

const config = require('./config');
const herdr = require('./herdr');
const telegram = require('./telegram');
const { StateWatcher } = require('./state-watcher');

class Notifier {
  static MESSAGES = {
    idle: 'is idle (finished working)',
    blocked: 'is blocked (waiting for input)',
    done: 'is done',
  };

  static ICONS = {
    blocked: '🔴',
    idle: '🟡',
    done: '🟢',
  };

  static DEFAULT_ICON = '⚪';

  constructor({
    loadConfig = config.loadConfig,
    listAgents = herdr.listAgents,
    sendMessage = telegram.sendMessage,
    notifyDesktop = herdr.notifyDesktop,
    watcher = new StateWatcher(),
    log = (line) => process.stderr.write(`${line}\n`),
    relay = null,
  } = {}) {
    this._loadConfig = loadConfig;
    this._listAgents = listAgents;
    this._sendMessage = sendMessage;
    this._notifyDesktop = notifyDesktop;
    this._watcher = watcher;
    this._log = log;
    this._relay = relay;
    this._hasWarnedUnconfigured = false;
  }

  static agentLabel(event) {
    const agent = event.agent || {};
    return agent.terminal_title_stripped || agent.agent || String(event.paneId);
  }

  static escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  static formatMessage(event) {
    const icon = Notifier.ICONS[event.type] || Notifier.DEFAULT_ICON;
    const status = Notifier.MESSAGES[event.type] || `changed to ${event.type}`;
    const label = Notifier.escapeHtml(Notifier.agentLabel(event));
    return `${icon} <b>${label}</b> ${status}`;
  }

  async tick() {
    const currentConfig = this._loadConfig();
    if (!currentConfig.enabled) {
      // Drop watcher state so transitions during the disabled window
      // don't fire retroactively on re-enable.
      this._watcher.reset();
      return { sent: 0, filtered: 0 };
    }
    if (!currentConfig.botToken || !currentConfig.chatId) {
      this._watcher.reset();
      if (!this._hasWarnedUnconfigured) {
        this._hasWarnedUnconfigured = true;
        this._log('herdr-telegram-notifications: botToken/chatId not configured; not sending (run the edit-config action)');
      }
      return { sent: 0, filtered: 0 };
    }

    const agents = await this._listAgents();
    const events = this._watcher.update(agents);
    const wanted = events.filter((event) => currentConfig.notifyOn[event.type]);

    let sent = 0;
    for (const event of wanted) {
      try {
        if (event.type === 'blocked' && currentConfig.relay.enabled && this._relay) {
          await this._relay.notifyBlocked(event, currentConfig);
        } else {
          await this._sendMessage({
            botToken: currentConfig.botToken,
            chatId: currentConfig.chatId,
            text: Notifier.formatMessage(event),
          });
        }
        sent += 1;
      } catch (error) {
        this._log(`herdr-telegram-notifications: send failed: ${error.message}`);
        await this._notifyDesktop('Telegram notification failed', error.message);
      }
    }
    return { sent, filtered: events.length - wanted.length };
  }
}

module.exports = { Notifier };

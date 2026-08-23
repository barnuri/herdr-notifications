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

  constructor({
    loadConfig = config.loadConfig,
    listAgents = herdr.listAgents,
    sendMessage = telegram.sendMessage,
    notifyDesktop = herdr.notifyDesktop,
    watcher = new StateWatcher(),
    log = (line) => process.stderr.write(`${line}\n`),
  } = {}) {
    this._loadConfig = loadConfig;
    this._listAgents = listAgents;
    this._sendMessage = sendMessage;
    this._notifyDesktop = notifyDesktop;
    this._watcher = watcher;
    this._log = log;
  }

  static agentLabel(event) {
    const agent = event.agent || {};
    return agent.terminal_title_stripped || agent.agent || String(event.paneId);
  }

  static formatMessage(event) {
    const status = Notifier.MESSAGES[event.type] || `changed to ${event.type}`;
    return `herdr: ${Notifier.agentLabel(event)} ${status}`;
  }

  async tick() {
    const currentConfig = this._loadConfig();
    if (!currentConfig.enabled) {
      // Drop watcher state so transitions during the disabled window
      // don't fire retroactively on re-enable.
      this._watcher.update([]);
      return { sent: 0, filtered: 0 };
    }

    const agents = await this._listAgents();
    const events = this._watcher.update(agents);
    const wanted = events.filter((event) => currentConfig.notifyOn[event.type]);

    let sent = 0;
    for (const event of wanted) {
      const text = Notifier.formatMessage(event);
      try {
        await this._sendMessage({
          botToken: currentConfig.botToken,
          chatId: currentConfig.chatId,
          text,
        });
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

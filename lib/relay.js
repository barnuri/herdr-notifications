'use strict';

const config = require('./config');
const herdr = require('./herdr');
const telegram = require('./telegram');
const { Notifier } = require('./notifier');
const { RelayStateStore } = require('./relay-state');

// Telegram's message cap is 4096 chars total; leave plenty of room for the
// header/markup around the <pre> block.
const MAX_CONTEXT_CHARS = 3500;

class Relay {
  constructor({
    loadConfig = config.loadConfig,
    readAgentOutput = herdr.readAgentOutput,
    answerBlockedAgent = herdr.answerBlockedAgent,
    notifyDesktop = herdr.notifyDesktop,
    sendMessage = telegram.sendMessage,
    getUpdates = telegram.getUpdates,
    answerCallbackQuery = telegram.answerCallbackQuery,
    editMessageText = telegram.editMessageText,
    detectOptions = require('./option-detector').detectOptions,
    stateStore = new RelayStateStore(),
    log = (line) => process.stderr.write(`${line}\n`),
  } = {}) {
    this._loadConfig = loadConfig;
    this._readAgentOutput = readAgentOutput;
    this._answerBlockedAgent = answerBlockedAgent;
    this._notifyDesktop = notifyDesktop;
    this._sendMessage = sendMessage;
    this._getUpdates = getUpdates;
    this._answerCallbackQuery = answerCallbackQuery;
    this._editMessageText = editMessageText;
    this._detectOptions = detectOptions;
    this._stateStore = stateStore;
    this._log = log;
  }

  // Called by lib/notifier.js in place of its plain sendMessage call when a
  // `blocked` event fires and relay.enabled is true. Throws on failure —
  // notifier.js's existing try/catch handles logging + desktop toast
  // uniformly for both the plain and relay-flavored blocked message.
  async notifyBlocked(event, currentConfig) {
    const context = await this._readAgentOutput(event.paneId, {
      lines: currentConfig.relay.contextLines,
    });
    const options = this._detectOptions(context);

    const icon = Notifier.ICONS.blocked;
    const status = Notifier.MESSAGES.blocked;
    const label = Notifier.escapeHtml(Notifier.agentLabel(event));
    const escapedContext = Notifier.escapeHtml(context).slice(-MAX_CONTEXT_CHARS);
    const text = `${icon} <b>${label}</b> ${status}\n<pre>${escapedContext}</pre>`;

    let token;
    let replyMarkup;
    let finalText = text;
    if (options.length > 0) {
      token = RelayStateStore.generateToken();
      const buttons = options.map((option, index) => ({
        // Free-text options (e.g. Claude Code's "Type something.") open a text
        // input after selection — the ✏️ signals a follow-up reply is expected.
        text: option.expectsText ? `${option.label} ✏️` : option.label,
        callback_data: `r:${token}:${index}`,
      }));
      replyMarkup = { inline_keyboard: [buttons] };
      // Buttons are a shortcut, not the only path — a free-text reply that
      // matches one of these options (by label or value) is resolved the
      // same way a tap would be; anything else still relays as literal text.
      finalText = `${text}\n\nTap a button, or reply with your own answer.`;
    }

    const result = await this._sendMessage({
      botToken: currentConfig.botToken,
      chatId: currentConfig.chatId,
      text: finalText,
      ...(replyMarkup ? { replyMarkup } : {}),
    });

    this._stateStore.trackBlocked(event.paneId, {
      messageId: result.message_id,
      token,
      options,
      text,
    });
  }

  // Called from bin/watch.js on its own cadence.
  async pollUpdates() {
    const currentConfig = this._loadConfig();
    if (!currentConfig.relay.enabled) {
      return;
    }

    const updates = await this._getUpdates(currentConfig.botToken, {
      offset: this._stateStore.getOffset(),
      timeout: 0,
    });
    if (!Array.isArray(updates) || updates.length === 0) {
      return;
    }

    let maxUpdateId = null;
    for (const update of updates) {
      if (typeof update.update_id === 'number' && (maxUpdateId === null || update.update_id > maxUpdateId)) {
        maxUpdateId = update.update_id;
      }
      // A single update's processing must never block the offset from
      // advancing past it — otherwise Telegram redelivers it forever (and,
      // for a callback_query, re-answering an already-answered one throws
      // on every retry, permanently stalling the relay).
      try {
        await this._processUpdate(update, currentConfig);
      } catch (error) {
        this._log(`herdr-telegram-notifications: relay failed to process update ${update.update_id}: ${error.message}`);
      }
    }

    if (maxUpdateId !== null) {
      this._stateStore.setOffset(maxUpdateId + 1);
    }
  }

  async _processUpdate(update, currentConfig) {
    const chat = update.callback_query
      ? update.callback_query.message && update.callback_query.message.chat
      : update.message && update.message.chat;

    // Security allow-list: anything from a chat other than the configured
    // one is dropped silently — no Telegram API call back, no log line
    // naming the sender, so an attacker gets no signal either way.
    if (!chat || String(chat.id) !== String(currentConfig.chatId)) {
      return;
    }

    if (update.callback_query) {
      await this._handleCallbackQuery(update.callback_query, currentConfig);
      return;
    }

    if (update.message && typeof update.message.text === 'string') {
      await this._handleMessage(update.message, currentConfig);
    }
  }

  async _handleCallbackQuery(callbackQuery, currentConfig) {
    const parts = String(callbackQuery.data || '').split(':');
    if (parts.length !== 3 || parts[0] !== 'r') {
      return;
    }
    const [, token, indexRaw] = parts;
    const index = Number(indexRaw);

    const entry = this._stateStore.resolveByToken(token);
    if (!entry || !Number.isInteger(index) || !entry.options[index]) {
      await this._answerCallbackQuery(currentConfig.botToken, callbackQuery.id, {
        text: 'This question has expired.',
      });
      return;
    }

    await this._answerCallbackQuery(currentConfig.botToken, callbackQuery.id, { text: 'Sent.' });

    const selected = entry.options[index];
    try {
      await this._answerBlockedAgent(entry.paneId, selected.value);
    } catch (error) {
      // answerCallbackQuery already told the user "Sent." — follow up in
      // chat so a delivery failure isn't silently swallowed.
      await this._reportRelayFailure(currentConfig, error);
      this._stateStore.expirePane(entry.paneId);
      return;
    }

    // The toast from answerCallbackQuery above is transient and easy to
    // miss; edit the original message in place so the selection stays
    // visible and the now-stale buttons can't be tapped again. Best-effort:
    // the answer was already delivered successfully, so a failure here
    // (e.g. the message is too old to edit) shouldn't read as a relay
    // failure to the user — just log it.
    if (entry.text && callbackQuery.message) {
      try {
        await this._editMessageText({
          botToken: currentConfig.botToken,
          chatId: currentConfig.chatId,
          messageId: callbackQuery.message.message_id,
          text: `${entry.text}\n\n✅ Selected: <b>${Notifier.escapeHtml(selected.label)}</b>`,
          replyMarkup: { inline_keyboard: [] },
        });
      } catch (error) {
        this._log(`herdr-telegram-notifications: relay failed to update the answered message: ${error.message}`);
      }
    }
    await this._finishAnswer(entry.paneId, currentConfig, selected);
  }

  // Shared tail for both answer paths (button tap and free-text reply): an
  // expectsText option just opened a text input in the pane, so keep it
  // tracked and ask for the follow-up; anything else completes the exchange.
  async _finishAnswer(paneId, currentConfig, option) {
    if (option && option.expectsText) {
      await this._promptForText(paneId, currentConfig, option.label);
      return;
    }
    this._stateStore.expirePane(paneId);
  }

  // An expectsText option was just selected in the pane (the digit opened a
  // text input there). Keep the pane tracked so the user's next reply is
  // relayed as the literal text; force_reply pre-focuses the reply box, and
  // registering the prompt's message id makes a reply-to on it route
  // correctly even when several panes are blocked.
  async _promptForText(paneId, currentConfig, selectedLabel) {
    this._stateStore.setAwaitingText(paneId);
    const prompt = await this._sendMessage({
      botToken: currentConfig.botToken,
      chatId: currentConfig.chatId,
      text: `✏️ <b>${Notifier.escapeHtml(selectedLabel)}</b> selected — now reply with the text to send.`,
      replyMarkup: { force_reply: true },
    });
    this._stateStore.registerMessage(prompt.message_id, paneId);
  }

  async _handleMessage(message, currentConfig) {
    let paneId = null;
    if (message.reply_to_message) {
      paneId = this._stateStore.resolveByMessageId(message.reply_to_message.message_id);
    } else {
      const blockedPanes = this._stateStore.getBlockedPanes();
      if (blockedPanes.length === 1) {
        [paneId] = blockedPanes;
      }
    }

    if (!paneId) {
      await this._sendMessage({
        botToken: currentConfig.botToken,
        chatId: currentConfig.chatId,
        text: 'Please reply directly to the specific blocked-agent notification you want to answer.',
      });
      return;
    }

    // The pane already had an expectsText option selected: this reply IS the
    // text to type — relay it verbatim, never re-matched against a menu.
    if (this._stateStore.isAwaitingText(paneId)) {
      try {
        await this._answerBlockedAgent(paneId, message.text);
      } catch (error) {
        await this._reportRelayFailure(currentConfig, error);
      }
      this._stateStore.expirePane(paneId);
      return;
    }

    const matched = this._matchOption(paneId, message.text);
    try {
      await this._answerBlockedAgent(paneId, matched ? matched.value : message.text);
    } catch (error) {
      await this._reportRelayFailure(currentConfig, error);
      this._stateStore.expirePane(paneId);
      return;
    }
    // Typing an expectsText option's number/label is the same as tapping its
    // button — _finishAnswer asks for the follow-up text in that case.
    await this._finishAnswer(paneId, currentConfig, matched);
  }

  // A free-text reply is always accepted (this is the universal fallback —
  // real text-input prompts need exactly this). But if the pane currently
  // has a detected menu, typing the option's own value/label should drive
  // that menu correctly (e.g. the digit key), not get typed as raw text
  // into a keypress-driven widget that will ignore it.
  _matchOption(paneId, rawText) {
    const options = this._stateStore.resolveOptionsByPane(paneId);
    if (!Array.isArray(options) || options.length === 0) {
      return null;
    }
    const normalized = String(rawText).trim().toLowerCase();
    return (
      options.find((option) => {
        const bareLabel = option.label.replace(/^\d+[.)]\s*/, '').trim().toLowerCase();
        return normalized === String(option.value).toLowerCase() || normalized === bareLabel;
      }) || null
    );
  }

  async _reportRelayFailure(currentConfig, error) {
    await this._sendMessage({
      botToken: currentConfig.botToken,
      chatId: currentConfig.chatId,
      text: `Failed to relay your answer: ${Notifier.escapeHtml(error.message)}`,
    });
  }
}

module.exports = { Relay };

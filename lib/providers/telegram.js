'use strict';

const {
  BUTTON_OR_REPLY_PROMPT,
  buttonLabel,
  escapeHtmlEntities,
  selectedBody,
  resolvedBody,
  statusLine,
  tailTrim,
} = require('./chat-text');
const { HttpJsonClient } = require('./http');
const { INBOUND_ACTION, INBOUND_TEXT } = require('./inbound');

class TelegramProvider {
  static ID = 'telegram';
  static DISPLAY_NAME = 'Telegram';
  // The only provider that can offer tappable choices: Telegram delivers button
  // presses through the same getUpdates long-poll as messages, so no publicly
  // reachable interactions endpoint is needed.
  static SUPPORTS_BUTTONS = true;
  static API_BASE = 'https://api.telegram.org';
  // Telegram caps a message at 4096 characters; leave room for the header and
  // the markup around the <pre> block.
  static MAX_CONTEXT_CHARS = 3500;
  static CALLBACK_DATA_PREFIX = 'r';
  // getUpdates with a negative offset returns only the newest update, which is
  // how a fresh install skips whatever is already sitting in the queue.
  static BOOTSTRAP_OFFSET = -1;
  // Short-poll: this plugin drives its own cadence from bin/watch.js rather
  // than holding a long-poll open.
  static POLL_TIMEOUT_SECONDS = 0;
  static PARSE_MODE = 'HTML';

  constructor({ providerConfig = {}, httpClient = new HttpJsonClient() } = {}) {
    this._botToken = providerConfig.botToken || '';
    this._chatId = providerConfig.chatId || '';
    this._http = httpClient;
  }

  static escape(text) {
    return escapeHtmlEntities(text);
  }

  static bold(text) {
    return `<b>${text}</b>`;
  }

  static formatStatus(event) {
    return statusLine(event, { bold: TelegramProvider.bold, escapeLabel: TelegramProvider.escape });
  }

  get id() {
    return TelegramProvider.ID;
  }

  get displayName() {
    return TelegramProvider.DISPLAY_NAME;
  }

  get supportsButtons() {
    return TelegramProvider.SUPPORTS_BUTTONS;
  }

  // The chat/channel this instance posts to. The relay scopes its inbound
  // cursor to this value: a cursor recorded against one target is meaningless
  // against another, and replaying a different channel's backlog would type
  // stale chat messages into a live pane.
  get targetId() {
    return this._chatId;
  }

  isConfigured() {
    return this._botToken !== '' && this._chatId !== '';
  }

  async sendStatus(event) {
    return this.sendText(TelegramProvider.formatStatus(event));
  }

  async sendText(text, { replyMarkup } = {}) {
    const result = await this._call('sendMessage', {
      chat_id: this._chatId,
      text,
      parse_mode: TelegramProvider.PARSE_MODE,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    return { messageId: result.message_id };
  }

  async sendBlocked({ event, context, options = [], token }) {
    // Trimmed after escaping so the cap applies to what Telegram actually
    // receives. Cutting from the front can only ever drop the head of an
    // entity, never leave a dangling '&'.
    const escapedContext = tailTrim(TelegramProvider.escape(context), TelegramProvider.MAX_CONTEXT_CHARS);
    const baseText = `${TelegramProvider.formatStatus(event)}\n<pre>${escapedContext}</pre>`;

    if (options.length === 0) {
      const { messageId } = await this.sendText(baseText);
      return { messageId, baseText };
    }

    const buttons = options.map((option, index) => ({
      text: buttonLabel(option),
      callback_data: `${TelegramProvider.CALLBACK_DATA_PREFIX}:${token}:${index}`,
    }));
    // Buttons are a shortcut, not the only path — a free-text reply that
    // matches one of these options is resolved the same way a tap would be.
    const { messageId } = await this.sendText(`${baseText}\n\n${BUTTON_OR_REPLY_PROMPT}`, {
      replyMarkup: { inline_keyboard: [buttons] },
    });
    return { messageId, baseText };
  }

  // Pre-focuses the reply box so the follow-up text lands as a reply to this
  // prompt, which is what routes it back to the right pane.
  async sendTextPrompt(text) {
    return this.sendText(text, { replyMarkup: { force_reply: true } });
  }

  async fetchInbound(cursor) {
    // Without a cursor, polling would replay Telegram's whole pending-update
    // queue (it holds them for 24h) as fresh answers and type day-old replies
    // into live panes. Adopt the newest update instead and listen from there.
    if (cursor === undefined || cursor === null) {
      return { events: [], cursor: await this._bootstrapCursor() };
    }

    const updates = await this._getUpdates(cursor);
    if (updates.length === 0) {
      return { events: [], cursor };
    }

    const events = [];
    let nextCursor = cursor;
    for (const update of updates) {
      if (typeof update.update_id === 'number' && update.update_id >= nextCursor) {
        nextCursor = update.update_id + 1;
      }
      const event = this._normalizeUpdate(update);
      if (event) {
        events.push(event);
      }
    }
    return { events, cursor: nextCursor };
  }

  async acknowledgeAction(actionId, text) {
    await this._call('answerCallbackQuery', {
      callback_query_id: actionId,
      ...(text ? { text } : {}),
    });
  }

  async markAnswered({ messageId, baseText, selectedLabel }) {
    await this._call('editMessageText', {
      chat_id: this._chatId,
      message_id: messageId,
      text: selectedBody(baseText, selectedLabel, {
        bold: TelegramProvider.bold,
        escapeLabel: TelegramProvider.escape,
      }),
      parse_mode: TelegramProvider.PARSE_MODE,
      reply_markup: { inline_keyboard: [] },
    });
  }

  async markResolved({ messageId, baseText }) {
    await this._call('editMessageText', {
      chat_id: this._chatId,
      message_id: messageId,
      text: resolvedBody(baseText),
      parse_mode: TelegramProvider.PARSE_MODE,
      reply_markup: { inline_keyboard: [] },
    });
  }

  async _bootstrapCursor() {
    const updates = await this._getUpdates(TelegramProvider.BOOTSTRAP_OFFSET);
    if (updates.length === 0) {
      return undefined;
    }
    const newest = updates[updates.length - 1];
    return typeof newest.update_id === 'number' ? newest.update_id + 1 : undefined;
  }

  async _getUpdates(offset) {
    const updates = await this._call('getUpdates', {
      offset,
      timeout: TelegramProvider.POLL_TIMEOUT_SECONDS,
      allowed_updates: ['message', 'callback_query'],
    });
    return Array.isArray(updates) ? updates : [];
  }

  // Security allow-list: anything from a chat other than the configured one is
  // dropped silently — no API call back, no log line naming the sender, so an
  // attacker gets no signal either way.
  _normalizeUpdate(update) {
    if (update.callback_query) {
      const callbackQuery = update.callback_query;
      const chat = callbackQuery.message && callbackQuery.message.chat;
      if (!this._isConfiguredChat(chat)) {
        return null;
      }
      return {
        kind: INBOUND_ACTION,
        id: String(update.update_id),
        actionId: callbackQuery.id,
        data: String(callbackQuery.data || ''),
        messageId: callbackQuery.message ? callbackQuery.message.message_id : null,
      };
    }

    const message = update.message;
    if (!message || typeof message.text !== 'string' || !this._isConfiguredChat(message.chat)) {
      return null;
    }
    return {
      kind: INBOUND_TEXT,
      id: String(update.update_id),
      text: message.text,
      replyToMessageId: message.reply_to_message ? message.reply_to_message.message_id : null,
    };
  }

  _isConfiguredChat(chat) {
    return Boolean(chat) && String(chat.id) === String(this._chatId);
  }

  async _call(method, payload) {
    const label = `telegram ${method}`;
    const url = `${TelegramProvider.API_BASE}/bot${this._botToken}/${method}`;
    const response = await this._http.postJson(url, payload, { label });
    const body = response.body;
    if (!response.ok || !body || body.ok === false) {
      const errorCode = body && body.error_code !== undefined ? body.error_code : 'unknown';
      const description = body && body.description ? body.description : 'no description';
      throw new Error(`${label} failed: HTTP ${response.status}, error_code ${errorCode}: ${description}`);
    }
    return body.result;
  }
}

module.exports = { TelegramProvider };

'use strict';

const { fencedBlock, optionListBody, resolvedBody, selectedBody, statusLine } = require('./chat-text');
const { HttpJsonClient } = require('./http');
const { INBOUND_TEXT, collectOldestFirst } = require('./inbound');

class DiscordProvider {
  static ID = 'discord';
  static DISPLAY_NAME = 'Discord';
  // Message components would need a publicly reachable interactions endpoint,
  // which a locally-running plugin cannot offer — options are rendered as a
  // reply-with-this-value list instead.
  static SUPPORTS_BUTTONS = false;
  static API_BASE = 'https://discord.com/api/v10';
  // Discord rejects a message over 2000 characters outright; leave room for the
  // header, the fence markers and the option list.
  static MAX_CONTEXT_CHARS = 1500;
  static INBOUND_PAGE_LIMIT = 100;
  static MARKDOWN_ESCAPE_PATTERN = /([\\`*_~|>])/g;

  constructor({ providerConfig = {}, httpClient = new HttpJsonClient() } = {}) {
    this._botToken = providerConfig.botToken || '';
    this._channelId = providerConfig.channelId || '';
    this._http = httpClient;
  }

  // Backslash-escapes the inline formatting characters so an agent title
  // containing `*` or `_` renders literally instead of turning into markup.
  static escape(text) {
    return String(text).replace(DiscordProvider.MARKDOWN_ESCAPE_PATTERN, '\\$1');
  }

  static bold(text) {
    return `**${text}**`;
  }

  static formatStatus(event) {
    return statusLine(event, { bold: DiscordProvider.bold, escapeLabel: DiscordProvider.escape });
  }

  get id() {
    return DiscordProvider.ID;
  }

  get displayName() {
    return DiscordProvider.DISPLAY_NAME;
  }

  get supportsButtons() {
    return DiscordProvider.SUPPORTS_BUTTONS;
  }

  // The chat/channel this instance posts to. The relay scopes its inbound
  // cursor to this value: a cursor recorded against one target is meaningless
  // against another, and replaying a different channel's backlog would type
  // stale chat messages into a live pane.
  get targetId() {
    return this._channelId;
  }

  isConfigured() {
    return this._botToken !== '' && this._channelId !== '';
  }

  async sendStatus(event) {
    return this.sendText(DiscordProvider.formatStatus(event));
  }

  async sendText(text) {
    const result = await this._post(this._messagesUrl(), { content: text }, 'createMessage');
    return { messageId: String(result.id) };
  }

  async sendBlocked({ event, context, options = [] }) {
    const baseText = `${DiscordProvider.formatStatus(event)}\n${fencedBlock(
      context,
      DiscordProvider.MAX_CONTEXT_CHARS,
    )}`;
    const text = options.length === 0 ? baseText : optionListBody(baseText, options, DiscordProvider.escape);
    const { messageId } = await this.sendText(text);
    return { messageId, baseText };
  }

  async sendTextPrompt(text) {
    return this.sendText(text);
  }

  // `after` is a message snowflake, so the cursor is the newest message id seen
  // so far.
  async fetchInbound(cursor) {
    const query = new URLSearchParams({ limit: String(DiscordProvider.INBOUND_PAGE_LIMIT) });
    if (cursor) {
      query.set('after', String(cursor));
    }
    const messages = await this._get(`${this._messagesUrl()}?${query}`, 'getChannelMessages');
    return collectOldestFirst(Array.isArray(messages) ? messages : [], {
      cursor,
      idOf: (message) => message.id,
      normalize: DiscordProvider._normalizeMessage,
    });
  }

  async acknowledgeAction() {
    // Discord has no equivalent of a callback-query acknowledgement: answers
    // arrive as ordinary messages, and the relay confirms them in the channel.
  }

  async markAnswered({ messageId, baseText, selectedLabel }) {
    await this._patch(
      `${this._messagesUrl()}/${messageId}`,
      {
        content: selectedBody(baseText, selectedLabel, {
          bold: DiscordProvider.bold,
          escapeLabel: DiscordProvider.escape,
        }),
      },
      'editMessage',
    );
  }

  async markResolved({ messageId, baseText }) {
    await this._patch(`${this._messagesUrl()}/${messageId}`, { content: resolvedBody(baseText) }, 'editMessage');
  }

  // Bot messages are dropped, this plugin's own included: without that the
  // relay reads its own blocked notification back and types it into the pane.
  static _normalizeMessage(message) {
    if (!message || typeof message.content !== 'string' || message.content === '') {
      return null;
    }
    if (message.author && message.author.bot === true) {
      return null;
    }
    const reference = message.message_reference;
    return {
      kind: INBOUND_TEXT,
      id: String(message.id),
      text: message.content,
      replyToMessageId: reference && reference.message_id ? String(reference.message_id) : null,
    };
  }

  _messagesUrl() {
    return `${DiscordProvider.API_BASE}/channels/${this._channelId}/messages`;
  }

  async _get(url, method) {
    return this._decode(await this._http.getJson(url, this._requestOptions(method)), method);
  }

  async _post(url, payload, method) {
    return this._decode(await this._http.postJson(url, payload, this._requestOptions(method)), method);
  }

  async _patch(url, payload, method) {
    return this._decode(await this._http.patchJson(url, payload, this._requestOptions(method)), method);
  }

  _requestOptions(method) {
    return { label: `discord ${method}`, headers: { authorization: `Bot ${this._botToken}` } };
  }

  _decode(response, method) {
    if (response.ok) {
      return response.body;
    }
    const body = response.body;
    const message = body && body.message ? body.message : 'no message';
    const code = body && body.code !== undefined ? body.code : 'unknown';
    throw new Error(`discord ${method} failed: HTTP ${response.status}, code ${code}: ${message}`);
  }
}

module.exports = { DiscordProvider };

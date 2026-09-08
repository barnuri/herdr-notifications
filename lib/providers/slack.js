'use strict';

const {
  BUTTON_OR_REPLY_PROMPT,
  buttonLabel,
  escapeHtmlEntities,
  fencedBlock,
  optionListBody,
  selectedBody,
  statusLine,
} = require('./chat-text');
const { HttpJsonClient, decodeSlackEnvelope } = require('./http');
const { INBOUND_TEXT, collectOldestFirst } = require('./inbound');
const { SocketModeConnection } = require('./slack-socket');

class SlackProvider {
  static ID = 'slack';
  static DISPLAY_NAME = 'Slack';
  static API_BASE = 'https://slack.com/api';
  static MAX_CONTEXT_CHARS = 2500;
  static INBOUND_PAGE_LIMIT = 100;
  // Slack truncates button text past 75 characters.
  static MAX_BUTTON_TEXT_CHARS = 75;
  static CALLBACK_DATA_PREFIX = 'r';
  static MRKDWN = 'mrkdwn';

  constructor({ providerConfig = {}, httpClient = new HttpJsonClient(), socket = null } = {}) {
    this._botToken = providerConfig.botToken || '';
    this._channelId = providerConfig.channelId || '';
    this._appToken = providerConfig.appToken || '';
    this._http = httpClient;
    // Injected in tests; in production the connection is shared per app token
    // because providers are rebuilt on every watcher tick.
    this._socket =
      socket || (this._appToken ? SocketModeConnection.shared(this._appToken, { httpClient }) : null);
  }

  // Slack reserves &, < and > for its own entity syntax (<@U123>, <#C123>,
  // <https://...|link>) and requires them escaped.
  static escape(text) {
    return escapeHtmlEntities(text);
  }

  static bold(text) {
    return `*${text}*`;
  }

  static formatStatus(event) {
    return statusLine(event, { bold: SlackProvider.bold, escapeLabel: SlackProvider.escape });
  }

  get id() {
    return SlackProvider.ID;
  }

  get displayName() {
    return SlackProvider.DISPLAY_NAME;
  }

  // Buttons need a Socket Mode connection to receive the click, which needs an
  // app-level token. Without one the provider falls back to a numbered list.
  get supportsButtons() {
    return this._socket !== null;
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
    return this.sendText(SlackProvider.formatStatus(event));
  }

  async sendText(text) {
    const body = await this._call('chat.postMessage', { channel: this._channelId, text });
    return { messageId: String(body.ts) };
  }

  async sendBlocked({ event, context, options = [], token }) {
    const baseText = `${SlackProvider.formatStatus(event)}\n${fencedBlock(context, SlackProvider.MAX_CONTEXT_CHARS)}`;

    if (options.length === 0) {
      const { messageId } = await this.sendText(baseText);
      return { messageId, baseText };
    }

    if (!this.supportsButtons) {
      const { messageId } = await this.sendText(optionListBody(baseText, options, SlackProvider.escape));
      return { messageId, baseText };
    }

    // Buttons are a shortcut, not the only path: a typed reply is still read
    // off the history poll and relayed, which is what a real text prompt needs.
    const promptText = `${baseText}\n${BUTTON_OR_REPLY_PROMPT}`;
    const body = await this._call('chat.postMessage', {
      channel: this._channelId,
      text: promptText,
      blocks: SlackProvider._blocks(promptText, options, token),
    });
    return { messageId: String(body.ts), baseText };
  }

  static _blocks(text, options, token) {
    return [
      SlackProvider._sectionBlock(text),
      {
        type: 'actions',
        elements: options.map((option, index) => {
          // The relay parses this exactly as it parses Telegram callback data,
          // so both providers drive the same code path. action_id and value
          // must agree: the relay reads whichever one Slack sends back.
          const callbackData = `${SlackProvider.CALLBACK_DATA_PREFIX}:${token}:${index}`;
          return {
            type: 'button',
            action_id: callbackData,
            value: callbackData,
            text: { type: 'plain_text', text: SlackProvider._buttonLabel(option) },
          };
        }),
      },
    ];
  }

  static _sectionBlock(text) {
    return { type: 'section', text: { type: SlackProvider.MRKDWN, text } };
  }

  static _buttonLabel(option) {
    return buttonLabel(option).slice(0, SlackProvider.MAX_BUTTON_TEXT_CHARS);
  }

  async sendTextPrompt(text) {
    return this.sendText(text);
  }

  // The cursor is a Slack `ts`. `oldest` is exclusive by default (`inclusive`
  // defaults to false), so the message that produced the cursor is not
  // redelivered.
  async fetchInbound(cursor) {
    // Button clicks arrive over the socket, typed answers over the history
    // poll. Both are live at once, so both are drained every tick.
    const actions = await this._drainSocketActions();

    const body = await this._call('conversations.history', {
      channel: this._channelId,
      limit: SlackProvider.INBOUND_PAGE_LIMIT,
      ...(cursor ? { oldest: String(cursor) } : {}),
    });
    const fromHistory = collectOldestFirst(Array.isArray(body.messages) ? body.messages : [], {
      cursor,
      idOf: (message) => message.ts,
      normalize: SlackProvider._normalizeMessage,
    });

    // Actions first: a tap is an explicit choice, and processing it before a
    // typed message avoids the typed one being read as the answer to a
    // question the tap already resolved.
    return { events: [...actions, ...fromHistory.events], cursor: fromHistory.cursor };
  }

  // A broken socket degrades to the typed-reply path rather than taking the
  // whole inbound poll down with it, so the failure is contained here instead
  // of relying on the connection's own contract.
  async _drainSocketActions() {
    if (!this._socket) {
      return [];
    }
    try {
      await this._socket.start();
      // A click from a channel other than the configured one is not ours.
      return this._socket
        .drainEvents()
        .filter((event) => !event.channelId || String(event.channelId) === String(this._channelId));
    } catch {
      return [];
    }
  }

  async acknowledgeAction() {
    // Slack has no callback-query acknowledgement in a poll-based flow: answers
    // arrive as ordinary messages, and the relay confirms them in the channel.
  }

  async markAnswered({ messageId, baseText, selectedLabel }) {
    const text = selectedBody(baseText, selectedLabel, {
      bold: SlackProvider.bold,
      escapeLabel: SlackProvider.escape,
    });
    await this._call('chat.update', {
      channel: this._channelId,
      ts: messageId,
      text,
      // Replaces the original blocks so the now-stale buttons disappear rather
      // than staying tappable; chat.update leaves existing blocks in place if
      // only `text` is sent.
      blocks: [SlackProvider._sectionBlock(text)],
    });
  }

  // Anything posted by an app is dropped, this plugin's own messages included:
  // without that the relay reads its own blocked notification back and types it
  // into the pane. Subtyped messages (joins, topic changes, huddles) are not
  // answers either.
  static _normalizeMessage(message) {
    if (!message || typeof message.text !== 'string' || message.text === '') {
      return null;
    }
    if (message.bot_id || message.app_id || message.subtype) {
      return null;
    }
    // A threaded reply carries the parent's ts; `thread_ts === ts` means this
    // message is itself a thread parent, not a reply to anything.
    const isThreadReply = Boolean(message.thread_ts) && message.thread_ts !== message.ts;
    return {
      kind: INBOUND_TEXT,
      id: String(message.ts),
      text: message.text,
      replyToMessageId: isThreadReply ? String(message.thread_ts) : null,
    };
  }

  async _call(method, payload) {
    const label = `slack ${method}`;
    const response = await this._http.postJson(`${SlackProvider.API_BASE}/${method}`, payload, {
      label,
      headers: { authorization: `Bearer ${this._botToken}` },
    });
    return decodeSlackEnvelope(response, label);
  }
}

module.exports = { SlackProvider };

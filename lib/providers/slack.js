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
  // conversations.history is a Tier 3 method (~50 requests/minute). The relay
  // polls every relay.pollMs — 1s by default, which on its own already exceeds
  // that budget — so the floor between history calls is enforced here rather
  // than left to the poll cadence. 1.5s keeps a single watcher at ~40/minute.
  static MIN_HISTORY_INTERVAL_MS = 1500;
  static HISTORY_METHOD = 'conversations.history';
  // Static because providers are rebuilt on every watcher tick: per-instance
  // throttle state would reset before it ever took effect.
  static HISTORY_GATES = new Map();

  constructor({
    providerConfig = {},
    httpClient = new HttpJsonClient(),
    socket = null,
    log = (line) => process.stderr.write(`${line}\n`),
    now = () => Date.now(),
  } = {}) {
    this._botToken = providerConfig.botToken || '';
    this._channelId = providerConfig.channelId || '';
    this._appToken = providerConfig.appToken || '';
    this._http = httpClient;
    this._log = log;
    this._now = now;
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
  //
  // Button clicks arrive over the socket, typed answers over the history poll.
  // Both are live at once, so both are drained every tick — but in this order,
  // and never as one fallible unit: draining the socket queue is destructive,
  // so a history call that threw after the drain discarded every queued click.
  // With conversations.history rate limited that was most of them, which is
  // why a tap so often appeared to do nothing at all.
  async fetchInbound(cursor) {
    const history = await this._fetchHistory(cursor);
    const actions = await this._drainSocketActions();

    // Actions first: a tap is an explicit choice, and processing it before a
    // typed message avoids the typed one being read as the answer to a
    // question the tap already resolved.
    return { events: [...actions, ...history.events], cursor: history.cursor };
  }

  // Never throws, and never advances the cursor on failure: a history poll that
  // is rate limited, skipped by the throttle, or simply broken costs only the
  // typed-reply path. Taking the whole inbound poll down with it would take the
  // button path down too, which is the opposite of what a failure here means.
  async _fetchHistory(cursor) {
    const gate = SlackProvider._historyGate(this._channelId);
    if (this._now() < gate.nextAtMs) {
      return { events: [], cursor };
    }
    gate.nextAtMs = this._now() + SlackProvider.MIN_HISTORY_INTERVAL_MS;

    let response;
    try {
      response = await this._request(SlackProvider.HISTORY_METHOD, {
        channel: this._channelId,
        limit: SlackProvider.INBOUND_PAGE_LIMIT,
        ...(cursor ? { oldest: String(cursor) } : {}),
      });
    } catch (error) {
      this._reportHistoryProblem(gate, error.message);
      return { events: [], cursor };
    }

    // Retrying inside the window Slack named only earns another 429 and keeps
    // the quota exhausted, so the throttle is pushed out to honour it.
    if (response.retryAfterMs !== undefined) {
      gate.nextAtMs = this._now() + response.retryAfterMs;
      this._reportHistoryProblem(
        gate,
        `${SlackProvider.HISTORY_METHOD} rate limited; pausing typed-reply polls for ${Math.round(response.retryAfterMs / 1000)}s (button clicks still work)`,
      );
      return { events: [], cursor };
    }

    let body;
    try {
      body = decodeSlackEnvelope(response, `slack ${SlackProvider.HISTORY_METHOD}`);
    } catch (error) {
      this._reportHistoryProblem(gate, error.message);
      return { events: [], cursor };
    }

    gate.lastReason = '';
    return collectOldestFirst(Array.isArray(body.messages) ? body.messages : [], {
      cursor,
      idOf: (message) => message.ts,
      normalize: SlackProvider._normalizeMessage,
    });
  }

  static _historyGate(channelId) {
    const existing = SlackProvider.HISTORY_GATES.get(channelId);
    if (existing) {
      return existing;
    }
    const gate = { nextAtMs: 0, lastReason: '' };
    SlackProvider.HISTORY_GATES.set(channelId, gate);
    return gate;
  }

  static resetHistoryGates() {
    SlackProvider.HISTORY_GATES.clear();
  }

  // Logged once per distinct reason. The relay polls every second, so logging
  // unconditionally turned one sustained rate limit into tens of thousands of
  // identical lines and a multi-megabyte log.
  _reportHistoryProblem(gate, reason) {
    if (gate.lastReason === reason) {
      return;
    }
    gate.lastReason = reason;
    this._log(`herdr-notifications: slack ${reason}`);
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

  // Socket Mode acknowledgement is transport-level and invisible to the user,
  // so there is nothing to show for a click that worked — markAnswered already
  // edits the original message, and a "Sent." post per tap would be noise. A
  // click that could NOT be routed is the opposite case: with nothing posted it
  // is indistinguishable from one that worked, which is what made an expired
  // button look like a broken button.
  async acknowledgeAction(actionId, message, { failed = false } = {}) {
    if (!failed || !message) {
      return;
    }
    await this.sendText(message);
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

  // Raw, undecoded: _fetchHistory needs to read `retryAfterMs` off a 429 before
  // the envelope decoder turns it into a thrown error.
  async _request(method, payload) {
    return this._http.postJson(`${SlackProvider.API_BASE}/${method}`, payload, {
      label: `slack ${method}`,
      headers: { authorization: `Bearer ${this._botToken}` },
    });
  }

  async _call(method, payload) {
    return decodeSlackEnvelope(await this._request(method, payload), `slack ${method}`);
  }
}

module.exports = { SlackProvider };

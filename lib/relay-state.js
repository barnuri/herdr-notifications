'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { configDir } = require('./config');

class RelayStateStore {
  static FILE_NAME = 'relay-state.json';
  // The state file only holds routing metadata (pane ids, message ids, opaque
  // tokens), but follow config.json's convention of not being group/world readable.
  static FILE_MODE = 0o600;

  static LOG_PREFIX = 'herdr-notifications';

  // Corrupt-state warning is emitted at most once per process (own flag, not
  // shared with lib/config.js's warnInvalidConfigOnce).
  static _hasWarnedAboutInvalidState = false;

  constructor() {
    this._state = RelayStateStore._loadState();
  }

  // Identifies which question a pane is showing. Labels are part of the key,
  // not just values: nearly every menu is numbered 1..n, so two different
  // questions in the same prompt share their values and a values-only key
  // would report a genuinely new question as unchanged and silently drop it.
  // The cost is the reverse error — a pane that redraws the *same* question
  // with different label text is announced twice — which is self-limiting and
  // far less harmful than losing a question the user is waiting on.
  static optionsKey(options) {
    if (!Array.isArray(options) || options.length === 0) {
      return '';
    }
    return options.map((option) => `${option.value}\u0000${option.label}`).join('|');
  }

  static generateToken() {
    return crypto.randomBytes(4).toString('hex');
  }

  static _statePath() {
    return path.join(configDir(), RelayStateStore.FILE_NAME);
  }

  // `cursors`, `messages` and `deliveries` are all keyed by provider or pane:
  // Telegram's update offset, a Discord snowflake and a Slack ts are unrelated
  // values that must never overwrite one another.
  static _emptyState() {
    return {
      cursors: {},
      blockedPanes: [],
      messages: {},
      deliveries: {},
      questions: {},
      tokens: {},
      awaitingText: {},
    };
  }

  static _normalizeObjectMap(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  // Each entry is { cursor, target }. Anything else is dropped: entries written
  // before cursors were target-scoped carry no record of which chat/channel
  // they belong to, so they cannot be trusted against the current one.
  static _normalizeCursors(value) {
    const source = RelayStateStore._normalizeObjectMap(value);
    const cursors = {};
    for (const [providerId, entry] of Object.entries(source)) {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry) && entry.target !== undefined) {
        cursors[providerId] = { cursor: entry.cursor, target: entry.target };
      }
    }
    return cursors;
  }

  // `messages` is provider-keyed maps. Anything else in a bucket (including a
  // pre-multi-provider flat messageId->paneId entry) is discarded.
  static _normalizeProviderMaps(value) {
    const source = RelayStateStore._normalizeObjectMap(value);
    const maps = {};
    for (const [providerId, providerMessages] of Object.entries(source)) {
      if (providerMessages !== null && typeof providerMessages === 'object' && !Array.isArray(providerMessages)) {
        maps[providerId] = providerMessages;
      }
    }
    return maps;
  }

  static _warnInvalidStateOnce(reason) {
    if (RelayStateStore._hasWarnedAboutInvalidState) {
      return;
    }
    RelayStateStore._hasWarnedAboutInvalidState = true;
    process.stderr.write(
      `${RelayStateStore.LOG_PREFIX}: ignoring invalid relay state at ${RelayStateStore._statePath()} (${reason}); using defaults\n`,
    );
  }

  static _normalizeState(parsed) {
    const cursors = RelayStateStore._normalizeCursors(parsed.cursors);
    // A pre-multi-provider flat `offset`, and that era's flat message map, are
    // both dropped rather than migrated: neither records which chat it belongs
    // to. Telegram's own bootstrap (getUpdates with offset -1) already skips
    // the pending-update queue those entries existed to skip.
    return {
      cursors,
      blockedPanes: Array.isArray(parsed.blockedPanes) ? parsed.blockedPanes : [],
      messages: RelayStateStore._normalizeProviderMaps(parsed.messages),
      deliveries: RelayStateStore._normalizeObjectMap(parsed.deliveries),
      questions: RelayStateStore._normalizeObjectMap(parsed.questions),
      tokens: RelayStateStore._normalizeObjectMap(parsed.tokens),
      awaitingText: RelayStateStore._normalizeObjectMap(parsed.awaitingText),
    };
  }

  static _readStateFile() {
    let fileContents;
    try {
      fileContents = fs.readFileSync(RelayStateStore._statePath(), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        RelayStateStore._warnInvalidStateOnce('unreadable file');
      }
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(fileContents);
    } catch {
      RelayStateStore._warnInvalidStateOnce('invalid JSON');
      return null;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      RelayStateStore._warnInvalidStateOnce('not a state object');
      return null;
    }
    return parsed;
  }

  static _loadState() {
    const raw = RelayStateStore._readStateFile();
    return raw ? RelayStateStore._normalizeState(raw) : RelayStateStore._emptyState();
  }

  _save() {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(RelayStateStore._statePath(), `${JSON.stringify(this._state, null, 2)}\n`, {
      mode: RelayStateStore.FILE_MODE,
    });
  }

  // Returns the stored cursor only when it was recorded against the same
  // chat/channel. Anything else — a different target, or an entry from before
  // cursors were target-scoped — reads as absent, which sends the provider
  // through its bootstrap instead. Bootstrapping is always safe (it adopts the
  // newest message and emits nothing), whereas trusting a cursor from another
  // channel replays that channel's backlog as fresh answers.
  getCursor(providerId, targetId) {
    const entry = this._state.cursors[providerId];
    if (entry === null || typeof entry !== 'object') {
      return undefined;
    }
    return String(entry.target) === String(targetId) ? entry.cursor : undefined;
  }

  setCursor(providerId, cursor, targetId) {
    this._state.cursors[providerId] = { cursor, target: targetId === undefined ? null : String(targetId) };
    this._save();
  }

  // `deliveries` is one entry per provider that received the blocked message:
  // its own message id plus the base text it rendered, which is what lets the
  // answered message be edited in place on every provider at once.
  // `event` and the options fingerprint are kept so the relay can announce the
  // *next* question of a multi-question prompt: it needs the agent's label to
  // render the message, and a way to tell a genuinely new question from a pane
  // that simply has not re-rendered yet.
  trackBlocked(paneId, { deliveries = [], token, options, event } = {}) {
    this.expirePane(paneId);
    if (!this._state.blockedPanes.includes(paneId)) {
      this._state.blockedPanes.push(paneId);
    }
    this._state.questions[paneId] = {
      ...(event !== undefined ? { event } : {}),
      optionsKey: RelayStateStore.optionsKey(options),
    };
    this._state.deliveries[paneId] = deliveries.map(({ providerId, messageId, baseText }) => ({
      providerId,
      messageId,
      baseText,
    }));
    for (const { providerId, messageId } of deliveries) {
      this.registerMessage(providerId, messageId, paneId, { save: false });
    }
    if (Array.isArray(options) && options.length > 0 && token !== undefined) {
      this._state.tokens[token] = { paneId, options };
    }
    this._save();
  }

  // Maps a follow-up prompt message (the "reply with your text" one sent after
  // an expectsText selection) to its pane, so a reply-to on that message
  // routes the user's text even with multiple blocked panes.
  registerMessage(providerId, messageId, paneId, { save = true } = {}) {
    if (!this._state.messages[providerId]) {
      this._state.messages[providerId] = {};
    }
    this._state.messages[providerId][messageId] = paneId;
    if (save) {
      this._save();
    }
  }

  // An expectsText option was selected: the pane's menu is gone (a text input
  // replaced it), so drop the token/options entries — but keep blockedPanes
  // and messages so the follow-up free-text reply still resolves the pane.
  setAwaitingText(paneId) {
    this._dropTokensForPane(paneId);
    this._state.awaitingText[paneId] = true;
    this._save();
  }

  isAwaitingText(paneId) {
    return this._state.awaitingText[paneId] === true;
  }

  resolveByMessageId(providerId, messageId) {
    const providerMessages = this._state.messages[providerId] || {};
    const paneId = providerMessages[messageId];
    return typeof paneId === 'string' ? paneId : null;
  }

  resolveByToken(token) {
    return this._state.tokens[token] || null;
  }

  // Lets a free-text reply be matched against the same options a button-tap
  // would have offered, without needing a separate messageId->options index —
  // `tokens` already maps 1:1 with "the pane currently has a detected menu".
  resolveOptionsByPane(paneId) {
    for (const entry of Object.values(this._state.tokens)) {
      if (entry && entry.paneId === paneId) {
        return entry.options;
      }
    }
    return null;
  }

  getBlockedPanes() {
    return [...this._state.blockedPanes];
  }

  getQuestion(paneId) {
    const question = this._state.questions[paneId];
    return question !== null && typeof question === 'object' ? question : null;
  }

  getDeliveries(paneId) {
    const deliveries = this._state.deliveries[paneId];
    return Array.isArray(deliveries) ? [...deliveries] : [];
  }

  expirePane(paneId) {
    const index = this._state.blockedPanes.indexOf(paneId);
    if (index !== -1) {
      this._state.blockedPanes.splice(index, 1);
    }
    this._dropMessagesForPane(paneId);
    delete this._state.deliveries[paneId];
    delete this._state.questions[paneId];
    this._dropTokensForPane(paneId);
    delete this._state.awaitingText[paneId];
    this._save();
  }

  _dropMessagesForPane(paneId) {
    for (const providerMessages of Object.values(this._state.messages)) {
      for (const messageId of Object.keys(providerMessages)) {
        if (providerMessages[messageId] === paneId) {
          delete providerMessages[messageId];
        }
      }
    }
  }

  _dropTokensForPane(paneId) {
    for (const [token, entry] of Object.entries(this._state.tokens)) {
      if (entry && entry.paneId === paneId) {
        delete this._state.tokens[token];
      }
    }
  }
}

module.exports = { RelayStateStore };

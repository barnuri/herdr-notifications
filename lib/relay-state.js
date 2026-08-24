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

  static DEFAULT_STATE = { offset: 0, blockedPanes: [], messages: {}, tokens: {}, awaitingText: {} };

  // Corrupt-state warning is emitted at most once per process (own flag, not
  // shared with lib/config.js's warnInvalidConfigOnce).
  static _hasWarnedAboutInvalidState = false;

  constructor() {
    this._state = RelayStateStore._loadState();
  }

  static generateToken() {
    return crypto.randomBytes(4).toString('hex');
  }

  static _statePath() {
    return path.join(configDir(), RelayStateStore.FILE_NAME);
  }

  static _emptyState() {
    return { offset: RelayStateStore.DEFAULT_STATE.offset, blockedPanes: [], messages: {}, tokens: {}, awaitingText: {} };
  }

  static _normalizeObjectMap(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  static _warnInvalidStateOnce(reason) {
    if (RelayStateStore._hasWarnedAboutInvalidState) {
      return;
    }
    RelayStateStore._hasWarnedAboutInvalidState = true;
    process.stderr.write(
      `herdr-telegram-notifications: ignoring invalid relay state at ${RelayStateStore._statePath()} (${reason}); using defaults\n`
    );
  }

  static _normalizeState(parsed) {
    return {
      offset: typeof parsed.offset === 'number' ? parsed.offset : RelayStateStore.DEFAULT_STATE.offset,
      blockedPanes: Array.isArray(parsed.blockedPanes) ? parsed.blockedPanes : [],
      messages: RelayStateStore._normalizeObjectMap(parsed.messages),
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

  getOffset() {
    return this._state.offset;
  }

  setOffset(offset) {
    this._state.offset = offset;
    this._save();
  }

  trackBlocked(paneId, { messageId, token, options, text } = {}) {
    this.expirePane(paneId);
    if (!this._state.blockedPanes.includes(paneId)) {
      this._state.blockedPanes.push(paneId);
    }
    this._state.messages[messageId] = paneId;
    if (Array.isArray(options) && options.length > 0) {
      // `text` (the base message body, sans the "tap a button" hint) is kept
      // so a button tap can edit the original message in place to show what
      // was picked — otherwise the buttons just sit there with no visible
      // confirmation after a tap. Only stored when passed, so callers that
      // don't supply it (existing tests, or the resolveByToken caller) get
      // exactly the pre-existing {paneId, options} shape back.
      this._state.tokens[token] = { paneId, options, ...(text !== undefined ? { text } : {}) };
    }
    this._save();
  }

  // Maps a follow-up prompt message (the "reply with your text" one sent after
  // an expectsText selection) to its pane, so a reply-to on that message
  // routes the user's text even with multiple blocked panes.
  registerMessage(messageId, paneId) {
    this._state.messages[messageId] = paneId;
    this._save();
  }

  // An expectsText option was selected: the pane's menu is gone (a text input
  // replaced it), so drop the token/options entries — but keep blockedPanes
  // and messages so the follow-up free-text reply still resolves the pane.
  setAwaitingText(paneId) {
    this._dropTokensForPane(paneId);
    this._state.awaitingText[paneId] = true;
    this._save();
  }

  _dropTokensForPane(paneId) {
    for (const [token, entry] of Object.entries(this._state.tokens)) {
      if (entry && entry.paneId === paneId) {
        delete this._state.tokens[token];
      }
    }
  }

  isAwaitingText(paneId) {
    return this._state.awaitingText[paneId] === true;
  }

  resolveByMessageId(messageId) {
    const paneId = this._state.messages[messageId];
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

  expirePane(paneId) {
    const index = this._state.blockedPanes.indexOf(paneId);
    if (index !== -1) {
      this._state.blockedPanes.splice(index, 1);
    }
    for (const [messageId, mappedPaneId] of Object.entries(this._state.messages)) {
      if (mappedPaneId === paneId) {
        delete this._state.messages[messageId];
      }
    }
    this._dropTokensForPane(paneId);
    delete this._state.awaitingText[paneId];
    this._save();
  }
}

module.exports = { RelayStateStore };

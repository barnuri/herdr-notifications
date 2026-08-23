'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_FILE_NAME = 'config.json';
const MIN_POLL_MS = 500;

const DEFAULTS = {
  enabled: true,
  botToken: '',
  chatId: '',
  pollMs: 2000,
  notifyOn: { idle: true, blocked: true, done: true },
};

// Corrupt-config warning is emitted at most once per process.
let hasWarnedAboutInvalidConfig = false;

function configDir() {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    return process.env.HERDR_PLUGIN_CONFIG_DIR;
  }
  return path.join(os.homedir(), '.config', 'herdr-telegram-notifications');
}

function configPath() {
  return path.join(configDir(), CONFIG_FILE_NAME);
}

// Deliberately excludes parse-error details: the config file holds the bot
// token, and JSON.parse errors can quote the source text.
function warnInvalidConfigOnce(reason) {
  if (hasWarnedAboutInvalidConfig) {
    return;
  }
  hasWarnedAboutInvalidConfig = true;
  process.stderr.write(`herdr-telegram-notifications: ignoring invalid config at ${configPath()} (${reason}); using defaults\n`);
}

function readConfigFile() {
  let fileContents;
  try {
    fileContents = fs.readFileSync(configPath(), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warnInvalidConfigOnce('unreadable file');
    }
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(fileContents);
  } catch {
    warnInvalidConfigOnce('invalid JSON');
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnInvalidConfigOnce('not a config object');
    return null;
  }
  return parsed;
}

function normalizeEnabled(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeBotToken(value) {
  return typeof value === 'string' ? value : DEFAULTS.botToken;
}

function normalizeChatId(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return DEFAULTS.chatId;
}

function normalizePollMs(value) {
  const isNumericInput = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
  if (!isNumericInput) {
    return DEFAULTS.pollMs;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULTS.pollMs;
  }
  return Math.max(MIN_POLL_MS, numeric);
}

function normalizeNotifyOn(value) {
  const raw = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const notifyOn = {};
  for (const key of Object.keys(DEFAULTS.notifyOn)) {
    notifyOn[key] = normalizeEnabled(raw[key], DEFAULTS.notifyOn[key]);
  }
  return notifyOn;
}

function loadConfig() {
  const raw = readConfigFile() || {};
  return Object.freeze({
    enabled: normalizeEnabled(raw.enabled, DEFAULTS.enabled),
    botToken: normalizeBotToken(raw.botToken),
    chatId: normalizeChatId(raw.chatId),
    pollMs: normalizePollMs(raw.pollMs),
    notifyOn: Object.freeze(normalizeNotifyOn(raw.notifyOn)),
  });
}

module.exports = { DEFAULTS, configDir, configPath, loadConfig };

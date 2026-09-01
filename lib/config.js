'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_FILE_NAME = 'config.json';
const MIN_POLL_MS = 500;
const MIN_CONTEXT_LINES = 1;
const MAX_CONTEXT_LINES = 200;
const MIN_RELAY_POLL_MS = 500;
// The config file holds the bot token, so it must not be group/world readable.
const CONFIG_FILE_MODE = 0o600;

const DEFAULTS = {
  enabled: true,
  botToken: '',
  chatId: '',
  pollMs: 2000,
  notifyOn: { idle: true, blocked: true, done: true },
  relay: { enabled: false, contextLines: 40, pollMs: 1000 },
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

function parseClampedNumber(value, { fallback, min, max = Infinity }) {
  const isNumericInput = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
  if (!isNumericInput) {
    return fallback;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

function normalizePollMs(value) {
  return parseClampedNumber(value, { fallback: DEFAULTS.pollMs, min: MIN_POLL_MS });
}

function normalizeNotifyOn(value) {
  const raw = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const notifyOn = {};
  for (const key of Object.keys(DEFAULTS.notifyOn)) {
    notifyOn[key] = normalizeEnabled(raw[key], DEFAULTS.notifyOn[key]);
  }
  return notifyOn;
}

function normalizeContextLines(value) {
  return parseClampedNumber(value, {
    fallback: DEFAULTS.relay.contextLines,
    min: MIN_CONTEXT_LINES,
    max: MAX_CONTEXT_LINES,
  });
}

function normalizeRelayPollMs(value) {
  return parseClampedNumber(value, { fallback: DEFAULTS.relay.pollMs, min: MIN_RELAY_POLL_MS });
}

function normalizeRelay(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze({ ...DEFAULTS.relay });
  }
  return {
    enabled: normalizeEnabled(value.enabled, DEFAULTS.relay.enabled),
    contextLines: normalizeContextLines(value.contextLines),
    pollMs: normalizeRelayPollMs(value.pollMs),
  };
}

function loadConfig() {
  const raw = readConfigFile() || {};
  return Object.freeze({
    enabled: normalizeEnabled(raw.enabled, DEFAULTS.enabled),
    botToken: normalizeBotToken(raw.botToken),
    chatId: normalizeChatId(raw.chatId),
    pollMs: normalizePollMs(raw.pollMs),
    notifyOn: Object.freeze(normalizeNotifyOn(raw.notifyOn)),
    relay: Object.freeze(normalizeRelay(raw.relay)),
  });
}

// Writes the whole config object. The mode only takes effect when the file is
// created; an existing file keeps whatever permissions it already has.
function writeConfig(nextConfig) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify(nextConfig, null, 2)}\n`, { mode: CONFIG_FILE_MODE });
}

// Read-modify-write over the *raw* file contents, not the normalized config, so
// unknown/future keys and hand-written values survive an edit by this plugin.
function updateConfig(mutate) {
  const nextConfig = mutate({ ...(readConfigFile() || {}) });
  writeConfig(nextConfig);
  return nextConfig;
}

module.exports = { DEFAULTS, CONFIG_FILE_MODE, configDir, configPath, loadConfig, writeConfig, updateConfig };

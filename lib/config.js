'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_FILE_NAME = 'config.json';
const PLUGIN_NAME = 'herdr-notifications';
// Config directory names this plugin used before it was renamed. Checked when
// the current path holds no config file, so a rename doesn't orphan an
// already-configured install. Matched exactly rather than by suffix: a
// different publisher's similarly-named plugin must never be read for tokens.
const LEGACY_CONFIG_DIR_NAMES = ['barnuri.telegram-notifications', 'herdr-telegram-notifications'];
const PROVIDER_ENABLED_KEY = 'enabled';
const TELEGRAM_PROVIDER_ID = 'telegram';

const MIN_POLL_MS = 500;
const MIN_CONTEXT_LINES = 1;
const MAX_CONTEXT_LINES = 200;
const MIN_RELAY_POLL_MS = 500;
// The config file holds provider bot tokens, so it must not be group/world readable.
const CONFIG_FILE_MODE = 0o600;

// Per-provider credential fields, and the schema for what a provider block may
// contain. Adding a provider means three edits: a class under lib/providers/,
// a line in lib/providers/index.js, and a block here.
const PROVIDER_DEFAULTS = Object.freeze({
  telegram: Object.freeze({ enabled: false, botToken: '', chatId: '' }),
  discord: Object.freeze({ enabled: false, botToken: '', channelId: '' }),
  // appToken (xapp-…) is optional: with it the Slack provider opens a Socket
  // Mode connection and offers real buttons; without it, options are rendered
  // as a reply-with-this-value list.
  slack: Object.freeze({ enabled: false, botToken: '', channelId: '', appToken: '' }),
});

// Frozen: `DEFAULTS` is exported and handed straight to writeConfig by
// bin/edit-config.js, so a stray mutation would corrupt the defaults for the
// whole process.
const DEFAULTS = Object.freeze({
  enabled: true,
  pollMs: 2000,
  notifyOn: Object.freeze({ idle: true, blocked: true, done: true }),
  relay: Object.freeze({ enabled: false, contextLines: 40, pollMs: 1000 }),
  providers: PROVIDER_DEFAULTS,
});

// Corrupt-config warning is emitted at most once per process.
let hasWarnedAboutInvalidConfig = false;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configDir() {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    return process.env.HERDR_PLUGIN_CONFIG_DIR;
  }
  return path.join(os.homedir(), '.config', PLUGIN_NAME);
}

function configPath() {
  return path.join(configDir(), CONFIG_FILE_NAME);
}

// Where a pre-rename config could be sitting: a sibling of the active config
// dir (herdr keeps every plugin's config dir under one parent, named after the
// plugin id), or the standalone-fallback location.
function legacyConfigPaths() {
  const parentDir = path.dirname(configDir());
  const homeConfigDir = path.join(os.homedir(), '.config');
  const paths = LEGACY_CONFIG_DIR_NAMES.flatMap((dirName) => [
    path.join(parentDir, dirName, CONFIG_FILE_NAME),
    path.join(homeConfigDir, dirName, CONFIG_FILE_NAME),
  ]);
  return paths.filter((candidate) => candidate !== configPath());
}

// Reads from the current path when it exists, otherwise from the first legacy
// path that does. Writes always target the current path, so the first edit
// through this plugin migrates the file forward.
function resolveReadPath() {
  const currentPath = configPath();
  if (fs.existsSync(currentPath)) {
    return currentPath;
  }
  return legacyConfigPaths().find((candidate) => fs.existsSync(candidate)) || currentPath;
}

// Deliberately excludes parse-error details: the config file holds bot tokens,
// and JSON.parse errors can quote the source text.
function warnInvalidConfigOnce(reason, filePath) {
  if (hasWarnedAboutInvalidConfig) {
    return;
  }
  hasWarnedAboutInvalidConfig = true;
  process.stderr.write(`${PLUGIN_NAME}: ignoring invalid config at ${filePath} (${reason}); using defaults\n`);
}

function readConfigFile() {
  const filePath = resolveReadPath();
  let fileContents;
  try {
    fileContents = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warnInvalidConfigOnce('unreadable file', filePath);
    }
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(fileContents);
  } catch {
    warnInvalidConfigOnce('invalid JSON', filePath);
    return null;
  }

  if (!isPlainObject(parsed)) {
    warnInvalidConfigOnce('not a config object', filePath);
    return null;
  }
  return parsed;
}

function normalizeEnabled(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

// Credentials are strings, but chat/channel ids are routinely hand-written as
// numbers (Telegram's are numeric), and pasted tokens carry stray whitespace.
function normalizeCredential(value, fallback) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return fallback;
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
  const raw = isPlainObject(value) ? value : {};
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
  if (!isPlainObject(value)) {
    return { ...DEFAULTS.relay };
  }
  return {
    enabled: normalizeEnabled(value.enabled, DEFAULTS.relay.enabled),
    contextLines: normalizeContextLines(value.contextLines),
    pollMs: normalizeRelayPollMs(value.pollMs),
  };
}

function normalizeProvider(value, providerDefaults) {
  const raw = isPlainObject(value) ? value : {};
  const provider = { enabled: normalizeEnabled(raw[PROVIDER_ENABLED_KEY], providerDefaults.enabled) };
  for (const field of Object.keys(providerDefaults)) {
    if (field === PROVIDER_ENABLED_KEY) {
      continue;
    }
    provider[field] = normalizeCredential(raw[field], providerDefaults[field]);
  }
  return provider;
}

// Pre-rename configs kept a single Telegram bot at the top level. Those keys
// are adopted as the `telegram` provider block.
function withLegacyTelegram(raw) {
  const providers = isPlainObject(raw.providers) ? raw.providers : {};
  const botToken = normalizeCredential(raw.botToken, '');
  const chatId = normalizeCredential(raw.chatId, '');
  if (!botToken && !chatId) {
    return providers;
  }

  const explicit = providers[TELEGRAM_PROVIDER_ID];
  if (!isPlainObject(explicit)) {
    // A half-configured legacy install stays off rather than failing on send.
    return {
      ...providers,
      [TELEGRAM_PROVIDER_ID]: { enabled: Boolean(botToken && chatId), botToken, chatId },
    };
  }

  // An explicit block wins field by field, but it must not *hide* credentials
  // the legacy keys still hold: `{ "enabled": false }` is a normal edit (it is
  // what the notify actions write) and must not make the token disappear.
  return { ...providers, [TELEGRAM_PROVIDER_ID]: { botToken, chatId, ...explicit } };
}

function normalizeProviders(raw) {
  const source = withLegacyTelegram(raw);
  const providers = {};
  for (const [providerId, providerDefaults] of Object.entries(PROVIDER_DEFAULTS)) {
    providers[providerId] = Object.freeze(normalizeProvider(source[providerId], providerDefaults));
  }
  return providers;
}

function loadConfig() {
  const raw = readConfigFile() || {};
  return Object.freeze({
    enabled: normalizeEnabled(raw.enabled, DEFAULTS.enabled),
    pollMs: normalizePollMs(raw.pollMs),
    notifyOn: Object.freeze(normalizeNotifyOn(raw.notifyOn)),
    relay: Object.freeze(normalizeRelay(raw.relay)),
    providers: Object.freeze(normalizeProviders(raw)),
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

module.exports = {
  DEFAULTS,
  PROVIDER_DEFAULTS,
  CONFIG_FILE_MODE,
  configDir,
  configPath,
  legacyConfigPaths,
  loadConfig,
  writeConfig,
  updateConfig,
};

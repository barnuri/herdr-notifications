'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

const {
  DEFAULTS,
  PROVIDER_DEFAULTS,
  configDir,
  configPath,
  legacyConfigPaths,
  loadConfig,
  updateConfig,
} = require('../lib/config');

let tempParentDir;
let tempConfigDir;
let previousConfigDirEnv;

function enabledByStatus(notifyOn) {
  return Object.fromEntries(Object.entries(notifyOn).map(([status, rule]) => [status, rule.enabled]));
}

function writeConfigFile(contents, dir = tempConfigDir) {
  const serialized = typeof contents === 'string' ? contents : JSON.stringify(contents);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), serialized, 'utf8');
}

beforeEach(() => {
  previousConfigDirEnv = process.env.HERDR_PLUGIN_CONFIG_DIR;
  tempParentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-notifications-config-'));
  tempConfigDir = path.join(tempParentDir, 'barnuri.notifications');
  fs.mkdirSync(tempConfigDir, { recursive: true });
  process.env.HERDR_PLUGIN_CONFIG_DIR = tempConfigDir;
});

afterEach(() => {
  if (previousConfigDirEnv === undefined) {
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  } else {
    process.env.HERDR_PLUGIN_CONFIG_DIR = previousConfigDirEnv;
  }
  fs.rmSync(tempParentDir, { recursive: true, force: true });
});

test('configDir honors HERDR_PLUGIN_CONFIG_DIR override', () => {
  assert.equal(configDir(), tempConfigDir);
  assert.equal(configPath(), path.join(tempConfigDir, 'config.json'));
});

test('returns defaults when config file is missing', () => {
  assert.deepEqual(loadConfig(), DEFAULTS);
});

test('every known provider is present and disabled by default', () => {
  const { providers } = loadConfig();
  assert.deepEqual(Object.keys(providers).sort(), ['discord', 'slack', 'telegram']);
  for (const provider of Object.values(providers)) {
    assert.equal(provider.enabled, false);
  }
});

test('per-type toggle override is respected', () => {
  writeConfigFile({ notifyOn: { idle: false, blocked: true, done: false } });
  const config = loadConfig();
  assert.deepEqual(enabledByStatus(config.notifyOn), { idle: false, blocked: true, done: false });
});

test('partial notifyOn falls back to defaults for missing keys', () => {
  writeConfigFile({ notifyOn: { done: false } });
  assert.deepEqual(enabledByStatus(loadConfig().notifyOn), { idle: true, blocked: true, done: false });
});

test('the legacy boolean shape keeps each status on its built-in duration rule', () => {
  writeConfigFile({ notifyOn: { idle: true, blocked: true, done: true } });
  const { notifyOn } = loadConfig();
  assert.equal(notifyOn.idle.minWorkingMs, 900000);
  assert.equal(notifyOn.done.minWorkingMs, 900000);
  assert.equal(notifyOn.blocked.minWorkingMs, 0);
  assert.equal(notifyOn.blocked.skipWhenFocused, false);
});

test('a per-status object configures duration and focus independently', () => {
  writeConfigFile({
    notifyOn: {
      idle: { enabled: true, minWorkingMs: 60000, skipWhenFocused: true },
      done: { enabled: false },
    },
  });
  const { notifyOn } = loadConfig();
  assert.deepEqual(notifyOn.idle, { enabled: true, minWorkingMs: 60000, skipWhenFocused: true });
  assert.equal(notifyOn.done.enabled, false);
  assert.equal(notifyOn.done.minWorkingMs, 900000);
});

test('the defaults block applies to every status that does not override it', () => {
  writeConfigFile({ notifyOn: { defaults: { minWorkingMs: 45000, skipWhenFocused: true } } });
  const { notifyOn } = loadConfig();
  for (const status of ['idle', 'blocked', 'done']) {
    assert.equal(notifyOn[status].minWorkingMs, 45000, status);
    assert.equal(notifyOn[status].skipWhenFocused, true, status);
  }
});

test('a per-status value beats the defaults block', () => {
  writeConfigFile({
    notifyOn: { defaults: { minWorkingMs: 45000 }, done: { minWorkingMs: 5000 } },
  });
  const { notifyOn } = loadConfig();
  assert.equal(notifyOn.done.minWorkingMs, 5000);
  assert.equal(notifyOn.idle.minWorkingMs, 45000);
});

test('the defaults block is not exposed as a status in the normalized config', () => {
  writeConfigFile({ notifyOn: { defaults: { minWorkingMs: 45000 } } });
  assert.deepEqual(Object.keys(loadConfig().notifyOn).sort(), ['blocked', 'done', 'idle']);
});

test('a negative minWorkingMs is clamped to zero', () => {
  writeConfigFile({ notifyOn: { done: { minWorkingMs: -5000 } } });
  assert.equal(loadConfig().notifyOn.done.minWorkingMs, 0);
});

test('unusable notifyOn field values fall back to the built-in rule', () => {
  writeConfigFile({
    notifyOn: { idle: { minWorkingMs: 'soon', skipWhenFocused: [] }, blocked: 'nonsense' },
  });
  const { notifyOn } = loadConfig();
  assert.equal(notifyOn.idle.minWorkingMs, 900000);
  assert.equal(notifyOn.idle.skipWhenFocused, false);
  assert.equal(notifyOn.blocked.enabled, true);
});

test('a numeric-string minWorkingMs is accepted', () => {
  writeConfigFile({ notifyOn: { done: { minWorkingMs: '120000' } } });
  assert.equal(loadConfig().notifyOn.done.minWorkingMs, 120000);
});

test('invalid JSON falls back to defaults', () => {
  writeConfigFile('{ not json');
  assert.deepEqual(loadConfig(), DEFAULTS);
});

test('non-object config falls back to defaults', () => {
  writeConfigFile('[1, 2, 3]');
  assert.deepEqual(loadConfig(), DEFAULTS);
});

test('pollMs is clamped to the minimum', () => {
  writeConfigFile({ pollMs: 10 });
  assert.equal(loadConfig().pollMs, 500);
});

test('non-numeric pollMs falls back to the default', () => {
  writeConfigFile({ pollMs: 'soon' });
  assert.equal(loadConfig().pollMs, DEFAULTS.pollMs);
});

test('relay contextLines is clamped to the allowed range', () => {
  writeConfigFile({ relay: { contextLines: 5000 } });
  assert.equal(loadConfig().relay.contextLines, 200);
});

test('relay defaults apply when the relay block is not an object', () => {
  writeConfigFile({ relay: 'yes' });
  assert.deepEqual(loadConfig().relay, DEFAULTS.relay);
});

test('multiple providers can be enabled in parallel', () => {
  writeConfigFile({
    providers: {
      telegram: { enabled: true, botToken: 'tg-token', chatId: '123' },
      discord: { enabled: true, botToken: 'dc-token', channelId: '456' },
      slack: { enabled: true, botToken: 'xoxb-token', channelId: 'C789' },
    },
  });
  const { providers } = loadConfig();
  assert.equal(providers.telegram.enabled, true);
  assert.equal(providers.discord.enabled, true);
  assert.equal(providers.slack.enabled, true);
  assert.equal(providers.discord.channelId, '456');
  assert.equal(providers.slack.botToken, 'xoxb-token');
});

test('numeric chat and channel ids are coerced to strings', () => {
  writeConfigFile({
    providers: {
      telegram: { enabled: true, botToken: 't', chatId: -1001234567890 },
      discord: { enabled: true, botToken: 'd', channelId: 987654321098765432 },
    },
  });
  const { providers } = loadConfig();
  assert.equal(providers.telegram.chatId, '-1001234567890');
  assert.equal(typeof providers.discord.channelId, 'string');
});

test('pasted credentials are trimmed', () => {
  writeConfigFile({ providers: { slack: { enabled: true, botToken: '  xoxb-token\n', channelId: ' C1 ' } } });
  const { slack } = loadConfig().providers;
  assert.equal(slack.botToken, 'xoxb-token');
  assert.equal(slack.channelId, 'C1');
});

test('unknown fields inside a provider block are dropped from the normalized view', () => {
  writeConfigFile({ providers: { telegram: { enabled: true, botToken: 't', chatId: '1', mystery: 'x' } } });
  assert.deepEqual(Object.keys(loadConfig().providers.telegram).sort(), ['botToken', 'chatId', 'enabled']);
});

test('a provider block that is not an object falls back to its defaults', () => {
  writeConfigFile({ providers: { discord: 'on' } });
  assert.deepEqual(loadConfig().providers.discord, PROVIDER_DEFAULTS.discord);
});

test('legacy top-level telegram credentials are adopted as the telegram provider', () => {
  writeConfigFile({ botToken: 'legacy-token', chatId: '4242' });
  const { telegram } = loadConfig().providers;
  assert.deepEqual(telegram, { enabled: true, botToken: 'legacy-token', chatId: '4242' });
});

test('a half-configured legacy install is adopted but stays disabled', () => {
  writeConfigFile({ botToken: 'legacy-token' });
  const { telegram } = loadConfig().providers;
  assert.equal(telegram.enabled, false);
  assert.equal(telegram.botToken, 'legacy-token');
});

test('an explicit telegram provider block wins over legacy top-level keys', () => {
  writeConfigFile({
    botToken: 'legacy-token',
    chatId: '1',
    providers: { telegram: { enabled: true, botToken: 'new-token', chatId: '2' } },
  });
  const { telegram } = loadConfig().providers;
  assert.equal(telegram.botToken, 'new-token');
  assert.equal(telegram.chatId, '2');
});

test('legacy keys do not leak into other providers', () => {
  writeConfigFile({ botToken: 'legacy-token', chatId: '4242' });
  const { discord, slack } = loadConfig().providers;
  assert.equal(discord.botToken, '');
  assert.equal(slack.botToken, '');
});

test('config is read from a pre-rename sibling directory when the current one has no file', () => {
  const legacyDir = path.join(tempParentDir, 'barnuri.telegram-notifications');
  writeConfigFile({ providers: { telegram: { enabled: true, botToken: 'from-legacy-dir', chatId: '9' } } }, legacyDir);
  assert.equal(loadConfig().providers.telegram.botToken, 'from-legacy-dir');
});

test('the current directory wins over a pre-rename sibling directory', () => {
  const legacyDir = path.join(tempParentDir, 'barnuri.telegram-notifications');
  writeConfigFile({ providers: { telegram: { enabled: true, botToken: 'from-legacy-dir', chatId: '9' } } }, legacyDir);
  writeConfigFile({ providers: { telegram: { enabled: true, botToken: 'from-current-dir', chatId: '9' } } });
  assert.equal(loadConfig().providers.telegram.botToken, 'from-current-dir');
});

test('legacyConfigPaths never includes the active config path', () => {
  assert.ok(!legacyConfigPaths().includes(configPath()));
});

test('an edit migrates a legacy directory config forward to the current path', () => {
  const legacyDir = path.join(tempParentDir, 'barnuri.telegram-notifications');
  writeConfigFile({ providers: { telegram: { enabled: true, botToken: 'from-legacy-dir', chatId: '9' } } }, legacyDir);

  updateConfig((raw) => ({ ...raw, pollMs: 5000 }));

  assert.ok(fs.existsSync(configPath()));
  const migrated = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  assert.equal(migrated.providers.telegram.botToken, 'from-legacy-dir');
  assert.equal(migrated.pollMs, 5000);
});

test('updateConfig preserves unknown keys from the raw file', () => {
  writeConfigFile({ futureKey: 'keep-me', pollMs: 1000 });
  const next = updateConfig((raw) => ({ ...raw, pollMs: 3000 }));
  assert.equal(next.futureKey, 'keep-me');
  assert.equal(JSON.parse(fs.readFileSync(configPath(), 'utf8')).futureKey, 'keep-me');
});

test('an explicit telegram block does not hide credentials the legacy keys still hold', () => {
  writeConfigFile({
    botToken: 'legacy-token',
    chatId: '4242',
    providers: { telegram: { enabled: false } },
  });

  const { telegram } = loadConfig().providers;

  assert.equal(telegram.enabled, false, 'the explicit switch still wins');
  assert.equal(telegram.botToken, 'legacy-token', 'disabling a provider must not discard its token');
  assert.equal(telegram.chatId, '4242');
});

test('an explicit telegram block fills only the fields it omits from the legacy keys', () => {
  writeConfigFile({
    botToken: 'legacy-token',
    chatId: '4242',
    providers: { telegram: { enabled: true, botToken: 'rotated-token' } },
  });

  const { telegram } = loadConfig().providers;

  assert.equal(telegram.botToken, 'rotated-token');
  assert.equal(telegram.chatId, '4242');
});

test('autoApprove defaults to off with empty rule lists', () => {
  const config = loadConfig();

  assert.deepEqual(config.autoApprove, { enabled: false, notify: true, globs: [], regexes: [], folders: [] });
});

test('autoApprove booleans and pattern lists are read from the file', () => {
  writeConfigFile({
    autoApprove: { enabled: true, notify: false, globs: ['git status*'], regexes: ['npm (test|run lint)'] },
  });

  assert.deepEqual(loadConfig().autoApprove, {
    enabled: true,
    notify: false,
    globs: ['git status*'],
    regexes: ['npm (test|run lint)'],
    folders: [],
  });
});

test('autoApprove folders are read, trimmed, and unusable ones dropped', () => {
  writeConfigFile({ autoApprove: { folders: ['  ~/repo  ', '', 7] } });

  assert.deepEqual(loadConfig().autoApprove.folders, ['~/repo']);
});

test('autoApprove pattern entries are trimmed, and unusable ones dropped', () => {
  writeConfigFile({ autoApprove: { globs: ['  ls *  ', '', '   ', 42, null], regexes: ['npm test'] } });

  const { autoApprove } = loadConfig();

  assert.deepEqual(autoApprove.globs, ['ls *'], 'only usable strings survive, trimmed');
  assert.deepEqual(autoApprove.regexes, ['npm test']);
});

test('a non-array pattern list falls back to empty rather than throwing', () => {
  writeConfigFile({ autoApprove: { enabled: true, globs: 'git status*', regexes: { a: 1 } } });

  const { autoApprove } = loadConfig();

  assert.deepEqual(autoApprove.globs, []);
  assert.deepEqual(autoApprove.regexes, []);
  assert.equal(autoApprove.enabled, true, 'the rest of the block still applies');
});

test('a non-object autoApprove block falls back to defaults', () => {
  writeConfigFile({ autoApprove: 'yes please' });

  assert.deepEqual(loadConfig().autoApprove, { enabled: false, notify: true, globs: [], regexes: [], folders: [] });
});

test('autoApprove notify defaults to true when only enabled is set', () => {
  writeConfigFile({ autoApprove: { enabled: true } });

  const { autoApprove } = loadConfig();

  assert.equal(autoApprove.enabled, true);
  assert.equal(autoApprove.notify, true);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

const {
  PRESETS,
  CUSTOM_PRESET_ID,
  findPreset,
  matchPresetId,
  nextPreset,
  applyPresetToNotifyOn,
} = require('../lib/notify-filter');
const { resolvePreset } = require('../bin/notify-filter');
const { loadConfig, updateConfig, configPath } = require('../lib/config');

let tempConfigDir;
let previousConfigDirEnv;

beforeEach(() => {
  previousConfigDirEnv = process.env.HERDR_PLUGIN_CONFIG_DIR;
  tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-telegram-filter-'));
  process.env.HERDR_PLUGIN_CONFIG_DIR = tempConfigDir;
});

afterEach(() => {
  if (previousConfigDirEnv === undefined) {
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  } else {
    process.env.HERDR_PLUGIN_CONFIG_DIR = previousConfigDirEnv;
  }
  fs.rmSync(tempConfigDir, { recursive: true, force: true });
});

test('needs-me preset covers blocked and idle but not done', () => {
  assert.deepEqual(findPreset('needs-me').notifyOn, { idle: true, blocked: true, done: false });
});

test('matchPresetId names a known combination and flags anything else custom', () => {
  assert.equal(matchPresetId({ idle: true, blocked: true, done: true }), 'all');
  assert.equal(matchPresetId({ idle: true, blocked: true, done: false }), 'needs-me');
  assert.equal(matchPresetId({ idle: false, blocked: true, done: false }), 'blocked-only');
  assert.equal(matchPresetId({ idle: true, blocked: false, done: true }), CUSTOM_PRESET_ID);
  assert.equal(matchPresetId(null), CUSTOM_PRESET_ID);
});

test('nextPreset cycles through every preset and wraps around', () => {
  const visited = [];
  let current = PRESETS[0].id;
  for (let step = 0; step < PRESETS.length; step += 1) {
    current = nextPreset(current).id;
    visited.push(current);
  }
  assert.deepEqual(visited, [...PRESETS.slice(1).map((preset) => preset.id), PRESETS[0].id]);
});

test('nextPreset sends a custom combination back to the first preset', () => {
  assert.equal(nextPreset(CUSTOM_PRESET_ID).id, PRESETS[0].id);
});

test('resolvePreset with no argument advances from the current notifyOn', () => {
  assert.equal(resolvePreset(undefined, { idle: true, blocked: true, done: true }).id, 'needs-me');
});

test('resolvePreset with an explicit id sets it directly', () => {
  assert.equal(resolvePreset('blocked-only', { idle: true, blocked: true, done: true }).id, 'blocked-only');
});

test('resolvePreset rejects an unknown preset id', () => {
  assert.throws(() => resolvePreset('nope', {}), /unknown preset "nope"/);
});

test('applying a preset rewrites notifyOn and preserves other config keys', () => {
  fs.writeFileSync(
    configPath(),
    JSON.stringify({
      providers: {
        telegram: { enabled: true, botToken: 'token', chatId: '42' },
        slack: { enabled: true, botToken: 'xoxb-token', channelId: 'C1' },
      },
      notifyOn: { idle: true, blocked: true, done: true },
      futureKey: 7,
    }),
  );

  const preset = findPreset('needs-me');
  updateConfig((raw) => ({ ...raw, notifyOn: { ...preset.notifyOn } }));

  const written = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  assert.deepEqual(written.notifyOn, { idle: true, blocked: true, done: false });
  assert.equal(written.providers.telegram.botToken, 'token');
  assert.equal(written.providers.slack.channelId, 'C1');
  assert.equal(written.futureKey, 7);
  assert.equal(loadConfig().notifyOn.done.enabled, false);
  assert.equal(loadConfig().providers.slack.enabled, true, 'the filter action must not disturb provider settings');
});

test('applying a preset to a missing config file creates it with mode 0600', () => {
  const preset = findPreset('blocked-only');
  updateConfig((raw) => ({ ...raw, notifyOn: { ...preset.notifyOn } }));

  assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600);
  const { notifyOn } = loadConfig();
  assert.deepEqual(
    { idle: notifyOn.idle.enabled, blocked: notifyOn.blocked.enabled, done: notifyOn.done.enabled },
    { idle: false, blocked: true, done: false },
  );
});

test('cycling a preset keeps each status duration and focus rule intact', () => {
  fs.writeFileSync(
    configPath(),
    JSON.stringify({
      notifyOn: {
        defaults: { minWorkingMs: 45000 },
        idle: { enabled: false, minWorkingMs: 120000, skipWhenFocused: true },
        blocked: { enabled: true, minWorkingMs: 0, skipWhenFocused: false },
        done: { enabled: false, minWorkingMs: 600000, skipWhenFocused: false },
      },
    }),
  );

  const preset = findPreset('all');
  updateConfig((raw) => ({ ...raw, notifyOn: applyPresetToNotifyOn(raw.notifyOn, preset) }));

  const written = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  assert.deepEqual(written.notifyOn.idle, { enabled: true, minWorkingMs: 120000, skipWhenFocused: true });
  assert.deepEqual(written.notifyOn.done, { enabled: true, minWorkingMs: 600000, skipWhenFocused: false });
  assert.deepEqual(written.notifyOn.defaults, { minWorkingMs: 45000 });
});

test('a preset applied to the legacy boolean shape stays boolean', () => {
  fs.writeFileSync(configPath(), JSON.stringify({ notifyOn: { idle: true, blocked: true, done: true } }));

  updateConfig((raw) => ({ ...raw, notifyOn: applyPresetToNotifyOn(raw.notifyOn, findPreset('blocked-only')) }));

  const written = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  assert.deepEqual(written.notifyOn, { idle: false, blocked: true, done: false });
});

test('matchPresetId reads the object shape, ignoring duration and focus rules', () => {
  assert.equal(
    matchPresetId({
      idle: { enabled: true, minWorkingMs: 900000, skipWhenFocused: true },
      blocked: { enabled: true, minWorkingMs: 0, skipWhenFocused: false },
      done: { enabled: false, minWorkingMs: 900000, skipWhenFocused: false },
    }),
    'needs-me',
  );
});

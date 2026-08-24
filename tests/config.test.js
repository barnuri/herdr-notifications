'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

const { DEFAULTS, configDir, configPath, loadConfig } = require('../lib/config');

let tempConfigDir;
let previousConfigDirEnv;

function writeConfigFile(contents) {
  const serialized = typeof contents === 'string' ? contents : JSON.stringify(contents);
  fs.writeFileSync(path.join(tempConfigDir, 'config.json'), serialized, 'utf8');
}

beforeEach(() => {
  previousConfigDirEnv = process.env.HERDR_PLUGIN_CONFIG_DIR;
  tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-telegram-config-'));
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

test('configDir honors HERDR_PLUGIN_CONFIG_DIR override', () => {
  assert.equal(configDir(), tempConfigDir);
  assert.equal(configPath(), path.join(tempConfigDir, 'config.json'));
});

test('returns defaults when config file is missing', () => {
  assert.deepEqual(loadConfig(), DEFAULTS);
});

test('per-type toggle override is respected', () => {
  writeConfigFile({ notifyOn: { idle: false, blocked: true, done: false } });
  const config = loadConfig();
  assert.deepEqual(config.notifyOn, { idle: false, blocked: true, done: false });
  assert.equal(config.enabled, true);
});

test('missing notifyOn keys default to true', () => {
  writeConfigFile({ notifyOn: { idle: false } });
  const config = loadConfig();
  assert.deepEqual(config.notifyOn, { idle: false, blocked: true, done: true });
});

test('master enabled=false is respected', () => {
  writeConfigFile({ enabled: false });
  const config = loadConfig();
  assert.equal(config.enabled, false);
  assert.deepEqual(config.notifyOn, DEFAULTS.notifyOn);
});

test('pollMs is clamped to the minimum', () => {
  writeConfigFile({ pollMs: 100 });
  assert.equal(loadConfig().pollMs, 500);
});

test('pollMs accepts numeric strings and rejects junk', () => {
  writeConfigFile({ pollMs: '3000' });
  assert.equal(loadConfig().pollMs, 3000);
  writeConfigFile({ pollMs: 'fast' });
  assert.equal(loadConfig().pollMs, DEFAULTS.pollMs);
});

test('chatId is normalized to a string', () => {
  writeConfigFile({ chatId: -1001234567890 });
  assert.equal(loadConfig().chatId, '-1001234567890');
  writeConfigFile({ chatId: '@my_channel' });
  assert.equal(loadConfig().chatId, '@my_channel');
});

test('corrupt JSON falls back to defaults', () => {
  writeConfigFile('{ not valid json');
  assert.deepEqual(loadConfig(), DEFAULTS);
});

test('relay defaults to disabled with documented contextLines/pollMs when config is empty', () => {
  writeConfigFile({});
  const config = loadConfig();
  assert.deepEqual(config.relay, { enabled: false, contextLines: 40, pollMs: 1000 });
  assert.deepEqual(config.relay, DEFAULTS.relay);
});

test('relay.enabled boolean coercion falls back to default when non-boolean', () => {
  writeConfigFile({ relay: { enabled: 'yes' } });
  assert.equal(loadConfig().relay.enabled, DEFAULTS.relay.enabled);
  writeConfigFile({ relay: { enabled: true } });
  assert.equal(loadConfig().relay.enabled, true);
});

test('relay.contextLines accepts numeric and numeric-string input', () => {
  writeConfigFile({ relay: { contextLines: 75 } });
  assert.equal(loadConfig().relay.contextLines, 75);
  writeConfigFile({ relay: { contextLines: '30' } });
  assert.equal(loadConfig().relay.contextLines, 30);
});

test('relay.contextLines is clamped to the documented [1, 200] range', () => {
  writeConfigFile({ relay: { contextLines: 0 } });
  assert.equal(loadConfig().relay.contextLines, 1);
  writeConfigFile({ relay: { contextLines: 500 } });
  assert.equal(loadConfig().relay.contextLines, 200);
});

test('relay.pollMs accepts numeric/numeric-string input and clamps independently of top-level pollMs', () => {
  writeConfigFile({ pollMs: 5000, relay: { pollMs: 100 } });
  const config = loadConfig();
  assert.equal(config.pollMs, 5000);
  assert.equal(config.relay.pollMs, 500);
  writeConfigFile({ relay: { pollMs: '2500' } });
  assert.equal(loadConfig().relay.pollMs, 2500);
});

test('partial relay config fills missing keys from defaults', () => {
  writeConfigFile({ relay: { enabled: true } });
  const config = loadConfig();
  assert.deepEqual(config.relay, { enabled: true, contextLines: DEFAULTS.relay.contextLines, pollMs: DEFAULTS.relay.pollMs });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { shellQuote, findPaneId, ensureConfigFile } = require('../bin/edit-config');
const { DEFAULTS } = require('../lib/config');

test('shellQuote wraps plain paths in single quotes', () => {
  assert.equal(shellQuote('/tmp/config.json'), `'/tmp/config.json'`);
});

test('shellQuote escapes embedded single quotes', () => {
  assert.equal(shellQuote(`/tmp/it's here`), `'/tmp/it'\\''s here'`);
});

test('findPaneId reads flat, nested tab, and panes-array shapes', () => {
  assert.equal(findPaneId({ pane_id: 'p1' }), 'p1');
  assert.equal(findPaneId({ tab: { pane_id: 'p2' } }), 'p2');
  assert.equal(findPaneId({ panes: [{ pane_id: 'p3' }] }), 'p3');
});

test('findPaneId returns null for missing or non-object payloads', () => {
  assert.equal(findPaneId(null), null);
  assert.equal(findPaneId('nope'), null);
  assert.equal(findPaneId({}), null);
});

test('ensureConfigFile writes defaults with mode 0600 and keeps an existing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-tg-test-'));
  process.env.HERDR_PLUGIN_CONFIG_DIR = dir;
  try {
    ensureConfigFile();
    const configFile = path.join(dir, 'config.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), DEFAULTS);
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);

    fs.writeFileSync(configFile, '{"enabled":false}\n');
    ensureConfigFile();
    assert.equal(fs.readFileSync(configFile, 'utf8'), '{"enabled":false}\n');
  } finally {
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

'use strict';

const fs = require('node:fs');

const { DEFAULTS, configDir, configPath } = require('../lib/config');
const { runHerdr, notifyDesktop } = require('../lib/herdr');

const NOTIFICATION_TITLE = 'Telegram Notifications';
const CONFIG_TAB_LABEL = 'telegram-config';
const DEFAULT_EDITOR = 'vi';
// The config file holds the bot token, so it must not be group/world readable.
const CONFIG_FILE_MODE = 0o600;

// 'pane run' takes a single shell command string, so the path must be quoted.
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function findPaneId(created) {
  if (created === null || typeof created !== 'object') {
    return null;
  }
  // 'tab create' payloads have shipped both flat and nested pane ids.
  return created.pane_id || created.tab?.pane_id || created.panes?.[0]?.pane_id || null;
}

// Materialize the config file (with defaults) so the editor has something to open.
function ensureConfigFile() {
  fs.mkdirSync(configDir(), { recursive: true });
  if (fs.existsSync(configPath())) {
    return;
  }
  fs.writeFileSync(configPath(), `${JSON.stringify(DEFAULTS, null, 2)}\n`, { mode: CONFIG_FILE_MODE });
}

async function main() {
  ensureConfigFile();

  const created = await runHerdr(['tab', 'create', '--cwd', configDir(), '--label', CONFIG_TAB_LABEL, '--focus']);
  const paneId = findPaneId(created);

  if (!paneId) {
    await notifyDesktop(NOTIFICATION_TITLE, `Config: ${configPath()}`);
    return;
  }

  const editor = process.env.EDITOR || DEFAULT_EDITOR;
  try {
    await runHerdr(['pane', 'run', paneId, `${editor} ${shellQuote(configPath())}`]);
  } catch {
    // 'pane run' has shipped without a JSON envelope; the editor may already be
    // launching, so surface the path instead of failing the action.
    await notifyDesktop(NOTIFICATION_TITLE, `Config: ${configPath()}`);
  }
}

main().catch((error) => {
  process.stderr.write(`herdr-telegram-notifications: edit-config failed: ${error.message}\n`);
  process.exit(1);
});

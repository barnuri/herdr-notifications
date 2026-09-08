'use strict';

const { loadConfig, updateConfig } = require('../lib/config');
const { PRESETS, findPreset, matchPresetId, nextPreset } = require('../lib/notify-filter');
const { notifyDesktop } = require('../lib/herdr');

const NOTIFICATION_TITLE = 'Herdr Notifications';

function usage() {
  const ids = PRESETS.map((preset) => preset.id).join(' | ');
  return `usage: node bin/notify-filter.js [${ids}]`;
}

// No argument cycles to the next preset; an explicit id sets it directly.
function resolvePreset(requestedId, currentNotifyOn) {
  if (!requestedId) {
    return nextPreset(matchPresetId(currentNotifyOn));
  }
  const preset = findPreset(requestedId);
  if (!preset) {
    throw new Error(`unknown preset "${requestedId}"; ${usage()}`);
  }
  return preset;
}

async function main() {
  const preset = resolvePreset(process.argv[2], loadConfig().notifyOn);
  updateConfig((raw) => ({ ...raw, notifyOn: { ...preset.notifyOn } }));
  await notifyDesktop(NOTIFICATION_TITLE, `Notify on: ${preset.title} — ${preset.summary}`);
  process.stdout.write(`notifyOn set to "${preset.id}" (${preset.summary})\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`herdr-notifications: notify-filter failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { resolvePreset, usage };

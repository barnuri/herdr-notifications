'use strict';

// Dry run of the hc source: follows real `hc events`, reads the real config,
// and prints each status transition with the verdict the watcher would reach.
// It sends nothing: no provider, relay or desktop toast is created.
//
//   HERDR_PLUGIN_CONFIG_DIR=<dir> node bin/hc-dry-run.js [seconds]   (default 30)

const { loadConfig } = require('../lib/config');
const { HcEventSource, attachTargetFromArgv } = require('../lib/hc');
const herdr = require('../lib/herdr');
const { StateWatcher } = require('../lib/state-watcher');
const { resolveNotifyRule, shouldNotify } = require('../lib/notify-rules');

const DEFAULT_SECONDS = 30;
const MS_PER_SECOND = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function print(line) {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
}

// Lists the herdr panes that are an `hc attach` of a terminal: their herdr
// events are the ones the watcher drops as duplicates.
async function printAttachedPanes() {
  let agents;
  try {
    agents = await herdr.listAgents();
  } catch (error) {
    print(`herdr TUI panes: unavailable (${error.message.split('\n')[0].slice(0, 120)})`);
    return;
  }
  for (const agent of agents) {
    let argvs = [];
    try {
      argvs = await herdr.paneForegroundArgvs(agent.pane_id);
    } catch {
      // Not readable: such a pane would keep its own notifications.
    }
    const target = argvs.map(attachTargetFromArgv).find((value) => value !== null);
    if (target) {
      print(`herdr pane ${agent.pane_id} is hc attach ${target}: its herdr events are deduped`);
    }
  }
  print(`herdr TUI panes: ${agents.length} agent(s) checked for hc attach`);
}

function describe(event, notifyOn) {
  const wanted = shouldNotify(notifyOn, event);
  const { delayMs } = resolveNotifyRule(notifyOn, event.type);
  const verdict = wanted ? `WOULD NOTIFY${delayMs > 0 ? ` after ${delayMs / MS_PER_SECOND}s if still ${event.type}` : ''}` : 'filtered';
  return `${event.paneId} ${event.previousStatus || '?'} -> ${event.type} [${event.agent.terminal_title_stripped}] worked ${Math.round((event.workingMs || 0) / MS_PER_SECOND)}s ${verdict}`;
}

async function main() {
  const seconds = Number(process.argv[2]) || DEFAULT_SECONDS;
  const config = loadConfig();
  print(`config: enabled=${config.enabled} hc.enabled=${config.hc.enabled} pollMs=${config.pollMs}`);
  await printAttachedPanes();

  const source = new HcEventSource({ log: (line) => print(`hc: ${line}`) });
  const watcher = new StateWatcher();
  const deadline = Date.now() + seconds * MS_PER_SECOND;
  let lastSummary = '';
  while (Date.now() < deadline) {
    const agents = source.listAgents();
    const summary = agents.map((agent) => `${agent.hc_address}=${agent.agent_status}`).join(' ');
    if (summary !== lastSummary) {
      print(`hc agents: ${summary || '(none with a status)'}`);
      lastSummary = summary;
    }
    for (const event of watcher.update(agents)) {
      print(describe(event, config.notifyOn));
    }
    await sleep(config.pollMs);
  }
  source.stop();
  print('dry run finished; nothing was sent');
}

main().catch((error) => {
  process.stderr.write(`hc-dry-run: ${error.message}\n`);
  process.exit(1);
});

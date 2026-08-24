'use strict';

// Opt-in, real end-to-end check: spins up a disposable, unfocused herdr
// workspace, launches a real `claude` session in a brand-new scratch
// directory (guaranteeing Claude Code's first-run trust-folder dialog),
// and verifies lib/option-detector.js + herdr.answerBlockedAgent actually
// drive that live dialog correctly.
//
// Not part of `npm test` — it requires the `herdr` CLI and a real,
// authenticated `claude` binary on PATH, spins up a real process, and takes
// several seconds. Run explicitly: `npm run test:e2e`.

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectOptions } = require('../lib/option-detector');
const { answerBlockedAgent } = require('../lib/herdr');

const execFileAsync = promisify(execFile);
const HERDR_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function herdrBinaryPath() {
  return process.env.HERDR_BIN_PATH || 'herdr';
}

async function herdr(args) {
  const { stdout } = await execFileAsync(herdrBinaryPath(), args, {
    encoding: 'utf8',
    maxBuffer: HERDR_MAX_BUFFER_BYTES,
  });
  return stdout;
}

async function herdrJson(args) {
  return JSON.parse(await herdr(args));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findAgent(paneId) {
  const { result } = await herdrJson(['agent', 'list']);
  return (result.agents || []).find((agent) => agent.pane_id === paneId) || null;
}

async function waitForBlocked(paneId, { timeoutMs = 20000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const agent = await findAgent(paneId);
    if (agent && agent.agent_status === 'blocked') {
      return agent;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${paneId} to reach agent_status "blocked"`);
}

const failures = [];

function check(label, condition, detail) {
  if (condition) {
    console.log(`[e2e] ✓ ${label}`);
  } else {
    console.log(`[e2e] ✗ ${label}`);
    failures.push(`${label}: ${detail}`);
  }
}

async function main() {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-e2e-option-detector-'));
  let workspaceId;

  try {
    console.log(`[e2e] scratch dir: ${scratchDir}`);
    const created = await herdrJson([
      'workspace', 'create',
      '--cwd', scratchDir,
      '--label', 'e2e-option-detector',
      '--no-focus',
    ]);
    const paneId = created.result.root_pane.pane_id;
    workspaceId = created.result.workspace.workspace_id;
    console.log(`[e2e] created workspace ${workspaceId}, pane ${paneId}`);

    await herdr(['pane', 'run', paneId, 'claude']);
    console.log('[e2e] launched claude, waiting for the trust-folder dialog...');
    await waitForBlocked(paneId);

    const dialogText = await herdr(['pane', 'read', paneId, '--source', 'visible', '--format', 'text']);
    console.log(`[e2e] captured dialog:\n${dialogText}`);

    const options = detectOptions(dialogText);
    check(
      'detectOptions finds exactly 2 options in the live trust-folder dialog',
      options.length === 2,
      `expected 2 options, got ${options.length}: ${JSON.stringify(options)}`
    );

    const exitOption = options[1];
    check(
      'the second option is the "No, exit" choice',
      Boolean(exitOption && /no,\s*exit/i.test(exitOption.label)),
      `expected options[1].label to mention "No, exit", got ${JSON.stringify(exitOption)}`
    );

    if (exitOption) {
      await answerBlockedAgent(paneId, exitOption.value);
      await sleep(1500);
      const stillPresent = await findAgent(paneId);
      check(
        'answerBlockedAgent(paneId, detected value) actually selects "No, exit" and the agent exits',
        stillPresent === null,
        'agent is still listed after answering — the detected option was not correctly selected'
      );
    }
  } finally {
    if (workspaceId) {
      try {
        await herdr(['workspace', 'close', workspaceId]);
      } catch (error) {
        console.error(`[e2e] warning: failed to close workspace ${workspaceId}: ${error.message}`);
      }
    }
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n[e2e] FAIL (${failures.length} failure(s)):`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log('\n[e2e] PASS');
}

main().catch((error) => {
  console.error(`[e2e] fatal: ${error.stack || error.message}`);
  process.exitCode = 1;
});

'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const HERDR_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

let execFileAsync = promisify(execFile);

function setExecFileAsync(fn) {
  execFileAsync = fn;
}

function herdrBinaryPath() {
  return process.env.HERDR_BIN_PATH || 'herdr';
}

async function execHerdr(args) {
  try {
    const { stdout } = await execFileAsync(herdrBinaryPath(), args, {
      encoding: 'utf8',
      maxBuffer: HERDR_MAX_BUFFER_BYTES,
    });
    return stdout;
  } catch (error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(`herdr ${args.join(' ')} failed: ${stderr || error.message}`);
  }
}

async function runHerdr(args) {
  const stdout = await execHerdr(args);
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`herdr ${args.join(' ')} returned unparseable output: ${stdout.trim()}`);
  }
  return envelope.result;
}

async function listAgents() {
  return (await runHerdr(['agent', 'list'])).agents || [];
}

async function notifyDesktop(title, body) {
  try {
    await execHerdr(['notification', 'show', title, '--body', body]);
    return true;
  } catch {
    // Notifications are best-effort; never let a failed toast break the caller.
    return false;
  }
}

// Only ever called for a pane whose status is `blocked` (relay.js reads
// output to build the notification for exactly that event) — and
// herdr's own `--source recent` (the default) always rejects a non-idle
// pane with `agent_not_idle` ("alternate-screen history can only be
// captured by scrolling while idle... use --source visible"). Since a
// blocked pane is by definition never idle, `recent` isn't just suboptimal
// here, it's guaranteed to throw — verified live against a real blocked
// session. `visible` (the current viewport) is what actually works, and is
// what the user would see looking at the pane themselves anyway.
async function readAgentOutput(paneId, { lines = 40 } = {}) {
  const stdout = await execHerdr([
    'agent',
    'read',
    paneId,
    '--lines',
    String(lines),
    '--source',
    'visible',
    '--format',
    'text',
  ]);
  return stdout.trim();
}

// `herdr agent prompt` rejects with `agent_blocked` when the target is already
// waiting at an approval/question dialog — exactly the case this function
// handles. Use the raw pane surface instead: inject the text, then submit it
// with an Enter keystroke.
const ENTER_KEY_CANDIDATES = ['enter', 'return'];

async function answerBlockedAgent(paneId, text) {
  await execHerdr(['pane', 'send-text', paneId, text]);
  let originalError;
  for (const key of ENTER_KEY_CANDIDATES) {
    try {
      await execHerdr(['pane', 'send-keys', paneId, key]);
      return;
    } catch (error) {
      // Keep the first (original 'enter') failure — if every candidate key
      // is rejected, that's the more informative error to surface, not the
      // fallback's.
      originalError = originalError || error;
    }
  }
  throw originalError;
}

module.exports = {
  runHerdr,
  listAgents,
  notifyDesktop,
  readAgentOutput,
  answerBlockedAgent,
  setExecFileAsync,
};

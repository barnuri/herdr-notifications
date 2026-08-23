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

module.exports = {
  runHerdr,
  listAgents,
  notifyDesktop,
  setExecFileAsync,
};

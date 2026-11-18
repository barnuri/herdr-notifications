'use strict';

const { spawn } = require('node:child_process');
const readline = require('node:readline');

// Agent states come from hc's own status record (OSC 7501). The plugin takes
// them as-is, so a `blocked` terminal reaches the same transition logic as a
// blocked herdr pane.
const HC_PANE_PREFIX = 'hc:';
const RESTART_MIN_MS = 1000;
const RESTART_MAX_MS = 60000;

function hcBinaryPath() {
  return process.env.HC_BIN_PATH || 'hc';
}

// Maps one hc terminal to the agent shape StateWatcher and the providers read.
// Returns null for a terminal without a status, or one that is no longer live.
function terminalToAgent(terminal) {
  if (!terminal || typeof terminal.address !== 'string' || terminal.state !== 'live') {
    return null;
  }
  const status = terminal.status;
  if (!status || typeof status.state !== 'string') {
    return null;
  }
  const name = terminal.agent || (terminal.foreground && terminal.foreground.name) || terminal.name || '';
  return {
    pane_id: `${HC_PANE_PREFIX}${terminal.address}`,
    agent_status: status.state,
    agent: name,
    terminal_title_stripped: terminal.title || name || terminal.address,
    cwd: terminal.cwd || '',
    source: 'hc',
    hc_address: terminal.address,
    hc_name: terminal.name || null,
  };
}

// `hc attach` options that take a value; the terminal is the first other argument.
const ATTACH_VALUE_OPTIONS = new Set(['--history']);

// Returns the hc terminal a process shows when its argv is `hc attach <t>`,
// else null. A bare `hc attach` (picker) names no terminal, so it is null too.
// `machine/t7` is another computer's terminal, which this host's hc never lists.
function attachTargetFromArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 2) {
    return null;
  }
  const program = String(argv[0]).split('/').pop();
  if (program !== 'hc' || argv[1] !== 'attach') {
    return null;
  }
  for (let index = 2; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (ATTACH_VALUE_OPTIONS.has(arg)) {
      index += 1;
    } else if (!arg.startsWith('-')) {
      return arg.includes('/') ? null : arg;
    }
  }
  return null;
}

// Finds the hc agent an `hc attach` target names: by address, else by name.
function findAttachedAgent(hcAgents, target) {
  return hcAgents.find((agent) => agent.hc_address === target || (agent.hc_name && agent.hc_name === target)) || null;
}

// Follows `hc events --json` as a long-running child process and keeps the
// latest terminal list. Each `listAgents()` call returns the current view, so
// the caller diffs it on its own poll cadence, the same as the herdr source.
class HcEventSource {
  constructor({ spawnFn = spawn, binary = hcBinaryPath(), log = () => {}, now = () => Date.now() } = {}) {
    this._spawn = spawnFn;
    this._binary = binary;
    this._log = log;
    this._now = now;
    this._terminals = new Map();
    this._child = null;
    this._loggedFailures = new Set();
    this._restartDelayMs = 0;
    this._nextStartAt = 0;
  }

  listAgents() {
    this._ensureStarted();
    const agents = [];
    for (const terminal of this._terminals.values()) {
      const agent = terminalToAgent(terminal);
      if (agent) {
        agents.push(agent);
      }
    }
    return agents;
  }

  stop() {
    const child = this._child;
    this._child = null;
    this._terminals = new Map();
    if (child) {
      child.kill();
    }
  }

  _ensureStarted() {
    if (this._child || this._now() < this._nextStartAt) {
      return;
    }
    let child;
    try {
      child = this._spawn(this._binary, ['events', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      this._reportSpawnFailure(error);
      return;
    }
    this._child = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => this._handleLine(line));
    child.on('error', (error) => this._reportSpawnFailure(error));
    child.on('exit', (code) => {
      // A stream that exits is restarted by a later listAgents() call, after a backoff.
      if (this._child === child) {
        this._child = null;
        this._terminals = new Map();
        this._logOnce(`hc events exited with code ${code}`);
        this._scheduleRestart();
      }
    });
  }

  _reportSpawnFailure(error) {
    this._child = null;
    this._logOnce(`hc events unavailable: ${error.message}`);
    this._scheduleRestart();
  }

  // Doubles the wait before the next start: 1 s, 2 s, 4 s ... capped at 60 s.
  _scheduleRestart() {
    const delay = this._restartDelayMs ? Math.min(this._restartDelayMs * 2, RESTART_MAX_MS) : RESTART_MIN_MS;
    this._restartDelayMs = delay;
    this._nextStartAt = this._now() + delay;
  }

  // Logs each distinct failure message once, so a repeating failure does not flood the log.
  _logOnce(message) {
    if (this._loggedFailures.has(message)) {
      return;
    }
    this._loggedFailures.add(message);
    this._log(message);
  }

  // Line kinds: a snapshot line carries `terminals` and replaces the view; a
  // JSON-RPC `event` notification carries a terminal object (or its address and
  // changed fields) and updates one terminal. Other lines (heartbeat, missed
  // notice) are ignored.
  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message && Array.isArray(message.terminals)) {
      // A snapshot shows the stream is healthy, so the next failure starts the backoff again.
      this._restartDelayMs = 0;
      this._terminals = new Map(
        message.terminals.filter((t) => t && typeof t.address === 'string').map((t) => [t.address, t]),
      );
      return;
    }
    if (!message || message.method !== 'event' || !message.params) {
      return;
    }
    const params = message.params;
    if (typeof params.terminal === 'string' && params.data && typeof params.data === 'object') {
      this._applyTypedEvent(params);
      return;
    }
    const patch = params.terminal && typeof params.terminal === 'object' ? params.terminal : params;
    const address = patch.address || params.address;
    if (typeof address !== 'string') {
      return;
    }
    const existing = this._terminals.get(address) || {};
    this._terminals.set(address, { ...existing, ...patch, address });
  }

  // Real `hc events` form: { type, terminal: "t26", data }. Only the types that
  // change what the watcher reads are applied; `turn` and the rest are ignored.
  _applyTypedEvent({ type, terminal: address, data }) {
    const existing = this._terminals.get(address) || {};
    let patch = null;
    if (type === 'created') {
      this._terminals.set(address, { ...data, address });
      return;
    }
    if (type === 'status') {
      patch = { status: data.status };
    } else if (type === 'foreground') {
      patch = { foreground: data };
    } else if (type === 'finished') {
      patch = { ...data, state: 'finished' };
    }
    if (patch) {
      this._terminals.set(address, { ...existing, ...patch, address });
    }
  }
}

module.exports = { HcEventSource, terminalToAgent, attachTargetFromArgv, findAttachedAgent, HC_PANE_PREFIX };

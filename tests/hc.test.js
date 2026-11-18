'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');

const { HcEventSource, terminalToAgent, attachTargetFromArgv } = require('../lib/hc');
const { Notifier } = require('../lib/notifier');

function liveTerminal(address, state, extra = {}) {
  return {
    address,
    state: 'live',
    agent: 'claude',
    title: `pane ${address}`,
    cwd: '/work',
    status: { state },
    ...extra,
  };
}

// A fake `hc events --json` child: stdout is a stream the test writes JSON lines to.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('exit', null);
  return child;
}

function fakeSpawn() {
  const spawned = [];
  const spawnFn = (binary, args) => {
    const child = fakeChild();
    spawned.push({ binary, args, child });
    return child;
  };
  return { spawnFn, spawned };
}

function write(child, message) {
  child.stdout.write(`${JSON.stringify(message)}\n`);
}

// Lines reach the parser through readline, so let the stream drain.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('terminalToAgent maps a live terminal with a status to the shared agent shape', () => {
  const agent = terminalToAgent(liveTerminal('t3', 'blocked'));
  assert.deepEqual(agent, {
    pane_id: 'hc:t3',
    agent_status: 'blocked',
    agent: 'claude',
    terminal_title_stripped: 'pane t3',
    cwd: '/work',
    source: 'hc',
    hc_address: 't3',
    hc_name: null,
  });
});

test('terminalToAgent skips terminals without a status or that are not live', () => {
  assert.equal(terminalToAgent({ address: 't1', state: 'live', status: null }), null);
  assert.equal(terminalToAgent({ address: 't2', state: 'finished', status: { state: 'idle' } }), null);
  assert.equal(terminalToAgent(null), null);
});

test('terminalToAgent falls back to the foreground program name, then the address, for the title', () => {
  const agent = terminalToAgent({
    address: 't9',
    state: 'live',
    status: { state: 'idle' },
    foreground: { name: 'bun' },
    title: '',
  });
  assert.equal(agent.agent, 'bun');
  assert.equal(agent.terminal_title_stripped, 'bun');
});

test('HcEventSource starts hc events --json once and reads the snapshot', async () => {
  const { spawnFn, spawned } = fakeSpawn();
  const source = new HcEventSource({ spawnFn, binary: 'hc-test' });

  assert.deepEqual(source.listAgents(), []);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].binary, 'hc-test');
  assert.deepEqual(spawned[0].args, ['events', '--json']);

  write(spawned[0].child, { channel: null, seq: 1, terminals: [liveTerminal('t3', 'working')] });
  await flush();
  assert.equal(source.listAgents()[0].agent_status, 'working');

  source.listAgents();
  assert.equal(spawned.length, 1, 'the stream is started once, not per poll');
});

test('HcEventSource applies a status event to the terminal it names', async () => {
  const { spawnFn, spawned } = fakeSpawn();
  const source = new HcEventSource({ spawnFn });
  source.listAgents();
  write(spawned[0].child, { channel: null, seq: 1, terminals: [liveTerminal('t3', 'working')] });
  await flush();

  write(spawned[0].child, {
    jsonrpc: '2.0',
    method: 'event',
    params: { terminal: { address: 't3', status: { state: 'idle' } } },
  });
  await flush();

  const [agent] = source.listAgents();
  assert.equal(agent.agent_status, 'idle');
});

test('HcEventSource applies real typed events: created, status, finished', async () => {
  const { spawnFn, spawned } = fakeSpawn();
  const source = new HcEventSource({ spawnFn });
  source.listAgents();
  const send = (type, data) =>
    write(spawned[0].child, { jsonrpc: '2.0', method: 'event', params: { seq: 1, terminal: 't9', type, data } });
  send('created', { address: 't9', state: 'live', name: 'job', status: null });
  send('status', { reported: true, records: {}, status: { state: 'blocked' } });
  await flush();
  assert.equal(source.listAgents()[0].agent_status, 'blocked');

  send('finished', { exit_code: 0, reason: 'exited' });
  await flush();
  assert.deepEqual(source.listAgents(), []);
});

test('HcEventSource ignores heartbeat lines and unparseable lines', async () => {
  const { spawnFn, spawned } = fakeSpawn();
  const source = new HcEventSource({ spawnFn });
  source.listAgents();
  write(spawned[0].child, { channel: null, seq: 1, terminals: [liveTerminal('t3', 'idle')] });
  spawned[0].child.stdout.write('not json\n');
  write(spawned[0].child, { jsonrpc: '2.0', method: 'heartbeat', params: { seq: 1 } });
  await flush();

  assert.deepEqual(
    source.listAgents().map((agent) => agent.pane_id),
    ['hc:t3'],
  );
});

test('HcEventSource logs a spawn failure once and yields no agents', () => {
  const logs = [];
  const source = new HcEventSource({
    spawnFn: () => {
      throw new Error('spawn hc ENOENT');
    },
    log: (line) => logs.push(line),
  });

  assert.deepEqual(source.listAgents(), []);
  assert.deepEqual(source.listAgents(), []);
  assert.deepEqual(logs, ['hc events unavailable: spawn hc ENOENT']);
});

test('HcEventSource restarts the stream after it exits, once the backoff has passed', () => {
  const { spawnFn, spawned } = fakeSpawn();
  let clock = 0;
  const source = new HcEventSource({ spawnFn, now: () => clock });
  source.listAgents();
  spawned[0].child.emit('exit', 0);

  source.listAgents();
  assert.equal(spawned.length, 1, 'no restart before the 1 s backoff');
  clock = 1000;
  source.listAgents();
  assert.equal(spawned.length, 2);
});

test('HcEventSource doubles the restart backoff per failure and caps it at 60 s', () => {
  const { spawnFn, spawned } = fakeSpawn();
  let clock = 0;
  const source = new HcEventSource({ spawnFn, now: () => clock });
  source.listAgents();

  const waits = [];
  for (let failure = 0; failure < 8; failure += 1) {
    spawned[spawned.length - 1].child.emit('exit', 1);
    const from = clock;
    while (spawned.length === failure + 1) {
      clock += 500;
      source.listAgents();
    }
    waits.push(clock - from);
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
});

test('HcEventSource resets the backoff after a snapshot arrives', async () => {
  const { spawnFn, spawned } = fakeSpawn();
  let clock = 0;
  const source = new HcEventSource({ spawnFn, now: () => clock });
  source.listAgents();
  spawned[0].child.emit('exit', 1);
  clock = 1000;
  source.listAgents();
  write(spawned[1].child, { channel: null, seq: 1, terminals: [liveTerminal('t3', 'idle')] });
  await flush();
  spawned[1].child.emit('exit', 1);

  clock += 1000;
  source.listAgents();
  assert.equal(spawned.length, 3, 'the delay after a healthy snapshot is 1 s again');
});

test('HcEventSource logs each distinct failure once', () => {
  const logs = [];
  let clock = 0;
  const { spawnFn, spawned } = fakeSpawn();
  const source = new HcEventSource({ spawnFn, now: () => clock, log: (line) => logs.push(line) });
  source.listAgents();
  spawned[0].child.emit('exit', 1);
  clock = 1000;
  source.listAgents();
  spawned[1].child.emit('exit', 1);
  clock += 2000;
  source.listAgents();
  spawned[2].child.emit('exit', 2);
  assert.deepEqual(logs, ['hc events exited with code 1', 'hc events exited with code 2']);
});

test('stop kills the child and clears the view', async () => {
  const { spawnFn, spawned } = fakeSpawn();
  const source = new HcEventSource({ spawnFn });
  source.listAgents();
  write(spawned[0].child, { channel: null, seq: 1, terminals: [liveTerminal('t3', 'idle')] });
  await flush();

  let killed = false;
  spawned[0].child.kill = () => {
    killed = true;
  };
  source.stop();
  assert.equal(killed, true);
  // The view is cleared, and the next call starts a new stream with no snapshot yet.
  assert.deepEqual(source.listAgents(), []);
  assert.equal(spawned.length, 2);
});

// Notifier integration: hc agents go through their own watcher and the same
// provider fan-out, and never through the relay.

function hcSourceStub(initial) {
  const state = { agents: initial };
  return {
    state,
    listAgents: () => state.agents,
  };
}

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    pollMs: 2000,
    notifyOn: { idle: true, blocked: true, done: true },
    relay: { enabled: false, contextLines: 40, pollMs: 1000 },
    hc: { enabled: true },
    providers: {},
    ...overrides,
  };
}

function recordingProvider() {
  const sent = [];
  return {
    id: 'telegram',
    sent,
    supportsButtons: false,
    isConfigured: () => true,
    async sendStatus(event) {
      sent.push(event);
      return { messageId: 'm1' };
    },
  };
}

function hcAgent(address, status) {
  return {
    pane_id: `hc:${address}`,
    agent_status: status,
    agent: 'claude',
    terminal_title_stripped: `pane ${address}`,
    source: 'hc',
    hc_address: address,
  };
}

test('an hc working -> idle transition notifies with source hc', async () => {
  const provider = recordingProvider();
  const hcSource = hcSourceStub([hcAgent('t3', 'working')]);
  const notifier = new Notifier({
    loadConfig: () => baseConfig(),
    listAgents: async () => [],
    createProviders: () => ({ providers: [provider], unconfigured: [] }),
    notifyDesktop: async () => true,
    hcSource,
    log: () => {},
  });

  await notifier.tick();
  hcSource.state.agents = [hcAgent('t3', 'idle')];
  await notifier.tick();

  assert.equal(provider.sent.length, 1);
  assert.equal(provider.sent[0].type, 'idle');
  assert.equal(provider.sent[0].paneId, 'hc:t3');
  assert.equal(provider.sent[0].source, 'hc');
});

test('hc agents are ignored while hc.enabled is false', async () => {
  const provider = recordingProvider();
  const hcSource = hcSourceStub([hcAgent('t3', 'working')]);
  const notifier = new Notifier({
    loadConfig: () => baseConfig({ hc: { enabled: false } }),
    listAgents: async () => [],
    createProviders: () => ({ providers: [provider], unconfigured: [] }),
    notifyDesktop: async () => true,
    hcSource,
    log: () => {},
  });

  await notifier.tick();
  hcSource.state.agents = [hcAgent('t3', 'idle')];
  await notifier.tick();

  assert.equal(provider.sent.length, 0);
});

test('a blocked hc event never reaches the relay', async () => {
  const provider = recordingProvider();
  const hcSource = hcSourceStub([hcAgent('t3', 'idle')]);
  const relayCalls = [];
  const relay = {
    announceBlocked: async (event) => {
      relayCalls.push(event);
      return [];
    },
    tryAutoApprove: async () => {
      relayCalls.push('auto');
      return false;
    },
    resolvePane: async () => relayCalls.push('resolve'),
  };
  const notifier = new Notifier({
    loadConfig: () => baseConfig({ relay: { enabled: true, contextLines: 40, pollMs: 1000 } }),
    listAgents: async () => [],
    createProviders: () => ({ providers: [provider], unconfigured: [] }),
    notifyDesktop: async () => true,
    hcSource,
    relay,
    log: () => {},
  });

  await notifier.tick();
  hcSource.state.agents = [hcAgent('t3', 'blocked')];
  await notifier.tick();

  assert.deepEqual(relayCalls, []);
  assert.equal(provider.sent.length, 1);
  assert.equal(provider.sent[0].type, 'blocked');
});

test('the hc and herdr watchers keep separate baselines', async () => {
  const provider = recordingProvider();
  const hcSource = hcSourceStub([hcAgent('t3', 'working')]);
  let herdr = [{ pane_id: 'w1-1', agent_status: 'working', agent: 'codex' }];
  const notifier = new Notifier({
    loadConfig: () => baseConfig(),
    listAgents: async () => herdr,
    paneForegroundArgvs: async () => [['opencode']],
    createProviders: () => ({ providers: [provider], unconfigured: [] }),
    notifyDesktop: async () => true,
    hcSource,
    log: () => {},
  });

  await notifier.tick();
  // Herdr keeps its pane, hc is unchanged: no transition, no event.
  await notifier.tick();
  assert.equal(provider.sent.length, 0);

  herdr = [{ pane_id: 'w1-1', agent_status: 'idle', agent: 'codex' }];
  await notifier.tick();
  assert.equal(provider.sent.length, 1);
  assert.equal(provider.sent[0].paneId, 'w1-1');
});

test('attachTargetFromArgv reads the terminal of an hc attach command', () => {
  assert.equal(attachTargetFromArgv(['hc', 'attach', 't7']), 't7');
  assert.equal(attachTargetFromArgv(['/opt/homebrew/bin/hc', 'attach', '--observe', 'build']), 'build');
  assert.equal(attachTargetFromArgv(['hc', 'attach', '--history', '200', 't1b']), 't1b');
});

test('attachTargetFromArgv is null for a picker, a remote terminal, or another program', () => {
  assert.equal(attachTargetFromArgv(['hc', 'attach']), null);
  assert.equal(attachTargetFromArgv(['hc', 'attach', 'box/t7']), null);
  assert.equal(attachTargetFromArgv(['hc', 'ls']), null);
  assert.equal(attachTargetFromArgv(['claude', 'attach', 't7']), null);
  assert.equal(attachTargetFromArgv(null), null);
});

function dedupNotifier({ provider, hcSource, herdrPanes, argvsByPane }) {
  return new Notifier({
    loadConfig: () => baseConfig(),
    listAgents: async () => herdrPanes.current,
    paneForegroundArgvs: async (paneId) => argvsByPane[paneId] || [],
    createProviders: () => ({ providers: [provider], unconfigured: [] }),
    notifyDesktop: async () => true,
    hcSource,
    log: () => {},
  });
}

test('a herdr pane that is an hc attach of a reported terminal notifies once, from hc', async () => {
  const provider = recordingProvider();
  const hcSource = hcSourceStub([hcAgent('t3', 'working')]);
  const herdrPanes = { current: [{ pane_id: 'w1:p1', agent_status: 'working', agent: 'claude' }] };
  const notifier = dedupNotifier({
    provider,
    hcSource,
    herdrPanes,
    argvsByPane: { 'w1:p1': [['hc', 'attach', 't3']] },
  });

  await notifier.tick();
  hcSource.state.agents = [hcAgent('t3', 'idle')];
  herdrPanes.current = [{ pane_id: 'w1:p1', agent_status: 'idle', agent: 'claude' }];
  await notifier.tick();

  assert.deepEqual(
    provider.sent.map((event) => event.paneId),
    ['hc:t3'],
  );
});

test('a herdr pane attached to a terminal hc does not report keeps its own notification', async () => {
  const provider = recordingProvider();
  const hcSource = hcSourceStub([hcAgent('t3', 'working')]);
  const herdrPanes = { current: [{ pane_id: 'w1:p1', agent_status: 'working', agent: 'claude' }] };
  const notifier = dedupNotifier({
    provider,
    hcSource,
    herdrPanes,
    argvsByPane: { 'w1:p1': [['hc', 'attach', 't9']] },
  });

  await notifier.tick();
  herdrPanes.current = [{ pane_id: 'w1:p1', agent_status: 'idle', agent: 'claude' }];
  await notifier.tick();

  assert.deepEqual(
    provider.sent.map((event) => event.paneId),
    ['w1:p1'],
  );
});

test('with hc on, a herdr server that is down still lets hc events through', async () => {
  const provider = recordingProvider();
  const logs = [];
  const hcSource = hcSourceStub([hcAgent('t3', 'working')]);
  const notifier = new Notifier({
    loadConfig: () => baseConfig(),
    listAgents: async () => {
      throw new Error('server_not_running');
    },
    createProviders: () => ({ providers: [provider], unconfigured: [] }),
    notifyDesktop: async () => true,
    hcSource,
    log: (line) => logs.push(line),
  });

  await notifier.tick();
  hcSource.state.agents = [hcAgent('t3', 'blocked')];
  await notifier.tick();

  assert.equal(provider.sent.length, 1);
  assert.equal(logs.length, 1, 'the herdr failure is logged once');
});

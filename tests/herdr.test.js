'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const herdr = require('../lib/herdr');

function stubExecResolving(stdout) {
  const calls = [];
  herdr.setExecFileAsync(async (bin, args, options) => {
    calls.push({ bin, args, options });
    return { stdout };
  });
  return calls;
}

function stubExecRejecting(error) {
  herdr.setExecFileAsync(async () => {
    throw error;
  });
}

afterEach(() => {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  herdr.setExecFileAsync(promisify(execFile));
});

test('listAgents parses the envelope and returns result.agents', async () => {
  const agents = [{ id: 'a1', name: 'builder' }, { id: 'a2', name: 'reviewer' }];
  const calls = stubExecResolving(JSON.stringify({ id: 'req-1', result: { agents } }));

  assert.deepEqual(await herdr.listAgents(), agents);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['agent', 'list']);
});

test('listAgents returns [] when the result has no agents key', async () => {
  stubExecResolving(JSON.stringify({ id: 'req-2', result: {} }));

  assert.deepEqual(await herdr.listAgents(), []);
});

test('listAgents propagates a clear error when exec fails', async () => {
  const execError = new Error('spawn herdr ENOENT');
  execError.stderr = '';
  stubExecRejecting(execError);

  await assert.rejects(herdr.listAgents(), /herdr agent list failed: spawn herdr ENOENT/);
});

test('runHerdr rejects on unparseable output', async () => {
  stubExecResolving('not json');

  await assert.rejects(herdr.runHerdr(['agent', 'list']), /returned unparseable output: not json/);
});

test('notifyDesktop returns true on success and passes title/body', async () => {
  const calls = stubExecResolving('');

  assert.equal(await herdr.notifyDesktop('Build done', 'All tests green'), true);
  assert.deepEqual(calls[0].args, ['notification', 'show', 'Build done', '--body', 'All tests green']);
});

test('notifyDesktop swallows failures and returns false', async () => {
  stubExecRejecting(new Error('notification daemon unavailable'));

  assert.equal(await herdr.notifyDesktop('Build done', 'All tests green'), false);
});

test('readAgentOutput reads visible text output and trims it', async () => {
  // Uses --source visible, not the default `recent`: a blocked pane (the
  // only caller of this function) is never idle, and herdr's `recent`
  // source rejects any non-idle pane with agent_not_idle — confirmed live
  // against a real blocked session.
  const calls = stubExecResolving('  some output text  \n');

  assert.equal(await herdr.readAgentOutput('pane-1', { lines: 25 }), 'some output text');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'agent',
    'read',
    'pane-1',
    '--lines',
    '25',
    '--source',
    'visible',
    '--format',
    'text',
  ]);
});

test('answerBlockedAgent sends the text then submits it with an enter keystroke', async () => {
  const calls = stubExecResolving('');

  await herdr.answerBlockedAgent('pane-1', 'yes');

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['pane', 'send-text', 'pane-1', 'yes']);
  assert.deepEqual(calls[1].args, ['pane', 'send-keys', 'pane-1', 'enter']);
});

test('answerBlockedAgent retries with "return" when the "enter" send-keys call rejects', async () => {
  const calls = [];
  herdr.setExecFileAsync(async (bin, args, options) => {
    calls.push({ bin, args, options });
    if (args[1] === 'send-keys' && args[3] === 'enter') {
      throw new Error('enter rejected');
    }
    return { stdout: '' };
  });

  await herdr.answerBlockedAgent('pane-1', 'yes');

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args, ['pane', 'send-text', 'pane-1', 'yes']);
  assert.deepEqual(calls[1].args, ['pane', 'send-keys', 'pane-1', 'enter']);
  assert.deepEqual(calls[2].args, ['pane', 'send-keys', 'pane-1', 'return']);
});

test('answerBlockedAgent rejects with the original "enter" error when both keys fail', async () => {
  herdr.setExecFileAsync(async (bin, args) => {
    if (args[1] === 'send-keys') {
      const error = new Error(`${args[3]} rejected`);
      error.stderr = '';
      throw error;
    }
    return { stdout: '' };
  });

  await assert.rejects(
    herdr.answerBlockedAgent('pane-1', 'yes'),
    /herdr pane send-keys pane-1 enter failed: enter rejected/
  );
});

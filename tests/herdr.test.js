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

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { SingleInstanceLock } = require('../lib/single-instance');

function lockPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lock-')), 'watch.pid');
}

test('the first watcher takes the lock and records its pid', () => {
  const file = lockPath();
  const release = SingleInstanceLock.acquire({ lockPath: file });

  assert.notEqual(release, null);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), String(process.pid));
  release();
});

test('a second watcher is refused while a live process holds the lock', () => {
  const file = lockPath();
  // This process is unquestionably alive, so it stands in for the incumbent.
  fs.writeFileSync(file, `${process.pid}\n`);

  assert.equal(SingleInstanceLock.acquire({ pid: process.pid + 1, lockPath: file }), null);
});

test('a pidfile left behind by a dead watcher is taken over', () => {
  const file = lockPath();
  // Never a live pid: 0 is not a valid process id and 1 would be launchd.
  fs.writeFileSync(file, '999999999\n');

  const release = SingleInstanceLock.acquire({ lockPath: file });
  assert.notEqual(release, null);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), String(process.pid));
  release();
});

test('a garbage pidfile is not mistaken for a live holder', () => {
  const file = lockPath();
  fs.writeFileSync(file, 'not-a-pid\n');

  const release = SingleInstanceLock.acquire({ lockPath: file });
  assert.notEqual(release, null);
  release();
});

test('release removes the lock so a successor can start', () => {
  const file = lockPath();
  const release = SingleInstanceLock.acquire({ lockPath: file });
  release();

  assert.equal(fs.existsSync(file), false);
  assert.notEqual(SingleInstanceLock.acquire({ lockPath: file }), null);
});

test('release leaves a lock that a successor has already taken over', () => {
  const file = lockPath();
  const release = SingleInstanceLock.acquire({ lockPath: file });
  fs.writeFileSync(file, `${process.pid + 1}\n`);

  release();
  assert.equal(fs.readFileSync(file, 'utf8').trim(), String(process.pid + 1));
});

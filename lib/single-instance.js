'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { configDir } = require('./config');

// Guards against a second copy of the watcher running against the same config.
//
// herdr spawns `[[startup]]` plugins when its own server starts, and a manual
// relaunch (or a herdr restart that does not reap the previous child) leaves
// two watchers alive. Two watchers are not merely wasteful: each opens its own
// Slack Socket Mode connection, Slack delivers a button click to exactly one of
// them, and each holds its own snapshot of relay-state.json — so roughly half
// of all clicks land in the process that has never seen the token they name and
// are dropped as expired. They also double the conversations.history call rate,
// which on its own exceeds Slack's Tier 3 budget.
class SingleInstanceLock {
  static FILE_NAME = 'watch.pid';
  static FILE_MODE = 0o600;
  static EXCLUSIVE_CREATE = 'wx';

  static path() {
    return path.join(configDir(), SingleInstanceLock.FILE_NAME);
  }

  // Returns a release function when the lock was taken, or null when another
  // live process already holds it. Never throws: a filesystem that will not
  // cooperate must not stop the watcher from running at all.
  static acquire({ pid = process.pid, lockPath = SingleInstanceLock.path() } = {}) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    } catch {
      return SingleInstanceLock._release(lockPath);
    }

    // Two attempts at most: the first can lose to an existing file, and clearing
    // a stale one earns exactly one retry. Looping past that would spin against
    // a live holder that keeps rewriting it.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (SingleInstanceLock._tryWrite(lockPath, pid)) {
        return SingleInstanceLock._release(lockPath);
      }
      const holder = SingleInstanceLock._readPid(lockPath);
      if (holder !== null && holder !== pid && SingleInstanceLock._isAlive(holder)) {
        return null;
      }
      // Nobody (or nobody living) owns it: the file is left over from a crash
      // or a kill, so it is cleared and the lock retried.
      try {
        fs.unlinkSync(lockPath);
      } catch {
        return SingleInstanceLock._release(lockPath);
      }
    }
    return SingleInstanceLock._release(lockPath);
  }

  // Exclusive create, so two watchers starting at the same instant cannot both
  // believe they won.
  static _tryWrite(lockPath, pid) {
    try {
      fs.writeFileSync(lockPath, `${pid}\n`, {
        flag: SingleInstanceLock.EXCLUSIVE_CREATE,
        mode: SingleInstanceLock.FILE_MODE,
      });
      return true;
    } catch {
      return false;
    }
  }

  static _readPid(lockPath) {
    let contents;
    try {
      contents = fs.readFileSync(lockPath, 'utf8');
    } catch {
      return null;
    }
    const pid = Number.parseInt(contents.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  // Signal 0 checks for existence without delivering anything. EPERM means the
  // pid exists but belongs to another user, which still counts as alive.
  static _isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  }

  // Only removes the file when this process still owns it, so a lock already
  // taken over by a successor watcher is left intact.
  static _release(lockPath) {
    return () => {
      if (SingleInstanceLock._readPid(lockPath) !== process.pid) {
        return;
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Already gone, or the directory is unwritable; nothing to do.
      }
    };
  }
}

module.exports = { SingleInstanceLock };

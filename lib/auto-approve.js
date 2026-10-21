'use strict';

const os = require('node:os');
const path = require('node:path');

// Rules compiled from config, each remembering the pattern text so a match can
// tell the user which rule fired.
class AutoApproveRules {
  static GLOB_KIND = 'glob';
  static REGEX_KIND = 'regex';
  static FOLDER_KIND = 'folder';
  static HOME_PREFIX = '~';
  // Anchored: a rule describes the whole command, so `git status` must not
  // authorise `git status && rm -rf /`.
  static ANCHOR_PREFIX = '^';
  static ANCHOR_SUFFIX = '$';
  static REGEX_META_PATTERN = /[.*+?^${}()|[\]\\]/g;
  static GLOB_STAR = '*';
  static GLOB_SINGLE = '?';

  constructor(matchers = [], folders = []) {
    this._matchers = matchers;
    this._folders = folders;
  }

  // A glob is the forgiving syntax: everything is literal except `*` (any run
  // of characters, slashes included — these are shell commands, not paths) and
  // `?` (exactly one).
  static globToRegExp(pattern) {
    const source = String(pattern)
      .split('')
      .map((character) => {
        if (character === AutoApproveRules.GLOB_STAR) {
          return '.*';
        }
        if (character === AutoApproveRules.GLOB_SINGLE) {
          return '.';
        }
        return character.replace(AutoApproveRules.REGEX_META_PATTERN, '\\$&');
      })
      .join('');
    return AutoApproveRules._anchored(source);
  }

  static _anchored(source) {
    return new RegExp(`${AutoApproveRules.ANCHOR_PREFIX}${source}${AutoApproveRules.ANCHOR_SUFFIX}`);
  }

  // Invalid patterns are reported and dropped rather than thrown: a typo in one
  // rule must not take the watcher process down, nor silently disable the rules
  // that are fine.
  // `~` is expanded because folders are hand-written; trailing slashes are
  // dropped by path.resolve so `/repo/` and `/repo` behave the same.
  static resolveFolder(folder) {
    const text = String(folder);
    const expanded =
      text === AutoApproveRules.HOME_PREFIX || text.startsWith(`${AutoApproveRules.HOME_PREFIX}${path.sep}`)
        ? path.join(os.homedir(), text.slice(AutoApproveRules.HOME_PREFIX.length))
        : text;
    return path.resolve(expanded);
  }

  static compile({ globs = [], regexes = [], folders = [] } = {}, log = () => {}) {
    const matchers = [];
    for (const pattern of globs) {
      matchers.push({
        kind: AutoApproveRules.GLOB_KIND,
        pattern,
        regex: AutoApproveRules.globToRegExp(pattern),
      });
    }
    for (const pattern of regexes) {
      try {
        matchers.push({
          kind: AutoApproveRules.REGEX_KIND,
          pattern,
          // Grouped before anchoring, so a top-level alternation cannot escape
          // the anchors and match a fragment of the command.
          regex: AutoApproveRules._anchored(`(?:${pattern})`),
        });
      } catch (error) {
        log(`ignoring invalid autoApprove regex ${JSON.stringify(pattern)}: ${error.message}`);
      }
    }
    const resolvedFolders = folders.map((pattern) => ({ pattern, folder: AutoApproveRules.resolveFolder(pattern) }));
    return new AutoApproveRules(matchers, resolvedFolders);
  }

  get size() {
    return this._matchers.length + this._folders.length;
  }

  // Returns the first folder rule containing `cwd` as { kind, pattern }, or
  // null. Containment is by path segment, so `/repo` does not cover
  // `/repo-other`.
  matchFolder(cwd) {
    if (typeof cwd !== 'string' || cwd === '') {
      return null;
    }
    const resolved = path.resolve(cwd);
    const matched = this._folders.find(
      ({ folder }) => resolved === folder || resolved.startsWith(`${folder}${path.sep}`),
    );
    return matched ? { kind: AutoApproveRules.FOLDER_KIND, pattern: matched.pattern } : null;
  }

  // Returns the first matching rule as { kind, pattern }, or null.
  match(subject) {
    if (typeof subject !== 'string' || subject === '') {
      return null;
    }
    const matched = this._matchers.find(({ regex }) => regex.test(subject));
    return matched ? { kind: matched.kind, pattern: matched.pattern } : null;
  }
}

module.exports = { AutoApproveRules };

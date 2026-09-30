'use strict';

// Rules compiled from config, each remembering the pattern text so a match can
// tell the user which rule fired.
class AutoApproveRules {
  static GLOB_KIND = 'glob';
  static REGEX_KIND = 'regex';
  // Anchored: a rule describes the whole command, so `git status` must not
  // authorise `git status && rm -rf /`.
  static ANCHOR_PREFIX = '^';
  static ANCHOR_SUFFIX = '$';
  static REGEX_META_PATTERN = /[.*+?^${}()|[\]\\]/g;
  static GLOB_STAR = '*';
  static GLOB_SINGLE = '?';

  constructor(matchers = []) {
    this._matchers = matchers;
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
  static compile({ globs = [], regexes = [] } = {}, log = () => {}) {
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
    return new AutoApproveRules(matchers);
  }

  get size() {
    return this._matchers.length;
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

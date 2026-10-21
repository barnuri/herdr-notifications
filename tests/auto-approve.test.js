'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { AutoApproveRules } = require('../lib/auto-approve');

function compile(config) {
  const logs = [];
  const rules = AutoApproveRules.compile(config, (message) => logs.push(message));
  return { rules, logs };
}

test('a glob matches the whole command, not a prefix of it', () => {
  const { rules } = compile({ globs: ['git status'] });

  assert.deepEqual(rules.match('git status'), { kind: 'glob', pattern: 'git status' });
  assert.equal(rules.match('git status --short'), null, 'an unanchored match would authorise more than the rule says');
});

test('* spans any run of characters and ? spans exactly one', () => {
  const { rules } = compile({ globs: ['npm run *', 'git lo?'] });

  assert.ok(rules.match('npm run build'));
  assert.ok(rules.match('npm run test -- --watch'), '* must cross spaces and flags');
  assert.ok(rules.match('git log'));
  assert.equal(rules.match('git lohh'), null);
});

test('glob metacharacters from the shell are matched literally', () => {
  const { rules } = compile({ globs: ['echo a.b'] });

  assert.ok(rules.match('echo a.b'));
  assert.equal(rules.match('echo axb'), null, '. must not act as a regex wildcard');
});

test('a regex rule is anchored as a whole and reports its own pattern', () => {
  const { rules } = compile({ regexes: ['npm (test|run lint)'] });

  assert.deepEqual(rules.match('npm test'), { kind: 'regex', pattern: 'npm (test|run lint)' });
  assert.ok(rules.match('npm run lint'));
  assert.equal(rules.match('npm test && rm -rf /'), null);
});

test('alternation cannot escape the anchors', () => {
  const { rules } = compile({ regexes: ['a|b'] });

  assert.ok(rules.match('a'));
  assert.equal(rules.match('xax'), null, 'the alternation must be grouped inside the anchors');
});

test('an invalid regex is logged and skipped, leaving the valid rules working', () => {
  const { rules, logs } = compile({ globs: ['ls *'], regexes: ['(unclosed', 'npm test'] });

  assert.equal(rules.size, 2, 'only the broken pattern is dropped');
  assert.ok(rules.match('ls -la'));
  assert.ok(rules.match('npm test'));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /invalid autoApprove regex/);
});

test('no rules means nothing matches', () => {
  const { rules } = compile({});

  assert.equal(rules.size, 0);
  assert.equal(rules.match('git status'), null);
});

test('a missing or empty subject never matches, even with a catch-all rule', () => {
  const { rules } = compile({ globs: ['*'] });

  assert.equal(rules.match(''), null);
  assert.equal(rules.match(null), null);
  assert.equal(rules.match(undefined), null);
  assert.ok(rules.match('anything at all'));
});

test('the first matching rule is the one reported', () => {
  const { rules } = compile({ globs: ['git *', 'git status'] });

  assert.deepEqual(rules.match('git status'), { kind: 'glob', pattern: 'git *' });
});

test('a folder rule covers the folder and everything below it, by path segment', () => {
  const { rules } = compile({ folders: ['/work/repo/'] });

  assert.equal(rules.size, 1);
  assert.deepEqual(rules.matchFolder('/work/repo'), { kind: 'folder', pattern: '/work/repo/' });
  assert.ok(rules.matchFolder('/work/repo/packages/a'));
  assert.equal(rules.matchFolder('/work/repo-other'), null, 'a sibling with a shared prefix is not inside');
  assert.equal(rules.matchFolder('/work'), null);
  assert.equal(rules.matchFolder(undefined), null);
  assert.equal(rules.match('/work/repo'), null, 'folder rules never match a command');
});

test('a folder rule expands a leading ~ to the home directory', () => {
  const { rules } = compile({ folders: ['~/repo'] });

  assert.ok(rules.matchFolder(require('node:path').join(require('node:os').homedir(), 'repo', 'src')));
});

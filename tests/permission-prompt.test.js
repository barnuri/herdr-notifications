'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { affirmativeOption, commandSubject } = require('../lib/permission-prompt');

// Verbatim shapes produced by detectOptions() against live agent output; see
// the cursor fixtures at the bottom of tests/option-detector.test.js.
const CURSOR_APPROVAL_OPTIONS = [
  { label: 'Run (once)', value: 'y' },
  { label: 'Skip & tell the agent what to do instead', value: 'n', expectsText: true },
];
const CLAUDE_PERMISSION_OPTIONS = [
  { label: '1. Yes', value: '1' },
  { label: "2. Yes, and don't ask again", value: '2' },
  { label: '3. No, and tell Claude what to do differently', value: '3' },
];
const YES_NO_OPTIONS = [
  { label: 'Yes', value: 'y' },
  { label: 'No', value: 'n' },
];

test("cursor's approval prompt resolves to the Run option", () => {
  assert.deepEqual(affirmativeOption(CURSOR_APPROVAL_OPTIONS), CURSOR_APPROVAL_OPTIONS[0]);
});

test('the (y/n) fallback pair resolves to Yes', () => {
  assert.deepEqual(affirmativeOption(YES_NO_OPTIONS), YES_NO_OPTIONS[0]);
});

test("a three-option permission prompt picks plain Yes, never \"don't ask again\"", () => {
  const chosen = affirmativeOption(CLAUDE_PERMISSION_OPTIONS);

  assert.equal(chosen.value, '1', 'the persistent variant must never be selected');
});

test('a numbered menu of real choices is not a permission prompt', () => {
  const menu = [
    { label: '1. Use the main branch', value: '1' },
    { label: '2. Use the feature branch', value: '2' },
  ];

  assert.equal(affirmativeOption(menu), null);
});

test('a menu mixing an affirmative with a substantive choice is rejected', () => {
  const menu = [
    { label: '1. Yes', value: '1' },
    { label: '2. Rebase onto main instead', value: '2' },
  ];

  assert.equal(affirmativeOption(menu), null, 'an unclassifiable label means this is not a permission prompt');
});

test('an all-affirmative or all-negative list is rejected', () => {
  assert.equal(affirmativeOption([{ label: 'Yes', value: '1' }, { label: 'Run it', value: '2' }]), null);
  assert.equal(affirmativeOption([{ label: 'No', value: '1' }, { label: 'Cancel', value: '2' }]), null);
});

test('more than three options is never a permission prompt', () => {
  const options = [
    { label: '1. Yes', value: '1' },
    { label: '2. Yes, and allow always', value: '2' },
    { label: '3. Skip', value: '3' },
    { label: '4. No', value: '4' },
  ];

  assert.equal(affirmativeOption(options), null);
});

test('a single option, an empty list, and a non-array are all rejected', () => {
  assert.equal(affirmativeOption([{ label: 'Yes', value: 'y' }]), null);
  assert.equal(affirmativeOption([]), null);
  assert.equal(affirmativeOption(undefined), null);
});

test("cursor's command line yields the command without its trailing cwd", () => {
  const capture = [
    '  $ rm -f /tmp/nonexistent-xyz Waiting for approval...',
    '───────────────────────────────────────────────',
    ' $  rm -f /tmp/nonexistent-xyz in .',
    '',
    ' Run this command?',
    '  → Run (once) (y)',
    '    Skip & tell the agent what to do instead (esc or n)',
  ].join('\n');

  assert.equal(commandSubject(capture), 'rm -f /tmp/nonexistent-xyz');
});

test('the last command line wins — the dialog sits below the transcript', () => {
  const capture = [' $ git status', '  output...', ' $  npm test in /repo'].join('\n');

  assert.equal(commandSubject(capture), 'npm test');
});

test('a prompt naming no command yields null so no rule can match it', () => {
  const trustDialog = [
    '  │  ⚠ Workspace Trust Required                  │',
    '  │  Do you trust the contents of this directory?│',
    '  │  ▶ [a] Trust this workspace                  │',
    '  │    [q] Quit                                  │',
  ].join('\n');

  assert.equal(commandSubject(trustDialog), null);
  assert.equal(commandSubject('Continue? (y/n)'), null);
  assert.equal(commandSubject(''), null);
  assert.equal(commandSubject(undefined), null);
});

test('a bare prompt character with no command is not a subject', () => {
  assert.equal(commandSubject(' $ '), null);
});

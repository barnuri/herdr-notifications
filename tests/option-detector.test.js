'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectOptions, MAX_DETECTED_OPTIONS } = require('../lib/option-detector.js');

test('contiguous numbered list in realistic pane output returns options in order', () => {
  const text = [
    'Running task...',
    'Some intermediate log line.',
    'Proceed with the destructive migration?',
    '1. Yes, proceed',
    '2. No, cancel',
    '3. Ask me later',
    '',
    '> ',
  ].join('\n');
  assert.deepEqual(detectOptions(text), [
    { label: '1. Yes, proceed', value: '1' },
    { label: '2. No, cancel', value: '2' },
    { label: '3. Ask me later', value: '3' },
  ]);
});

test('two separate numbered runs separated by prose: only the last contiguous run is returned', () => {
  const text = [
    '1. Yes',
    '2. No',
    'This menu is now stale, some unrelated output appeared here.',
    'More prose describing what happened next.',
    '1. Retry',
    '2. Abort',
    '3. Skip',
  ].join('\n');
  assert.deepEqual(detectOptions(text), [
    { label: '1. Retry', value: '1' },
    { label: '2. Abort', value: '2' },
    { label: '3. Skip', value: '3' },
  ]);
});

test('a real Claude Code select-menu prompt (pointer glyph on the highlighted option) is detected', () => {
  // Captured verbatim from a live `herdr pane read --source visible` against
  // a real Claude Code trust-folder dialog — the highlighted option is
  // prefixed with `❯`, the rest are plain-indented.
  const text = [
    ' Quick safety check: Is this a project you created or one you trust?',
    '',
    ' ❯ 1. Yes, I trust this folder',
    '   2. No, exit',
    '',
    ' Enter to confirm · Esc to cancel',
  ].join('\n');
  assert.deepEqual(detectOptions(text), [
    { label: '1. Yes, I trust this folder', value: '1' },
    { label: '2. No, exit', value: '2' },
  ]);
});

test('wrapped multi-line option descriptions and separators do not break the run', () => {
  // Shape captured from a real Claude Code AskUserQuestion prompt: each
  // option's description wraps onto indented continuation lines, and a
  // horizontal rule sits between the numbered options and the trailing
  // built-in free-text ones.
  const text = [
    ' │ The dedup/state/audit atomicity bug needs a real fix.',
    '',
    ' ❯ 1. Scoped transaction (Recommended)',
    '      Wrap dedup+approval-upsert+audit into one shared',
    '      session/commit per write. Fixes the demon',
    '      without a new architecture.',
    '   2. Full transactional outbox',
    '      Add an outbox table + relay: every write commits',
    '      notification as a row in the same transaction.',
    '   3. Type something.',
    '',
    '──────────────',
    '   4. Chat about this',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ].join('\n');
  assert.deepEqual(detectOptions(text), [
    { label: '1. Scoped transaction (Recommended)', value: '1' },
    { label: '2. Full transactional outbox', value: '2' },
    { label: '3. Type something.', value: '3', expectsText: true },
    { label: '4. Chat about this', value: '4', expectsText: true },
  ]);
});

test('a stale answered menu earlier in scrollback does not merge with the current one', () => {
  const text = [
    '1. Old choice A',
    '   wrapped description of the old choice',
    '2. Old choice B',
    'Selected: 1. Old choice A',
    'Agent did some work here.',
    '1. New choice A',
    '   wrapped description of the new choice',
    '2. New choice B',
    '3. New choice C',
  ].join('\n');
  assert.deepEqual(detectOptions(text), [
    { label: '1. New choice A', value: '1' },
    { label: '2. New choice B', value: '2' },
    { label: '3. New choice C', value: '3' },
  ]);
});

test('y/n-style prompt variants each return the two-option Yes/No array', () => {
  const expected = [
    { label: 'Yes', value: 'y' },
    { label: 'No', value: 'n' },
  ];
  assert.deepEqual(detectOptions('Do you want to continue? (y/n)'), expected);
  assert.deepEqual(detectOptions('Overwrite existing file? [Y/n]'), expected);
  assert.deepEqual(detectOptions('Delete all local changes? (yes/no)'), expected);
});

test('plain prose with no recognizable prompt returns an empty array', () => {
  const text = 'Everything completed successfully.\nNo further action is required.';
  assert.deepEqual(detectOptions(text), []);
});

test('more than MAX_DETECTED_OPTIONS numbered lines are capped', () => {
  const lines = [];
  for (let i = 1; i <= MAX_DETECTED_OPTIONS + 3; i += 1) {
    lines.push(`${i}. Option ${i}`);
  }
  const result = detectOptions(lines.join('\n'));
  assert.equal(result.length, MAX_DETECTED_OPTIONS);
  assert.deepEqual(result, lines.slice(0, MAX_DETECTED_OPTIONS).map((line, index) => ({
    label: `${index + 1}. Option ${index + 1}`,
    value: `${index + 1}`,
  })));
});

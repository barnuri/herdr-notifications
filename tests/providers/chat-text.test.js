'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  bareOptionLabel,
  escapeHtmlEntities,
  fencedBlock,
  optionLines,
  optionListBody,
  selectedBody,
  statusLine,
  tailTrim,
} = require('../../lib/providers/chat-text');

const MARKDOWN = { bold: (text) => `**${text}**`, escapeLabel: (text) => text };

test('escapeHtmlEntities escapes the three reserved characters and nothing else', () => {
  assert.equal(escapeHtmlEntities('a<b>&c'), 'a&lt;b&gt;&amp;c');
  assert.equal(escapeHtmlEntities('plain *text* 1.'), 'plain *text* 1.');
});

test('escapeHtmlEntities escapes ampersands before the other entities', () => {
  assert.equal(escapeHtmlEntities('&<'), '&amp;&lt;', 'the inserted & must not be double-escaped');
});

test('tailTrim keeps the end of the text', () => {
  assert.equal(tailTrim('abcdef', 3), 'def');
  assert.equal(tailTrim('ab', 10), 'ab');
});

test('fencedBlock wraps content in a code fence', () => {
  assert.equal(fencedBlock('hello', 100), '```\nhello\n```');
});

test('a fence inside the content cannot close the block', () => {
  const rendered = fencedBlock('before ``` after', 100);
  assert.equal(rendered.split('```').length - 1, 2, 'only the opening and closing fences remain');
  assert.match(rendered, /before/);
  assert.match(rendered, /after/);
});

test('fencedBlock trims the content, not the fence markers', () => {
  const rendered = fencedBlock('headXXXXtail', 4);
  assert.equal(rendered, '```\ntail\n```');
});

test('bareOptionLabel strips a leading menu number', () => {
  assert.equal(bareOptionLabel('1. Yes, proceed'), 'Yes, proceed');
  assert.equal(bareOptionLabel('2) No'), 'No');
  assert.equal(bareOptionLabel('Yes'), 'Yes', 'a label with no number is untouched');
  assert.equal(bareOptionLabel('3.  padded label  '), 'padded label');
});

test('the number prefix must be at the very start, as the option detector emits it', () => {
  assert.equal(bareOptionLabel('step 1. do the thing'), 'step 1. do the thing');
});

test('statusLine composes the icon, bolded label and status', () => {
  const line = statusLine({ type: 'done', paneId: 'p', agent: { agent: 'agent-a' } }, MARKDOWN);
  assert.equal(line, '🟢 **agent-a** is done');
});

test('statusLine escapes the label with the caller-supplied escaper', () => {
  const line = statusLine(
    { type: 'done', paneId: 'p', agent: { agent: 'a<b>' } },
    { bold: (text) => `*${text}*`, escapeLabel: escapeHtmlEntities },
  );
  assert.equal(line, '🟢 *a&lt;b&gt;* is done');
});

test('optionLines keys each option by the value to reply with', () => {
  const lines = optionLines(
    [
      { label: '1. Proceed', value: '1' },
      { label: '2. Type something', value: '2', expectsText: true },
      { label: 'Yes', value: 'y' },
    ],
    (text) => text,
  );

  assert.deepEqual(lines, ['`1` — Proceed', '`2` — Type something ✏️', '`y` — Yes']);
});

test('optionListBody appends the prompt and the option lines to the base text', () => {
  const body = optionListBody('base', [{ label: '1. Proceed', value: '1' }], (text) => text);

  assert.equal(body, 'base\nReply with one of these, or your own answer:\n`1` — Proceed');
});

test('selectedBody appends the confirmation below the base text', () => {
  assert.equal(selectedBody('base', '1. Proceed', MARKDOWN), 'base\n\n✅ Selected: **1. Proceed**');
});

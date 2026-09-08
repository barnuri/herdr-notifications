'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { INBOUND_ACTION, INBOUND_TEXT, collectOldestFirst } = require('../../lib/providers/inbound');

// Newest-first, the way both Discord and Slack return a history page.
const PAGE = [{ id: '3' }, { id: '2' }, { id: '1' }];

function options(overrides = {}) {
  return {
    cursor: '1',
    idOf: (message) => message.id,
    normalize: (message) => ({ kind: INBOUND_TEXT, id: message.id }),
    ...overrides,
  };
}

test('the protocol kinds are distinct strings', () => {
  assert.equal(INBOUND_TEXT, 'text');
  assert.equal(INBOUND_ACTION, 'action');
});

test('an empty page keeps the incoming cursor and yields no events', () => {
  assert.deepEqual(collectOldestFirst([], options({ cursor: '7' })), { events: [], cursor: '7' });
});

test('without a cursor the newest id is adopted and no events are emitted', () => {
  const result = collectOldestFirst(PAGE, options({ cursor: undefined }));

  assert.deepEqual(result, { events: [], cursor: '3' });
});

test('events come back oldest-first with the newest id as the next cursor', () => {
  const { events, cursor } = collectOldestFirst(PAGE, options());

  assert.deepEqual(
    events.map((event) => event.id),
    ['1', '2', '3'],
  );
  assert.equal(cursor, '3');
});

test('messages the normalizer rejects are dropped without affecting the cursor', () => {
  const { events, cursor } = collectOldestFirst(
    PAGE,
    options({ normalize: (message) => (message.id === '2' ? null : { kind: INBOUND_TEXT, id: message.id }) }),
  );

  assert.deepEqual(
    events.map((event) => event.id),
    ['1', '3'],
  );
  assert.equal(cursor, '3');
});

test('a page where every message is rejected still advances the cursor', () => {
  const { events, cursor } = collectOldestFirst(PAGE, options({ normalize: () => null }));

  assert.deepEqual(events, []);
  assert.equal(cursor, '3');
});

test('the cursor is stringified so a numeric platform id round-trips', () => {
  const { cursor } = collectOldestFirst([{ id: 900 }], options({ cursor: 1 }));

  assert.equal(cursor, '900');
  assert.equal(typeof cursor, 'string');
});

test('the input page is not mutated by the oldest-first pass', () => {
  const page = [...PAGE];
  collectOldestFirst(page, options());

  assert.deepEqual(page, PAGE);
});

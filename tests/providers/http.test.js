'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { HttpJsonClient, decodeSlackEnvelope } = require('../../lib/providers/http');

function jsonResponse(body, { status = 200, ok = status < 400 } = {}) {
  return { status, ok, json: async () => body };
}

test('postJson sends a JSON body with a JSON content type', async () => {
  const calls = [];
  const client = new HttpJsonClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true });
    },
  });

  const result = await client.postJson('https://example.test/send', { text: 'hi' }, { label: 'send' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(calls[0].init.body, JSON.stringify({ text: 'hi' }));
  assert.deepEqual(result, { status: 200, ok: true, body: { ok: true } });
});

test('caller-supplied headers are merged in', async () => {
  let seenHeaders = null;
  const client = new HttpJsonClient({
    fetchImpl: async (_url, init) => {
      seenHeaders = init.headers;
      return jsonResponse({});
    },
  });

  await client.postJson('https://example.test/x', {}, { label: 'x', headers: { authorization: 'Bearer t' } });

  assert.equal(seenHeaders.authorization, 'Bearer t');
  assert.equal(seenHeaders['content-type'], 'application/json; charset=utf-8');
});

test('getJson omits the content-type header', async () => {
  let seenHeaders = null;
  const client = new HttpJsonClient({
    fetchImpl: async (_url, init) => {
      seenHeaders = init.headers;
      return jsonResponse([]);
    },
  });

  await client.getJson('https://example.test/list', { label: 'list', headers: { authorization: 'Bot t' } });

  assert.equal(seenHeaders['content-type'], undefined);
  assert.equal(seenHeaders.authorization, 'Bot t');
});

test('patchJson issues a PATCH', async () => {
  let seenMethod = null;
  const client = new HttpJsonClient({
    fetchImpl: async (_url, init) => {
      seenMethod = init.method;
      return jsonResponse({});
    },
  });

  await client.patchJson('https://example.test/m/1', { content: 'edited' }, { label: 'edit' });

  assert.equal(seenMethod, 'PATCH');
});

test('an error response with a JSON body is returned as data, not thrown', async () => {
  const client = new HttpJsonClient({
    fetchImpl: async () => jsonResponse({ ok: false, error: 'channel_not_found' }, { status: 400 }),
  });

  const result = await client.postJson('https://example.test/x', {}, { label: 'x' });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'channel_not_found');
});

test('an error response with a non-JSON body throws with the label and status', async () => {
  const client = new HttpJsonClient({
    fetchImpl: async () => ({
      status: 502,
      ok: false,
      json: async () => {
        throw new Error('unexpected token');
      },
    }),
  });

  await assert.rejects(
    () => client.postJson('https://example.test/x', {}, { label: 'discord createMessage' }),
    /discord createMessage failed: HTTP 502, non-JSON body/,
  );
});

test('a transport failure throws with the label and the underlying message', async () => {
  const client = new HttpJsonClient({
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
  });

  await assert.rejects(
    () => client.postJson('https://example.test/x', {}, { label: 'slack chat.postMessage' }),
    /slack chat.postMessage failed: getaddrinfo ENOTFOUND/,
  );
});

test('a successful response with a non-JSON body resolves with a null body', async () => {
  const client = new HttpJsonClient({
    fetchImpl: async () => ({
      status: 204,
      ok: true,
      json: async () => {
        throw new Error('no content');
      },
    }),
  });

  const result = await client.postJson('https://example.test/x', {}, { label: 'x' });

  assert.deepEqual(result, { status: 204, ok: true, body: null });
});

test('decodeSlackEnvelope returns the body when Slack reports ok', () => {
  const body = { ok: true, ts: '1.1' };
  assert.deepEqual(decodeSlackEnvelope({ status: 200, ok: true, body }, 'slack chat.postMessage'), body);
});

test('decodeSlackEnvelope throws the Slack error string when ok is false', () => {
  assert.throws(
    () => decodeSlackEnvelope({ status: 200, ok: true, body: { ok: false, error: 'channel_not_found' } }, 'slack x'),
    /slack x failed: channel_not_found/,
  );
});

test('decodeSlackEnvelope falls back to the HTTP status when there is no body', () => {
  assert.throws(() => decodeSlackEnvelope({ status: 503, ok: false, body: null }, 'slack x'), /slack x failed: HTTP 503/);
});

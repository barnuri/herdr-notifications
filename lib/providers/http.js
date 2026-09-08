'use strict';

// Shared JSON-over-HTTP plumbing for every provider client.
//
// Errors never carry the token: it travels only in a header (or, for Telegram,
// in the URL path, which is why `label` is what gets reported rather than the
// URL). Provider-specific success/failure decoding stays with the caller — this
// only owns the request, the timeout, and turning a non-JSON body into a
// readable error.
class HttpJsonClient {
  static DEFAULT_TIMEOUT_MS = 30000;
  static CONTENT_TYPE_HEADER = 'content-type';
  static JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

  constructor({ fetchImpl = globalThis.fetch, timeoutMs = HttpJsonClient.DEFAULT_TIMEOUT_MS } = {}) {
    this._fetchImpl = fetchImpl;
    this._timeoutMs = timeoutMs;
  }

  // Resolves to { status, ok, body } — a provider-level error response (HTTP
  // 4xx with a JSON error payload) is data, not an exception, because every
  // provider needs to read its own error field out of it. Only transport
  // failures and undecodable bodies throw.
  async postJson(url, payload, { label, headers = {} } = {}) {
    return this._request(url, { method: 'POST', headers, body: JSON.stringify(payload) }, label);
  }

  async patchJson(url, payload, { label, headers = {} } = {}) {
    return this._request(url, { method: 'PATCH', headers, body: JSON.stringify(payload) }, label);
  }

  async getJson(url, { label, headers = {} } = {}) {
    return this._request(url, { method: 'GET', headers }, label);
  }

  async _request(url, init, label) {
    const requestInit = {
      ...init,
      headers: { [HttpJsonClient.CONTENT_TYPE_HEADER]: HttpJsonClient.JSON_CONTENT_TYPE, ...init.headers },
      signal: AbortSignal.timeout(this._timeoutMs),
    };
    if (init.method === 'GET') {
      delete requestInit.headers[HttpJsonClient.CONTENT_TYPE_HEADER];
    }

    let response;
    try {
      response = await this._fetchImpl(url, requestInit);
    } catch (error) {
      throw new Error(`${label} failed: ${error.message}`);
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (body === null && !response.ok) {
      throw new Error(`${label} failed: HTTP ${response.status}, non-JSON body`);
    }
    return { status: response.status, ok: response.ok, body };
  }
}

// Slack signals failure in the body (`ok: false`) as often as in the HTTP
// status, so both are decoded together. Lives here rather than on SlackProvider
// because SocketModeConnection needs it too, and slack.js already requires
// slack-socket.js — importing the other way would be a cycle.
function decodeSlackEnvelope(response, label) {
  const body = response.body;
  if (!body || body.ok !== true) {
    const error = body && body.error ? body.error : `HTTP ${response.status}`;
    throw new Error(`${label} failed: ${error}`);
  }
  return body;
}

module.exports = { HttpJsonClient, decodeSlackEnvelope };

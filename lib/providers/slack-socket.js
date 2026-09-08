'use strict';

const { HttpJsonClient, decodeSlackEnvelope } = require('./http');
const { INBOUND_ACTION } = require('./inbound');

// Slack Socket Mode: the app opens an outbound WebSocket to Slack and receives
// interaction payloads over it, so button clicks work without any publicly
// reachable endpoint. Events are queued here and drained by the provider on its
// normal poll, which keeps the provider's poll-shaped interface intact.
//
// Connections are shared per app token: providers are rebuilt on every watcher
// tick, and a socket per tick would open a new connection every couple of
// seconds.
class SocketModeConnection {
  static API_URL = 'https://slack.com/api/apps.connections.open';
  static API_LABEL = 'slack apps.connections.open';
  static FRAME_DISCONNECT = 'disconnect';
  static PAYLOAD_BLOCK_ACTIONS = 'block_actions';
  static RECONNECT_BASE_MS = 1000;
  static RECONNECT_MAX_MS = 30000;
  static RECONNECT_FACTOR = 2;
  // A queue this long means nothing is draining it; dropping the oldest is
  // better than growing without bound.
  static MAX_QUEUED_EVENTS = 100;
  static SHARED = new Map();

  // One connection per app token, reused across provider instances.
  static shared(appToken, options = {}) {
    const existing = SocketModeConnection.SHARED.get(appToken);
    if (existing) {
      return existing;
    }
    const connection = new SocketModeConnection({ appToken, ...options });
    SocketModeConnection.SHARED.set(appToken, connection);
    return connection;
  }

  static resetShared() {
    for (const connection of SocketModeConnection.SHARED.values()) {
      connection.stop();
    }
    SocketModeConnection.SHARED.clear();
  }

  constructor({
    appToken,
    httpClient = new HttpJsonClient(),
    webSocketImpl = globalThis.WebSocket,
    log = (line) => process.stderr.write(`${line}\n`),
    setTimeoutImpl = setTimeout,
  } = {}) {
    this._appToken = appToken;
    this._http = httpClient;
    this._webSocketImpl = webSocketImpl;
    this._log = log;
    this._setTimeout = setTimeoutImpl;
    this._socket = null;
    this._connecting = false;
    this._stopped = false;
    this._queue = [];
    this._reconnectDelayMs = SocketModeConnection.RECONNECT_BASE_MS;
  }

  get isConnected() {
    return Boolean(this._socket);
  }

  // Idempotent: safe to call on every poll. Never throws — a socket that cannot
  // be opened must not break the notification path, only the button path.
  async start() {
    if (this._stopped || this._socket || this._connecting) {
      return;
    }
    this._connecting = true;
    try {
      const url = await this._openConnection();
      this._attach(url);
      this._reconnectDelayMs = SocketModeConnection.RECONNECT_BASE_MS;
    } catch (error) {
      this._log(`herdr-notifications: slack socket mode connect failed: ${error.message}`);
      this._scheduleReconnect();
    } finally {
      this._connecting = false;
    }
  }

  // Hands over everything received since the last call.
  drainEvents() {
    const events = this._queue;
    this._queue = [];
    return events;
  }

  stop() {
    this._stopped = true;
    this._closeSocket();
  }

  // Goes through the shared HTTP client so this inherits its request timeout:
  // a hung apps.connections.open would otherwise never settle, leaving
  // `_connecting` true forever and permanently wedging start().
  async _openConnection() {
    const response = await this._http.postJson(
      SocketModeConnection.API_URL,
      {},
      {
        label: SocketModeConnection.API_LABEL,
        headers: { authorization: `Bearer ${this._appToken}` },
      },
    );
    const body = decodeSlackEnvelope(response, SocketModeConnection.API_LABEL);
    if (typeof body.url !== 'string') {
      throw new Error(`${SocketModeConnection.API_LABEL} failed: no socket url in response`);
    }
    return body.url;
  }

  _attach(url) {
    const socket = new this._webSocketImpl(url);
    this._socket = socket;

    socket.onmessage = (event) => {
      this._handleFrame(socket, event.data);
    };
    socket.onclose = () => {
      if (this._socket === socket) {
        this._socket = null;
        this._scheduleReconnect();
      }
    };
    socket.onerror = () => {
      // A socket error is always followed by a close, which owns the reconnect.
      // Slack's error events carry no actionable detail worth logging per tick.
    };
  }

  _handleFrame(socket, data) {
    let frame;
    try {
      frame = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch (error) {
      // A frame Slack sent that cannot be parsed means a click is silently
      // lost, so it is reported rather than dropped quietly.
      this._log(`herdr-notifications: slack socket mode unparseable frame: ${error.message}`);
      return;
    }

    // Ack first: Slack disconnects the socket if an envelope is unacknowledged
    // for 3s, and acking means "received", not "processed".
    if (typeof frame.envelope_id === 'string') {
      this._send(socket, { envelope_id: frame.envelope_id });
    }

    if (frame.type === SocketModeConnection.FRAME_DISCONNECT) {
      // link_disabled / warning / refresh_requested all mean "reopen".
      this._closeSocket();
      this._scheduleReconnect();
      return;
    }

    // Dispatched on the payload shape rather than the envelope's own `type`, so
    // this keeps working regardless of what Slack names the outer envelope.
    const payload = frame.payload;
    if (!payload || payload.type !== SocketModeConnection.PAYLOAD_BLOCK_ACTIONS) {
      return;
    }
    for (const action of payload.actions || []) {
      const event = SocketModeConnection._toActionEvent(payload, action);
      if (event) {
        this._enqueue(event);
      }
    }
  }

  static _toActionEvent(payload, action) {
    const data = action.action_id || action.value;
    if (typeof data !== 'string' || data === '') {
      return null;
    }
    const channelId = payload.channel ? payload.channel.id : null;
    const messageTs = payload.message ? payload.message.ts : null;
    return {
      kind: INBOUND_ACTION,
      id: `${payload.trigger_id || messageTs || ''}:${action.action_ts || ''}`,
      // Carried only to satisfy the shared action-event shape; Slack has no
      // callback-query to acknowledge, so SlackProvider ignores it.
      actionId: payload.trigger_id || '',
      data,
      messageId: messageTs,
      channelId,
    };
  }

  _enqueue(event) {
    this._queue.push(event);
    while (this._queue.length > SocketModeConnection.MAX_QUEUED_EVENTS) {
      this._queue.shift();
    }
  }

  _send(socket, message) {
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      this._log(`herdr-notifications: slack socket mode ack failed: ${error.message}`);
    }
  }

  _closeSocket() {
    if (!this._socket) {
      return;
    }
    const socket = this._socket;
    this._socket = null;
    try {
      socket.close();
    } catch {
      // Already closing or closed; nothing to do.
    }
  }

  _scheduleReconnect() {
    if (this._stopped) {
      return;
    }
    const delay = this._reconnectDelayMs;
    this._reconnectDelayMs = Math.min(
      SocketModeConnection.RECONNECT_MAX_MS,
      delay * SocketModeConnection.RECONNECT_FACTOR,
    );
    const timer = this._setTimeout(() => {
      this.start();
    }, delay);
    // A pending reconnect must not hold the watcher process open on shutdown.
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  }
}

module.exports = { SocketModeConnection };

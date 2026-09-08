'use strict';

const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');

const { SocketModeConnection } = require('../../lib/providers/slack-socket');

// Stands in for the global WebSocket: records what was sent and lets a test
// push frames in as if Slack had delivered them.
class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
  }

  deliver(frame) {
    this.onmessage({ data: JSON.stringify(frame) });
  }
}

function blockActionsFrame({ envelopeId = 'env-1', actionId = 'r:tok:1', channel = 'C1', ts = '1.1' } = {}) {
  return {
    envelope_id: envelopeId,
    type: 'interactive',
    payload: {
      type: 'block_actions',
      trigger_id: 'trigger-1',
      channel: { id: channel },
      message: { ts },
      actions: [{ action_id: actionId, value: actionId, action_ts: '1.2' }],
    },
  };
}

// Stands in for HttpJsonClient: the connection goes through the shared client
// so it inherits its request timeout.
function stubOpenClient(openResponses, calls) {
  const queue = Array.isArray(openResponses) ? [...openResponses] : [openResponses];
  return {
    async postJson(url, payload, options) {
      calls.push({ url, payload, options });
      const body = queue.length > 1 ? queue.shift() : queue[0];
      return { status: 200, ok: true, body };
    },
  };
}

function build({ openResponse = { ok: true, url: 'wss://slack.test/link' }, timers = [] } = {}) {
  const openCalls = [];
  const logs = [];
  const connection = new SocketModeConnection({
    appToken: 'xapp-token',
    httpClient: stubOpenClient(openResponse, openCalls),
    webSocketImpl: FakeWebSocket,
    log: (line) => logs.push(line),
    setTimeoutImpl: (fn, delay) => {
      timers.push({ fn, delay });
      return { unref() {} };
    },
  });
  return { connection, openCalls, logs, timers };
}

afterEach(() => {
  FakeWebSocket.instances = [];
  SocketModeConnection.resetShared();
});

test('start opens a socket at the url apps.connections.open returns', async () => {
  const { connection, openCalls } = build();

  await connection.start();

  assert.equal(openCalls.length, 1);
  assert.equal(openCalls[0].url, SocketModeConnection.API_URL);
  assert.equal(openCalls[0].options.headers.authorization, 'Bearer xapp-token');
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(FakeWebSocket.instances[0].url, 'wss://slack.test/link');
  assert.equal(connection.isConnected, true);
});

test('start is idempotent so it can be called on every poll', async () => {
  const { connection, openCalls } = build();

  await connection.start();
  await connection.start();
  await connection.start();

  assert.equal(openCalls.length, 1);
  assert.equal(FakeWebSocket.instances.length, 1);
});

test('a failed open is logged and does not throw into the caller', async () => {
  const { connection, logs } = build({ openResponse: { ok: false, error: 'invalid_auth' } });

  await connection.start();

  assert.equal(connection.isConnected, false);
  assert.ok(logs.some((line) => line.includes('invalid_auth')));
});

test('a failed open schedules a reconnect with growing backoff', async () => {
  const timers = [];
  const { connection } = build({ openResponse: { ok: false, error: 'ratelimited' }, timers });

  await connection.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, SocketModeConnection.RECONNECT_BASE_MS);

  await connection.start();
  assert.equal(timers.length, 2);
  assert.equal(timers[1].delay, SocketModeConnection.RECONNECT_BASE_MS * 2);
});

test('every envelope is acknowledged by id on receipt', async () => {
  const { connection } = build();
  await connection.start();
  const socket = FakeWebSocket.instances[0];

  socket.deliver(blockActionsFrame({ envelopeId: 'env-42' }));

  assert.deepEqual(socket.sent, [{ envelope_id: 'env-42' }]);
});

test('a frame with no envelope id is not acknowledged', async () => {
  const { connection } = build();
  await connection.start();
  const socket = FakeWebSocket.instances[0];

  socket.deliver({ type: 'hello', num_connections: 1 });

  assert.deepEqual(socket.sent, []);
});

test('a block_actions payload becomes a drainable action event', async () => {
  const { connection } = build();
  await connection.start();

  FakeWebSocket.instances[0].deliver(blockActionsFrame({ actionId: 'r:tok:2', channel: 'C9', ts: '5.5' }));
  const events = connection.drainEvents();

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'action');
  assert.equal(events[0].data, 'r:tok:2');
  assert.equal(events[0].messageId, '5.5');
  assert.equal(events[0].channelId, 'C9');
});

test('draining clears the queue so an event is delivered once', async () => {
  const { connection } = build();
  await connection.start();

  FakeWebSocket.instances[0].deliver(blockActionsFrame());

  assert.equal(connection.drainEvents().length, 1);
  assert.deepEqual(connection.drainEvents(), []);
});

test('every action in a multi-action payload is queued', async () => {
  const { connection } = build();
  await connection.start();
  const frame = blockActionsFrame();
  frame.payload.actions = [
    { action_id: 'r:tok:0', action_ts: '1' },
    { action_id: 'r:tok:1', action_ts: '2' },
  ];

  FakeWebSocket.instances[0].deliver(frame);

  assert.deepEqual(
    connection.drainEvents().map((event) => event.data),
    ['r:tok:0', 'r:tok:1'],
  );
});

test('an action with neither action_id nor value is dropped', async () => {
  const { connection } = build();
  await connection.start();
  const frame = blockActionsFrame();
  frame.payload.actions = [{ action_ts: '1' }];

  FakeWebSocket.instances[0].deliver(frame);

  assert.deepEqual(connection.drainEvents(), []);
});

test('a value-only button still resolves its routing data', async () => {
  const { connection } = build();
  await connection.start();
  const frame = blockActionsFrame();
  frame.payload.actions = [{ value: 'r:tok:3', action_ts: '1' }];

  FakeWebSocket.instances[0].deliver(frame);

  assert.equal(connection.drainEvents()[0].data, 'r:tok:3');
});

test('a non-block_actions payload is acknowledged but produces no event', async () => {
  const { connection } = build();
  await connection.start();
  const socket = FakeWebSocket.instances[0];

  socket.deliver({ envelope_id: 'env-9', type: 'events_api', payload: { type: 'event_callback' } });

  assert.deepEqual(socket.sent, [{ envelope_id: 'env-9' }]);
  assert.deepEqual(connection.drainEvents(), []);
});

test('an unparseable frame is ignored', async () => {
  const { connection } = build();
  await connection.start();

  FakeWebSocket.instances[0].onmessage({ data: 'not json' });

  assert.deepEqual(connection.drainEvents(), []);
});

test('a disconnect frame closes the socket and schedules a reconnect', async () => {
  const timers = [];
  const { connection } = build({ timers });
  await connection.start();
  const socket = FakeWebSocket.instances[0];

  socket.deliver({ envelope_id: 'env-d', type: 'disconnect', reason: 'refresh_requested' });

  assert.equal(socket.closed, true);
  assert.equal(connection.isConnected, false);
  assert.equal(timers.length, 1);
});

test('an unexpected close schedules a reconnect', async () => {
  const timers = [];
  const { connection } = build({ timers });
  await connection.start();

  FakeWebSocket.instances[0].onclose();

  assert.equal(connection.isConnected, false);
  assert.equal(timers.length, 1);
});

test('repeated open failures back off, and a successful connect resets the delay', async () => {
  const timers = [];
  const responses = [
    { ok: false, error: 'ratelimited' },
    { ok: false, error: 'ratelimited' },
    { ok: true, url: 'wss://slack.test/link' },
  ];
  const connection = new SocketModeConnection({
    appToken: 'xapp-token',
    httpClient: stubOpenClient(responses, []),
    webSocketImpl: FakeWebSocket,
    log: () => {},
    setTimeoutImpl: (fn, delay) => {
      timers.push({ fn, delay });
      return { unref() {} };
    },
  });

  await connection.start();
  await connection.start();
  assert.deepEqual(
    timers.map((timer) => timer.delay),
    [SocketModeConnection.RECONNECT_BASE_MS, SocketModeConnection.RECONNECT_BASE_MS * 2],
    'each failed open waits longer than the last',
  );

  await connection.start();
  assert.equal(connection.isConnected, true);
  FakeWebSocket.instances[0].onclose();
  assert.equal(
    timers[2].delay,
    SocketModeConnection.RECONNECT_BASE_MS,
    'a connect that succeeded clears the accumulated backoff',
  );
});

test('the queue is bounded so an undrained connection cannot grow without limit', async () => {
  const { connection } = build();
  await connection.start();
  const socket = FakeWebSocket.instances[0];

  for (let index = 0; index < SocketModeConnection.MAX_QUEUED_EVENTS + 10; index += 1) {
    socket.deliver(blockActionsFrame({ envelopeId: `env-${index}`, actionId: `r:tok:${index}` }));
  }

  const events = connection.drainEvents();
  assert.equal(events.length, SocketModeConnection.MAX_QUEUED_EVENTS);
  assert.equal(events[events.length - 1].data, `r:tok:${SocketModeConnection.MAX_QUEUED_EVENTS + 9}`, 'newest kept');
});

test('stop closes the socket and blocks further reconnects', async () => {
  const timers = [];
  const { connection } = build({ timers });
  await connection.start();
  const socket = FakeWebSocket.instances[0];

  connection.stop();
  socket.onclose();

  assert.equal(socket.closed, true);
  assert.equal(timers.length, 0);
  await connection.start();
  assert.equal(FakeWebSocket.instances.length, 1, 'a stopped connection does not reopen');
});

test('one connection is shared per app token', () => {
  const first = SocketModeConnection.shared('xapp-a', { webSocketImpl: FakeWebSocket });
  const second = SocketModeConnection.shared('xapp-a', { webSocketImpl: FakeWebSocket });
  const other = SocketModeConnection.shared('xapp-b', { webSocketImpl: FakeWebSocket });

  assert.equal(first, second, 'providers rebuilt each tick must not open a socket per tick');
  assert.notEqual(first, other);
});

test('a response with ok:true but no url is a failure, not a socket to nowhere', async () => {
  const { connection, logs } = build({ openResponse: { ok: true } });

  await connection.start();

  assert.equal(connection.isConnected, false);
  assert.ok(logs.some((line) => line.includes('no socket url in response')));
  assert.equal(FakeWebSocket.instances.length, 0);
});

test('an unparseable frame is reported rather than dropped silently', async () => {
  const { connection, logs } = build();
  await connection.start();

  FakeWebSocket.instances[0].onmessage({ data: '{ broken' });

  assert.ok(logs.some((line) => line.includes('unparseable frame')));
});

test('the open request goes through the shared http client, which owns the timeout', async () => {
  const { connection, openCalls } = build();

  await connection.start();

  assert.equal(openCalls.length, 1, 'a raw fetch here would have no request timeout and could wedge start()');
  assert.deepEqual(openCalls[0].payload, {});
});

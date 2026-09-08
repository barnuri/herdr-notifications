'use strict';

// Records every request a provider makes and replays a queued response per
// call (the last queued response repeats once the queue is down to one entry).
function stubHttp(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const next = () => (queue.length > 1 ? queue.shift() : queue[0]);

  return {
    calls,
    client: {
      async postJson(url, payload, options) {
        calls.push({ method: 'POST', url, payload, options });
        return next();
      },
      async patchJson(url, payload, options) {
        calls.push({ method: 'PATCH', url, payload, options });
        return next();
      },
      async getJson(url, options) {
        calls.push({ method: 'GET', url, options });
        return next();
      },
    },
  };
}

module.exports = { stubHttp };

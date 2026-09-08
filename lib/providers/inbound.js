'use strict';

// The inbound-event protocol between a provider and the relay. A provider
// normalizes whatever its platform delivers into one of these kinds; the relay
// dispatches on them without knowing which platform they came from.
const INBOUND_TEXT = 'text';
const INBOUND_ACTION = 'action';

// The paging pattern shared by the providers whose inbound API returns a page
// of recent messages newest-first (Discord's `after`, Slack's `oldest`).
//
// `idOf` reads the platform's message identifier (a Discord snowflake, a Slack
// ts) and `normalize` turns one raw message into a relay event, or null to drop
// it. Events come back oldest-first so a burst of replies is applied in the
// order it was written.
function collectOldestFirst(messages, { cursor, idOf, normalize }) {
  if (messages.length === 0) {
    return { events: [], cursor };
  }

  const newestId = String(idOf(messages[0]));
  // Without a cursor the first poll would replay the whole channel backlog as
  // fresh answers; adopt the newest id and start listening from there.
  if (!cursor) {
    return { events: [], cursor: newestId };
  }

  const events = [];
  for (const message of [...messages].reverse()) {
    const event = normalize(message);
    if (event) {
      events.push(event);
    }
  }
  return { events, cursor: newestId };
}

module.exports = { INBOUND_TEXT, INBOUND_ACTION, collectOldestFirst };

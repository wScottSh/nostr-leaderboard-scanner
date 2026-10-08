/*
 * relay.js -- NIP-01 over WebSockets: publish signed events, and read
 * kind-0 profiles.
 *
 * RELAYS is the leaderboard's own default list (nostr-leaderboard
 * src/relay.js), so every Submit lands where the leaderboard looks; INDEXERS
 * are the profile indexers a name is looked up on and a generated key's
 * kind-0 is also sent to. Both are fixed in code on purpose: a relay taken
 * from the URL would let a crafted link redirect the broadcast. The only
 * override is at build time (SCANNER_RELAYS / SCANNER_INDEXERS in
 * scripts/build.mjs), for a local end-to-end run.
 */

/* global __SCANNER_RELAYS__, __SCANNER_INDEXERS__ */
export const RELAYS = typeof __SCANNER_RELAYS__ !== 'undefined'
  ? __SCANNER_RELAYS__
  : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

export const INDEXERS = typeof __SCANNER_INDEXERS__ !== 'undefined'
  ? __SCANNER_INDEXERS__
  : ['wss://purplepag.es', 'wss://user.kindpag.es'];

/**
 * publishToRelay: sends every event over one socket and matches each
 * ["OK", id, accepted, message] by id. Resolves one { relay, eventId, ok,
 * message } per event once all have answered, or on error, close, or
 * timeout (unanswered events then fail with that reason). Never rejects. A
 * relay that already has an event answers OK true ("duplicate:"), so
 * resending a stored event is harmless.
 */
export function publishToRelay(url, events, { timeoutMs = 10000, WebSocketImpl = globalThis.WebSocket, onResult = () => {} } = {}) {
  return new Promise((resolve) => {
    const results = new Map();
    let ws;
    let done = false;
    const record = (eventId, ok, message) => {
      if (results.has(eventId)) return;
      const r = { relay: url, eventId, ok, message };
      results.set(eventId, r);
      onResult(r);
    };
    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const ev of events) record(ev.id, false, reason);
      try {
        ws?.close();
      } catch { /* already closed */ }
      resolve(events.map((ev) => results.get(ev.id)));
    };
    const timer = setTimeout(() => finish('timed out'), timeoutMs);
    try {
      ws = new WebSocketImpl(url);
    } catch (e) {
      finish(String(e.message || e));
      return;
    }
    ws.onopen = () => {
      for (const ev of events) ws.send(JSON.stringify(['EVENT', ev]));
    };
    ws.onmessage = (msg) => {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (!Array.isArray(data) || data[0] !== 'OK' || !events.some((ev) => ev.id === data[1])) return;
      record(data[1], data[2] === true, data[3] || '');
      if (results.size === events.length) finish('');
    };
    ws.onerror = () => finish('connection error');
    ws.onclose = () => finish('connection closed');
  });
}

/** Publish (event, relay) pairs: one socket per relay, all relays in parallel. Resolves the flat results. */
export async function publishPairs(pairs, onResult = () => {}, opts = {}) {
  const byRelay = new Map();
  for (const { event, relay } of pairs) byRelay.set(relay, [...(byRelay.get(relay) ?? []), event]);
  const all = await Promise.all([...byRelay].map(([relay, events]) => publishToRelay(relay, events, { ...opts, onResult })));
  return all.flat();
}

/**
 * fetchEvents: REQ filter on every relay, collecting events until each
 * sends EOSE, fails, or times out. Never rejects; unreachable relays just
 * contribute nothing.
 */
export async function fetchEvents(urls, filter, { timeoutMs = 5000, WebSocketImpl = globalThis.WebSocket } = {}) {
  const perRelay = await Promise.all(urls.map((url) => new Promise((resolve) => {
    const events = [];
    let ws;
    let done = false;
    const sub = 'scan';
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.send(JSON.stringify(['CLOSE', sub]));
        ws?.close();
      } catch { /* already closed */ }
      resolve(events);
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      ws = new WebSocketImpl(url);
    } catch {
      finish();
      return;
    }
    ws.onopen = () => ws.send(JSON.stringify(['REQ', sub, filter]));
    ws.onmessage = (msg) => {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (done || !Array.isArray(data) || data[1] !== sub) return;
      if (data[0] === 'EVENT' && data[2] && typeof data[2] === 'object') events.push(data[2]);
      else if (data[0] === 'EOSE' || data[0] === 'CLOSED') finish();
    };
    ws.onerror = finish;
    ws.onclose = finish;
  })));
  return perRelay.flat();
}

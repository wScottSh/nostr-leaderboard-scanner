/*
 * relay.js -- NIP-01 publish: open each relay, send ["EVENT", ev], wait for
 * its ["OK", id, accepted, message]. The relay list is the leaderboard's own
 * defaults (nostr-leaderboard src/relay.js), so every scan lands where the
 * leaderboard looks. Fixed on purpose: a relay taken from the URL would let a
 * crafted link redirect the broadcast.
 */

export const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

/**
 * publishToRelay: resolves { relay, ok, message } on OK, error, close, or
 * timeout. Never rejects. A relay that already has the event answers
 * OK true ("duplicate:"), so re-scanning the same QR is harmless.
 */
export function publishToRelay(url, event, { timeoutMs = 10000, WebSocketImpl = globalThis.WebSocket } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    const done = (ok, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch { /* already closed */ }
      resolve({ relay: url, ok, message });
    };
    const timer = setTimeout(() => done(false, 'timed out'), timeoutMs);
    try {
      ws = new WebSocketImpl(url);
    } catch (e) {
      clearTimeout(timer);
      resolve({ relay: url, ok: false, message: String(e.message || e) });
      return;
    }
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onmessage = (msg) => {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (Array.isArray(data) && data[0] === 'OK' && data[1] === event.id) done(data[2] === true, data[3] || '');
    };
    ws.onerror = () => done(false, 'connection error');
    ws.onclose = () => done(false, 'connection closed');
  });
}

/** Publish to every relay in parallel; onResult fires as each one answers. */
export function publishAll(urls, event, onResult = () => {}, opts) {
  return Promise.all(
    urls.map((u) =>
      publishToRelay(u, event, opts).then((r) => {
        onResult(r);
        return r;
      }),
    ),
  );
}

/*
 * A throwaway NIP-01 relay in memory, for the finalizer test and the e2e.
 *
 * reject(ev, attempt) may return a rejection message. unindexed lists tag
 * letters this relay doesn't index: a filter on one matches nothing, the
 * way some public relays treat #k.
 */
import { WebSocketServer } from 'ws';

function matches(filter, ev, unindexed) {
  if (filter.ids && !filter.ids.includes(ev.id)) return false;
  if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
  if (filter.authors && !filter.authors.includes(ev.pubkey)) return false;
  if (filter.since !== undefined && ev.created_at < filter.since) return false;
  if (filter.until !== undefined && ev.created_at > filter.until) return false;
  return Object.entries(filter).filter(([k]) => k.startsWith('#')).every(([k, values]) =>
    !unindexed.includes(k.slice(1)) && ev.tags.some((t) => t[0] === k.slice(1) && values.includes(t[1])));
}

export function startRelay(name, { reject = () => null, unindexed = [] } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const relay = { name, received: [], stored: new Map(), attempts: new Map(), wss };
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const text = raw.toString();
      const msg = JSON.parse(text);
      if (msg[0] === 'EVENT') {
        const ev = msg[1];
        relay.received.push({ text, ev });
        const attempt = (relay.attempts.get(ev.id) ?? 0) + 1;
        relay.attempts.set(ev.id, attempt);
        const no = reject(ev, attempt);
        if (no) return ws.send(JSON.stringify(['OK', ev.id, false, no]));
        const dup = relay.stored.has(ev.id);
        relay.stored.set(ev.id, ev);
        ws.send(JSON.stringify(['OK', ev.id, true, dup ? 'duplicate: already have this event' : '']));
      } else if (msg[0] === 'REQ') {
        const [, sub, ...filters] = msg;
        for (const ev of relay.stored.values()) {
          if (filters.some((f) => matches(f, ev, unindexed))) ws.send(JSON.stringify(['EVENT', sub, ev]));
        }
        ws.send(JSON.stringify(['EOSE', sub]));
      }
    });
  });
  relay.close = () => new Promise((resolve) => {
    for (const c of wss.clients) c.terminate();
    wss.close(resolve);
  });
  return new Promise((resolve) => wss.on('listening', () => {
    relay.url = `ws://127.0.0.1:${wss.address().port}`;
    resolve(relay);
  }));
}

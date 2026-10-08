/*
 * relay.js against a fake WebSocket: several events over one socket per
 * relay, OKs matched by id, the never-reject contract, and kind-0 reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { publishToRelay, publishPairs, fetchEvents, RELAYS, INDEXERS } from '../src/relay.js';

const ev = (n) => ({ id: String(n).repeat(64).slice(0, 64), kind: 1 });
const A = ev(1);
const B = ev(2);
const C = ev(3);

class FakeWS {
  static opened = [];
  static sent = [];
  // (message, url) -> replies to deliver, in order
  static reply = () => [];
  constructor(url) {
    this.url = url;
    FakeWS.opened.push(url);
    queueMicrotask(() => this.onopen());
  }
  send(msg) {
    FakeWS.sent.push([this.url, JSON.parse(msg)]);
    for (const r of FakeWS.reply(JSON.parse(msg), this.url)) queueMicrotask(() => this.onmessage({ data: JSON.stringify(r) }));
  }
  close() {}
}

const reset = (reply) => {
  FakeWS.opened = [];
  FakeWS.sent = [];
  FakeWS.reply = reply;
};

test('relay lists: the leaderboard defaults and the profile indexers, unless overridden at build time', () => {
  assert.deepEqual(RELAYS, ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']);
  assert.deepEqual(INDEXERS, ['wss://purplepag.es', 'wss://user.kindpag.es']);
});

test('publishPairs: one socket per relay carrying all its events; each OK matched by id', async () => {
  const held = [];
  reset(([type, e], url) => {
    if (type !== 'EVENT') return [];
    if (url === 'wss://r2' && e.id === B.id) return [['OK', e.id, false, 'invalid: created_at too early']];
    if (url === 'wss://r1' && e.id === A.id) {
      held.push(e); // answered after B, out of order
      return [];
    }
    const replies = [['OK', e.id, true, e.id === C.id ? 'duplicate: have it' : '']];
    if (url === 'wss://r1' && e.id === B.id) replies.push(['OK', held[0].id, true, '']);
    return replies;
  });
  const seen = [];
  const results = await publishPairs(
    [{ event: A, relay: 'wss://r1' }, { event: B, relay: 'wss://r1' }, { event: B, relay: 'wss://r2' }, { event: C, relay: 'wss://r2' }],
    (r) => seen.push(r), { WebSocketImpl: FakeWS },
  );
  assert.deepEqual(FakeWS.opened.sort(), ['wss://r1', 'wss://r2']);
  assert.deepEqual(FakeWS.sent.filter(([u]) => u === 'wss://r1').map(([, m]) => m), [['EVENT', A], ['EVENT', B]]);
  const pick = (relay, e) => results.find((r) => r.relay === relay && r.eventId === e.id);
  assert.deepEqual(pick('wss://r1', A), { relay: 'wss://r1', eventId: A.id, ok: true, message: '' });
  assert.deepEqual(pick('wss://r2', B), { relay: 'wss://r2', eventId: B.id, ok: false, message: 'invalid: created_at too early' });
  assert.equal(pick('wss://r2', C).message, 'duplicate: have it');
  assert.equal(results.length, 4);
  assert.equal(seen.length, 4);
});

test('publishToRelay: unanswered events time out, answered ones keep their answer, foreign OKs ignored', async () => {
  reset(([, e]) => (e.id === A.id ? [['OK', 'f'.repeat(64), true, ''], ['OK', A.id, true, '']] : []));
  const r = await publishToRelay('wss://x', [A, B], { WebSocketImpl: FakeWS, timeoutMs: 30 });
  assert.deepEqual(r, [
    { relay: 'wss://x', eventId: A.id, ok: true, message: '' },
    { relay: 'wss://x', eventId: B.id, ok: false, message: 'timed out' },
  ]);
});

test('publishToRelay: never rejects, even when the socket cannot be built', async () => {
  class Throws {
    constructor() {
      throw new Error('bad url');
    }
  }
  assert.deepEqual(await publishToRelay('nope', [A], { WebSocketImpl: Throws }),
    [{ relay: 'nope', eventId: A.id, ok: false, message: 'bad url' }]);
});

test('fetchEvents: collects EVENTs from every relay until EOSE', async () => {
  reset(([type, sub, filter], url) => {
    if (type !== 'REQ') return [];
    assert.deepEqual(filter, { kinds: [0], authors: ['ab'] });
    return [['EVENT', sub, { id: url }], ['EVENT', 'other-sub', { id: 'no' }], ['EOSE', sub], ['EVENT', sub, { id: 'late' }]];
  });
  const got = await fetchEvents(['wss://i1', 'wss://i2'], { kinds: [0], authors: ['ab'] }, { WebSocketImpl: FakeWS });
  assert.deepEqual(got.map((e) => e.id).sort(), ['wss://i1', 'wss://i2']);
});

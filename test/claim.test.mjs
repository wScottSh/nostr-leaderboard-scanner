/*
 * The Claim, the Submit planner, and the persisted store: exact Claim shape,
 * the Run published verbatim, and publish bookkeeping that converges under
 * repeats, retries, and reloads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  claimTemplate, startRecord, plan, applyResults, submitStatus, canWalkAway, recordKey, withStamp, withProfile,
} from '../src/claim.js';
import { newStamp, applyOp, serializeOts, parseOts } from '../src/ots.js';
import { openStore, setKey, putRecord, findRecord, recordsFor } from '../src/store.js';
import { generatedKey, pastedKey, renameKey, profileName } from '../src/identity.js';
import { generateSecretKey } from '../src/sign.js';
import { decodeEvent } from '../src/decode.js';
import { verifyEvent, checkRun } from '../src/verify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures', 'multiframe_fixture.json'), 'utf8'));
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
const RUN = decodeEvent(hexToBytes(fixture.packedPayloadHex));
const RUN_JSON = JSON.stringify(RUN);

const RELAYS = ['wss://a', 'wss://b', 'wss://c'];
const INDEXERS = ['wss://idx1', 'wss://idx2'];
const TARGETS = { relays: RELAYS, indexers: INDEXERS };

const memoryStorage = (m = new Map()) => ({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m });
const answer = (pairs, fn) => pairs.map(({ event, relay }) => ({ eventId: event.id, relay, ...fn(event, relay) }));
const ok = () => ({ ok: true, message: '' });

// ------------------------------------------------------------- Claim shape

test('Claim: exact shape, pointing at the Run and committing to its signature', () => {
  assert.deepEqual(claimTemplate(RUN, 1800000000, 'wss://a'), {
    kind: 8064,
    created_at: 1800000000,
    content: '',
    tags: [
      ['t', 'ag-lb'],
      ['t', 'claim'],
      ['e', RUN.id, 'wss://a', RUN.pubkey],
      ['p', RUN.pubkey],
      ['sig', RUN.sig],
    ],
  });
});

test('Claim: signed by the player, and never something the leaderboard takes for a Run', () => {
  const key = generatedKey('Mario', 1800000000);
  const { claim } = startRecord(RUN, key, 1800000001, 'wss://a');
  assert.equal(claim.pubkey, key.pubkey);
  assert.equal(claim.created_at, 1800000001);
  assert.equal(verifyEvent(claim), true);
  assert.equal(checkRun(claim).ok, false);
  assert.ok(!claim.tags.some((t) => t[0] === 'n' || (t[0] === 't' && t[1] === 'sm64')));
});

// ------------------------------------------------------------- what Submit sends

test('Submit plan: generated key sends kind-0 (relays + indexers), the Run, and the Claim', () => {
  const key = generatedKey('Mario', 1800000000);
  const record = startRecord(RUN, key, 1800000001, RELAYS[0]);
  const pairs = plan(record, TARGETS);
  const by = (ev) => pairs.filter((p) => p.event === ev).map((p) => p.relay);
  assert.deepEqual(by(record.profile), [...RELAYS, ...INDEXERS]);
  assert.deepEqual(by(record.run), RELAYS);
  assert.deepEqual(by(record.claim), RELAYS);
  assert.equal(pairs.length, 11);
  assert.equal(profileName(record.profile), 'Mario');
});

test('Submit plan: a pasted key never publishes a kind-0', () => {
  const key = { ...pastedKey(generateSecretKey(), 'Peach'), profile: { id: 'x', kind: 0 } };
  const record = startRecord(RUN, key, 1800000001, RELAYS[0]);
  assert.equal(record.profile, null);
  assert.ok(plan(record, TARGETS).every((p) => p.event.kind !== 0));
});

test('the Run Submit publishes is byte-identical to the decoded event, even after a reload', () => {
  const storage = memoryStorage();
  const key = generatedKey('Mario', 1800000000);
  openStore(storage).update((s) => putRecord(setKey(s, key), startRecord(RUN, key, 1800000001, RELAYS[0])));
  const reloaded = findRecord(openStore(storage).get(), RUN.id, key.pubkey);
  const runs = plan(reloaded, TARGETS).filter((p) => p.event.id === RUN.id);
  assert.equal(runs.length, RELAYS.length);
  for (const { event } of runs) assert.equal(JSON.stringify(event), RUN_JSON);
});

// ------------------------------------------------------------- results

test('applyResults: applying the same answers twice changes nothing', () => {
  const record = startRecord(RUN, generatedKey('Mario', 1), 2, RELAYS[0]);
  const results = answer(plan(record, TARGETS), (ev, relay) =>
    (relay === 'wss://b' ? { ok: false, message: 'blocked: created_at too old' } : ok()));
  const once = applyResults(record, results);
  assert.deepEqual(applyResults(once, results), once);
});

test('retry sends only the failed pairs, and a later failure never undoes an acceptance', () => {
  const record = startRecord(RUN, generatedKey('Mario', 1), 2, RELAYS[0]);
  const first = applyResults(record, answer(plan(record, TARGETS), (ev, relay) =>
    (ev.id === RUN.id && relay === 'wss://b' ? { ok: false, message: 'invalid: created_at too early' } : ok())));
  assert.deepEqual(plan(first, TARGETS).map((p) => [p.event.id, p.relay]), [[RUN.id, 'wss://b']]);
  assert.equal(first.sends[RUN.id]['wss://b'].message, 'invalid: created_at too early');

  const flaky = applyResults(first, [{ eventId: RUN.id, relay: 'wss://a', ok: false, message: 'timed out' }]);
  assert.equal(flaky.sends[RUN.id]['wss://a'].state, 'ok');
});

test('success: Run (duplicate counts) and Claim each on at least one relay', () => {
  const record = startRecord(RUN, generatedKey('Mario', 1), 2, RELAYS[0]);
  const dupRun = applyResults(record, answer(plan(record, TARGETS), (ev, relay) => {
    if (ev.id === RUN.id) return { ok: true, message: 'duplicate: already have this event' };
    if (ev.id === record.claim.id && relay !== 'wss://c') return { ok: false, message: 'rate-limited' };
    return ok();
  }));
  assert.equal(submitStatus(dupRun, TARGETS).submitted, true);

  const noClaim = applyResults(record, answer(plan(record, TARGETS), (ev) =>
    (ev.id === record.claim.id ? { ok: false, message: 'blocked' } : ok())));
  assert.deepEqual(submitStatus(noClaim, TARGETS).status.claim, 'failed');
  assert.equal(submitStatus(noClaim, TARGETS).submitted, false);
  assert.equal(submitStatus(noClaim, TARGETS).relaysOwed, true);

  const noRun = applyResults(record, answer(plan(record, TARGETS), (ev) =>
    (ev.id === RUN.id ? { ok: false, message: 'invalid: created_at too early' } : ok())));
  assert.equal(submitStatus(noRun, TARGETS).submitted, false);
});

test('reload mid-Submit: unsent pairs are still owed, and finishing them converges', () => {
  const storage = memoryStorage();
  const key = generatedKey('Mario', 1);
  const store = openStore(storage);
  store.update((s) => putRecord(setKey(s, key), startRecord(RUN, key, 2, RELAYS[0])));
  const k = recordKey(RUN.id, key.pubkey);
  const pairs = plan(store.get().claims[k], TARGETS);
  const half = answer(pairs.slice(0, 4), ok);
  store.update((s) => ({ ...s, claims: { ...s.claims, [k]: applyResults(s.claims[k], half) } }));

  const firstRelayOnly = applyResults(store.get().claims[k], answer(pairs.filter((p) => p.relay === 'wss://a'), ok));
  assert.equal(submitStatus(firstRelayOnly, TARGETS).submitted, true);
  assert.equal(submitStatus(firstRelayOnly, TARGETS).relaysOwed, true, 'pairs never sent are still owed');

  const after = openStore(storage);
  const record = after.get().claims[k];
  assert.equal(submitStatus(record, TARGETS).relaysOwed, true);
  const owed = plan(record, TARGETS);
  assert.deepEqual(owed.map((p) => p.event.id + p.relay), pairs.slice(4).map((p) => p.event.id + p.relay));

  const done = applyResults(record, answer(owed, ok));
  assert.deepEqual(plan(done, TARGETS), []);
  assert.deepEqual(submitStatus(done, TARGETS), { status: { profile: 'ok', run: 'ok', claim: 'ok' }, submitted: true, relaysOwed: false });
});

// ------------------------------------------------------------- store and keys

test('store: versioned, survives reload, ignores garbage', () => {
  const storage = memoryStorage();
  const key = pastedKey(generateSecretKey(), null);
  openStore(storage).update((s) => setKey(s, key));
  assert.deepEqual(openStore(storage).get().key, key);
  storage.setItem('nostr-leaderboard-scanner', '{"v":99}');
  assert.deepEqual(openStore(storage).get(), { v: 1, key: null, claims: {} });
  storage.setItem('nostr-leaderboard-scanner', 'not json');
  assert.equal(openStore(storage).get().key, null);
});

test('store: Claims are per (Run, key); another key makes its own', () => {
  const a = generatedKey('Mario', 1);
  const b = generatedKey('Luigi', 1);
  let s = putRecord(setKey(openStore(memoryStorage()).get(), a), startRecord(RUN, a, 2, RELAYS[0]));
  s = putRecord(s, startRecord(RUN, b, 3, RELAYS[0]));
  assert.equal(findRecord(s, RUN.id, a.pubkey).claim.pubkey, a.pubkey);
  assert.equal(findRecord(s, RUN.id, b.pubkey).claim.pubkey, b.pubkey);
  assert.equal(recordsFor(s, a.pubkey).length, 1);
});

test('rename: a new kind-0, strictly newer than the last, same key', () => {
  const key = generatedKey('Mario', 1000);
  const renamed = renameKey(key, 'Wario', 1000);
  assert.equal(renamed.pubkey, key.pubkey);
  assert.equal(profileName(renamed.profile), 'Wario');
  assert.equal(renamed.profile.created_at, 1001);
  assert.equal(verifyEvent(renamed.profile), true);
});

// ------------------------------------------------------------- the Claim's timestamp proof

const proofFor = (claimId) => {
  const root = newStamp(new Uint8Array(Buffer.from(claimId, 'hex')));
  const pend = newStamp(applyOp({ tag: 0xf0, arg: new Uint8Array([1]) }, root.msg));
  pend.attestations.push({ type: 'pending', uri: 'https://alice.btc.calendar.opentimestamps.org' });
  root.ops.push({ op: { tag: 0xf0, arg: new Uint8Array([1]) }, stamp: pend });
  return serializeOts(root);
};

test('stamped at Submit: the ots-pending carrier is signed with the key captured then and joins the publish plan', () => {
  const key = generatedKey('Mario', 1);
  const record = startRecord(RUN, key, 2, RELAYS[0]);
  const file = proofFor(record.claim.id);
  const stamped = withStamp(record, { file, calendars: ['https://alice'], errors: { 'https://bob': 'HTTP 500' } }, key, 3);
  assert.equal(stamped.pending.pubkey, key.pubkey);
  assert.equal(verifyEvent(stamped.pending), true);
  assert.deepEqual(stamped.pending.tags, [['t', 'ag-lb'], ['t', 'ots-pending'], ['e', record.claim.id]]);
  assert.equal(stamped.pending.content, Buffer.from(file).toString('base64'));
  assert.deepEqual(stamped.ots, { calendars: ['https://alice'], errors: { 'https://bob': 'HTTP 500' } });
  assert.deepEqual(plan(stamped, TARGETS).filter((p) => p.event === stamped.pending).map((p) => p.relay), RELAYS);
});

test('stamping failed everywhere: no carrier, errors kept, nothing owed (the finalizer stamps it)', () => {
  const key = generatedKey('Mario', 1);
  const record = withStamp(startRecord(RUN, key, 2, RELAYS[0]), { file: null, calendars: [], errors: { a: 'x' } }, key, 3);
  assert.equal(record.pending, null);
  assert.deepEqual(record.ots.errors, { a: 'x' });
  const sent = applyResults(record, answer(plan(record, TARGETS), ok));
  assert.deepEqual(submitStatus(sent, TARGETS), { status: { profile: 'ok', run: 'ok', claim: 'ok' }, submitted: true, relaysOwed: false });
});

test('walk away: once the Run, the Claim and the ots-pending are each on a relay, or stamping produced nothing to send', () => {
  const key = generatedKey('Mario', 1);
  const record = startRecord(RUN, key, 2, RELAYS[0]);
  const sent = applyResults(record, answer(plan(record, TARGETS), (ev, relay) => (relay === 'wss://a' ? ok() : { ok: false, message: 'timed out' })));
  assert.equal(canWalkAway(sent, TARGETS, true), false, 'not while the calendars are still being asked');
  assert.equal(canWalkAway(sent, TARGETS, false), true, 'no carrier to send (stamping failed or a reload cut it): the finalizer stamps it');

  const stamped = withStamp(sent, { file: proofFor(record.claim.id), calendars: ['https://alice'], errors: {} }, key, 3);
  assert.equal(canWalkAway(stamped, TARGETS, false), false, 'the ots-pending is not on any relay yet');
  const refused = applyResults(stamped, answer(plan(stamped, TARGETS).filter((p) => p.event === stamped.pending), () => ({ ok: false, message: 'blocked' })));
  assert.equal(canWalkAway(refused, TARGETS, false), false);
  const carried = applyResults(refused, [{ eventId: stamped.pending.id, relay: 'wss://c', ok: true, message: '' }]);
  assert.equal(canWalkAway(carried, TARGETS, false), true);

  const noClaim = applyResults(record, answer(plan(record, TARGETS), (ev) => (ev.id === record.claim.id ? { ok: false, message: 'blocked' } : ok())));
  assert.equal(canWalkAway(noClaim, TARGETS, false), false);
  const noRun = applyResults(record, answer(plan(record, TARGETS), (ev) => (ev.id === RUN.id ? { ok: false, message: 'invalid: created_at too early' } : ok())));
  assert.equal(canWalkAway(noRun, TARGETS, false), false, 'a Claim pointing at a Run no relay holds is not done');
});

test('Change name: the next Submit or Retry of an existing record publishes the renamed kind-0', () => {
  const key = generatedKey('Mario', 1000);
  const record = startRecord(RUN, key, 1001, RELAYS[0]);
  const sent = applyResults(record, answer(plan(record, TARGETS), ok));
  assert.deepEqual(plan(sent, TARGETS), []);

  const renamed = renameKey(key, 'Wario', 2000);
  const refreshed = withProfile(sent, renamed);
  assert.equal(profileName(refreshed.profile), 'Wario');
  assert.deepEqual(plan(refreshed, TARGETS).map((p) => [p.event.id, p.relay]),
    [...RELAYS, ...INDEXERS].map((r) => [renamed.profile.id, r]), 'only the new kind-0 is owed');
  assert.equal(withProfile(refreshed, renamed), refreshed, 'idempotent');

  assert.equal(withProfile(sent, key), sent, 'an unchanged name owes nothing');
  assert.equal(withProfile(sent, renameKey(generatedKey('Luigi', 1), 'Luigi', 5)), sent, 'another key never touches it');
  assert.equal(withProfile(sent, null), sent);
});

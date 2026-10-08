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
  claimTemplate, startRecord, plan, applyResults, submitStatus, recordKey, needsStamp, withStamp, upgradeDue, withUpgrade,
} from '../src/claim.js';
import { newStamp, applyOp, serializeOts, parseOts, bitcoinHeights, otsStatus } from '../src/ots.js';
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
  assert.equal(submitStatus(noClaim, TARGETS).needsRetry, true);

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
  assert.equal(submitStatus(firstRelayOnly, TARGETS).needsRetry, true, 'pairs never sent are still owed');

  const after = openStore(storage);
  const record = after.get().claims[k];
  assert.equal(submitStatus(record, TARGETS).needsRetry, true);
  const owed = plan(record, TARGETS);
  assert.deepEqual(owed.map((p) => p.event.id + p.relay), pairs.slice(4).map((p) => p.event.id + p.relay));

  const done = applyResults(record, answer(owed, ok));
  assert.deepEqual(plan(done, TARGETS), []);
  assert.deepEqual(submitStatus(done, TARGETS), {
    status: { profile: 'ok', run: 'ok', claim: 'ok' }, submitted: true, needsRetry: false,
  });
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

const proofFor = (claimId, { bitcoin }) => {
  const root = newStamp(new Uint8Array(Buffer.from(claimId, 'hex')));
  const pend = newStamp(applyOp({ tag: 0xf0, arg: new Uint8Array([1]) }, root.msg));
  pend.attestations.push({ type: 'pending', uri: 'https://alice.btc.calendar.opentimestamps.org' });
  root.ops.push({ op: { tag: 0xf0, arg: new Uint8Array([1]) }, stamp: pend });
  if (bitcoin) {
    const btc = newStamp(applyOp({ tag: 0x08 }, root.msg));
    btc.attestations.push({ type: 'bitcoin', height: bitcoin });
    root.ops.push({ op: { tag: 0x08 }, stamp: btc });
  }
  return serializeOts(root);
};

test('stamped: the ots-pending carrier is signed by the claimer and joins the publish plan', () => {
  const key = generatedKey('Mario', 1);
  const record = startRecord(RUN, key, 2, RELAYS[0]);
  assert.equal(needsStamp(record), true);
  const file = proofFor(record.claim.id, {});
  const stamped = withStamp(record, { file, calendars: ['https://alice'], errors: { 'https://bob': 'HTTP 500' } }, key, 3);
  assert.equal(needsStamp(stamped), false);
  assert.equal(stamped.pending.pubkey, key.pubkey);
  assert.equal(verifyEvent(stamped.pending), true);
  assert.deepEqual(stamped.pending.tags, [['t', 'ag-lb'], ['t', 'ots-pending'], ['e', record.claim.id]]);
  assert.equal(stamped.pending.content, stamped.ots.file);
  assert.deepEqual(stamped.ots.errors, { 'https://bob': 'HTTP 500' });
  assert.deepEqual(plan(stamped, TARGETS).filter((p) => p.event === stamped.pending).map((p) => p.relay), RELAYS);

  const otherKey = withStamp(record, { file, calendars: ['https://alice'], errors: {} }, generatedKey('Luigi', 1), 3);
  assert.equal(otherKey.pending, null, 'only the claimer signs its carrier');
  assert.equal(needsStamp(otherKey), false);
});

test('stamping failed everywhere: no proof, errors kept, still owed a stamp', () => {
  const key = generatedKey('Mario', 1);
  const record = withStamp(startRecord(RUN, key, 2, RELAYS[0]), { file: null, calendars: [], errors: { a: 'x' } }, key, 3);
  assert.equal(record.pending, null);
  assert.equal(needsStamp(record), true);
  assert.deepEqual(record.ots.errors, { a: 'x' });
});

test('upgrade timing: an hour after the Claim, at most every 10 minutes, never after the 1040 exists', () => {
  const key = generatedKey('Mario', 1);
  const t0 = 1800000000;
  const record = withStamp(startRecord(RUN, key, t0, RELAYS[0]), { file: proofFor('00'.repeat(32), {}), calendars: [], errors: {} }, key, t0);
  assert.equal(upgradeDue(record, (t0 + 3599) * 1000), false);
  assert.equal(upgradeDue(record, (t0 + 3600) * 1000), true);
  const checked = { ...record, ots: { ...record.ots, lastUpgrade: (t0 + 3600) * 1000 } };
  assert.equal(upgradeDue(checked, (t0 + 3600 + 599) * 1000), false);
  assert.equal(upgradeDue(checked, (t0 + 3600 + 600) * 1000), true);
  assert.equal(upgradeDue({ ...checked, final: {} }, (t0 + 9999) * 1000), false);
});

test('upgraded: a Bitcoin attestation yields a NIP-03 1040 of the pruned proof, signed by a throwaway key, once', () => {
  const key = generatedKey('Mario', 1);
  const record = startRecord(RUN, key, 2, RELAYS[0]);
  const stillPending = withUpgrade(record, proofFor(record.claim.id, {}), 5000, RELAYS[0]);
  assert.equal(stillPending.final, null);
  assert.equal(stillPending.ots.lastUpgrade, 5000);

  const done = withUpgrade(record, proofFor(record.claim.id, { bitcoin: 917000 }), 7200000, RELAYS[0]);
  const { final } = done;
  assert.equal(final.kind, 1040);
  assert.equal(final.created_at, 7200);
  assert.notEqual(final.pubkey, key.pubkey);
  assert.equal(verifyEvent(final), true);
  assert.deepEqual(final.tags, [['e', record.claim.id, RELAYS[0]], ['k', '8064']]);
  const pruned = parseOts(Buffer.from(final.content, 'base64'));
  assert.deepEqual(bitcoinHeights(pruned), [917000]);
  assert.equal(pruned.ops.length, 1, 'pending branch pruned');
  assert.equal(otsStatus(done.ots.file), 'complete');

  assert.equal(withUpgrade(done, proofFor(record.claim.id, { bitcoin: 917000 }), 9999999, RELAYS[0]).final, final);
  assert.deepEqual(plan(done, TARGETS).filter((p) => p.event === final).map((p) => p.relay), RELAYS);
});

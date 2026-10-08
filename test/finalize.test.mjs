/*
 * The finalizer's pure core: which relay events count, and what it does for
 * each Claim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  indexEvents, decide, mergeFiles, pendingCalendars, readiness, finalEvent, pendingEvent, parseFinal, STAMP_AFTER_S, PARTIAL_AFTER_S,
} from '../src/finalize.js';
import { claimTemplate } from '../src/claim.js';
import { signEvent, generateSecretKey, pubkeyOf } from '../src/sign.js';
import { decodeEvent } from '../src/decode.js';
import { verifyEvent } from '../src/verify.js';
import { newStamp, applyOp, serializeOts, parseOts, bitcoinHeights, finalTemplate } from '../src/ots.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures', 'multiframe_fixture.json'), 'utf8'));
const RUN = decodeEvent(Uint8Array.from(Buffer.from(fixture.packedPayloadHex, 'hex')));
const ALICE = 'https://alice.btc.calendar.opentimestamps.org';
const BOB = 'https://bob.btc.calendar.opentimestamps.org';
const T0 = 1800000000;
const claimer = generateSecretKey();
const finalizer = generateSecretKey();

const signedClaim = (createdAt = T0) => signEvent(claimTemplate(RUN, createdAt, 'wss://a'), claimer);

/** A proof of digestHex forking into one pending leaf per calendar; a height puts Bitcoin under that leaf. */
function proof(digestHex, heights, salt = 0) {
  const root = newStamp(Uint8Array.from(Buffer.from(digestHex, 'hex')));
  Object.entries(heights).forEach(([uri, height], i) => {
    const op = { tag: 0xf0, arg: new Uint8Array([salt, i]) };
    const leaf = newStamp(applyOp(op, root.msg));
    leaf.attestations.push({ type: 'pending', uri });
    if (height) {
      const btc = newStamp(applyOp({ tag: 0x08 }, leaf.msg));
      btc.attestations.push({ type: 'bitcoin', height });
      leaf.ops.push({ op: { tag: 0x08 }, stamp: btc });
    }
    root.ops.push({ op, stamp: leaf });
  });
  return serializeOts(root);
}

const decideFor = (events, claimId, now = T0 + 3600) => decide(indexEvents(events).get(claimId) ?? { claim: null, pendings: [], finals: [] }, now, pubkeyOf(finalizer));

test('decide: a Claim with no proof anywhere is stamped once it is over 120 s old', () => {
  const claim = signedClaim();
  assert.deepEqual(decideFor([claim], claim.id, T0 + STAMP_AFTER_S), { kind: 'skip', reason: 'claim too new to stamp' });
  assert.deepEqual(decideFor([claim], claim.id, T0 + STAMP_AFTER_S + 1), { kind: 'stamp' });
});

test('decide: a Claim with an ots-pending is upgraded from that proof', () => {
  const claim = signedClaim();
  const file = proof(claim.id, { [ALICE]: 0 });
  const decision = decideFor([claim, pendingEvent(claim.id, file, T0, claimer)], claim.id);
  assert.equal(decision.kind, 'upgrade');
  assert.deepEqual(decision.files, [file]);
});

test('decide: a 1040 with a Bitcoin attestation means done, whatever else is there', () => {
  const claim = signedClaim();
  const pending = pendingEvent(claim.id, proof(claim.id, { [ALICE]: 0 }), T0, claimer);
  const final = finalEvent(claim.id, proof(claim.id, { [ALICE]: 917000 }), 'wss://a', T0 + 7200, finalizer);
  assert.deepEqual(decideFor([claim, pending, final], claim.id), { kind: 'done' });
  assert.deepEqual(decideFor([final, claim], claim.id), { kind: 'done' });
});

test('decide: a valid Bitcoin 1040 signed by any other key is ignored (its Bitcoin header is unverifiable here)', () => {
  const claim = signedClaim();
  const pending = pendingEvent(claim.id, proof(claim.id, { [ALICE]: 0 }), T0, claimer);
  const someoneElse = finalEvent(claim.id, proof(claim.id, { [ALICE]: 917000 }), 'wss://a', T0 + 7200, generateSecretKey());
  assert.equal(verifyEvent(someoneElse), true);
  assert.equal(decideFor([claim, pending, someoneElse], claim.id).kind, 'upgrade');
  assert.deepEqual(decideFor([claim, someoneElse], claim.id), { kind: 'stamp' });
});

test('decide: a 1040 without a Bitcoin attestation, or for another digest, does not count', () => {
  const claim = signedClaim();
  const pendingOnly = signEvent(finalTemplate(claim.id, proof(claim.id, { [ALICE]: 0 }), 'wss://a', T0), finalizer);
  assert.deepEqual(decideFor([claim, pendingOnly], claim.id), { kind: 'stamp' });
  const otherDigest = signEvent(finalTemplate(claim.id, proof(RUN.id, { [ALICE]: 917000 }), 'wss://a', T0), finalizer);
  assert.deepEqual(decideFor([claim, otherDigest], claim.id), { kind: 'stamp' });
});

test('decide: an ots-pending with no Claim on the relays is skipped (never finalize a digest nobody claimed)', () => {
  const claimId = 'ab'.repeat(32);
  const pending = pendingEvent(claimId, proof(claimId, { [ALICE]: 0 }), T0, claimer);
  assert.deepEqual(decideFor([pending], claimId), { kind: 'skip', reason: 'claim not found' });
});

test('boundary: forged signatures are dropped', () => {
  const claim = signedClaim();
  const forgedClaim = { ...claim, sig: claim.sig.replace(/^./, (c) => (c === '0' ? '1' : '0')) };
  const pending = pendingEvent(claim.id, proof(claim.id, { [ALICE]: 0 }), T0, claimer);
  assert.deepEqual(decideFor([forgedClaim, pending], claim.id), { kind: 'skip', reason: 'claim not found' });

  const forgedPending = { ...pending, content: Buffer.from(proof(claim.id, { [BOB]: 0 })).toString('base64') };
  assert.deepEqual(decideFor([claim, forgedPending], claim.id), { kind: 'stamp' });

  const final = finalEvent(claim.id, proof(claim.id, { [ALICE]: 917000 }), 'wss://a', T0, finalizer);
  assert.deepEqual(decideFor([claim, { ...final, pubkey: claim.pubkey }], claim.id), { kind: 'stamp' });
});

test('boundary: an ots-pending whose proof stamps a different digest than its Claim is dropped', () => {
  const claim = signedClaim();
  const wrong = pendingEvent(claim.id, proof(RUN.id, { [ALICE]: 0 }), T0, claimer);
  assert.equal(verifyEvent(wrong), true, 'validly signed');
  assert.deepEqual(decideFor([claim, wrong], claim.id), { kind: 'stamp' });
  const garbage = signEvent({ kind: 8064, created_at: T0, tags: [['t', 'ag-lb'], ['t', 'ots-pending'], ['e', claim.id]], content: 'not a proof' }, claimer);
  assert.deepEqual(decideFor([claim, garbage], claim.id), { kind: 'stamp' });
});

test('boundary: only the exact tag shapes count', () => {
  const claim = signedClaim();
  const extraClaimTag = signEvent({ ...claimTemplate(RUN, T0, 'wss://a'), tags: [...claimTemplate(RUN, T0, 'wss://a').tags, ['x', 'y']] }, claimer);
  assert.equal(indexEvents([extraClaimTag]).size, 0);
  const noSig = signEvent({ ...claimTemplate(RUN, T0, 'wss://a'), tags: claimTemplate(RUN, T0, 'wss://a').tags.slice(0, 4) }, claimer);
  assert.equal(indexEvents([noSig]).size, 0);

  const file = proof(claim.id, { [ALICE]: 0 });
  const content = Buffer.from(file).toString('base64');
  const extraPendingTag = signEvent({ kind: 8064, created_at: T0, content, tags: [['t', 'ag-lb'], ['t', 'ots-pending'], ['e', claim.id], ['x', 'y']] }, claimer);
  const reordered = signEvent({ kind: 8064, created_at: T0, content, tags: [['t', 'ots-pending'], ['t', 'ag-lb'], ['e', claim.id]] }, claimer);
  assert.deepEqual(decideFor([claim, extraPendingTag, reordered], claim.id), { kind: 'stamp' });

  const btc = Buffer.from(proof(claim.id, { [ALICE]: 917000 })).toString('base64');
  const noK = signEvent({ kind: 1040, created_at: T0, content: btc, tags: [['e', claim.id, 'wss://a']] }, finalizer);
  const wrongK = signEvent({ kind: 1040, created_at: T0, content: btc, tags: [['e', claim.id], ['k', '1']] }, finalizer);
  assert.deepEqual(decideFor([claim, noK, wrongK], claim.id), { kind: 'stamp' });
  const bareE = signEvent({ kind: 1040, created_at: T0, content: btc, tags: [['e', claim.id], ['k', '8064']] }, finalizer);
  assert.equal(parseFinal(bareE), claim.id, 'a 1040 without a relay hint still counts');
});

test('duplicate pendings: the same event twice counts once; different proofs merge into one with every calendar', () => {
  const claim = signedClaim();
  const phone = pendingEvent(claim.id, proof(claim.id, { [ALICE]: 0 }, 1), T0, claimer);
  const fallback = pendingEvent(claim.id, proof(claim.id, { [BOB]: 0 }, 2), T0 + 200, finalizer);
  assert.equal(indexEvents([claim, phone, phone]).get(claim.id).pendings.length, 1);

  const decision = decideFor([claim, phone, fallback, phone], claim.id);
  assert.equal(decision.files.length, 2);
  const merged = mergeFiles(decision.files);
  assert.deepEqual(pendingCalendars(merged).sort(), [ALICE, BOB]);
  assert.equal(parseOts(merged).ops.length, 2, 'both stamping branches kept');
  assert.equal(Buffer.from(parseOts(merged).msg).toString('hex'), claim.id);
});

test('readiness: every stamping calendar in Bitcoin, or 12 h after the Claim with at least one', () => {
  const calendars = [ALICE, BOB];
  const both = proof('00'.repeat(32), { [ALICE]: 917000, [BOB]: 917001 });
  assert.deepEqual(readiness(both, calendars, T0, T0 + 3600), { ready: true, attested: [ALICE, BOB], waiting: [] });

  const aliceOnly = proof('00'.repeat(32), { [ALICE]: 917000, [BOB]: 0 });
  assert.equal(readiness(aliceOnly, calendars, T0, T0 + PARTIAL_AFTER_S - 1).ready, false);
  assert.deepEqual(readiness(aliceOnly, calendars, T0, T0 + PARTIAL_AFTER_S), { ready: true, attested: [ALICE], waiting: [BOB] });

  const none = proof('00'.repeat(32), { [ALICE]: 0, [BOB]: 0 });
  assert.equal(readiness(none, calendars, T0, T0 + 30 * 86400).ready, false, 'never without a Bitcoin attestation');
});

test('finalEvent: NIP-03 1040, Bitcoin paths only (every calendar), digest = Claim id, signed by the finalizer', () => {
  const claim = signedClaim();
  const final = finalEvent(claim.id, proof(claim.id, { [ALICE]: 917000, [BOB]: 917001, 'https://x.example': 0 }), 'wss://a', T0 + 7200, finalizer);
  assert.equal(verifyEvent(final), true);
  assert.equal(final.kind, 1040);
  assert.equal(final.created_at, T0 + 7200);
  assert.notEqual(final.pubkey, claim.pubkey);
  assert.deepEqual(final.tags, [['e', claim.id, 'wss://a'], ['k', '8064']]);
  const pruned = parseOts(Buffer.from(final.content, 'base64'));
  assert.equal(Buffer.from(pruned.msg).toString('hex'), claim.id);
  assert.deepEqual(bitcoinHeights(pruned).sort(), [917000, 917001]);
  assert.deepEqual(pendingCalendars(serializeOts(pruned)), [], 'no pending attestations left');
  assert.equal(parseFinal(final), claim.id);
});

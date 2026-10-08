/*
 * The finalizer end to end: `node finalizer/run.mjs` against local relays
 * and fake calendars, run the way the systemd timer runs it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { startRelay } from './support/relay.mjs';
import { startCalendar } from './support/calendar.mjs';
import { runFinalizer as finalize } from './support/finalizer.mjs';
import { claimTemplate } from '../src/claim.js';
import { signEvent, generateSecretKey, pubkeyOf } from '../src/sign.js';
import { decodeEvent } from '../src/decode.js';
import { verifyEvent } from '../src/verify.js';
import { stampDigest, parseOts, bitcoinHeights } from '../src/ots.js';
import { pendingEvent, pendingCalendars } from '../src/finalize.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures', 'multiframe_fixture.json'), 'utf8'));
const RUN = decodeEvent(Uint8Array.from(Buffer.from(fixture.packedPayloadHex, 'hex')));
const nowSec = () => Math.floor(Date.now() / 1000);

const of = (relay, pred) => [...relay.received].map(({ ev }) => ev).filter(pred);
const isFinal = (ev) => ev.kind === 1040;
const isPending = (ev) => ev.tags.some((t) => t[0] === 't' && t[1] === 'ots-pending');
const keyFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'finalizer-')), 'key.hex');

test('a walked-away Claim gets exactly one Bitcoin-only 1040, once every stamping calendar attests', async () => {
  const [plain, noK, alice, bob] = await Promise.all([startRelay('plain'), startRelay('no-#k', { unindexed: ['k'] }), startCalendar(), startCalendar()]);
  try {
    const claimer = generateSecretKey();
    const claim = signEvent(claimTemplate(RUN, nowSec() - 60, plain.url), claimer);
    const { file } = await stampDigest(claim.id, { calendars: [alice.url, bob.url] });
    const pending = pendingEvent(claim.id, file, claim.created_at, claimer);
    for (const r of [plain, noK]) for (const ev of [RUN, claim, pending]) r.stored.set(ev.id, ev);
    const env = { relays: [plain.url, noK.url], calendars: [alice.url, bob.url], keyFile: keyFile() };

    let run = await finalize(env);
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /upgrade \w+ not ready; bitcoin: none/);
    assert.equal(of(plain, isFinal).length, 0, 'nothing to publish while no calendar is in Bitcoin');

    alice.mine(917000);
    run = await finalize(env);
    assert.match(run.out, /not ready; bitcoin: 127\.0\.0\.1:\d+; waiting: 127\.0\.0\.1:\d+/);
    assert.equal(of(plain, isFinal).length, 0, 'waits for the other calendar (the Claim is not 12 h old)');

    bob.mine(917001);
    run = await finalize(env);
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /1040 \w+; .* accepted 2\/2/);
    const [final, ...more] = of(plain, isFinal);
    assert.equal(more.length, 0);
    assert.deepEqual(of(noK, isFinal), [final], 'the same 1040 on every relay');
    assert.equal(verifyEvent(final), true);
    assert.deepEqual(final.tags, [['e', claim.id, plain.url], ['k', '8064']]);
    assert.equal(final.pubkey, pubkeyOf(readFileSync(env.keyFile, 'utf8').trim()), 'signed by the finalizer key');
    assert.equal(statSync(env.keyFile).mode & 0o777, 0o600);
    const proof = parseOts(Buffer.from(final.content, 'base64'));
    assert.equal(Buffer.from(proof.msg).toString('hex'), claim.id, 'digest = Claim id');
    assert.deepEqual(bitcoinHeights(proof).sort(), [917000, 917001], 'both calendars’ Bitcoin paths');
    assert.deepEqual(pendingCalendars(Buffer.from(final.content, 'base64')), [], 'Bitcoin-only');

    const received = plain.received.length + noK.received.length;
    run = await finalize(env);
    assert.equal(run.code, 0, run.out);
    assert.equal(plain.received.length + noK.received.length, received, 'second run publishes nothing');
    run = await finalize({ ...env, relays: [noK.url] });
    assert.match(run.out, /done=1 upgrade=0 stamp=0/, 'a relay that does not index #k still shows the 1040 by #e');
    assert.equal(noK.received.length, received - plain.received.length);
  } finally {
    await Promise.all([plain, noK, alice, bob].map((x) => x.close()));
  }
});

test('a Claim whose page closed before stamping gets one ots-pending from the finalizer; a dead relay does not fail the run', async () => {
  const [relay, cal] = await Promise.all([startRelay('relay'), startCalendar()]);
  try {
    const claim = signEvent(claimTemplate(RUN, nowSec() - 900, relay.url), generateSecretKey());
    const fresh = signEvent(claimTemplate(RUN, nowSec() - 300, relay.url), generateSecretKey());
    const orphan = signEvent(claimTemplate({ ...RUN, id: 'cd'.repeat(32) }, nowSec() - 900, relay.url), generateSecretKey());
    for (const ev of [RUN, claim, fresh, orphan]) relay.stored.set(ev.id, ev);
    const env = { relays: [relay.url, 'ws://127.0.0.1:9'], calendars: [cal.url], keyFile: keyFile() };

    const dry = await finalize({ ...env, args: ['--dry-run'] });
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /stamp \w+ dry-run: would stamp/);
    assert.match(dry.out, /skip \w+ claim too new to stamp/);
    assert.match(dry.out, new RegExp(`skip ${orphan.id.slice(0, 12)} run not found`));
    assert.equal(relay.received.length, 0, 'dry run publishes nothing');
    assert.deepEqual(cal.requests, [], 'dry run never stamps');

    let run = await finalize(env);
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /accepted 1\/2 \(127\.0\.0\.1:9: connection/);
    const [pending, ...more] = of(relay, isPending);
    assert.equal(more.length, 0, 'exactly one ots-pending');
    assert.deepEqual(pending.tags, [['t', 'ag-lb'], ['t', 'ots-pending'], ['e', claim.id]]);
    assert.equal(verifyEvent(pending), true);
    assert.equal(Buffer.from(parseOts(Buffer.from(pending.content, 'base64')).msg).toString('hex'), claim.id);
    assert.deepEqual(pendingCalendars(Buffer.from(pending.content, 'base64')), [cal.url]);
    assert.ok(!of(relay, isPending).some((ev) => ev.tags.some((t) => t[1] === fresh.id)), 'a Claim under 10 min old is left to its phone');

    run = await finalize(env);
    assert.equal(of(relay, isPending).length, 1, 'the next run upgrades it instead of stamping again');
    assert.match(run.out, /upgrade \w+ not ready/);
  } finally {
    await Promise.all([relay.close(), cal.close()]);
  }
});

test('a pass where a read got no answer from any relay publishes nothing', async () => {
  const [relay, cal] = await Promise.all([startRelay('no-pendings', { drop: (f) => f['#t']?.[0] === 'ots-pending' }), startCalendar()]);
  try {
    const claimer = generateSecretKey();
    const claim = signEvent(claimTemplate(RUN, nowSec() - 900, relay.url), claimer);
    const { file } = await stampDigest(claim.id, { calendars: [cal.url] });
    for (const ev of [RUN, claim, pendingEvent(claim.id, file, claim.created_at, claimer)]) relay.stored.set(ev.id, ev);
    const requests = cal.requests.length;

    const run = await finalize({ relays: [relay.url], calendars: [cal.url], keyFile: keyFile() });
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /abort: no relay answered the ots-pending read/);
    assert.equal(relay.received.length, 0, 'no second ots-pending for a Claim whose pending could not be read');
    assert.equal(cal.requests.length, requests, 'no stamp requested');
  } finally {
    await Promise.all([relay.close(), cal.close()]);
  }
});

test('fallback stamping is capped at 20 Claims a pass; the rest wait for the next pass', async () => {
  const [relay, cal] = await Promise.all([startRelay('relay'), startCalendar()]);
  try {
    relay.stored.set(RUN.id, RUN);
    for (let i = 0; i < 23; i += 1) {
      const claim = signEvent(claimTemplate(RUN, nowSec() - 900 - i, relay.url), generateSecretKey());
      relay.stored.set(claim.id, claim);
    }
    const env = { relays: [relay.url], calendars: [cal.url], keyFile: keyFile() };
    let run = await finalize(env);
    assert.equal(run.code, 0, run.out);
    assert.equal(of(relay, isPending).length, 20);
    assert.match(run.out, /stamp: 3 more Claims over the 20-per-pass cap; next pass/);
    run = await finalize(env);
    assert.equal(of(relay, isPending).length, 23, 'the next pass stamps the rest');
  } finally {
    await Promise.all([relay.close(), cal.close()]);
  }
});

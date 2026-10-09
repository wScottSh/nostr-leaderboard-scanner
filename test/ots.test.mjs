/*
 * OpenTimestamps: the .ots format against real proofs (python-opentimestamps
 * client examples) and real calendar responses captured live from alice and
 * finney (fixtures/ots_calendar_responses.json), plus stamping, upgrading,
 * and pruning with a fake fetch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  applyOp, parseOts, serializeOts, parseTimestamp, serializeTimestamp, newStamp, merge, bitcoinHeights,
  pruneToBitcoin, stampDigest, upgradeOts, pendingTemplate, finalTemplate, CALENDARS,
} from '../src/ots.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => new Uint8Array(readFileSync(path.join(here, 'fixtures', name)));
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());

const HELLO = fx('hello-world.txt.ots');
const TWO = fx('two-calendars.txt.ots');
const LIVE = JSON.parse(readFileSync(path.join(here, 'fixtures', 'ots_calendar_responses.json'), 'utf8'));
const [ALICE, , FINNEY] = CALENDARS;

const pendingUris = (stamp) => {
  const out = [];
  const walk = (s) => {
    for (const a of s.attestations) if (a.type === 'pending') out.push(a.uri);
    s.ops.forEach((o) => walk(o.stamp));
  };
  walk(stamp);
  return out.sort();
};

// ------------------------------------------------------------- ops

test('ops: every hash op is the right hash (known answers on the empty message)', () => {
  const empty = new Uint8Array();
  assert.equal(hex(applyOp({ tag: 0x08 }, empty)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hex(applyOp({ tag: 0x02 }, empty)), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(hex(applyOp({ tag: 0x03 }, empty)), '9c1185a5c5e9fc54612808977ee8f548b2258d31');
  assert.equal(hex(applyOp({ tag: 0x67 }, empty)), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(hex(applyOp({ tag: 0xf0, arg: unhex('cd') }, unhex('ab'))), 'abcd');
  assert.equal(hex(applyOp({ tag: 0xf1, arg: unhex('cd') }, unhex('ab'))), 'cdab');
  assert.equal(hex(applyOp({ tag: 0xf2 }, unhex('0102'))), '0201');
  assert.equal(new TextDecoder().decode(applyOp({ tag: 0xf3 }, unhex('0aff'))), '0aff');
  assert.throws(() => applyOp({ tag: 0x42 }, empty), /unknown op/);
});

// ------------------------------------------------------------- real proofs

test('real complete proof: hello-world.txt.ots parses, its Bitcoin attestation is found, and it re-serializes byte for byte', () => {
  const stamp = parseOts(HELLO);
  assert.equal(hex(stamp.msg), hex(sha256(fx('hello-world.txt'))));
  assert.deepEqual(bitcoinHeights(stamp), [358391]);
  assert.equal(hex(serializeOts(stamp)), hex(HELLO));
});

test('real two-calendar pending proof: a fork, two pending attestations, byte-identical round trip', () => {
  const stamp = parseOts(TWO);
  assert.equal(hex(stamp.msg), hex(sha256(fx('two-calendars.txt'))));
  assert.deepEqual(pendingUris(stamp), ['https://alice.btc.calendar.opentimestamps.org', 'https://bob.btc.calendar.opentimestamps.org']);
  assert.equal(hex(serializeOts(stamp)), hex(TWO));
  assert.deepEqual(bitcoinHeights(stamp), []);
});

test('real calendar responses (captured live): parse to a pending attestation and re-serialize byte for byte', () => {
  for (const [cal, body] of Object.entries(LIVE.responses)) {
    const stamp = parseTimestamp(unhex(body), unhex(LIVE.digest));
    assert.deepEqual(pendingUris(stamp), [cal]);
    assert.equal(hex(serializeTimestamp(stamp)), body, cal);
  }
});

test('parse rejects a bad header, trailing bytes, and truncation', () => {
  assert.throws(() => parseOts(HELLO.slice(1)), /not an OpenTimestamps/);
  assert.throws(() => parseOts(Uint8Array.from([...HELLO, 0])), /trailing/);
  assert.throws(() => parseOts(HELLO.slice(0, -3)), /truncated/);
});

test('round trip: every op and attestation type, forks, and several attestations on one node', () => {
  const root = newStamp(sha256(new Uint8Array([1])));
  const add = (stamp, op) => {
    const child = newStamp(applyOp(op, stamp.msg));
    stamp.ops.push({ op, stamp: child });
    return child;
  };
  const a = add(add(add(root, { tag: 0xf1, arg: unhex('00112233') }), { tag: 0x02 }), { tag: 0xf3 });
  a.attestations.push({ type: 'litecoin', height: 1234567 }, { type: 'pending', uri: 'https://z.example' });
  const b = add(add(add(root, { tag: 0x03 }), { tag: 0xf2 }), { tag: 0x67 });
  b.attestations.push({ type: 'unknown', tag: unhex('0102030405060708'), payload: unhex('beef') }, { type: 'bitcoin', height: 900000 });
  add(add(root, { tag: 0xf0, arg: unhex('ff') }), { tag: 0x08 }).attestations.push({ type: 'pending', uri: 'https://a.example' });

  const bytes = serializeOts(root);
  const parsed = parseOts(bytes);
  assert.equal(hex(serializeOts(parsed)), hex(bytes));
  assert.deepEqual(bitcoinHeights(parsed), [900000]);
  assert.deepEqual(pendingUris(parsed), ['https://a.example', 'https://z.example']);
});

test('serialize sorts like python-opentimestamps: ops by tag then argument, attestations by notary tag then value', () => {
  const stamp = parseOts(TWO);
  let fork = stamp;
  while (fork.ops.length === 1) fork = fork.ops[0].stamp;
  fork.ops.reverse();
  assert.equal(hex(serializeOts(stamp)), hex(TWO), 'insertion order does not leak into the bytes');

  const root = newStamp(unhex('00'));
  for (const op of [{ tag: 0xf1, arg: unhex('00') }, { tag: 0x08 }, { tag: 0xf0, arg: unhex('02') }, { tag: 0xf0, arg: unhex('01') }, { tag: 0x03 }]) {
    const child = newStamp(applyOp(op, root.msg));
    child.attestations.push({ type: 'bitcoin', height: 1 });
    root.ops.push({ op, stamp: child });
  }
  root.attestations.push(
    { type: 'pending', uri: 'https://z.example' }, { type: 'litecoin', height: 2 }, { type: 'bitcoin', height: 9 },
    { type: 'pending', uri: 'https://a.example' }, { type: 'unknown', tag: unhex('0102030405060708'), payload: unhex('00') },
    { type: 'bitcoin', height: 3 },
  );
  const parsed = parseTimestamp(serializeTimestamp(root), root.msg);
  assert.deepEqual(parsed.ops.map(({ op }) => [op.tag, op.arg ? hex(op.arg) : null]),
    [[0x03, null], [0x08, null], [0xf0, '01'], [0xf0, '02'], [0xf1, '00']]);
  assert.deepEqual(parsed.attestations.map((a) => a.uri ?? a.height ?? a.type),
    ['unknown', 3, 9, 2, 'https://a.example', 'https://z.example']);
});

// ------------------------------------------------------------- prune

test('prune keeps every Bitcoin-attested branch and drops pending ones', () => {
  const stamp = parseOts(HELLO);
  const pendingBranch = newStamp(applyOp({ tag: 0xf0, arg: unhex('aa') }, stamp.msg));
  pendingBranch.attestations.push({ type: 'pending', uri: ALICE });
  stamp.ops.push({ op: { tag: 0xf0, arg: unhex('aa') }, stamp: pendingBranch });
  const otherChains = newStamp(applyOp({ tag: 0xf0, arg: unhex('bb') }, stamp.msg));
  otherChains.attestations.push({ type: 'litecoin', height: 5 }, { type: 'unknown', tag: unhex('0102030405060708'), payload: unhex('00') });
  stamp.ops.push({ op: { tag: 0xf0, arg: unhex('bb') }, stamp: otherChains });
  assert.notEqual(hex(serializeOts(stamp)), hex(HELLO));
  assert.equal(hex(serializeOts(pruneToBitcoin(stamp))), hex(HELLO));
  assert.equal(pruneToBitcoin(parseOts(TWO)), null, 'nothing left without Bitcoin');
});

// ------------------------------------------------------------- calendars

const response = (bytes, status = 200) => ({ ok: status === 200, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
const CLAIM_ID = 'ab'.repeat(32);
const NONCE = unhex('00112233445566778899aabbccddeeff');

async function stampLive() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith(ALICE)) return response(unhex(LIVE.responses[ALICE]));
    if (url.startsWith(FINNEY)) return response(unhex(LIVE.responses[FINNEY]));
    throw new TypeError('Failed to fetch');
  };
  return { ...(await stampDigest(CLAIM_ID, { fetchImpl, nonce: NONCE })), calls };
}

test('stamping: digest -> append 16 random bytes -> sha256 is what each calendar gets; any one success makes a proof', async () => {
  const { file, calendars, errors, calls } = await stampLive();
  const commitment = sha256(new Uint8Array([...unhex(CLAIM_ID), ...NONCE]));
  assert.deepEqual(calls.map((c) => c.url).sort(), CALENDARS.map((c) => `${c}/digest`).sort());
  for (const { init } of calls) {
    assert.equal(init.method, 'POST');
    assert.equal(hex(init.body), hex(commitment));
    assert.equal(init.headers.Accept, 'application/vnd.opentimestamps.v1');
  }
  assert.deepEqual(calendars, [ALICE, FINNEY]);
  assert.deepEqual(errors, { [CALENDARS[1]]: 'Failed to fetch' });

  const stamp = parseOts(file);
  assert.equal(hex(stamp.msg), CLAIM_ID, 'NIP-03: the digest is the event id');
  assert.deepEqual(stamp.ops.map((o) => [o.op.tag, hex(o.op.arg)]), [[0xf0, hex(NONCE)]]);
  const tip = stamp.ops[0].stamp.ops[0];
  assert.equal(tip.op.tag, 0x08);
  assert.equal(tip.stamp.ops.length, 2, 'forks into both calendars');
  assert.deepEqual(pendingUris(stamp), [ALICE, FINNEY].sort());
});

test('stamping: no calendar answering means no proof, and every error is kept', async () => {
  const fetchImpl = async (url) => (url.startsWith(ALICE) ? response(new Uint8Array([1, 2]), 500) : response(new Uint8Array([0xff])));
  const r = await stampDigest(CLAIM_ID, { fetchImpl });
  assert.equal(r.file, null);
  assert.deepEqual(r.calendars, []);
  assert.equal(r.errors[ALICE], 'HTTP 500');
  assert.match(r.errors[FINNEY], /truncated/);
});

test('upgrade: asks each of our calendars for its commitment, merges Bitcoin paths, treats failures as not yet', async () => {
  const { file } = await stampLive();
  const pending = parseOts(file);
  const leaves = [];
  const walk = (s) => {
    if (s.attestations.some((a) => a.type === 'pending')) leaves.push(s);
    s.ops.forEach((o) => walk(o.stamp));
  };
  walk(pending);
  const aliceLeaf = leaves.find((s) => s.attestations[0].uri === ALICE);

  const done = newStamp(aliceLeaf.msg);
  const block = newStamp(applyOp({ tag: 0x08 }, aliceLeaf.msg));
  block.attestations.push({ type: 'bitcoin', height: 917000 });
  done.ops.push({ op: { tag: 0x08 }, stamp: block });

  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url === `${ALICE}/timestamp/${hex(aliceLeaf.msg)}`) return response(serializeTimestamp(done));
    throw new TypeError('Failed to fetch'); // a 404 without CORS looks like this
  };
  const up = await upgradeOts(file, { fetchImpl });
  assert.equal(up.changed, true);
  assert.equal(asked.length, 2);
  assert.equal(bitcoinHeights(parseOts(up.file)).length, 1);
  const upgraded = parseOts(up.file);
  assert.deepEqual(pendingUris(upgraded), [ALICE, FINNEY].sort(), 'pending kept until the 1040 lands');

  const pruned = pruneToBitcoin(upgraded);
  assert.deepEqual(pendingUris(pruned), []);
  assert.deepEqual(bitcoinHeights(pruned), [917000]);
  assert.equal(hex(pruned.msg), CLAIM_ID);

  const again = await upgradeOts(file, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(again.changed, false);
  assert.equal(hex(again.file), hex(file));
});

const hang = () => new Promise(() => {});

test('stamping: a calendar that never answers times out as its own error; the others still make the proof', { timeout: 3000 }, async () => {
  const fetchImpl = async (url) => {
    if (url.startsWith(ALICE)) return response(unhex(LIVE.responses[ALICE]));
    if (url.startsWith(FINNEY)) return { ok: true, status: 200, arrayBuffer: hang };
    return hang();
  };
  const r = await stampDigest(CLAIM_ID, { fetchImpl, nonce: NONCE, timeoutMs: 50 });
  assert.deepEqual(r.calendars, [ALICE]);
  assert.match(r.errors[CALENDARS[1]], /no answer/);
  assert.match(r.errors[FINNEY], /no answer/, 'a stalled body times out too');
  assert.deepEqual(pendingUris(parseOts(r.file)), [ALICE]);
});

test('upgrade: a calendar that never answers is "not yet", and the others still upgrade', { timeout: 3000 }, async () => {
  const { file } = await stampLive();
  const aliceLeaf = (function find(s) {
    if (s.attestations.some((a) => a.uri === ALICE)) return s;
    for (const o of s.ops) { const f = find(o.stamp); if (f) return f; }
    return null;
  })(parseOts(file));
  const done = newStamp(aliceLeaf.msg);
  const block = newStamp(applyOp({ tag: 0x08 }, aliceLeaf.msg));
  block.attestations.push({ type: 'bitcoin', height: 917000 });
  done.ops.push({ op: { tag: 0x08 }, stamp: block });
  const fetchImpl = async (url) => (url.startsWith(ALICE) ? response(serializeTimestamp(done)) : hang());
  const up = await upgradeOts(file, { fetchImpl, timeoutMs: 50 });
  assert.equal(up.changed, true);
  assert.equal(bitcoinHeights(parseOts(up.file)).length, 1);
});

test('upgrade: never contacts a calendar outside our list', async () => {
  const stamp = parseOts(TWO);
  const asked = [];
  await upgradeOts(serializeOts(stamp), { calendars: [ALICE], fetchImpl: async (url) => { asked.push(url); throw new Error('x'); } });
  assert.equal(asked.length, 1);
  assert.ok(asked[0].startsWith(`${ALICE}/timestamp/`));
});

// ------------------------------------------------------------- carrier events

test('proof carriers: ots-pending (ag-lb family, never sm64/n) and NIP-03 kind 1040', () => {
  assert.deepEqual(pendingTemplate(CLAIM_ID, unhex('0102'), 5), {
    kind: 8064, created_at: 5, tags: [['t', 'ag-lb'], ['t', 'ots-pending'], ['e', CLAIM_ID]], content: 'AQI=',
  });
  assert.deepEqual(finalTemplate(CLAIM_ID, unhex('0102'), 'wss://r', 6), {
    kind: 1040, created_at: 6, tags: [['e', CLAIM_ID, 'wss://r'], ['k', '8064']], content: 'AQI=',
  });
  assert.equal(merge(newStamp(unhex('01')), newStamp(unhex('01'))).ops.length, 0);
  assert.throws(() => merge(newStamp(unhex('01')), newStamp(unhex('02'))), /different messages/);
});

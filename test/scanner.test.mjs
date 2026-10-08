/*
 * Scanner tests, no camera/browser/network. The keystone fixture
 * (fixtures/multiframe_fixture.json) is copied from sm64-nostr's
 * reader/test/fixtures: the REAL QR frame URLs a cabinet's C build_event()
 * emitted (2 frames). Its expected id is the same event nostr-leaderboard's
 * test/fixtures/cabinet_event.json pins, so these tests close the loop
 * ROM -> scanner -> leaderboard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  base32Decode, extractFragment, parseFragmentHeader, parseFrame, reassembleFrames,
  unpackPayload, decodeEvent, computeEventId,
} from '../src/decode.js';
import { FrameCollector } from '../src/collector.js';
import { verifyEvent, checkRun } from '../src/verify.js';
import { starBoardUrl, cabinetUrl } from '../src/links.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures', 'multiframe_fixture.json'), 'utf8'));
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));

// The event nostr-leaderboard's own test fixture holds for this capture.
const LEADERBOARD_EVENT = {
  id: '91ff8df59c339bf5c643750cdb1c7edf99c48aa9ce7879a22c9a52da7b84362f',
  pubkey: 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
  created_at: 1700000000,
  kind: 8064,
  tags: [['t', 'ag-lb'], ['t', 'sm64'], ['n', 'TEST']],
  content: '{"course":15,"act":6,"coins":100,"frames":16909060,"nonce":51966,"keyId":0}',
  sig: '0f4ba80ae33f8e8e1be408387f0e8e233ba2c7b079120e0c1286d9750375953f4f15887578cf4693a3ad4546f899e176b1253998d9fef3a8a19dbaf867f512b0',
};

// ------------------------------------------------------------- decode

test('base32Decode: RFC 4648 vectors', () => {
  const vectors = [['', ''], ['MY', 'f'], ['MZXQ', 'fo'], ['MZXW6', 'foo'], ['MZXW6YQ', 'foob'],
    ['MZXW6YTB', 'fooba'], ['MZXW6YTBOI', 'foobar']];
  for (const [enc, plain] of vectors) assert.equal(new TextDecoder().decode(base32Decode(enc)), plain);
  assert.throws(() => base32Decode('MZ1'));
});

test('fragment header: parses, and rejects malformed headers', () => {
  assert.deepEqual(parseFragmentHeader('01/02/ABC'), { index: 1, count: 2, chunk: 'ABC' });
  assert.throws(() => parseFragmentHeader('02/02/ABC'), /index 2 of 2/);
  assert.throws(() => parseFragmentHeader('0102ABC'));
  assert.throws(() => parseFragmentHeader('00/01/abc'), /base32/);
  assert.throws(() => extractFragment('https://example.com/no-hash'));
  assert.equal(parseFrame('https://example.com/menu'), null);
  assert.equal(parseFrame('WIFI:S:arcade;;'), null);
});

test('reassemble: real cabinet frames, any order, any base, duplicates', () => {
  const frames = fixture.frames.map(parseFrame);
  const fwd = reassembleFrames(frames);
  const rev = reassembleFrames([...frames].reverse().concat(frames[0]));
  assert.equal(fwd.complete, true);
  assert.equal(rev.base32Text, fwd.base32Text);
  assert.deepEqual(base32Decode(fwd.base32Text), hexToBytes(fixture.packedPayloadHex));
  const rehosted = fixture.frames[1].replace(/^[^#]*/, 'http://192.168.1.5:8065/');
  assert.equal(reassembleFrames([frames[0], parseFrame(rehosted)]).base32Text, fwd.base32Text);
});

test('reassemble: incomplete set is reported incomplete, never partial', () => {
  assert.deepEqual(reassembleFrames([parseFrame(fixture.frames[0])]), { complete: false, seen: 1, count: 2 });
});

test('reassemble: refuses to splice frames from two broadcasts', () => {
  const a = parseFrame(fixture.frames[0]);
  assert.throws(() => reassembleFrames([a, { index: 0, count: 3, chunk: 'AA' }]), /disagree/);
  assert.throws(() => reassembleFrames([a, { index: 1, count: 2, chunk: a.chunk + 'AA' }]), /two different/);
});

test('unpack: every wire field verbatim; wrong format tag / length rejected', () => {
  const bytes = hexToBytes(fixture.packedPayloadHex);
  const u = unpackPayload(bytes);
  assert.equal(u.COURSE, fixture.capture.course);
  assert.equal(u.FRAMES, fixture.capture.frames);
  assert.equal(u.NONCE16, fixture.capture.nonce16);
  assert.equal(u.PUBKEY, fixture.pubkeyHex);
  assert.equal(u.TAG, fixture.tag);
  assert.equal(u.NAME, fixture.name);
  assert.equal(u.SIG, fixture.sigHex);

  const v2 = bytes.slice();
  v2[0] = 2;
  assert.throws(() => unpackPayload(v2), /unsupported QR format 2/);
  assert.throws(() => unpackPayload(bytes.slice(0, -1)), /too short/);
  assert.throws(() => unpackPayload(Uint8Array.from([...bytes, 0])), /format says/);
});

test('decodeEvent: exactly the event nostr-leaderboard holds for this capture', () => {
  const ev = decodeEvent(hexToBytes(fixture.packedPayloadHex));
  assert.equal(ev.id, fixture.expectedIdHex);
  assert.deepEqual(ev, LEADERBOARD_EVENT);
});

// ------------------------------------------------------------- collector

test('collector: two real frames -> complete event', () => {
  const c = new FrameCollector();
  assert.deepEqual(c.add(fixture.frames[1]), { kind: 'progress', got: 1, count: 2, restarted: false });
  assert.deepEqual(c.add(fixture.frames[1]), { kind: 'ignored' });
  assert.deepEqual(c.add('https://not-a-cabinet.example/'), { kind: 'ignored' });
  const done = c.add(fixture.frames[0]);
  assert.equal(done.kind, 'complete');
  assert.equal(done.event.id, LEADERBOARD_EVENT.id);
});

test('collector: screen switches to another star mid-scan -> restarts from the new frame', () => {
  const c = new FrameCollector();
  c.add(fixture.frames[0]);
  const other = 'https://sm64nostr.pages.dev#00/03/AAAA';
  assert.deepEqual(c.add(other), { kind: 'progress', got: 1, count: 3, restarted: true });
  assert.equal(c.count, 3);
});

test('collector: frames complete but payload garbage -> error, then reset', () => {
  const c = new FrameCollector();
  const res = c.add('https://x.example/#00/01/AAAAAAAA');
  assert.equal(res.kind, 'error');
  assert.equal(c.frames.size, 0);
});

// ------------------------------------------------------------- verify

test('checkRun: real capture passes the leaderboard rules', () => {
  const r = checkRun(decodeEvent(hexToBytes(fixture.packedPayloadHex)));
  assert.equal(r.ok, true);
  assert.deepEqual(
    { eventName: r.run.eventName, course: r.run.course, keyId: r.run.keyId, frames: r.run.frames },
    { eventName: 'TEST', course: 15, keyId: 0, frames: 16909060 },
  );
});

test('checkRun: tampering is caught', () => {
  const ev = decodeEvent(hexToBytes(fixture.packedPayloadHex));
  const faster = { ...ev, content: ev.content.replace('16909060', '30') };
  assert.equal(verifyEvent(faster), false, 'id no longer matches');
  const rehashed = { ...faster, id: computeEventId(faster) };
  assert.equal(checkRun(rehashed).ok, false, 'sig no longer matches');
  assert.match(checkRun(rehashed).reason, /signature/);
});

// ------------------------------------------------------------- links

test('links: deep link matches nostr-leaderboard hash routes', () => {
  const { run } = checkRun(LEADERBOARD_EVENT);
  const base = 'https://lb.example/';
  assert.equal(cabinetUrl(run.pubkey, 'SUMMER JAM 2026', base), `${base}#/c/${run.pubkey}/SUMMER%20JAM%202026`);
  assert.equal(starBoardUrl(run, base), `${base}#/c/${run.pubkey}/TEST/15-0`);
});

// ------------------------------------------------------------- invariant

test('the Run is never signed here: only src/sign.js touches the signing API', () => {
  const dir = path.join(here, '..', 'src');
  const signing = readdirSync(dir)
    .filter((n) => n.endsWith('.js'))
    .filter((f) => /schnorr\.sign\b|\.sign\(|getPublicKey|randomSecretKey|randomPrivateKey/.test(readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(signing, ['sign.js']);
});

/*
 * Identity and signing: the "Name or nsec" field, the name rules, kind-0
 * lookup folding, and the signer's refusal to sign anything Run-shaped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { validateName, parseIdentityInput, npubOf, newestProfile, profileName, profileTemplate } from '../src/identity.js';
import { signEvent, pubkeyOf, generateSecretKey } from '../src/sign.js';
import { decodeEvent } from '../src/decode.js';
import { verifyEvent, checkRun } from '../src/verify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures', 'multiframe_fixture.json'), 'utf8'));
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
const RUN = decodeEvent(hexToBytes(fixture.packedPayloadHex));

// NIP-19 test vectors.
const NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
const NSEC_HEX = '67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa';
const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
const NPUB_HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';

// ------------------------------------------------------------- name rules

test('name rules: NFC-normalized and trimmed, measured in code points', () => {
  assert.deepEqual(validateName('  Mario  '), { ok: true, name: 'Mario' });
  assert.equal(validateName('José').name, 'José', 'combining accent composes under NFC');
  assert.equal(validateName('🍄'.repeat(32)).ok, true, '32 astral code points fit');
  assert.equal(validateName('é'.repeat(32)).ok, true);
});

test('name rules: each failure has its own message', () => {
  assert.match(validateName('   ').error, /Enter a name/);
  assert.match(validateName('🍄'.repeat(33)).error, /32 characters/);
  assert.match(validateName('Mar\u0007io').error, /control character/);
  assert.match(validateName('Mar\nio').error, /control character/);
  assert.match(validateName('nsec1hello').error, /nsec1 or npub1/);
  assert.match(validateName('NPUB1hello').error, /nsec1 or npub1/);
  assert.equal(validateName('nsec hello').ok, true, 'only the bech32 prefix is reserved');
});

// ------------------------------------------------------------- name or nsec

test('identity input: an nsec decodes to its secret key, whitespace and case forgiven', () => {
  assert.deepEqual(parseIdentityInput(NSEC), { kind: 'nsec', sk: NSEC_HEX });
  assert.deepEqual(parseIdentityInput(`  ${NSEC.toUpperCase()}\n`), { kind: 'nsec', sk: NSEC_HEX });
});

test('identity input: an npub is refused with a pointer to the nsec', () => {
  assert.deepEqual(parseIdentityInput(NPUB), {
    kind: 'invalid', error: 'That’s your public key; paste your nsec (starts with nsec1)',
  });
  assert.equal(npubOf(NPUB_HEX), NPUB);
});

test('identity input: a mangled nsec is invalid, never treated as a name', () => {
  assert.equal(parseIdentityInput(NSEC.slice(0, -1)).kind, 'invalid');
  assert.equal(parseIdentityInput(NSEC.slice(0, -1) + 'q').kind, 'invalid', 'checksum');
});

test('identity input: anything else is a name under the name rules', () => {
  assert.deepEqual(parseIdentityInput(' Luigi '), { kind: 'name', name: 'Luigi' });
  assert.equal(parseIdentityInput('').kind, 'invalid');
});

// ------------------------------------------------------------- profiles

test('kind-0 lookup: newest validly signed profile wins; forged or foreign ones are ignored', () => {
  const sk = generateSecretKey();
  const pk = pubkeyOf(sk);
  const old = signEvent(profileTemplate('Old', 100), sk);
  const cur = signEvent(profileTemplate('Current', 200), sk);
  const forged = { ...signEvent(profileTemplate('Forged', 300), sk), content: '{"name":"Thief"}' };
  const other = signEvent(profileTemplate('Other', 400), generateSecretKey());
  assert.equal(newestProfile([old, forged, cur, other], pk), cur);
  assert.equal(profileName(cur), 'Current');
  assert.equal(profileName({ content: '{"display_name":"Disp"}' }), 'Disp');
  assert.equal(profileName({ content: 'not json' }), null);
  assert.equal(newestProfile([], pk), null);
});

// ------------------------------------------------------------- signer

test('signer: refuses anything a leaderboard could parse as a Run', () => {
  const template = { kind: RUN.kind, created_at: RUN.created_at, tags: RUN.tags, content: RUN.content };
  assert.equal(checkRun(RUN).ok, true, 'the fixture is a Run');
  const sk = generateSecretKey();
  assert.throws(() => signEvent(template, sk), /refusing to sign a Run/);
  assert.throws(() => signEvent({ ...template, tags: [['t', 'ag-lb'], ['t', 'claim'], ['t', 'sm64']] }, sk), /Run/);
  assert.throws(() => signEvent({ ...template, tags: [['t', 'ag-lb'], ['t', 'claim'], ['n', 'X']] }, sk), /Run/);
  assert.throws(() => signEvent({ ...template, tags: [['t', 'ag-lb']] }, sk), /neither a Claim/);
  assert.throws(() => signEvent({ kind: 1, created_at: 1, tags: [], content: 'hi' }, sk), /kind 1/);
});

test('signer: signs the player’s own events with valid BIP-340 signatures', () => {
  const sk = NSEC_HEX;
  for (const t of [
    profileTemplate('Mario', 1),
    { kind: 8064, created_at: 2, tags: [['t', 'ag-lb'], ['t', 'claim']], content: '' },
    { kind: 8064, created_at: 3, tags: [['t', 'ag-lb'], ['t', 'ots-pending']], content: 'AA==' },
    { kind: 1040, created_at: 4, tags: [['k', '8064']], content: 'AA==' },
  ]) {
    const ev = signEvent(t, sk);
    assert.equal(ev.pubkey, pubkeyOf(sk));
    assert.equal(verifyEvent(ev), true, `kind ${t.kind} verifies`);
  }
});

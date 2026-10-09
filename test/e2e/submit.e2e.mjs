/*
 * End-to-end Submit in headless Chromium against throwaway local relays.
 *
 *   npm run e2e        (CHROME=<path> to use another Chromium)
 *
 * Builds the page with SCANNER_RELAYS / SCANNER_INDEXERS / SCANNER_CALENDARS
 * pointing at two local relays and a fake OpenTimestamps calendar started
 * here, so nothing leaves this machine (asserted: every socket and request
 * the page opens is local). The last step closes the page right after
 * Submit and runs the finalizer against the same relay and calendar.
 * dist/ is rebuilt with the real lists on the way out.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

import { decodeEvent } from '../../src/decode.js';
import { signEvent, generateSecretKey, pubkeyOf } from '../../src/sign.js';
import { profileTemplate, npubOf } from '../../src/identity.js';
import { parseOts, bitcoinHeights } from '../../src/ots.js';
import { verifyEvent } from '../../src/verify.js';
import { startRelay } from '../support/relay.mjs';
import { startCalendar } from '../support/calendar.mjs';
import { runFinalizer } from '../support/finalizer.mjs';
import { bech32 } from '@scure/base';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = JSON.parse(readFileSync(path.join(root, 'test', 'fixtures', 'multiframe_fixture.json'), 'utf8'));
const packed = Uint8Array.from(Buffer.from(fixture.packedPayloadHex, 'hex'));
const RUN = decodeEvent(packed);
const CHROME = process.env.CHROME ?? path.join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const log = (...a) => console.log('  ', ...a);

// ------------------------------------------------------------- the page

function serveDist() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
  const server = createServer((req, res) => {
    const file = path.join(root, 'dist', new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html'));
    if (!file.startsWith(path.join(root, 'dist')) || !existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes) {
  let out = '';
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buf >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buf &= 0xff;
  }
  if (bits) out += BASE32[(buf << (5 - bits)) & 31];
  return out;
}
const singleFrameUrl = (base, bytes) => `${base}#00/01/${base32(bytes)}`;

async function waitFor(what, fn, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const kindsAt = (relay) => relay.received.map(({ ev }) =>
  (ev.kind === 8064 ? `8064:${ev.tags.filter((t) => t[0] === 't').map((t) => t[1]).slice(1).join('+')}` : String(ev.kind)));

// ------------------------------------------------------------- run

const relay = await startRelay('relay', {
  // The first copy of the Run is refused the way a relay with a NIP-11 created_at_lower_limit would.
  reject: (ev, attempt) => (ev.id === RUN.id && attempt === 1 ? 'invalid: created_at too early' : null),
});
const indexer = await startRelay('indexer');
const calendar = await startCalendar({ delayMs: 1500 });

// A player who already has a Nostr key and a name on the indexer.
const otherSk = generateSecretKey();
const otherProfile = signEvent(profileTemplate('Peach', 1700000000), otherSk);
indexer.stored.set(otherProfile.id, otherProfile);
const otherNsec = bech32.encode('nsec', bech32.toWords(Buffer.from(otherSk, 'hex')));

const build = spawnSync('node', ['scripts/build.mjs'], {
  cwd: root, encoding: 'utf8', env: { ...process.env, SCANNER_RELAYS: relay.url, SCANNER_INDEXERS: indexer.url, SCANNER_CALENDARS: calendar.url },
});
assert.equal(build.status, 0, build.stderr);
log(build.stdout.trim().split('\n')[0]);

const { server, url: base } = await serveDist();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const sockets = [];
const requests = [];
const errors = [];
const newPage = async (context) => {
  const page = await context.newPage();
  page.on('websocket', (ws) => sockets.push(ws.url()));
  page.on('request', (req) => requests.push(req.url()));
  page.on('pageerror', (e) => errors.push(e.message));
  return page;
};

try {
  const context = await browser.newContext();
  const page = await newPage(context);
  console.log('1. new player: a name, then Submit');
  await page.goto(singleFrameUrl(base, packed));
  await page.getByText('Submit as').waitFor();
  assert.equal(await page.locator('#submit').isDisabled(), true, 'Submit disabled while the field is empty');
  assert.equal(relay.received.length, 0, 'nothing published before Submit');
  await page.locator('#ident').fill('npub1abc');
  await page.getByText('That’s your public key; paste your nsec (starts with nsec1)').waitFor();
  assert.equal(await page.locator('#submit').isDisabled(), true, 'Submit disabled for an npub');
  await page.locator('#ident').fill('Mario');
  await page.locator('#submit').click();

  const pendingAt = (r) => r.received.find(({ ev }) => ev.tags.some((t) => t[0] === 't' && t[1] === 'ots-pending'));
  await waitFor('kind-0, Run, Claim, and ots-pending at the relay', () => pendingAt(relay) && relay.received.length >= 4, 45000);
  const runMsg = relay.received.find(({ ev }) => ev.id === RUN.id);
  assert.equal(runMsg.text, JSON.stringify(['EVENT', RUN]), 'the Run went out byte-identical to the decoded fixture');
  const profile = relay.received.find(({ ev }) => ev.kind === 0).ev;
  assert.equal(JSON.parse(profile.content).name, 'Mario');
  const claim = relay.received.find(({ ev }) => ev.tags.some((t) => t[1] === 'claim')).ev;
  assert.deepEqual(claim.tags, [['t', 'ag-lb'], ['t', 'claim'], ['e', RUN.id, relay.url, RUN.pubkey], ['p', RUN.pubkey], ['sig', RUN.sig]]);
  assert.equal(claim.pubkey, profile.pubkey);
  const pending = pendingAt(relay).ev;
  assert.deepEqual(pending.tags, [['t', 'ag-lb'], ['t', 'ots-pending'], ['e', claim.id]]);
  assert.equal(pending.pubkey, claim.pubkey);
  assert.deepEqual(kindsAt(indexer), ['0'], 'the indexer only gets the kind-0');
  log('relay got:', kindsAt(relay).join(', '));
  log('ots-pending content bytes:', Buffer.from(pending.content, 'base64').length);

  console.log('2. the relay refused the Run once: its reason shows verbatim, Retry failed resends only that');
  await page.getByText('invalid: created_at too early').waitFor();
  await page.getByText('Not saved yet: no relay accepted the Run').waitFor();
  const before = relay.received.length;
  await page.getByRole('button', { name: 'Retry failed' }).click();
  await page.getByText('Done. You can close this page. Your Bitcoin timestamp finishes on its own in a few hours.').waitFor();
  assert.deepEqual(relay.received.slice(before).map(({ ev }) => ev.id), [RUN.id], 'retry resent only the failed pair');
  const otsLine = await page.locator('#ots-status').textContent();
  log('ots line:', otsLine);
  assert.match(otsLine, /Timestamp requested at/);

  console.log('3. reload: the key is remembered and My claims lists the Claim');
  const tampered = packed.slice();
  tampered[3] = 99; // a different (badly signed) run, so the Submit screen shows instead of the stored record
  await page.goto(singleFrameUrl(base, tampered));
  await page.reload();
  await page.getByRole('button', { name: 'Mario · Submit' }).waitFor();
  log('remembered:', await page.getByRole('button', { name: 'Mario · Submit' }).textContent());
  await page.goto(base);
  await page.getByRole('button', { name: 'My claims (1)' }).click();
  await page.locator('.claim').getByText('Rainbow Ride').waitFor();
  const card = await page.locator('.claim').innerText();
  log('my claims:', card.replace(/\s+/g, ' '));
  assert.match(card, /Submitted\./);
  assert.match(card, /Timestamp requested at/);
  assert.equal(await page.getByText('Download proof').count(), 0, 'the proof lives on Nostr, not in a download');
  const proof = parseOts(Buffer.from(pending.content, 'base64'));
  assert.equal(Buffer.from(proof.msg).toString('hex'), claim.id, 'the published ots-pending stamps the Claim id');

  console.log('4. re-scanning the claimed Run opens the stored record; no new Claim');
  const sent = relay.received.length;
  await page.goto(singleFrameUrl(base, packed));
  await page.getByText('Claimed as').waitFor();
  await page.waitForTimeout(500);
  assert.equal(relay.received.length, sent, 'nothing re-sent on re-scan');

  console.log('4b. Change name, then Retry on the already-claimed Run: the new kind-0 goes out');
  await page.goto(singleFrameUrl(base, tampered));
  await page.reload();
  await page.getByRole('button', { name: 'Change name' }).click();
  await page.locator('#rename').fill('Wario');
  await page.getByRole('button', { name: 'Save name' }).click();
  await page.getByRole('button', { name: 'Wario · Submit' }).waitFor();
  await page.goto(singleFrameUrl(base, packed));
  await page.reload();
  await page.getByText('Claimed as').waitFor();
  const beforeRename = relay.received.length;
  await page.getByRole('button', { name: 'Retry failed' }).click();
  const renamedAt = (r) => r.received.some(({ ev }) => ev.kind === 0 && JSON.parse(ev.content).name === 'Wario');
  await waitFor('the renamed kind-0 at the relay and the indexer', () => renamedAt(relay) && renamedAt(indexer), 15000);
  assert.deepEqual(relay.received.slice(beforeRename).map(({ ev }) => ev.kind), [0], 'only the new kind-0 was sent');
  log('renamed kind-0 published on Retry');

  console.log('5. pasted nsec on a fresh phone: name from the indexer, no kind-0 published');
  const phone2 = await newPage(await browser.newContext());
  await phone2.goto(singleFrameUrl(base, packed));
  await phone2.locator('#ident').fill(otherNsec);
  await phone2.getByText('✓ Peach').waitFor();
  const before2 = relay.received.length;
  await phone2.locator('#submit').click();
  await phone2.getByText('Claimed as').waitFor();
  await waitFor('the second Claim', () => relay.received.slice(before2).some(({ ev }) => ev.pubkey === pubkeyOf(otherSk)), 15000);
  await phone2.waitForTimeout(1000);
  assert.ok(!relay.received.some(({ ev }) => ev.kind === 0 && ev.pubkey === pubkeyOf(otherSk)), 'no kind-0 for a pasted key');
  assert.ok(!indexer.received.some(({ ev }) => ev.pubkey === pubkeyOf(otherSk)));
  log('claimed as:', (await phone2.locator('#live p').first().textContent()).replace(/\s+/g, ' ').trim(), `(${npubOf(pubkeyOf(otherSk)).slice(0, 12)}…)`);

  console.log('6. walk away: a new player closes the page the moment Done shows; the finalizer finishes the proof');
  const context3 = await browser.newContext();
  const phone3 = await newPage(context3);
  await phone3.goto(singleFrameUrl(base, packed));
  await phone3.locator('#ident').fill('Toad');
  await phone3.locator('#submit').click();
  await phone3.getByText('Saving… keep this page open a few seconds.').waitFor();
  await phone3.getByText('Done. You can close this page. Your Bitcoin timestamp finishes on its own in a few hours.').waitFor({ timeout: 30000 });
  await context3.close();
  const toad = relay.received.find(({ ev }) => ev.kind === 0 && JSON.parse(ev.content).name === 'Toad').ev.pubkey;
  const toadClaim = relay.received.find(({ ev }) => ev.pubkey === toad && ev.tags.some((t) => t[1] === 'claim')).ev;
  assert.ok(relay.received.some(({ ev }) => ev.pubkey === toad && ev.tags.some((t) => t[1] === 'ots-pending')), 'the ots-pending was on the relay before Done');
  log('page closed; claim', toadClaim.id.slice(0, 12));

  calendar.mine(917000);
  const finals = () => [...relay.stored.values()].filter((ev) => ev.kind === 1040 && ev.tags.some((t) => t[0] === 'e' && t[1] === toadClaim.id));
  const env = { relays: [relay.url], calendars: [calendar.url], keyFile: path.join(mkdtempSync(path.join(tmpdir(), 'finalizer-')), 'key.hex') };
  const first = await runFinalizer(env);
  assert.equal(first.code, 0, first.out);
  first.out.trim().split('\n').forEach((l) => log('finalizer:', l));
  const second = await runFinalizer(env);
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /upgrade=0 stamp=0/, 'second run has nothing to do');
  const [final, ...extra] = finals();
  assert.equal(extra.length, 0, 'exactly one 1040 for the Claim');
  assert.equal(verifyEvent(final), true);
  const finalProof = parseOts(Buffer.from(final.content, 'base64'));
  assert.equal(Buffer.from(finalProof.msg).toString('hex'), toadClaim.id, '1040 stamps the Claim id');
  assert.deepEqual(bitcoinHeights(finalProof), [917000]);
  log(`1040 ${final.id.slice(0, 12)} for the closed page's Claim: Bitcoin block ${bitcoinHeights(finalProof)[0]}`);

  const foreign = [...sockets, ...requests].filter((u) => !/^(ws|http):\/\/127\.0\.0\.1:/.test(u));
  assert.deepEqual(foreign, [], 'the page only ever talked to this machine');
  assert.deepEqual(errors, [], 'no page errors');
  log(`sockets opened: ${sockets.length}, requests: ${requests.length}, all local`);
  console.log('e2e: all checks passed');
} finally {
  await browser.close();
  server.close();
  await Promise.all([relay.close(), indexer.close(), calendar.close()]);
  const env = { ...process.env };
  delete env.SCANNER_RELAYS;
  delete env.SCANNER_INDEXERS;
  delete env.SCANNER_CALENDARS;
  spawnSync('node', ['scripts/build.mjs'], { cwd: root, env });
}

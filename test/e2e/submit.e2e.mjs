/*
 * End-to-end Submit in headless Chromium against throwaway local relays.
 *
 *   npm run e2e        (CHROME=<path> to use another Chromium)
 *
 * Builds the page with SCANNER_RELAYS / SCANNER_INDEXERS pointing at two
 * local relays started here, so nothing reaches a public relay (asserted:
 * every WebSocket the page opens is local). OpenTimestamps calendars are
 * the real ones. dist/ is rebuilt with the real relays on the way out.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright-core';

import { decodeEvent } from '../../src/decode.js';
import { signEvent, generateSecretKey, pubkeyOf } from '../../src/sign.js';
import { profileTemplate, npubOf } from '../../src/identity.js';
import { parseOts, serializeOts, otsStatus } from '../../src/ots.js';
import { bech32 } from '@scure/base';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = JSON.parse(readFileSync(path.join(root, 'test', 'fixtures', 'multiframe_fixture.json'), 'utf8'));
const packed = Uint8Array.from(Buffer.from(fixture.packedPayloadHex, 'hex'));
const RUN = decodeEvent(packed);
const CHROME = process.env.CHROME ?? path.join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const log = (...a) => console.log('  ', ...a);

// ------------------------------------------------------------- a throwaway relay

/** NIP-01 relay in memory. reject(ev, attempt) may return a rejection message. */
function startRelay(name, { reject = () => null } = {}) {
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
        const [, sub, filter] = msg;
        for (const ev of relay.stored.values()) {
          if ((!filter.kinds || filter.kinds.includes(ev.kind)) && (!filter.authors || filter.authors.includes(ev.pubkey))) {
            ws.send(JSON.stringify(['EVENT', sub, ev]));
          }
        }
        ws.send(JSON.stringify(['EOSE', sub]));
      }
    });
  });
  return new Promise((resolve) => wss.on('listening', () => {
    relay.url = `ws://127.0.0.1:${wss.address().port}`;
    resolve(relay);
  }));
}

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

// A player who already has a Nostr key and a name on the indexer.
const otherSk = generateSecretKey();
const otherProfile = signEvent(profileTemplate('Peach', 1700000000), otherSk);
indexer.stored.set(otherProfile.id, otherProfile);
const otherNsec = bech32.encode('nsec', bech32.toWords(Buffer.from(otherSk, 'hex')));

const build = spawnSync('node', ['scripts/build.mjs'], {
  cwd: root, encoding: 'utf8', env: { ...process.env, SCANNER_RELAYS: relay.url, SCANNER_INDEXERS: indexer.url },
});
assert.equal(build.status, 0, build.stderr);
log(build.stdout.trim().split('\n')[0]);

const { server, url: base } = await serveDist();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const sockets = [];
const errors = [];
const newPage = async (context) => {
  const page = await context.newPage();
  page.on('websocket', (ws) => sockets.push(ws.url()));
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
  await page.getByText('Not submitted yet').waitFor();
  const before = relay.received.length;
  await page.getByRole('button', { name: 'Retry failed' }).click();
  await page.getByText('Submitted.').waitFor();
  assert.deepEqual(relay.received.slice(before).map(({ ev }) => ev.id), [RUN.id], 'retry resent only the failed pair');
  const otsLine = await page.locator('#ots-status').textContent();
  log('ots line:', otsLine);
  assert.match(otsLine, /Timestamp pending at/);

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
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download proof (.ots)' }).click()]);
  const proof = parseOts(new Uint8Array(readFileSync(await download.path())));
  assert.equal(Buffer.from(proof.msg).toString('hex'), claim.id, 'the downloaded proof stamps the Claim id');
  assert.equal(Buffer.from(serializeOts(proof)).toString('base64'), pending.content, 'and matches the published ots-pending');
  log(`downloaded ${download.suggestedFilename()}: stamps the Claim id; status ${otsStatus(pending.content)}`);

  console.log('4. re-scanning the claimed Run opens the stored record; no new Claim');
  const sent = relay.received.length;
  await page.goto(singleFrameUrl(base, packed));
  await page.getByText('Claimed as').waitFor();
  await page.waitForTimeout(500);
  assert.equal(relay.received.length, sent, 'nothing re-sent on re-scan');

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

  const foreign = sockets.filter((u) => !u.startsWith('ws://127.0.0.1:'));
  assert.deepEqual(foreign, [], 'the page only ever opened local relay sockets');
  assert.deepEqual(errors, [], 'no page errors');
  log(`sockets opened: ${sockets.length}, all local`);
  console.log('e2e: all checks passed');
} finally {
  await browser.close();
  server.close();
  relay.wss.close();
  indexer.wss.close();
  const env = { ...process.env };
  delete env.SCANNER_RELAYS;
  delete env.SCANNER_INDEXERS;
  spawnSync('node', ['scripts/build.mjs'], { cwd: root, env });
}

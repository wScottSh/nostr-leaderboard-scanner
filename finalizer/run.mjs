#!/usr/bin/env node
/*
 * The finalizer: one pass over the leaderboard relays that finishes every
 * recent Claim's Bitcoin timestamp, so a player can Submit and walk away.
 *
 *   node finalizer/run.mjs [--dry-run]
 *
 * Relays are the only state. Each pass reads the last week's Claims,
 * ots-pending carriers and NIP-03 kind-1040s, then per Claim (src/finalize.js):
 * stamps it if no proof was ever published, upgrades its pending proof at
 * the calendars and publishes the 1040 once ready, or does nothing. A second
 * pass right after finds the 1040 and publishes nothing.
 *
 * FINALIZER_KEY_FILE   hex secret key that signs the 1040s and fallback
 *                      ots-pendings; created (0600) if missing. Default ./finalizer.key
 *                      Only 1040s signed by this key mark a Claim done.
 * FINALIZER_RELAYS, FINALIZER_CALENDARS   comma-separated overrides, for tests only.
 *
 * --dry-run prints each decision, asks the calendars (GET only), and
 * publishes, stamps and writes nothing. It reads the key if there is one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { RELAYS as DEFAULT_RELAYS, queryRelays, publishPairs } from '../src/relay.js';
import { CALENDARS as DEFAULT_CALENDARS, stampDigest, upgradeOts } from '../src/ots.js';
import { generateSecretKey, pubkeyOf } from '../src/sign.js';
import {
  indexEvents, decide, mergeFiles, pendingCalendars, readiness, finalEvent, pendingEvent, runIdOf, STAMPS_PER_PASS,
} from '../src/finalize.js';

const DAY = 86400;
const WINDOW = 7 * DAY;
const ID_CHUNK = 100;
const CONCURRENCY = 8;
const READ = { timeoutMs: 15_000 };

const list = (env, fallback) => (process.env[env] ? process.env[env].split(',').map((s) => s.trim()).filter(Boolean) : fallback);
const RELAYS = list('FINALIZER_RELAYS', DEFAULT_RELAYS);
const CALENDARS = list('FINALIZER_CALENDARS', DEFAULT_CALENDARS);
const dryRun = process.argv.includes('--dry-run');
const nowSec = () => Math.floor(Date.now() / 1000);
const short = (id) => id.slice(0, 12);
const host = (u) => new URL(u).host;
const log = (...parts) => console.log(parts.join(' '));

/** The key in file, or null if there is none yet. */
function readKey(file) {
  try {
    const sk = readFileSync(file, 'utf8').trim();
    pubkeyOf(sk);
    return sk;
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`${file}: ${e.message}`);
    return null;
  }
}

function loadKey(file) {
  const existing = readKey(file);
  if (existing) return existing;
  const sk = generateSecretKey();
  writeFileSync(file, `${sk}\n`, { mode: 0o600, flag: 'wx' });
  log('key: created', file);
  return sk;
}

const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * One REQ to every relay -> its events, or null when no relay reached EOSE.
 * Acting on a read nobody answered would republish what is already there.
 */
async function read(what, filter) {
  const { events, answered } = await queryRelays(RELAYS, filter, READ);
  if (answered) return events;
  log(`abort: no relay answered the ${what} read; publishing nothing this pass`);
  return null;
}

/** Every recent Claim's entry, or null if any read went unanswered. */
async function readRelays(now, pubkey) {
  const recent = await Promise.all([
    read('claim', { kinds: [8064], '#t': ['claim'], since: now - WINDOW }),
    read('ots-pending', { kinds: [8064], '#t': ['ots-pending'], since: now - WINDOW }),
    read('1040', { kinds: [1040], '#k': ['8064'], since: now - WINDOW - DAY }),
  ]);
  if (recent.includes(null)) return null;
  const first = [...indexEvents(recent.flat()).values()].filter((entry) => decide(entry, now, pubkey).kind !== 'done');
  // Some relays don't index #k: ask for the 1040s of every Claim not yet done by #e too.
  const open = first.filter((entry) => entry.claim).map((entry) => entry.claim.id);
  // A Claim with no proof yet is stamped only if the Run it names is on the relays.
  const runIds = [...new Set(first.filter((entry) => entry.claim && !entry.pendings.length).map((entry) => runIdOf(entry.claim)))];
  const more = await Promise.all([
    ...chunks(open, ID_CHUNK).map((ids) => read('1040 by #e', { kinds: [1040], '#e': ids })),
    ...chunks(runIds, ID_CHUNK).map((ids) => read('run', { kinds: [8064], ids })),
  ]);
  if (more.includes(null)) return null;
  return indexEvents([...recent.flat(), ...more.flat()]);
}

/** Publishes one event everywhere -> "accepted k/n" for the log. */
async function publish(event) {
  const results = await publishPairs(RELAYS.map((relay) => ({ event, relay })));
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok).map((r) => `${host(r.relay)}: ${r.message}`);
  return `accepted ${ok.length}/${RELAYS.length}${failed.length ? ` (${failed.join('; ')})` : ''}`;
}

async function stamp(claimId, now, sk) {
  if (dryRun) return log('stamp', short(claimId), 'dry-run: would stamp at', CALENDARS.map(host).join(','));
  const { file, calendars, errors } = await stampDigest(claimId, { calendars: CALENDARS });
  const errs = Object.entries(errors).map(([c, m]) => `${host(c)}: ${m}`).join('; ');
  if (!file) return log('stamp', short(claimId), 'failed:', errs);
  const event = pendingEvent(claimId, file, now, sk);
  log('stamp', short(claimId), `at ${calendars.map(host).join(',')}${errs ? ` (failed ${errs})` : ''};`,
    'ots-pending', short(event.id), await publish(event));
}

async function upgrade(claimId, entry, files, now, sk) {
  const merged = mergeFiles(files);
  const { file } = await upgradeOts(merged, { calendars: CALENDARS });
  const { ready, attested, waiting } = readiness(file, pendingCalendars(merged), entry.claim.created_at, now);
  const status = `bitcoin: ${attested.map(host).join(',') || 'none'}; waiting: ${waiting.map(host).join(',') || 'none'}`;
  if (!ready) return log('upgrade', short(claimId), 'not ready;', status);
  if (dryRun) return log('upgrade', short(claimId), 'dry-run: would publish 1040;', status);
  const event = finalEvent(claimId, file, RELAYS[0], now, sk);
  log('upgrade', short(claimId), `1040 ${short(event.id)};`, status + ';', await publish(event));
}

async function main() {
  const now = nowSec();
  const keyFile = process.env.FINALIZER_KEY_FILE ?? 'finalizer.key';
  const sk = dryRun ? readKey(keyFile) : loadKey(keyFile);
  const pubkey = sk && pubkeyOf(sk);
  const entries = await readRelays(now, pubkey);
  if (!entries) return;
  const decisions = [...entries].map(([id, entry]) => ({ id, entry, decision: decide(entry, now, pubkey) }));
  const count = (k) => decisions.filter((d) => d.decision.kind === k).length;
  log(`${dryRun ? 'dry-run ' : ''}relays=${RELAYS.map(host).join(',')}`, `claims=${entries.size}`,
    `done=${count('done')} upgrade=${count('upgrade')} stamp=${count('stamp')} skip=${count('skip')}`,
    `key=${pubkey ? pubkey.slice(0, 12) : 'none (no 1040 counts as ours)'}`);
  for (const { id, entry, decision } of decisions) {
    const age = entry.claim && now - entry.claim.created_at;
    if (age > WINDOW - DAY && decision.kind !== 'done') {
      log('expiring', short(id), `${Math.floor(age / 3600)} h old, no 1040 yet; leaves the 7-day window in ${Math.ceil((WINDOW - age) / 3600)} h`);
    }
  }
  const stamps = decisions.filter((d) => d.decision.kind === 'stamp').sort((a, b) => a.entry.claim.created_at - b.entry.claim.created_at);
  const deferred = new Set(stamps.slice(STAMPS_PER_PASS));
  if (deferred.size) log(`stamp: ${deferred.size} more Claims over the ${STAMPS_PER_PASS}-per-pass cap; next pass`);
  const queue = decisions.filter((d) => !deferred.has(d));
  const worker = async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      const { id, entry, decision } = d;
      if (decision.kind === 'stamp') await stamp(id, now, sk);
      else if (decision.kind === 'upgrade') await upgrade(id, entry, decision.files, now, sk);
      else if (dryRun) log(decision.kind, short(id), decision.reason ?? '');
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

main().then(() => process.exit(0), (e) => {
  console.error('finalizer bug:', e.stack || e);
  process.exit(1);
});

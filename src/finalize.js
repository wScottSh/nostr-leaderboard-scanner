/*
 * finalize.js -- what the finalizer does for each Claim, decided from relay
 * events alone. Pure: no sockets, no clocks, no calendars (finalizer/run.mjs
 * is the shell).
 *
 * Entry = { claim: Event|null, pendings: Pending[], finals: Event[] }   per Claim id; finals from any author
 * Pending = { event, stamp }   an ots-pending carrier and its parsed proof
 * Decision = { kind: 'done' } | { kind: 'stamp' } | { kind: 'upgrade', files: Uint8Array[] }
 *          | { kind: 'skip', reason }
 *
 * Every event is checked here, at the boundary: a valid id and signature and
 * the exact tag shape the scanner writes. Anything else is dropped.
 */
import { bytesToHex } from '@noble/hashes/utils.js';
import { verifyEvent } from './verify.js';
import { signEvent } from './sign.js';
import {
  parseOts, serializeOts, merge, pruneToBitcoin, bitcoinHeights, bitcoinCalendars, finalTemplate, pendingTemplate, decodeFile,
} from './ots.js';

export const STAMP_AFTER_S = 120;
export const PARTIAL_AFTER_S = 12 * 3600;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const isTag = (tag, ...want) => Array.isArray(tag) && tag.length === want.length
  && want.every((w, i) => (w instanceof RegExp ? typeof tag[i] === 'string' && w.test(tag[i]) : tag[i] === w));
const ANY = /^/;

/** The proof inside content, if it stamps digestHex; else null. */
function proofFor(content, digestHex) {
  try {
    const stamp = parseOts(decodeFile(content));
    return bytesToHex(stamp.msg) === digestHex ? stamp : null;
  } catch {
    return null;
  }
}

/** A Claim exactly as the scanner signs it -> its id; else null. */
export function parseClaim(ev) {
  if (ev?.kind !== 8064 || !verifyEvent(ev)) return null;
  const [t1, t2, e, p, sig, ...rest] = ev.tags;
  const ok = !rest.length && isTag(t1, 't', 'ag-lb') && isTag(t2, 't', 'claim')
    && isTag(e, 'e', HEX64, ANY, HEX64) && isTag(p, 'p', HEX64) && isTag(sig, 'sig', HEX128);
  return ok ? ev.id : null;
}

/** An ots-pending carrier whose proof stamps the Claim it names -> { claimId, stamp }; else null. */
export function parsePending(ev) {
  if (ev?.kind !== 8064 || !verifyEvent(ev)) return null;
  const [t1, t2, e, ...rest] = ev.tags;
  if (rest.length || !isTag(t1, 't', 'ag-lb') || !isTag(t2, 't', 'ots-pending') || !isTag(e, 'e', HEX64)) return null;
  const stamp = proofFor(ev.content, e[1]);
  return stamp && { claimId: e[1], stamp };
}

/** A NIP-03 kind-1040 for a Claim carrying a Bitcoin attestation of its id -> claimId; else null. */
export function parseFinal(ev) {
  if (ev?.kind !== 1040 || !verifyEvent(ev)) return null;
  const e = ev.tags.filter((t) => t[0] === 'e');
  const k = ev.tags.filter((t) => t[0] === 'k');
  if (e.length !== 1 || k.length !== 1 || !isTag(k[0], 'k', '8064')) return null;
  if (!isTag(e[0], 'e', HEX64) && !isTag(e[0], 'e', HEX64, ANY)) return null;
  const stamp = proofFor(ev.content, e[0][1]);
  return stamp && bitcoinHeights(stamp).length ? e[0][1] : null;
}

/** Relay events (any mix, duplicates fine) -> Map<claimId, Entry>. */
export function indexEvents(events) {
  const entries = new Map();
  const seen = new Set();
  const entry = (id) => {
    if (!entries.has(id)) entries.set(id, { claim: null, pendings: [], finals: [] });
    return entries.get(id);
  };
  for (const ev of events) {
    if (!ev || seen.has(ev.id)) continue;
    seen.add(ev.id);
    const claimId = parseClaim(ev);
    if (claimId) {
      entry(claimId).claim = ev;
      continue;
    }
    const pending = parsePending(ev);
    if (pending) {
      entry(pending.claimId).pendings.push({ event: ev, stamp: pending.stamp });
      continue;
    }
    const finalFor = parseFinal(ev);
    if (finalFor) entry(finalFor).finals.push(ev);
  }
  return entries;
}

/**
 * finalizerPubkey: only this finalizer's own 1040s make a Claim done. Nobody
 * here checks a 1040's Bitcoin block header, so anyone else's could be a
 * forgery published to stop the Claim from ever being finalized.
 */
export function decide(entry, nowSec, finalizerPubkey) {
  if (entry.finals.some((ev) => ev.pubkey === finalizerPubkey)) return { kind: 'done' };
  if (!entry.claim) return { kind: 'skip', reason: 'claim not found' };
  if (entry.pendings.length) return { kind: 'upgrade', files: entry.pendings.map((p) => serializeOts(p.stamp)) };
  if (nowSec - entry.claim.created_at > STAMP_AFTER_S) return { kind: 'stamp' };
  return { kind: 'skip', reason: 'claim too new to stamp' };
}

/** Every pending proof for one Claim folded into one. */
export function mergeFiles(files) {
  const [first, ...rest] = files.map(parseOts);
  for (const stamp of rest) merge(first, stamp);
  return serializeOts(first);
}

/** Calendars a proof is waiting on (its pending attestations). */
export function pendingCalendars(fileBytes) {
  const uris = new Set();
  const walk = (s) => {
    for (const a of s.attestations) if (a.type === 'pending') uris.add(a.uri);
    for (const { stamp } of s.ops) walk(stamp);
  };
  walk(parseOts(fileBytes));
  return [...uris];
}

/**
 * Whether an upgraded proof is ready for its 1040: every calendar that
 * stamped the Claim attests in Bitcoin, or the Claim is over 12 h old and at
 * least one does. The leaderboard compares k-of-n calendar times, so an
 * early 1040 would throw the late calendars' times away; 12 h past the
 * Claim is long enough for any live calendar.
 */
export function readiness(upgradedBytes, calendars, claimCreatedAt, nowSec) {
  const done = bitcoinCalendars(parseOts(upgradedBytes));
  const attested = calendars.filter((c) => done.includes(c));
  const waiting = calendars.filter((c) => !done.includes(c));
  const ready = attested.length > 0 && (!waiting.length || nowSec - claimCreatedAt >= PARTIAL_AFTER_S);
  return { ready, attested, waiting };
}

/** The NIP-03 kind-1040 for a Claim: Bitcoin paths only, signed by the finalizer. */
export function finalEvent(claimId, upgradedBytes, relayHint, nowSec, skHex) {
  const pruned = serializeOts(pruneToBitcoin(parseOts(upgradedBytes)));
  return signEvent(finalTemplate(claimId, pruned, relayHint, nowSec), skHex);
}

/** The ots-pending carrier for a proof the finalizer stamped itself. */
export const pendingEvent = (claimId, fileBytes, nowSec, skHex) => signEvent(pendingTemplate(claimId, fileBytes, nowSec), skHex);

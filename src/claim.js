/*
 * claim.js -- a Claim and everything Submit owes the relays for it.
 *
 * A ClaimRecord holds the signed events of one (Run, claimer key) pair and
 * what each relay answered. The shell asks plan() which (event, relay) pairs
 * are still owed, sends them, and folds the answers back with applyResults().
 * Every signed event is stored once and resent verbatim, so a retry, a
 * re-scan, or a reload mid-send converges on the same end state.
 *
 * ClaimRecord = {
 *   run, claim,               the cabinet's Run (verbatim) and the player's Claim
 *   profile,                  latest kind-0 of a key generated here (see withProfile), else null
 *   pending,                  ots-pending carrier, once stamped and signed by the claimer key
 *   final,                    NIP-03 kind-1040, once Bitcoin attests
 *   sends: { [eventId]: { [relay]: { state: 'ok'|'error', message } } },   absent = not yet sent
 *   ots: { file: base64|null, calendars: string[], errors: {[cal]: msg}, lastUpgrade: ms,
 *          bitcoinSeenAt: ms|undefined   when an upgrade first found a Bitcoin attestation },
 * }
 */
import { signEvent, generateSecretKey } from './sign.js';
import {
  encodeFile, decodeFile, pendingTemplate, finalTemplate, parseOts, pruneToBitcoin, serializeOts, bitcoinHeights, bitcoinCalendars,
} from './ots.js';

export const recordKey = (runId, pubkey) => `${runId}:${pubkey}`;

/** The Claim template: points at the Run, commits to its signature, names nobody. */
export function claimTemplate(run, createdAt, relayHint) {
  return {
    kind: 8064,
    created_at: createdAt,
    content: '',
    tags: [
      ['t', 'ag-lb'],
      ['t', 'claim'],
      ['e', run.id, relayHint, run.pubkey],
      ['p', run.pubkey],
      ['sig', run.sig],
    ],
  };
}

export function newRecord({ run, claim, profile = null }) {
  return {
    run,
    claim,
    profile,
    pending: null,
    final: null,
    sends: {},
    ots: { file: null, calendars: [], errors: {}, lastUpgrade: 0 },
  };
}

/**
 * Signs the Claim for run as key: called once per (Run, key) pair, at the
 * first Submit tap. A pasted key's profile is never republished.
 */
export function startRecord(run, key, createdAt, relayHint) {
  return newRecord({
    run,
    claim: signEvent(claimTemplate(run, createdAt, relayHint), key.sk),
    profile: key.origin === 'generated' ? key.profile : null,
  });
}

/**
 * Points the record at the active generated key's latest kind-0, so a
 * Change name goes out with the next Submit or Retry of any Claim, not only
 * new ones. Unchanged for any other key, or when the name is unchanged.
 */
export function withProfile(record, key) {
  if (key?.origin !== 'generated' || key.pubkey !== record.claim.pubkey || !key.profile) return record;
  if (record.profile && record.profile.created_at >= key.profile.created_at) return record;
  return { ...record, profile: key.profile };
}

/** Which relays each stored event goes to. Indexers only want the profile. */
export function destinations(record, { relays, indexers = [] }) {
  return [
    record.profile && { role: 'profile', event: record.profile, relays: [...relays, ...indexers] },
    { role: 'run', event: record.run, relays },
    { role: 'claim', event: record.claim, relays },
    record.pending && { role: 'pending', event: record.pending, relays },
    record.final && { role: 'final', event: record.final, relays },
  ].filter(Boolean);
}

const cell = (record, eventId, relay) => record.sends[eventId]?.[relay];

/** (event, relay) pairs not yet accepted: never sent, or sent and failed. */
export function plan(record, targets) {
  return destinations(record, targets).flatMap(({ event, relays }) =>
    relays.filter((relay) => cell(record, event.id, relay)?.state !== 'ok').map((relay) => ({ event, relay })));
}

/**
 * Fold relay answers ({ eventId, relay, ok, message }) into the record.
 * Acceptance is sticky: a later failure for a pair a relay already accepted
 * doesn't undo it, so applying any results twice changes nothing.
 */
export function applyResults(record, results) {
  const sends = { ...record.sends };
  for (const { eventId, relay, ok, message } of results) {
    if (sends[eventId]?.[relay]?.state === 'ok') continue;
    sends[eventId] = { ...sends[eventId], [relay]: { state: ok ? 'ok' : 'error', message } };
  }
  return { ...record, sends };
}

/** 'ok' once any relay accepted it, 'unsent' if never tried anywhere, else 'failed'. */
export function eventStatus(record, eventId, relays) {
  const cells = relays.map((r) => cell(record, eventId, r));
  if (cells.some((c) => c?.state === 'ok')) return 'ok';
  return cells.every((c) => !c) ? 'unsent' : 'failed';
}

/**
 * submitted: the Run and the Claim each sit on at least one relay (the Run
 * counts even when a relay already had it: someone else may have submitted
 * it, the Claim is what's yours).
 * relaysOwed: some event no relay holds yet, or some pair was never sent
 * (a reload cut the Submit short).
 * stampOwed / carrierOwed: see needsStamp / carrierOwed.
 * needsRetry: any of the three; the record isn't finished.
 */
export function submitStatus(record, targets) {
  const dests = destinations(record, targets);
  const status = Object.fromEntries(dests.map(({ role, event, relays }) => [role, eventStatus(record, event.id, relays)]));
  const neverSent = dests.some(({ event, relays }) => relays.some((r) => !cell(record, event.id, r)));
  const relaysOwed = Object.values(status).some((s) => s !== 'ok') || neverSent;
  const stampOwed = needsStamp(record);
  const owesCarrier = carrierOwed(record);
  return {
    status,
    submitted: status.run === 'ok' && status.claim === 'ok',
    relaysOwed,
    stampOwed,
    carrierOwed: owesCarrier,
    needsRetry: relaysOwed || stampOwed || owesCarrier,
  };
}

// ------------------------------------------------------------- the Claim's timestamp proof

const HOUR_MS = 3600 * 1000;
const FINAL_WAIT_MS = 24 * HOUR_MS;
const UPGRADE_EVERY_MS = 10 * 60 * 1000;

/** Stamping hasn't produced a proof yet (never ran, every calendar failed, or a reload cut it short). */
export const needsStamp = (record) => !record.ots.file;

/**
 * There is a proof but no ots-pending carrier for it yet (it was stamped
 * while another key was active), and no 1040 has made the carrier moot.
 * Only the claimer's key can sign it.
 */
export const carrierOwed = (record) => Boolean(record.ots.file) && !record.pending && !record.final;

/** Signs the owed ots-pending carrier if key is the claimer's; otherwise the record is returned unchanged. */
export function withCarrier(record, key, createdAt) {
  if (!carrierOwed(record) || key?.pubkey !== record.claim.pubkey) return record;
  return { ...record, pending: signEvent(pendingTemplate(record.claim.id, decodeFile(record.ots.file), createdAt), key.sk) };
}

/**
 * Folds a stampDigest result into the record and, with the claimer's key,
 * signs the ots-pending carrier so anyone can finish the proof if this
 * phone never returns.
 */
export function withStamp(record, { file, calendars, errors }, key, createdAt) {
  const ots = { ...record.ots, file: file ? encodeFile(file) : null, calendars, errors };
  return withCarrier({ ...record, ots }, key, createdAt);
}

/** A pending proof is worth asking the calendars about: an hour after the Claim, at most every 10 minutes. */
export function upgradeDue(record, nowMs) {
  return Boolean(record.ots.file) && !record.final
    && nowMs - record.claim.created_at * 1000 >= HOUR_MS
    && nowMs - record.ots.lastUpgrade >= UPGRADE_EVERY_MS;
}

/**
 * While some Bitcoin attestation is in but no 1040 yet: which stamping
 * calendars have attested, which are still awaited, and when the wait ends
 * regardless. Else null.
 */
export function finalWait(record) {
  if (record.final || !record.ots.bitcoinSeenAt) return null;
  return waitFor(parseOts(decodeFile(record.ots.file)), record.ots.calendars, record.ots.bitcoinSeenAt);
}

function waitFor(stamp, calendars, seenAt) {
  const attested = bitcoinCalendars(stamp);
  return {
    attested: calendars.filter((c) => attested.includes(c)),
    waiting: calendars.filter((c) => !attested.includes(c)),
    until: seenAt + FINAL_WAIT_MS,
  };
}

/**
 * Folds an upgraded proof into the record. The NIP-03 kind-1040 waits until
 * every calendar that stamped the Claim attests in Bitcoin, or 24 h after
 * the first one did: the leaderboard compares k-of-n calendar times, so a
 * 1040 carrying only the first calendar's branch would throw the rest away.
 * It is signed with a fresh throwaway key, so finishing never depends on
 * the claimer's key still being on this phone.
 */
export function withUpgrade(record, fileBytes, nowMs, relayHint) {
  const ots = { ...record.ots, file: encodeFile(fileBytes), lastUpgrade: nowMs };
  if (record.final) return { ...record, ots };
  const stamp = parseOts(fileBytes);
  if (!bitcoinHeights(stamp).length) return { ...record, ots };
  ots.bitcoinSeenAt = record.ots.bitcoinSeenAt ?? nowMs;
  const { waiting, until } = waitFor(stamp, ots.calendars, ots.bitcoinSeenAt);
  if (waiting.length && nowMs < until) return { ...record, ots };
  const template = finalTemplate(record.claim.id, serializeOts(pruneToBitcoin(stamp)), relayHint, Math.floor(nowMs / 1000));
  return { ...record, ots, final: signEvent(template, generateSecretKey()) };
}

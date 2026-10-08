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
 *   pending,                  ots-pending carrier, signed at Submit once a calendar answered
 *   sends: { [eventId]: { [relay]: { state: 'ok'|'error', message } } },   absent = not yet sent
 *   ots: { calendars: string[], errors: {[cal]: msg} },   which calendars stamped the Claim at Submit
 * }
 * The finalizer (finalizer/run.mjs) finishes the proof from the relays; the
 * phone never upgrades it.
 */
import { signEvent } from './sign.js';
import { pendingTemplate } from './ots.js';

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
    sends: {},
    ots: { calendars: [], errors: {} },
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
 */
export function submitStatus(record, targets) {
  const dests = destinations(record, targets);
  const status = Object.fromEntries(dests.map(({ role, event, relays }) => [role, eventStatus(record, event.id, relays)]));
  const neverSent = dests.some(({ event, relays }) => relays.some((r) => !cell(record, event.id, r)));
  return {
    status,
    submitted: status.run === 'ok' && status.claim === 'ok',
    relaysOwed: Object.values(status).some((s) => s !== 'ok') || neverSent,
  };
}

// ------------------------------------------------------------- the Claim's timestamp proof

/**
 * Folds a stampDigest result into the record and signs the ots-pending
 * carrier with key, the claimer's key captured at Submit, so the finalizer
 * can finish the proof without this phone. No proof (every calendar failed)
 * leaves no carrier: the finalizer stamps the Claim itself.
 */
export function withStamp(record, { file, calendars, errors }, key, createdAt) {
  const pending = file ? signEvent(pendingTemplate(record.claim.id, file, createdAt), key.sk) : null;
  return { ...record, pending, ots: { calendars, errors } };
}

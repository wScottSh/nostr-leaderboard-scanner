/*
 * verify.js -- "will nostr-leaderboard accept this run?", answered on the
 * phone before broadcasting. Mirrors nostr-leaderboard's src/verify.js
 * (NIP-01 id + BIP-340 signature) and src/model.js parseRun (format-v3 shape)
 * exactly, so the scanner and the leaderboard agree on what a run is.
 *
 * Informational only: per sm64-nostr's handoff spec a local check must never
 * gate the broadcast -- relays and the leaderboard verify downstream.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { computeEventId } from './decode.js';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const CONTENT_MAX = { course: 0xff, act: 0xff, coins: 0xff, frames: 0xffffffff, nonce: 0xffff, keyId: 0xff };

/** true iff ev's id is the hash of its own fields and sig verifies against its pubkey. Never throws. */
export function verifyEvent(ev) {
  try {
    if (!HEX64.test(ev.id) || !HEX64.test(ev.pubkey) || !HEX128.test(ev.sig)) return false;
    if (computeEventId(ev) !== ev.id) return false;
    return schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey));
  } catch {
    return false;
  }
}

/**
 * checkRun: ev -> { ok: true, run } or { ok: false, reason }. `run` carries
 * the fields the leaderboard ranks on (and routes by: pubkey + event name +
 * course/keyId).
 */
export function checkRun(ev) {
  if (!verifyEvent(ev)) return { ok: false, reason: 'signature does not verify' };
  if (ev.kind !== 8064) return { ok: false, reason: `kind ${ev.kind}, not 8064` };
  const t = ev.tags.filter((tag) => tag[0] === 't').map((tag) => tag[1]);
  if (!t.includes('ag-lb') || !t.includes('sm64')) return { ok: false, reason: 'not an sm64 cabinet event' };
  const names = ev.tags.filter((tag) => tag[0] === 'n');
  if (names.length !== 1) return { ok: false, reason: 'missing event name' };
  let content;
  try {
    content = JSON.parse(ev.content);
  } catch {
    return { ok: false, reason: 'content is not JSON' };
  }
  for (const [k, max] of Object.entries(CONTENT_MAX)) {
    const v = content?.[k];
    if (!Number.isInteger(v) || v < 0 || v > max) return { ok: false, reason: `bad ${k}` };
  }
  return { ok: true, run: { id: ev.id, pubkey: ev.pubkey, eventName: names[0][1], ...content } };
}

/*
 * sign.js -- the only file that may hold a secret key or produce a
 * signature (a test enforces this). It signs the player's own events (the
 * kind-0 profile of a key generated here, the Claim, the ots-pending proof
 * carrier) and the finalizer's (ots-pending, NIP-03 kind-1040 proof).
 *
 * The Run is never signed, built, or modified here: signEvent refuses any
 * template nostr-leaderboard's parseRun could take for a Run (kind 8064 with
 * t=sm64 or an n tag).
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { computeEventId } from './decode.js';

const HEX64 = /^[0-9a-f]{64}$/;
const SIGNABLE_8064_ROLES = ['claim', 'ots-pending'];

export function generateSecretKey() {
  return bytesToHex(schnorr.utils.randomSecretKey());
}

/** x-only pubkey (hex) of a secret key (hex). Throws on a key outside the curve order. */
export function pubkeyOf(skHex) {
  if (!HEX64.test(skHex)) throw new Error('secret key must be 64 lowercase hex chars');
  return bytesToHex(schnorr.getPublicKey(hexToBytes(skHex)));
}

/** Throws unless the template is one of the player's own event shapes. */
export function assertSignable(template) {
  const tags = template.tags ?? [];
  const t = tags.filter((tag) => tag[0] === 't').map((tag) => tag[1]);
  if (template.kind === 8064) {
    if (t.includes('sm64') || tags.some((tag) => tag[0] === 'n')) {
      throw new Error('refusing to sign a Run: Runs are signed on the cabinet only');
    }
    if (!t.includes('ag-lb') || !t.some((v) => SIGNABLE_8064_ROLES.includes(v))) {
      throw new Error('refusing to sign a kind-8064 event that is neither a Claim nor an ots-pending proof');
    }
    return;
  }
  if (template.kind === 0 || template.kind === 1040) return;
  throw new Error(`refusing to sign kind ${template.kind}`);
}

/** { kind, created_at, tags, content } + secret key -> signed NIP-01 event. */
export function signEvent(template, skHex) {
  assertSignable(template);
  const ev = {
    pubkey: pubkeyOf(skHex),
    created_at: template.created_at,
    kind: template.kind,
    tags: template.tags,
    content: template.content,
  };
  const id = computeEventId(ev);
  return { id, ...ev, sig: bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(skHex))) };
}

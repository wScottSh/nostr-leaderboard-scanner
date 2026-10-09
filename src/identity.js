/*
 * identity.js -- who is submitting: parses the "Name or nsec" field,
 * enforces the name rules, reads names out of kind-0 profiles, and builds
 * the stored key (generated or pasted). Keys and signatures come from
 * sign.js.
 */
import { bech32 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { verifyEvent } from './verify.js';
import { generateSecretKey, pubkeyOf, signEvent } from './sign.js';

export const NAME_MAX = 32;

/**
 * The name rules: NFC, trimmed, 1-32 code points, no control characters, and
 * not something that looks like a key. -> { ok: true, name } | { ok: false, error }
 */
export function validateName(raw) {
  const name = raw.normalize('NFC').trim();
  if (!name) return { ok: false, error: 'Enter a name for the leaderboard.' };
  if ([...name].length > NAME_MAX) return { ok: false, error: `Keep it to ${NAME_MAX} characters.` };
  if (/\p{Cc}/u.test(name)) return { ok: false, error: 'The name contains a control character.' };
  if (/^n(sec|pub)1/i.test(name)) return { ok: false, error: 'A name can’t start with nsec1 or npub1.' };
  return { ok: true, name };
}

/**
 * The "Name or nsec" field ->
 *   { kind: 'nsec', sk }       a pasted secret key (hex)
 *   { kind: 'name', name }     a name for a key generated here
 *   { kind: 'invalid', error }
 */
export function parseIdentityInput(raw) {
  const text = raw.normalize('NFC').trim();
  const lower = text.toLowerCase();
  if (lower.startsWith('npub1')) {
    return { kind: 'invalid', error: 'That’s your public key; paste your nsec (starts with nsec1)' };
  }
  if (lower.startsWith('nsec1')) {
    try {
      const sk = decodeBech32Key('nsec', lower);
      pubkeyOf(sk); // throws for a scalar outside the curve order (all-zero, >= n)
      return { kind: 'nsec', sk };
    } catch {
      return { kind: 'invalid', error: 'That nsec isn’t a valid key. Check it was pasted whole.' };
    }
  }
  const v = validateName(text);
  return v.ok ? { kind: 'name', name: v.name } : { kind: 'invalid', error: v.error };
}

function decodeBech32Key(prefix, text) {
  const { prefix: got, words } = bech32.decode(text);
  if (got !== prefix) throw new Error(`expected ${prefix}`);
  const bytes = bech32.fromWords(words);
  if (bytes.length !== 32) throw new Error('key must be 32 bytes');
  return bytesToHex(Uint8Array.from(bytes));
}

export function npubOf(pubkeyHex) {
  return bech32.encode('npub', bech32.toWords(hexToBytes(pubkeyHex)));
}

export function shortNpub(pubkeyHex) {
  const n = npubOf(pubkeyHex);
  return `${n.slice(0, 12)}…${n.slice(-4)}`;
}

/** The kind-0 template a generated key publishes for its name. */
export function profileTemplate(name, createdAt) {
  return { kind: 0, created_at: createdAt, tags: [], content: JSON.stringify({ name }) };
}

/** Newest validly signed kind-0 for pubkey among events from any number of relays (highest created_at wins). */
export function newestProfile(events, pubkey) {
  let best = null;
  for (const ev of events) {
    if (ev.kind !== 0 || ev.pubkey !== pubkey) continue;
    if (best && ev.created_at <= best.created_at) continue;
    if (verifyEvent(ev)) best = ev;
  }
  return best;
}
/** A kind-0's display name (name, else display_name), or null. */
export function profileName(ev) {
  if (!ev) return null;
  try {
    const meta = JSON.parse(ev.content);
    const name = [meta?.name, meta?.display_name].find((v) => typeof v === 'string' && v.trim());
    return name ? name.trim() : null;
  } catch {
    return null;
  }
}

/** What to call a stored key on screen. */
export function keyLabel(key) {
  return key.name || shortNpub(key.pubkey);
}

/** A key made on this phone for a name; its kind-0 goes out with the next Submit. */
export function generatedKey(name, createdAt) {
  const sk = generateSecretKey();
  return renameKey({ sk, pubkey: pubkeyOf(sk), origin: 'generated', name: null, profile: null }, name, createdAt);
}

/** Re-signs a generated key's kind-0, always newer than the one it replaces. */
export function renameKey(key, name, createdAt) {
  const at = Math.max(createdAt, (key.profile?.created_at ?? 0) + 1);
  return { ...key, name, profile: signEvent(profileTemplate(name, at), key.sk) };
}

/** A pasted key. name is whatever its own kind-0 says (or null); nothing is published for it. */
export function pastedKey(sk, name) {
  return { sk, pubkey: pubkeyOf(sk), origin: 'pasted', name, profile: null };
}

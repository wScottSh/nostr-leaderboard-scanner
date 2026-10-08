/*
 * ots.js -- OpenTimestamps for Claims: stamp a Claim id at the calendars,
 * keep the pending proof, upgrade it once Bitcoin attests, and prune it for
 * NIP-03.
 *
 * The binary format follows python-opentimestamps (opentimestamps/core/
 * timestamp.py, op.py, notary.py, serialize.py) exactly, including the sort
 * order of a node's attestations and ops, so a file parsed and re-serialized
 * comes back byte-identical.
 *
 * Timestamp   = { msg: Uint8Array, attestations: Attestation[], ops: { op: Op, stamp: Timestamp }[] }
 * Op          = { tag: number, arg?: Uint8Array }      arg only for append (f0) / prepend (f1)
 * Attestation = { type: 'pending', uri } | { type: 'bitcoin' | 'litecoin', height }
 *             | { type: 'unknown', tag: Uint8Array, payload: Uint8Array }
 * A detached .ots file is always sha256 here (the digest is a NIP-01 id).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { sha1, ripemd160 } from '@noble/hashes/legacy.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';

export const CALENDARS = [
  'https://alice.btc.calendar.opentimestamps.org',
  'https://bob.btc.calendar.opentimestamps.org',
  'https://finney.calendar.eternitywall.com',
];

const MAGIC = hexToBytes('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294');
const MAJOR_VERSION = 1;
const OP_SHA256 = 0x08;
const APPEND = 0xf0;
const PREPEND = 0xf1;
const MAX_MSG = 4096;
const MAX_PAYLOAD = 8192;
const MAX_URI = 1000;
const URI_CHARS = /^[A-Za-z0-9\-._/:]*$/;
const RECURSION_LIMIT = 256;

const NOTARY = {
  pending: hexToBytes('83dfe30d2ef90c8e'),
  bitcoin: hexToBytes('0588960d73d71901'),
  litecoin: hexToBytes('06869a0d73d71b45'),
};

const hexlify = (msg) => utf8ToBytes(bytesToHex(msg));
const UNARY = {
  0x08: sha256,
  0x02: sha1,
  0x03: ripemd160,
  0x67: keccak_256,
  0xf2: (msg) => msg.slice().reverse(),
  0xf3: hexlify,
};

/** Result of applying op to msg. Throws on an unknown op or a message the op can't take. */
export function applyOp(op, msg) {
  if (msg.length > MAX_MSG || (op.tag === 0xf3 && msg.length > MAX_MSG / 2)) throw new Error('ots: message too long for op');
  if ((op.tag === 0xf2 || op.tag === 0xf3) && !msg.length) throw new Error('ots: op needs a non-empty message');
  let out;
  if (op.tag === APPEND) out = concatBytes(msg, op.arg);
  else if (op.tag === PREPEND) out = concatBytes(op.arg, msg);
  else if (UNARY[op.tag]) out = UNARY[op.tag](msg);
  else throw new Error(`ots: unknown op 0x${op.tag.toString(16)}`);
  if (out.length > MAX_MSG) throw new Error('ots: op result too long');
  return out;
}

// ------------------------------------------------------------- ordering (python's __lt__)

function compareBytes(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

const attestationTag = (a) => (a.type === 'unknown' ? a.tag : NOTARY[a.type]);

function compareAttestations(a, b) {
  if (a.type !== b.type) return compareBytes(attestationTag(a), attestationTag(b));
  if (a.type === 'pending') return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
  if (a.type === 'unknown') return compareBytes(a.tag, b.tag) || compareBytes(a.payload, b.payload);
  return a.height - b.height;
}

const compareOps = (a, b) => a.tag - b.tag || compareBytes(a.arg ?? new Uint8Array(), b.arg ?? new Uint8Array());
const sameAttestation = (a, b) => a.type === b.type && compareAttestations(a, b) === 0;

// ------------------------------------------------------------- bytes

class Writer {
  constructor() {
    this.parts = [];
  }
  bytes(b) {
    this.parts.push(b instanceof Uint8Array ? b : Uint8Array.from(b));
  }
  varuint(n) {
    const out = [];
    do {
      let b = n & 0x7f;
      n = Math.floor(n / 128);
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    this.bytes(out);
  }
  varbytes(b) {
    this.varuint(b.length);
    this.bytes(b);
  }
  done() {
    return concatBytes(...this.parts);
  }
}

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.i = 0;
  }
  bytes(n) {
    if (this.i + n > this.b.length) throw new Error('ots: truncated');
    const out = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return out;
  }
  u8() {
    return this.bytes(1)[0];
  }
  varuint() {
    let value = 0;
    let scale = 1;
    for (;;) {
      const b = this.u8();
      value += (b & 0x7f) * scale;
      if (!(b & 0x80)) return value;
      scale *= 128;
      if (scale > 2 ** 53) throw new Error('ots: varuint too large');
    }
  }
  varbytes(max, min = 0) {
    const n = this.varuint();
    if (n > max || n < min) throw new Error(`ots: varbytes length ${n} out of range`);
    return this.bytes(n);
  }
  eof() {
    if (this.i !== this.b.length) throw new Error('ots: trailing bytes');
  }
}

// ------------------------------------------------------------- timestamp tree

export const newStamp = (msg) => ({ msg, attestations: [], ops: [] });

function readAttestation(r) {
  const tag = r.bytes(8).slice();
  const payload = r.varbytes(MAX_PAYLOAD).slice();
  const p = new Reader(payload);
  let att;
  if (compareBytes(tag, NOTARY.pending) === 0) {
    const uri = new TextDecoder().decode(p.varbytes(MAX_URI));
    if (!URI_CHARS.test(uri)) throw new Error('ots: invalid pending URI');
    att = { type: 'pending', uri };
  } else if (compareBytes(tag, NOTARY.bitcoin) === 0) att = { type: 'bitcoin', height: p.varuint() };
  else if (compareBytes(tag, NOTARY.litecoin) === 0) att = { type: 'litecoin', height: p.varuint() };
  else return { type: 'unknown', tag, payload };
  p.eof();
  return att;
}

function writeAttestation(w, a) {
  w.bytes(attestationTag(a));
  const p = new Writer();
  if (a.type === 'pending') p.varbytes(utf8ToBytes(a.uri));
  else if (a.type === 'unknown') p.bytes(a.payload);
  else p.varuint(a.height);
  w.varbytes(p.done());
}

function readOp(r, tag) {
  if (tag === APPEND || tag === PREPEND) return { tag, arg: r.varbytes(MAX_MSG, 1).slice() };
  if (!UNARY[tag]) throw new Error(`ots: unknown op 0x${tag.toString(16)}`);
  return { tag };
}

function addOp(stamp, op, child) {
  const existing = stamp.ops.find((o) => compareOps(o.op, op) === 0);
  if (existing) merge(existing.stamp, child);
  else stamp.ops.push({ op, stamp: child });
}

function readTimestamp(r, msg, depth = RECURSION_LIMIT) {
  if (!depth) throw new Error('ots: recursion limit');
  const stamp = newStamp(msg);
  const tagOrAttestation = (tag) => {
    if (tag === 0x00) {
      const att = readAttestation(r);
      if (!stamp.attestations.some((a) => sameAttestation(a, att))) stamp.attestations.push(att);
    } else {
      const op = readOp(r, tag);
      addOp(stamp, op, readTimestamp(r, applyOp(op, msg), depth - 1));
    }
  };
  let tag = r.u8();
  while (tag === 0xff) {
    tagOrAttestation(r.u8());
    tag = r.u8();
  }
  tagOrAttestation(tag);
  return stamp;
}

function writeTimestamp(w, stamp) {
  const atts = [...stamp.attestations].sort(compareAttestations);
  const ops = [...stamp.ops].sort((a, b) => compareOps(a.op, b.op));
  if (!atts.length && !ops.length) throw new Error("ots: an empty timestamp can't be serialized");
  for (const a of atts.slice(0, -1)) {
    w.bytes([0xff, 0x00]);
    writeAttestation(w, a);
  }
  if (!ops.length) {
    w.bytes([0x00]);
    writeAttestation(w, atts.at(-1));
    return;
  }
  if (atts.length) {
    w.bytes([0xff, 0x00]);
    writeAttestation(w, atts.at(-1));
  }
  ops.forEach(({ op, stamp: child }, i) => {
    if (i < ops.length - 1) w.bytes([0xff]);
    w.bytes([op.tag]);
    if (op.arg) w.varbytes(op.arg);
    writeTimestamp(w, child);
  });
}

/** A bare timestamp (what a calendar returns) for msg. */
export function parseTimestamp(bytes, msg) {
  const r = new Reader(bytes);
  const stamp = readTimestamp(r, msg);
  r.eof();
  return stamp;
}

export function serializeTimestamp(stamp) {
  const w = new Writer();
  writeTimestamp(w, stamp);
  return w.done();
}

/** Merges other into stamp (same msg), in place. */
export function merge(stamp, other) {
  if (compareBytes(stamp.msg, other.msg) !== 0) throw new Error("ots: can't merge timestamps of different messages");
  for (const a of other.attestations) if (!stamp.attestations.some((b) => sameAttestation(a, b))) stamp.attestations.push(a);
  for (const { op, stamp: child } of other.ops) addOp(stamp, op, child);
  return stamp;
}

// ------------------------------------------------------------- detached .ots files

/** .ots bytes -> Timestamp whose msg is the stamped sha256 digest. */
export function parseOts(bytes) {
  const r = new Reader(bytes);
  if (compareBytes(r.bytes(MAGIC.length), MAGIC) !== 0) throw new Error('ots: not an OpenTimestamps proof');
  const major = r.u8();
  if (major !== MAJOR_VERSION) throw new Error(`ots: unsupported version ${major}`);
  const hashOp = r.u8();
  const digestLen = { 0x08: 32, 0x02: 20, 0x03: 20, 0x67: 32 }[hashOp];
  if (!digestLen) throw new Error(`ots: unknown file hash op 0x${hashOp.toString(16)}`);
  if (hashOp !== OP_SHA256) throw new Error('ots: only sha256 proofs are used here');
  const stamp = readTimestamp(r, r.bytes(digestLen).slice());
  r.eof();
  return stamp;
}

export function serializeOts(stamp) {
  const w = new Writer();
  w.bytes(MAGIC);
  w.bytes([MAJOR_VERSION, OP_SHA256]);
  w.bytes(stamp.msg);
  writeTimestamp(w, stamp);
  return w.done();
}

// ------------------------------------------------------------- reading a proof

function* walk(stamp) {
  yield stamp;
  for (const { stamp: child } of stamp.ops) yield* walk(child);
}

const attestations = (stamp) => [...walk(stamp)].flatMap((s) => s.attestations.map((a) => ({ msg: s.msg, ...a })));

export const bitcoinHeights = (stamp) => attestations(stamp).filter((a) => a.type === 'bitcoin').map((a) => a.height);

/** 'none' (no proof), 'pending' (calendars only), or 'complete' (Bitcoin attests). */
export function otsStatus(fileB64) {
  if (!fileB64) return 'none';
  return bitcoinHeights(parseOts(base64.decode(fileB64))).length ? 'complete' : 'pending';
}

/**
 * Copy of stamp keeping only the paths that end in a Bitcoin attestation
 * (every calendar's, not just one: the leaderboard compares calendar times),
 * or null if there are none. NIP-03 wants no pending attestations.
 */
export function pruneToBitcoin(stamp) {
  const ops = stamp.ops.map(({ op, stamp: child }) => ({ op, stamp: pruneToBitcoin(child) })).filter((o) => o.stamp);
  const atts = stamp.attestations.filter((a) => a.type === 'bitcoin');
  return atts.length || ops.length ? { msg: stamp.msg, attestations: atts, ops } : null;
}

// ------------------------------------------------------------- talking to calendars

const OTS_HEADERS = { Accept: 'application/vnd.opentimestamps.v1' };
const CALENDAR_TIMEOUT_MS = 10_000;

/**
 * One calendar request's body, or a throw (HTTP error, network error, or no
 * answer in timeoutMs). The race covers a fetch or body that ignores the
 * abort signal, so one stalled calendar never holds up the others.
 */
async function fetchBytes(fetchImpl, url, init, timeoutMs) {
  const abort = new AbortController();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`no answer in ${timeoutMs / 1000} s`);
      abort.abort(err);
      reject(err);
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([fetchImpl(url, { ...init, signal: abort.signal }), timedOut]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await Promise.race([res.arrayBuffer(), timedOut]));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stamps a digest (a Claim id, hex) at every calendar in parallel, the way the
 * python client does: digest -> append 16 random bytes -> sha256 -> POST.
 * -> { file: Uint8Array | null, calendars: [urls that answered], errors: { url: message } }
 */
export async function stampDigest(digestHex, {
  calendars = CALENDARS, fetchImpl = globalThis.fetch, nonce, timeoutMs = CALENDAR_TIMEOUT_MS,
} = {}) {
  const root = newStamp(hexToBytes(digestHex));
  const salted = { op: { tag: APPEND, arg: nonce ?? crypto.getRandomValues(new Uint8Array(16)) } };
  salted.stamp = newStamp(applyOp(salted.op, root.msg));
  const tip = newStamp(sha256(salted.stamp.msg));
  salted.stamp.ops.push({ op: { tag: OP_SHA256 }, stamp: tip });
  root.ops.push(salted);

  const ok = [];
  const errors = {};
  await Promise.all(calendars.map(async (cal) => {
    try {
      const body = await fetchBytes(fetchImpl, `${cal}/digest`, {
        method: 'POST',
        headers: { ...OTS_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tip.msg,
      }, timeoutMs);
      merge(tip, parseTimestamp(body, tip.msg));
      ok.push(cal);
    } catch (e) {
      errors[cal] = String(e.message || e);
    }
  }));
  return { file: ok.length ? serializeOts(root) : null, calendars: calendars.filter((c) => ok.includes(c)), errors };
}

/**
 * Asks each pending attestation's calendar (only ours) for its finished
 * path and merges what comes back. A proof still waiting answers 404,
 * which a browser sees as a network error (no CORS on 404): both mean "not
 * yet". -> { file: Uint8Array, changed: boolean }
 */
export async function upgradeOts(fileBytes, {
  calendars = CALENDARS, fetchImpl = globalThis.fetch, timeoutMs = CALENDAR_TIMEOUT_MS,
} = {}) {
  const root = parseOts(fileBytes);
  const leaves = [...walk(root)].flatMap((s) =>
    s.attestations.filter((a) => a.type === 'pending' && calendars.includes(a.uri)).map((a) => ({ s, uri: a.uri })));
  let changed = false;
  await Promise.all(leaves.map(async ({ s, uri }) => {
    try {
      const body = await fetchBytes(fetchImpl, `${uri}/timestamp/${bytesToHex(s.msg)}`, { headers: OTS_HEADERS }, timeoutMs);
      const before = serializeTimestamp(s);
      merge(s, parseTimestamp(body, s.msg));
      if (compareBytes(before, serializeTimestamp(s)) !== 0) changed = true;
    } catch { /* not yet */ }
  }));
  return { file: serializeOts(root), changed };
}

// ------------------------------------------------------------- the events that carry proofs

/** ots-pending carrier: the pending proof, published so anyone can finish it. */
export const pendingTemplate = (claimId, fileBytes, createdAt) => ({
  kind: 8064,
  created_at: createdAt,
  tags: [['t', 'ag-lb'], ['t', 'ots-pending'], ['e', claimId]],
  content: base64.encode(fileBytes),
});

/** NIP-03 attestation for the Claim, Bitcoin paths only. */
export const finalTemplate = (claimId, prunedBytes, relayHint, createdAt) => ({
  kind: 1040,
  created_at: createdAt,
  tags: [['e', claimId, relayHint], ['k', '8064']],
  content: base64.encode(prunedBytes),
});

export const encodeFile = (bytes) => base64.encode(bytes);
export const decodeFile = (b64) => base64.decode(b64);

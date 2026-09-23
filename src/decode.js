/*
 * decode.js -- QR frame URLs -> the cabinet's signed kind-8064 event. Pure.
 *
 * A port of sm64-nostr's reader/reader.js (spec #115/#122, ADR-0005/0006):
 * every frame is `<BASE>#<SEQ>/<TOTAL>/<PAYLOAD>`; the base32 payload chunks
 * reassemble (any order) into the packed format-v3 bytes, which unpack into
 * the event. All wire knowledge comes from generated/transport_contract.js,
 * rendered from sm64-nostr's own C headers (npm run sync-contract).
 *
 * Zero far-side reconstruction: every signed value is recovered verbatim from
 * the wire; `kind` and the ag-lb tag are format constants. The only derived
 * value is `id`, a SHA-256 of what the wire already fixed. Nothing here can
 * sign.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { TRANSPORT_CONTRACT, FORMAT_DESCRIPTOR } from './generated/transport_contract.js';

const {
  PIPELINE_BASE32_ALPHABET: BASE32,
  PIPELINE_FRAGMENT_BASE36_ALPHABET: BASE36,
  PIPELINE_URL_FIELD_SEP: FIELD_SEP,
  PIPELINE_URL_FRAGMENT_SEP: FRAGMENT_SEP,
  PIPELINE_FRAGMENT_INDEX_LEN: INDEX_LEN,
  PIPELINE_FRAGMENT_COUNT_LEN: COUNT_LEN,
  PIPELINE_EVENT_TAG_KEY,
  PIPELINE_EVENT_TAG0_VALUE,
  PIPELINE_EVENT_NAME_TAG_KEY,
  PIPELINE_EVENT_KIND,
} = TRANSPORT_CONTRACT;

// "00/02/" ahead of the base32 chunk.
const COUNT_START = INDEX_LEN + FIELD_SEP.length;
const HEADER_LEN = COUNT_START + COUNT_LEN + FIELD_SEP.length;

/** RFC 4648 §6 base32 (uppercase, no padding) -> bytes. Throws on a foreign character. */
export function base32Decode(text) {
  const out = [];
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const v = BASE32.indexOf(text[i]);
    if (v < 0) throw new Error(`base32: bad character ${JSON.stringify(text[i])} at ${i}`);
    buf = ((buf << 5) | v) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function base36Field(field) {
  let value = 0;
  for (const ch of field) {
    const d = BASE36.indexOf(ch);
    if (d < 0) throw new Error(`fragment header: bad base36 digit ${JSON.stringify(ch)}`);
    value = value * BASE36.length + d;
  }
  return value;
}

/** Everything after the first `#`. Host-agnostic: any base URL works. */
export function extractFragment(url) {
  const i = url.indexOf(FRAGMENT_SEP);
  if (i < 0) throw new Error('not a cabinet QR (no # fragment)');
  return url.slice(i + FRAGMENT_SEP.length);
}

/** "SS/TT/<chunk>" -> { index, count, chunk }. Throws on a malformed header. */
export function parseFragmentHeader(fragment) {
  if (fragment.length < HEADER_LEN) throw new Error('fragment header: too short');
  if (fragment[INDEX_LEN] !== FIELD_SEP || fragment[COUNT_START + COUNT_LEN] !== FIELD_SEP) {
    throw new Error('fragment header: missing field separator');
  }
  const index = base36Field(fragment.slice(0, INDEX_LEN));
  const count = base36Field(fragment.slice(COUNT_START, COUNT_START + COUNT_LEN));
  if (count === 0 || index >= count) throw new Error(`fragment header: index ${index} of ${count}`);
  const chunk = fragment.slice(HEADER_LEN);
  for (const ch of chunk) if (!BASE32.includes(ch)) throw new Error('fragment: payload is not base32');
  return { index, count, chunk };
}

/** A scanned string -> its parsed frame, or null if it isn't a cabinet frame (camera noise, other QRs). */
export function parseFrame(url) {
  try {
    return parseFragmentHeader(extractFragment(url));
  } catch {
    return null;
  }
}

/**
 * reassembleFrames: parsed frames (any order, duplicates fine) ->
 * { complete: true, base32Text } or { complete: false, seen, count }.
 *
 * The cabinet slices every chunk but the last to the same length, so frames
 * whose non-last chunk lengths disagree (or whose last chunk is longer) came
 * from two different broadcasts: throw rather than splice them. Two runs
 * with identical lengths can still mix; the signature check catches that.
 */
export function reassembleFrames(frames) {
  const chunks = new Map();
  let count = null;
  let chunkLen = null;
  for (const f of frames) {
    if (count === null) count = f.count;
    else if (f.count !== count) throw new Error(`frames disagree on total (${count} vs ${f.count})`);
    if (f.index < f.count - 1) {
      if (chunkLen === null) chunkLen = f.chunk.length;
      else if (f.chunk.length !== chunkLen) throw new Error('frames from two different broadcasts');
    }
    if (!chunks.has(f.index)) chunks.set(f.index, f.chunk);
  }
  if (count === null) return { complete: false, seen: 0, count: 0 };
  if (chunkLen !== null && chunks.has(count - 1) && chunks.get(count - 1).length > chunkLen) {
    throw new Error('frames from two different broadcasts');
  }
  if (chunks.size !== count) return { complete: false, seen: chunks.size, count };
  let base32Text = '';
  for (let i = 0; i < count; i++) base32Text += chunks.get(i);
  return { complete: true, base32Text };
}

/**
 * unpackPayload: packed bytes -> { FIELD_NAME: value }, walking the format
 * descriptor in order (var_len fields sized by their already-read len field).
 * Rejects a wrong FORMAT_TAG, an oversize var field, or leftover/missing bytes.
 */
export function unpackPayload(bytes) {
  const out = {};
  let offset = 0;
  for (const field of FORMAT_DESCRIPTOR.fields) {
    const size = field.var_len ? out[field.len_field] : field.size;
    if (field.var_len && size > field.max_size) throw new Error(`${field.name} longer than ${field.max_size}`);
    if (offset + size > bytes.length) throw new Error(`payload too short for ${field.name}`);
    const slice = bytes.subarray(offset, offset + size);
    if (field.encoding === 'hex') out[field.name] = bytesToHex(slice);
    else if (field.encoding === 'ascii') out[field.name] = String.fromCharCode(...slice);
    else out[field.name] = slice.reduce((v, b) => v * 256 + b, 0); // big-endian, <= 4 bytes
    offset += size;
    if (field.name === 'FORMAT_TAG' && out.FORMAT_TAG !== FORMAT_DESCRIPTOR.format_tag) {
      throw new Error(`unsupported QR format ${out.FORMAT_TAG} (this scanner reads format ${FORMAT_DESCRIPTOR.format_tag})`);
    }
  }
  if (offset !== bytes.length) throw new Error(`payload is ${bytes.length} bytes, format says ${offset}`);
  return out;
}

/** NIP-01 canonical serialization: [0, pubkey, created_at, kind, tags, content]. */
export function serializeForId(ev) {
  return JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
}

export function computeEventId(ev) {
  return bytesToHex(sha256(utf8ToBytes(serializeForId(ev))));
}

/** Packed bytes -> the complete, broadcast-ready NIP-01 event. */
export function decodeEvent(bytes) {
  const u = unpackPayload(bytes);
  const ev = {
    pubkey: u.PUBKEY,
    created_at: u.CREATED_AT,
    kind: PIPELINE_EVENT_KIND,
    tags: [
      [PIPELINE_EVENT_TAG_KEY, PIPELINE_EVENT_TAG0_VALUE],
      [PIPELINE_EVENT_TAG_KEY, u.TAG],
      [PIPELINE_EVENT_NAME_TAG_KEY, u.NAME],
    ],
    // Fixed key order, matching the cabinet's event_id.c.
    content: JSON.stringify({
      course: u.COURSE,
      act: u.ACT,
      coins: u.COINS,
      frames: u.FRAMES,
      nonce: u.NONCE16,
      keyId: u.KEY_ID,
    }),
  };
  return { id: computeEventId(ev), ...ev, sig: u.SIG };
}

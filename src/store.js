/*
 * store.js -- everything this phone remembers, as one versioned JSON value
 * in Web Storage (localStorage in the page, a Map-backed shim in tests).
 *
 * State = {
 *   v: 1,
 *   key: null | { sk, pubkey, origin: 'generated'|'pasted', name, profile },
 *   claims: { [recordKey(runId, pubkey)]: ClaimRecord },   see claim.js
 * }
 * key.profile is the latest kind-0 this phone signed for a generated key;
 * a pasted key's is always null (its profile is never published from here).
 */
import { recordKey } from './claim.js';

const STORAGE_KEY = 'nostr-leaderboard-scanner';

export const emptyState = () => ({ v: 1, key: null, claims: {} });

/** -> { get(), update(fn) }; update applies a pure State -> State and persists the result. */
export function openStore(storage) {
  let state = load(storage);
  return {
    get: () => state,
    update(fn) {
      state = fn(state);
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
      return state;
    },
  };
}

function load(storage) {
  try {
    const state = JSON.parse(storage.getItem(STORAGE_KEY));
    return state?.v === 1 ? state : emptyState();
  } catch {
    return emptyState();
  }
}

export const setKey = (state, key) => ({ ...state, key });

export const putRecord = (state, record) => ({
  ...state,
  claims: { ...state.claims, [recordKey(record.run.id, record.claim.pubkey)]: record },
});

export const findRecord = (state, runId, pubkey) => state.claims[recordKey(runId, pubkey)] ?? null;

export const recordsFor = (state, pubkey) => Object.values(state.claims).filter((r) => r.claim.pubkey === pubkey);

/** Newest Claim first. */
export const allRecords = (state) => Object.values(state.claims).sort((a, b) => b.claim.created_at - a.claim.created_at);

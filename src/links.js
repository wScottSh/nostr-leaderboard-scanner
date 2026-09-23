/*
 * links.js -- deep links into nostr-leaderboard's hash routes
 * (#/c/<pubkey>/<event name>/<course>-<keyId>, see its src/main.js).
 */

export const LEADERBOARD_URL = 'https://wscottsh.github.io/nostr-leaderboard/';

export function cabinetUrl(pubkey, eventName, base = LEADERBOARD_URL) {
  return `${base}#/c/${pubkey}/${encodeURIComponent(eventName)}`;
}

export function starBoardUrl(run, base = LEADERBOARD_URL) {
  return `${cabinetUrl(run.pubkey, run.eventName, base)}/${run.course}-${run.keyId}`;
}

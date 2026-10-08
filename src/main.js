/*
 * main.js -- the page a phone opens from a cabinet's star QR. DOM shell only.
 *
 *   1. The opening URL's own #fragment is the first frame. For a one-frame
 *      capture that's the whole event: no camera needed.
 *   2. Otherwise the page grabs the camera and collects the rest of the
 *      cycling frames (FrameCollector).
 *   3. The Submit screen shows the Run and asks who is claiming it. Nothing
 *      is published before Submit.
 *   4. Submit signs a Claim once (claim.js), publishes the owed events
 *      (relay.js), and stamps the Claim (ots.js). Everything is persisted
 *      (store.js), so results, retries, and proofs survive a reload.
 */
import jsQR from 'jsqr';
import { FrameCollector } from './collector.js';
import { checkRun } from './verify.js';
import { RELAYS, INDEXERS, publishPairs, fetchEvents } from './relay.js';
import { starBoardUrl, cabinetUrl, LEADERBOARD_URL } from './links.js';
import { courseName, starName, formatFrames, COURSES } from './stars.js';
import { openStore, setKey, putRecord, findRecord, recordsFor, allRecords } from './store.js';
import {
  parseIdentityInput, validateName, generatedKey, pastedKey, renameKey, newestProfile, profileName, keyLabel, shortNpub,
} from './identity.js';
import {
  recordKey, startRecord, destinations, plan, applyResults, submitStatus, needsStamp, withStamp, upgradeDue, withUpgrade,
} from './claim.js';
import { stampDigest, upgradeOts, otsStatus, decodeFile, parseOts, bitcoinHeights } from './ots.js';

const app = document.getElementById('app');
const collector = new FrameCollector();
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const MAX_SCAN_WIDTH = 1280;
const TARGETS = { relays: RELAYS, indexers: INDEXERS };
const store = openStore(localStorage);

let video = null;
let stream = null;
let raf = 0;
let detector = null;
let detecting = false;

// What is on screen, so background work knows what to redraw.
let view = { name: 'idle' };
// In-flight work, never persisted: a reload simply finds these pairs still owed.
const sending = new Set(); // `${eventId}|${relay}`
const stamping = new Set(); // record keys
const upgrading = new Set(); // record keys

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const shortHex = (h) => `${h.slice(0, 8)}…${h.slice(-4)}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const relayName = (u) => u.replace(/^wss?:\/\//, '');
const calendarName = (u) => new URL(u).hostname.split('.')[0];

// ---------------------------------------------------------------- views

function renderIdle(message = '') {
  stopCamera();
  view = { name: 'idle' };
  const records = allRecords(store.get());
  const owed = records.filter((r) => submitStatus(r, TARGETS).needsRetry).length;
  app.innerHTML = `
    <section class="card center">
      <div class="big-star star">★</div>
      <h2>Scan a star</h2>
      <p class="sub">Grab a star on the cabinet, then point your camera at the QR code it shows.
        Nothing is published until you tap Submit.</p>
      ${message ? `<p class="notice">${esc(message)}</p>` : ''}
      <p><button data-action="camera">Start camera</button></p>
      ${records.length ? `<p><button class="link" data-action="claims">My claims (${records.length})</button>
        ${owed ? `<span class="sub"> · ${owed} need${owed === 1 ? 's' : ''} a retry</span>` : ''}</p>` : ''}
      <p class="fine"><a href="${LEADERBOARD_URL}">Open the leaderboard</a></p>
    </section>`;
}

function renderScanning() {
  view = { name: 'scanning' };
  app.innerHTML = `
    <section class="card">
      <div class="viewfinder"><video id="video" playsinline muted></video><div class="reticle"></div></div>
      <p id="scan-status" class="sub center">Point the camera at the cabinet's QR code.</p>
      <div id="grid" class="grid"></div>
      <p class="center"><button class="secondary" data-action="cancel">Cancel</button></p>
    </section>`;
  video = document.getElementById('video');
  renderProgress();
}

function renderProgress(restarted = false) {
  const grid = document.getElementById('grid');
  const status = document.getElementById('scan-status');
  if (!grid || !collector.count) return;
  grid.innerHTML = Array.from({ length: collector.count }, (_, i) =>
    `<span class="${collector.got.has(i) ? 'got' : ''}">${i + 1}</span>`).join('');
  status.textContent = restarted
    ? 'The screen changed to a different star — starting over.'
    : `Got ${collector.got.size} of ${collector.count} frames. Keep holding steady…`;
}

/** The decoded Run: star, course, time, coins, event, local check, signed JSON. */
function runSummary(event) {
  const check = checkRun(event);
  const r = check.ok ? check.run : null;
  const content = safeJson(event.content) ?? {};
  const name = event.tags.find((t) => t[0] === 'n')?.[1] ?? '';
  return `
      <div class="run-head">
        <span class="abbr">${esc(COURSES[content.course]?.abbr ?? content.course)}</span>
        <div>
          <h2><span class="star">★</span> ${esc(starName(content.course, content.keyId))}</h2>
          <div class="sub">${esc(courseName(content.course))} · act ${esc(content.act)}</div>
        </div>
      </div>
      <div class="stats">
        <div><div class="label">Time</div><div class="value time">${formatFrames(content.frames)}</div></div>
        <div><div class="label">Coins</div><div class="value">${esc(content.coins)}</div></div>
        <div><div class="label">Event</div><div class="value small">${esc(name)}</div></div>
      </div>
      <p class="${check.ok ? 'good' : 'notice'}">${check.ok
        ? '✓ Signature verified on this phone — the leaderboard will accept this run.'
        : `⚠ ${esc(check.reason)} — the leaderboard will reject this run. You can still submit it; relays decide.`}</p>
      <details><summary class="sub">Signed run <span class="mono">${shortHex(event.id)}</span></summary>
        <pre>${esc(JSON.stringify(event, null, 2))}</pre>
        <p><button class="link" data-action="copy">Copy JSON</button>
          ${r ? ` · <a href="${esc(cabinetUrl(r.pubkey, r.eventName))}">cabinet page</a>` : ''}</p>
      </details>`;
}

// ---- the Submit screen

function renderSubmit(run) {
  stopCamera();
  const key = store.get().key;
  const existing = key && findRecord(store.get(), run.id, key.pubkey);
  if (existing) return renderRecord(recordKey(run.id, key.pubkey));
  view = { name: 'submit', run };
  app.innerHTML = `
    <section class="card run">
      ${runSummary(run)}
      <h3>Submit as</h3>
      <div id="identity"></div>
    </section>`;
  renderIdentity();
}

// Identity-field state lives here while the Submit screen is up.
let identity = { input: '', parsed: null, lookup: null, confirmForget: false, renaming: false, nameError: '' };

function renderIdentity() {
  const box = document.getElementById('identity');
  if (!box || view.name !== 'submit') return;
  const key = store.get().key;
  if (!key) {
    box.innerHTML = `
      <p><input id="ident" class="field" type="text" placeholder="Name or nsec" autocomplete="off" autocapitalize="off"
        spellcheck="false" aria-label="Name or nsec" value="${esc(identity.input)}"></p>
      <p id="ident-msg" class="sub" aria-live="polite"></p>
      <div class="actions"><button id="submit" data-action="submit">Submit</button></div>
      <p class="fine">Paste your nsec to post as your existing Nostr account, or type a name to get a new one.
        Either way the key stays on this phone.</p>`;
    const input = box.querySelector('#ident');
    input.oninput = () => onIdentityInput(input.value);
    updateIdentityMessage();
    return;
  }
  const hasClaims = recordsFor(store.get(), key.pubkey).length > 0;
  box.innerHTML = `
    <div class="actions"><button data-action="submit">${esc(keyLabel(key))} · Submit</button></div>
    <p class="fine"><button class="link" data-action="forget">Not you?</button>
      ${key.origin === 'generated' ? ' · <button class="link" data-action="rename">Change name</button>' : ''}</p>
    ${identity.confirmForget && key.origin === 'generated' && hasClaims ? `
      <p class="notice">This phone can't post as ${esc(keyLabel(key))} again after this. Its runs stay on the leaderboard.
        <br><button class="secondary" data-action="forget-confirm">Forget ${esc(keyLabel(key))}</button>
        <button class="link" data-action="forget-cancel">Keep</button></p>` : ''}
    ${identity.renaming ? `
      <p><input id="rename" class="field" type="text" aria-label="New name" value="${esc(key.name ?? '')}" autocomplete="off"></p>
      <p class="sub">${identity.nameError ? `<span class="bad-text">${esc(identity.nameError)}</span>`
        : 'The new name is published with your next Submit.'}</p>
      <p><button class="secondary" data-action="rename-save">Save name</button>
        <button class="link" data-action="rename-cancel">Cancel</button></p>` : ''}`;
}

function onIdentityInput(value) {
  identity.input = value;
  identity.parsed = value.trim() ? parseIdentityInput(value) : null;
  const p = identity.parsed;
  if (p?.kind === 'nsec' && identity.lookup?.sk !== p.sk) lookupName(p.sk);
  updateIdentityMessage();
}

/** Redraw the message and button, leaving the input the player is typing in alone. */
function updateIdentityMessage() {
  const msg = document.getElementById('ident-msg');
  const button = document.getElementById('submit');
  if (!msg || !button) return;
  const p = identity.parsed;
  msg.innerHTML = !p ? ''
    : p.kind === 'invalid' ? `<span class="bad-text">${esc(p.error)}</span>`
    : p.kind === 'name' ? `A key for <strong>${esc(p.name)}</strong> is made on this phone and remembered here.`
    : identity.lookup?.pending ? 'Looking up your name…'
    : `✓ ${esc(identity.lookup?.name ?? shortNpub(identity.lookup?.pubkey ?? ''))}`;
  button.disabled = !p || p.kind === 'invalid';
}

async function lookupName(sk) {
  const pubkey = pastedKey(sk, null).pubkey;
  identity.lookup = { sk, pubkey, pending: true, name: null };
  const events = await fetchEvents([...INDEXERS, ...RELAYS], { kinds: [0], authors: [pubkey] });
  const name = profileName(newestProfile(events, pubkey));
  if (identity.lookup?.sk === sk) identity.lookup = { sk, pubkey, pending: false, name };
  // The player may have tapped Submit before the lookup finished.
  const key = store.get().key;
  if (key?.pubkey === pubkey && key.origin === 'pasted' && !key.name && name) store.update((s) => setKey(s, { ...key, name }));
  updateIdentityMessage();
}

// ---- results for one Claim

function renderRecord(rk) {
  stopCamera();
  const record = store.get().claims[rk];
  view = { name: 'record', rk };
  app.innerHTML = `
    <section class="card run">
      ${runSummary(record.run)}
      <div id="live"></div>
    </section>`;
  renderLive();
}

function claimerLabel(record) {
  const key = store.get().key;
  if (key?.pubkey === record.claim.pubkey) return keyLabel(key);
  return profileName(record.profile) ?? shortNpub(record.claim.pubkey);
}

const ROLE_LABEL = {
  profile: 'Your name (kind 0)',
  run: 'Run',
  claim: 'Your Claim',
  pending: 'Timestamp proof, pending (ots-pending)',
  final: 'Timestamp proof, Bitcoin (NIP-03)',
};

function cellView(record, eventId, relay) {
  if (sending.has(`${eventId}|${relay}`)) return { cls: 'pending', text: 'sending…' };
  const c = record.sends[eventId]?.[relay];
  if (!c) return { cls: 'pending', text: 'not sent' };
  if (c.state === 'ok') return { cls: 'ok', text: c.message.startsWith('duplicate') ? 'already had it' : 'saved' };
  return { cls: 'bad', text: c.message || 'rejected' };
}

function renderLive() {
  const live = document.getElementById('live');
  if (!live || view.name !== 'record') return;
  const record = store.get().claims[view.rk];
  const { submitted } = submitStatus(record, TARGETS);
  const busy = isBusy(view.rk);
  const retryable = !busy && (plan(record, TARGETS).length > 0 || needsStamp(record));
  const check = checkRun(record.run);
  live.innerHTML = `
    <p class="sub">Claimed as <strong>${esc(claimerLabel(record))}</strong>
      · ${new Date(record.claim.created_at * 1000).toLocaleString()}</p>
    ${destinations(record, TARGETS).map(({ role, event, relays }) => `
      <h3>${esc(ROLE_LABEL[role])}</h3>
      <ul class="relays">${relays.map((relay) => {
        const c = cellView(record, event.id, relay);
        return `<li class="${c.cls}" data-event="${esc(event.id)}" data-relay="${esc(relay)}">${esc(relayName(relay))}<span class="msg">${esc(c.text)}</span></li>`;
      }).join('')}</ul>`).join('')}
    <p id="publish-summary" class="${submitted ? 'good' : 'sub'}">${esc(publishSummary(record, busy))}</p>
    <p id="ots-status" class="sub">${esc(otsLine(record, view.rk))}</p>
    <div class="actions">
      ${retryable ? '<button class="secondary" data-action="retry">Retry failed</button>' : ''}
      ${check.ok ? `<a class="button" href="${esc(starBoardUrl(check.run))}">See this star's leaderboard</a>` : ''}
      <button class="secondary" data-action="next">Scan next star</button>
      <button class="link" data-action="claims">My claims</button>
    </div>`;
}

function publishSummary(record, busy) {
  const { status, submitted } = submitStatus(record, TARGETS);
  if (submitted) {
    const dup = Object.values(record.sends[record.run.id] ?? {}).some((c) => c.state === 'ok' && c.message.startsWith('duplicate'));
    return `Submitted. The Run and your Claim are on the leaderboard's relays; they appear on its next refresh.${
      dup ? ' A relay already had this Run (maybe someone submitted it first); your Claim is what makes it yours.' : ''}`;
  }
  if (busy) return 'Submitting…';
  const missing = [status.run !== 'ok' && 'the Run', status.claim !== 'ok' && 'your Claim'].filter(Boolean).join(' and ');
  return `Not submitted yet: no relay accepted ${missing}. Retry when you have signal.`;
}

function otsLine(record, rk) {
  if (stamping.has(rk)) return 'Timestamping your Claim at the OpenTimestamps calendars…';
  const status = otsStatus(record.ots.file);
  const errors = Object.entries(record.ots.errors ?? {}).map(([cal, msg]) => `${calendarName(cal)}: ${msg}`).join('; ');
  if (status === 'none') return errors ? `Timestamp failed (${errors}). Retry to stamp again.` : 'Not timestamped yet.';
  if (status === 'pending') {
    return `Timestamp pending at ${record.ots.calendars.map(calendarName).join(', ')}${errors ? ` (failed: ${errors})` : ''}. `
      + 'Bitcoin confirms it in about 1–2 hours; this page finishes the proof when you come back, and so can anyone holding the published pending proof.';
  }
  const heights = bitcoinHeights(parseOts(decodeFile(record.ots.file)));
  return `Timestamp confirmed in Bitcoin block ${Math.min(...heights)}.`;
}

// ---- My claims

function renderClaims() {
  stopCamera();
  view = { name: 'claims' };
  const records = allRecords(store.get());
  app.innerHTML = `
    <section class="card">
      <h2>My claims</h2>
      ${records.length ? '' : '<p class="sub">No claims on this phone yet.</p>'}
      <div id="claims-list"></div>
      <div class="actions">
        <button data-action="camera">Scan a star</button>
      </div>
    </section>`;
  renderClaimsList();
  upgradeProofs();
}

function renderClaimsList() {
  const list = document.getElementById('claims-list');
  if (!list || view.name !== 'claims') return;
  list.innerHTML = allRecords(store.get()).map((record) => {
    const rk = recordKey(record.run.id, record.claim.pubkey);
    const content = safeJson(record.run.content) ?? {};
    const { submitted, needsRetry } = submitStatus(record, TARGETS);
    const busy = isBusy(rk);
    return `
      <div class="claim" data-rk="${esc(rk)}">
        <h3><span class="star">★</span> ${esc(starName(content.course, content.keyId))} · ${formatFrames(content.frames)}</h3>
        <p class="sub">${esc(courseName(content.course))} · as ${esc(claimerLabel(record))}
          · ${new Date(record.claim.created_at * 1000).toLocaleString()}</p>
        <p class="${submitted ? 'good' : 'notice'}">${esc(busy ? 'Submitting…' : submitted
          ? (needsRetry ? 'Submitted; some relays still owe a copy.' : 'Submitted.') : publishSummary(record, false))}</p>
        <p class="sub">${esc(otsLine(record, rk))}</p>
        <p>
          <button class="link" data-action="open" data-rk="${esc(rk)}">Details</button>
          ${!busy && (needsRetry || needsStamp(record)) ? ` · <button class="link" data-action="retry" data-rk="${esc(rk)}">Retry</button>` : ''}
          ${record.ots.file ? ` · <button class="link" data-action="download" data-rk="${esc(rk)}">Download proof (.ots)</button>` : ''}
        </p>
      </div>`;
  }).join('');
}

function redraw() {
  if (view.name === 'record') renderLive();
  else if (view.name === 'claims') renderClaimsList();
}

// ---------------------------------------------------------------- Submit

function submit(run) {
  let key = store.get().key;
  if (!key) {
    const p = identity.parsed;
    if (p?.kind === 'name') key = generatedKey(p.name, nowSec());
    else if (p?.kind === 'nsec') key = pastedKey(p.sk, identity.lookup?.sk === p.sk ? identity.lookup.name : null);
    else return;
    store.update((s) => setKey(s, key));
  }
  const rk = recordKey(run.id, key.pubkey);
  // One Claim per (Run, key), signed at the first tap and reused forever after.
  if (!findRecord(store.get(), run.id, key.pubkey)) store.update((s) => putRecord(s, startRecord(run, key, nowSec(), RELAYS[0])));
  renderRecord(rk);
  work(rk);
}

const isBusy = (rk) => {
  const record = store.get().claims[rk];
  return stamping.has(rk) || plan(record, TARGETS).some(({ event, relay }) => sending.has(`${event.id}|${relay}`));
};

const updateRecord = (rk, fn) => store.update((s) => putRecord(s, fn(s.claims[rk])));

/** Everything a Claim still owes: unsent or failed (event, relay) pairs, and a stamp if it has none. */
function work(rk) {
  sendOwed(rk);
  if (needsStamp(store.get().claims[rk])) stamp(rk);
}

/** Sends owed pairs (only those for event ids in `only`, if given) that aren't already in flight. */
async function sendOwed(rk, only = null) {
  const pairs = plan(store.get().claims[rk], TARGETS)
    .filter(({ event, relay }) => (!only || only.includes(event.id)) && !sending.has(`${event.id}|${relay}`));
  if (!pairs.length) return;
  for (const { event, relay } of pairs) sending.add(`${event.id}|${relay}`);
  redraw();
  await publishPairs(pairs, (res) => {
    sending.delete(`${res.eventId}|${res.relay}`);
    updateRecord(rk, (r) => applyResults(r, [res]));
    redraw();
  });
}

async function stamp(rk) {
  if (stamping.has(rk)) return;
  stamping.add(rk);
  redraw();
  try {
    const result = await stampDigest(store.get().claims[rk].claim.id);
    updateRecord(rk, (r) => withStamp(r, result, store.get().key, nowSec()));
  } finally {
    stamping.delete(rk);
  }
  redraw();
  // Only the new proof carrier: earlier failures wait for the player's Retry.
  const { pending } = store.get().claims[rk];
  if (pending) sendOwed(rk, [pending.id]);
}

/** Finish pending proofs an hour or more old; publish the 1040 the moment Bitcoin attests. */
async function upgradeProofs() {
  const due = allRecords(store.get()).filter((r) => upgradeDue(r, Date.now()));
  await Promise.all(due.map(async (record) => {
    const rk = recordKey(record.run.id, record.claim.pubkey);
    if (upgrading.has(rk)) return;
    upgrading.add(rk);
    try {
      const { file } = await upgradeOts(decodeFile(record.ots.file));
      updateRecord(rk, (r) => withUpgrade(r, file, Date.now(), RELAYS[0]));
    } finally {
      upgrading.delete(rk);
    }
    redraw();
    const { final } = store.get().claims[rk];
    if (final) sendOwed(rk, [final.id]);
  }));
}

function download(rk) {
  const record = store.get().claims[rk];
  const url = URL.createObjectURL(new Blob([decodeFile(record.ots.file)], { type: 'application/octet-stream' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `claim-${record.claim.id.slice(0, 12)}.ots` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- identity actions

function forgetKey() {
  identity = { input: '', parsed: null, lookup: null, confirmForget: false, renaming: false, nameError: '' };
  store.update((s) => setKey(s, null));
  renderIdentity();
}

function onForget() {
  const key = store.get().key;
  if (key.origin === 'generated' && recordsFor(store.get(), key.pubkey).length) {
    identity.confirmForget = true;
    renderIdentity();
  } else {
    forgetKey();
  }
}

function saveName() {
  const v = validateName(document.getElementById('rename')?.value ?? '');
  if (!v.ok) {
    identity.nameError = v.error;
    return renderIdentity();
  }
  store.update((s) => setKey(s, renameKey(s.key, v.name, nowSec())));
  identity.renaming = false;
  identity.nameError = '';
  renderIdentity();
}

// ---------------------------------------------------------------- misc

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch { /* clipboard blocked; the JSON is on screen */ }
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- frames

/** Feed one scanned/opened string; returns true once the scan is finished. */
function accept(text) {
  const res = collector.add(text);
  if (res.kind === 'complete') {
    collector.reset();
    renderSubmit(res.event);
    return true;
  }
  if (res.kind === 'error') {
    renderIdle(`That QR didn't decode: ${res.error.message || res.error}`);
    return true;
  }
  if (res.kind === 'progress') renderProgress(res.restarted);
  return false;
}

async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    renderIdle('The camera needs this page opened over https in a full browser (Safari or Chrome).');
    return;
  }
  renderScanning();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    renderIdle(`Couldn't open the camera (${e.name || e}). Allow camera access and try again.`);
    return;
  }
  if (!detector && 'BarcodeDetector' in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) detector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch { /* fall back to jsQR */ }
  }
  raf = requestAnimationFrame(tick);
}

function stopCamera() {
  cancelAnimationFrame(raf);
  raf = 0;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video = null;
}

async function tick() {
  if (!video || !stream) return;
  if (video.readyState >= video.HAVE_ENOUGH_DATA && !detecting) {
    detecting = true;
    try {
      for (const text of await scanFrame()) if (accept(text)) return;
    } finally {
      detecting = false;
    }
  }
  if (stream) raf = requestAnimationFrame(tick);
}

async function scanFrame() {
  if (detector) {
    try {
      return (await detector.detect(video)).map((c) => c.rawValue);
    } catch {
      detector = null; // broken native detector: use jsQR from now on
    }
  }
  const scale = Math.min(1, MAX_SCAN_WIDTH / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  return code?.data ? [code.data] : [];
}

// ---------------------------------------------------------------- boot

/** The URL this page was opened with is itself a frame (the camera app scanned it). */
function bootstrap() {
  collector.reset();
  if (!location.hash || location.hash === '#') return renderIdle();
  if (accept(location.href)) return;
  if (collector.count) {
    // Multi-frame capture: we have one frame, the camera gets the rest.
    startCamera().then(() => renderProgress());
  } else {
    renderIdle();
  }
}

function clearHash() {
  history.replaceState(null, '', location.pathname + location.search);
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, rk } = el.dataset;
  if (action === 'camera') startCamera();
  else if (action === 'cancel') {
    collector.reset();
    renderIdle();
  } else if (action === 'next') {
    clearHash();
    collector.reset();
    startCamera();
  } else if (action === 'claims') {
    clearHash();
    renderClaims();
  } else if (action === 'open') renderRecord(rk);
  else if (action === 'retry') work(rk ?? view.rk);
  else if (action === 'download') download(rk);
  else if (action === 'copy') copy(JSON.stringify(view.run ?? store.get().claims[view.rk]?.run));
  else if (action === 'submit' && view.name === 'submit') submit(view.run);
  else if (action === 'forget') onForget();
  else if (action === 'forget-confirm') forgetKey();
  else if (action === 'forget-cancel') {
    identity.confirmForget = false;
    renderIdentity();
  } else if (action === 'rename') {
    identity.renaming = true;
    renderIdentity();
  } else if (action === 'rename-save') saveName();
  else if (action === 'rename-cancel') {
    identity.renaming = false;
    identity.nameError = '';
    renderIdentity();
  }
});
window.addEventListener('hashchange', bootstrap);
bootstrap();
upgradeProofs();

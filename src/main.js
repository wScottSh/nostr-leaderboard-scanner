/*
 * main.js -- the page a phone opens from a cabinet's star QR.
 *
 *   1. The opening URL's own #fragment is the first frame. For a one-frame
 *      capture that's the whole event: no camera needed.
 *   2. Otherwise the page grabs the camera and collects the rest of the
 *      cycling frames (FrameCollector).
 *   3. The event is checked locally (checkRun -- informational, never gates),
 *      published to the leaderboard's relays, and deep-linked to its star
 *      board on nostr-leaderboard.
 */
import jsQR from 'jsqr';
import { FrameCollector } from './collector.js';
import { checkRun } from './verify.js';
import { RELAYS, publishPairs } from './relay.js';
import { starBoardUrl, cabinetUrl, LEADERBOARD_URL } from './links.js';
import { courseName, starName, formatFrames, COURSES } from './stars.js';

const app = document.getElementById('app');
const collector = new FrameCollector();
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const MAX_SCAN_WIDTH = 1280;

let video = null;
let stream = null;
let raf = 0;
let detector = null;
let detecting = false;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const shortHex = (h) => `${h.slice(0, 8)}…${h.slice(-4)}`;

// ---------------------------------------------------------------- views

function renderIdle(message = '') {
  stopCamera();
  app.innerHTML = `
    <section class="card center">
      <div class="big-star star">★</div>
      <h2>Scan a star</h2>
      <p class="sub">Grab a star on the cabinet, then point your camera at the QR code it shows.
        Nothing is installed and nothing about you is sent — only the cabinet's signed run.</p>
      ${message ? `<p class="notice">${esc(message)}</p>` : ''}
      <p><button data-action="camera">Start camera</button></p>
      <p class="fine"><a href="${LEADERBOARD_URL}">Open the leaderboard</a></p>
    </section>`;
}

function renderScanning() {
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

function renderResult(event) {
  stopCamera();
  const check = checkRun(event);
  const r = check.ok ? check.run : null;
  const content = safeJson(event.content) ?? {};
  const name = event.tags.find((t) => t[0] === 'n')?.[1] ?? '';
  const course = content.course;
  const keyId = content.keyId;

  app.innerHTML = `
    <section class="card run">
      <div class="run-head">
        <span class="abbr">${esc(COURSES[course]?.abbr ?? course)}</span>
        <div>
          <h2><span class="star">★</span> ${esc(starName(course, keyId))}</h2>
          <div class="sub">${esc(courseName(course))} · act ${esc(content.act)}</div>
        </div>
      </div>
      <div class="stats">
        <div><div class="label">Time</div><div class="value time">${formatFrames(content.frames)}</div></div>
        <div><div class="label">Coins</div><div class="value">${esc(content.coins)}</div></div>
        <div><div class="label">Event</div><div class="value small">${esc(name)}</div></div>
      </div>
      <p class="${check.ok ? 'good' : 'notice'}">${check.ok
        ? '✓ Signature verified on this phone — the leaderboard will accept this run.'
        : `⚠ ${esc(check.reason)} — the leaderboard will reject this run. Broadcasting anyway; relays decide.`}</p>
      <h3>Publishing</h3>
      <ul class="relays">${RELAYS.map((u) => `<li data-relay="${esc(u)}" class="pending">${esc(u.replace(/^wss:\/\//, ''))}<span class="msg">sending…</span></li>`).join('')}</ul>
      <p id="publish-summary" class="sub"></p>
      <div class="actions">
        ${r ? `<a class="button" href="${esc(starBoardUrl(r))}">See this star's leaderboard</a>` : ''}
        <button class="secondary" data-action="next">Scan next star</button>
      </div>
      <details><summary class="sub">Signed event <span class="mono">${shortHex(event.id)}</span></summary>
        <pre>${esc(JSON.stringify(event, null, 2))}</pre>
        <p><button class="link" data-action="copy">Copy JSON</button>
          ${r ? ` · <a href="${esc(cabinetUrl(r.pubkey, r.eventName))}">cabinet page</a>` : ''}</p>
      </details>
    </section>`;
  app.querySelector('[data-action="copy"]').onclick = () => copy(JSON.stringify(event));
  publish(event);
}

function renderError(err) {
  renderIdle(`That QR didn't decode: ${err.message || err}`);
}

// ---------------------------------------------------------------- publishing

async function publish(event) {
  const results = await publishPairs(RELAYS.map((relay) => ({ event, relay })), (res) => {
    const li = app.querySelector(`li[data-relay="${CSS.escape(res.relay)}"]`);
    if (!li) return;
    li.className = res.ok ? 'ok' : 'bad';
    li.querySelector('.msg').textContent = res.ok ? (res.message.startsWith('duplicate') ? 'already had it' : 'saved') : res.message;
  });
  const summary = document.getElementById('publish-summary');
  if (!summary) return;
  const okCount = results.filter((r) => r.ok).length;
  summary.innerHTML = okCount
    ? `Saved to ${okCount} of ${results.length} relays. It will appear on the leaderboard on its next refresh.`
    : `No relay accepted the run. <button class="link" data-action="retry">Try again</button>`;
  const retry = summary.querySelector('[data-action="retry"]');
  if (retry) retry.onclick = () => renderResult(event);
}

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
    renderResult(res.event);
    return true;
  }
  if (res.kind === 'error') {
    renderError(res.error);
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

document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'camera') startCamera();
  else if (action === 'cancel') {
    collector.reset();
    renderIdle();
  }
  else if (action === 'next') {
    history.replaceState(null, '', location.pathname + location.search);
    collector.reset();
    startCamera();
  }
});
window.addEventListener('hashchange', bootstrap);
bootstrap();

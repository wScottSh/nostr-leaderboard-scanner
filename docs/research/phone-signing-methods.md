# How an existing Nostr key can sign from a phone web page

Research for issue #2 (child of map #1). Question: a **static** mobile web page, opened from the phone's stock camera app via a QR URL (so it runs in Safari, Chrome, or the camera's in-app browser), needs a person's **existing** Nostr key to sign a **Claim** at **Submit**. What are the ways, and what does each cost?

Facts only. This doc does not recommend a method; that decision belongs to ticket #3.

- Researched 2026-09-23.
- NIP texts read from `nostr-protocol/nips` master @ `182a13e3be` (2026-09-23).
- App facts come from each project's own README, manifest, or source on its default branch as of that date.
- **Unverified** marks anything not confirmed against a primary source or a live run. Nothing here was tested on a real phone.

## What the page needs from the key, whatever the method

The Run is already signed by the cabinet, so it's published verbatim. For an existing key, the only thing that needs the player's signature is the **Claim**: one `sign_event` call. To show the "Post as <name>?" prompt *before* Submit, the page needs two things first:

1. **The pubkey.** Each method has its own way to get it; see each section.
2. **The kind-0 name.** Kind 0 is replaceable user metadata. Its `content` is stringified JSON with `name` ([NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)). [NIP-24](https://github.com/nostr-protocol/nips/blob/master/24.md) adds `display_name` and says "`name` should always be set regardless of the presence of `display_name`". Query with `{"kinds":[0],"authors":[<hex>],"limit":1}` and keep the newest `created_at`.

**Which relays to ask for kind 0.** No signing method below hands the page the user's relays: NIP-07 has no relay method in the spec, NIP-46's `get_public_key` returns only the pubkey, and NIP-55 has no relay method. Your options:

- **Public indexer relays that store kind 0.** Checked live via NIP-11 on 2026-09-23:
  - `wss://purplepag.es` reports `"attributes":["Indexer","Metadata","Lists"]` and `created_at_lower_limit: 0`.
  - `wss://user.kindpag.es` says it "Stores kind 0, 3 and 10002 events".
  - `wss://indexer.coracle.social` accepts **only kind 10002**. It's useful for step 1 of the outbox route below, not for kind 0 directly.
- **The outbox route ([NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md)).** Fetch the user's kind `10002` relay list (from an indexer), then query their **write** relays. NIP-65: "When downloading events **from** a user, clients SHOULD use the **write** relays of that user."
- **The page's own configured relays.** These only work if the user happens to publish there.

**If no kind 0 is found**, the page has a pubkey and no name. The protocol says nothing about that case; it's an open question for #3.

## 1. NIP-07 `window.nostr`

**Spec.** [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md) (`draft` `optional`): "The `window.nostr` object may be made available by web browsers or extensions". Required methods are `getPublicKey()`, which returns hex, and `signEvent({created_at, kind, tags, content})`, which returns the event with `id`, `pubkey`, and `sig` added. The page checks that `window.nostr` exists, then calls these directly. There's no reload and no app switch. The extension shows its own approval prompt.

**Getting the pubkey.** `await window.nostr.getPublicKey()`.

**What actually provides `window.nostr` on a phone today**, per each provider's own source:

| Provider | Platform | Where `window.nostr` exists | Status (source) |
|---|---|---|---|
| **Nostash** (Safari web extension) | iOS / iPadOS 18+, Safari 18+ | Safari, once the extension is installed and enabled | README: "NIP-07 compatible Safari extension … works on iPhone, iPad, and Mac". On the App Store (id6744309333). Last release 2.1.0, 2025-06-24. [tyiu/nostash](https://github.com/tyiu/nostash) |
| Nostore (its predecessor) | macOS Safari | — | **Archived**. README: "no longer in support … will drop off the App Store". [ursuscamp/nostore](https://github.com/ursuscamp/nostore) |
| **nos2x-fox** | Firefox for Android | Firefox for Android | AMO API: v1.21.0 declares `android: {min: 128.0}` compatibility. Updated 2026-09-21. [diegogurpegui/nos2x-fox](https://github.com/diegogurpegui/nos2x-fox), [AMO](https://addons.mozilla.org/en-US/firefox/addon/nos2x-fox/) |
| **Alby** extension | Firefox for Android | Firefox for Android | README: "✅ Firefox desktop and mobile". AMO v3.15.0 declares `android: {min: 120.0}`. [getAlby/lightning-browser-extension](https://github.com/getAlby/lightning-browser-extension) |
| nos2x | Chromium desktop | — | README: "This extension is Chromium-only". The phone equivalent is the fox fork. [fiatjaf/nos2x](https://github.com/fiatjaf/nos2x) |
| **Nowser** | Android, iOS (TestFlight only) | **Only inside Nowser's built-in browser**. `window.nostr` is injected in `lib/component/webview/webview_component.dart`. | README platform table: NIP-07 ✓ on Android and iOS. iOS is distributed via TestFlight. Latest release 1.4.1, 2025-12-12. [haorendashu/nowser](https://github.com/haorendashu/nowser) |
| **Aegis** | iOS (TestFlight), Android | **Only inside Aegis's in-app browser** | README: "Inject `window.nostr` in the in-app browser". Latest release v0.5.1, 2026-05-12. [ZharlieW/Aegis](https://github.com/ZharlieW/Aegis) |
| Kiwi Browser | Android | — | README: "Kiwi Browser is now archived. It will no longer be maintained after January 2025." It points users to Edge Canary's developer-only "Extension install by id". [kiwibrowser/src.next](https://github.com/kiwibrowser/src.next) |
| Chrome (Android or iOS) | — | None | No extension support on phones. The only first-party signal found: Chrome Web Store help offers "Add to Desktop" from a phone, not install ([support](https://support.google.com/chrome_webstore/answer/2664769)). **No explicit Google statement found.** |

**How this plays out from a camera-scanned QR.**

- **iOS.** Apple support: the Camera app "shows a notification. Tap the notification to open the link" ([Apple](https://support.apple.com/en-us/102680)).
  - That link opening in the user's default browser, and whether the Control Center Code Scanner uses an in-app view where Safari extensions don't run: **unverified**.
  - NIP-07 therefore only works when the link lands in **real Safari** and Nostash is installed and enabled for the site. Per-site permission prompts are standard Safari web-extension behavior (**unverified for Nostash specifically**).
- **Android.** Which browser the stock camera (or Google Lens) hands the URL to varies by OEM: **unverified**.
  - NIP-07 only works if that browser is Firefox with nos2x-fox or Alby installed. Chrome, the usual default, has no NIP-07.
- **Nowser and Aegis** provide NIP-07 only if the user opens the URL *inside* those apps. A QR scanned with the stock camera doesn't land there, so the user must copy the URL into the app.

**Friction.** When present, it's the lowest of any method: 1 approval tap in the extension prompt, 0 app switches, 0 reloads. Share of phone users who have it: small (**unmeasured**). It requires a pre-installed extension in a non-default setup: Safari plus Nostash on iOS, Firefox plus an add-on on Android.

**Security norm.** The key stays in the extension. This is the pattern that signer projects describe as not giving web apps your keys. nos2x README: "sign Nostr events on web-apps without having to give them your keys."

## 2. Pasting an `nsec` (or a NIP-49 `ncryptsec`)

**Mechanics.** The page shows a text field and decodes bech32 `nsec` per [NIP-19](https://github.com/nostr-protocol/nips/blob/master/19.md). NIP-19 says bech32 keys are "only meant for displaying to users, copy-pasting, sharing, rendering QR codes and inputting data". The page derives the pubkey locally with secp256k1 and signs locally. It works in every browser on every platform with no extension or app.

**Getting the pubkey.** Derived from the secret key, with no network needed. Then the kind-0 lookup described above.

**`ncryptsec` ([NIP-49](https://github.com/nostr-protocol/nips/blob/master/49.md), `draft` `optional`).**

- The format is a password-encrypted key: scrypt (user-chosen `LOG_N`; the spec's table shows 16 = 64 MiB, ~100 ms "on fast computer"), then XChaCha20-Poly1305, then bech32 `ncryptsec`.
- The page asks for the string plus the password, decrypts locally, then behaves as with `nsec`.
- NIP-49 records a `KEY_SECURITY_BYTE` of `0x00` "if the key has been known to have been handled insecurely (stored unencrypted, cut and paste unencrypted, etc)". In other words, the spec itself classes cut-and-paste of an unencrypted key as insecure handling.
- Scrypt time and memory at `LOG_N` 16 or higher on a mid-range phone browser: **unverified**.

**Community and NIP stance.**

- **No NIP forbids** a web app from accepting an nsec.
- The signing NIPs do state their reason for existing as avoiding exactly this:
  - NIP-46 Rationale: "Private keys should be exposed to as few systems - apps, operating systems, devices - as possible as each system adds to the attack surface."
  - NIP-55 Rationale: "so that the client never needs to handle the user's private key."
  - Amber README quotes the NIP-46 line and aims to keep "your nsec segregated in a single, dedicated app".
- Secondary guides go further ("Never paste your real nsec into a client"), but those are not primary sources.
- Whether mainstream web clients still offer nsec login in 2026 was **not surveyed**.

**Friction.**

- The user has to *have the nsec to hand*. People who use a signer app or extension may not know it or be able to export it easily (**unverified**, varies by app).
- Cost: 1 app switch to a password manager or signer to copy it, 1 paste, 0 reloads. Add one password entry for `ncryptsec`.
- Ongoing: if the page keeps the key for later scans, it holds a raw secret in browser storage. That overlaps with map #1's open question about generated key vs. existing key coexistence. The map already excludes revealing the nsec.

## 3. NIP-55 Android signer (Amber and others) via `nostrsigner:` + `callbackUrl`

**Spec.** [NIP-55](https://github.com/nostr-protocol/nips/blob/master/55.md) (`draft` `optional`), section "Using Web Applications".

- Web clients "can't receive a result from an intent". Instead, the signer returns the result by navigating to `callbackUrl` with the result appended, or, if there's no `callbackUrl`, by copying it to the clipboard.
- Request format: `nostrsigner:<payload>?type=<method>&callbackUrl=https://example.com/?result=`.
- Other params: `returnType` (`signature` or `event`) and `compressionType` (`none` or `gzip`). With `gzip`, the result is `"Signer1"` + Base64(gzip(json)), because "intents and URLs have length limits".
- The spec itself advises: "Consider using NIP-46 … for web applications. With the approach here the web client can't call the signer in the background, so the user sees a popup for every request."
- The installed-signer check (`queryIntentActivities`) is Android-app-only. **A web page has no spec'd way to detect whether a signer is installed.** What a browser does with an unhandled `nostrsigner:` link: **unverified**.

**Exact flow for a static page** (two round trips: one to learn the pubkey for the prompt, one to sign the Claim):

1. The user taps a link or button. The page navigates to `nostrsigner:?type=get_public_key&callbackUrl=<page-url>?pk=`.
2. Android opens the signer. The user approves.
3. The signer launches `callbackUrl` + the URL-encoded pubkey. Verified in Amber source (`IntentUtils.kt`): `Intent(ACTION_VIEW)` with data = `callBackUrl + Uri.encode(value)`, then `startActivity`.
   - This is a **fresh navigation that the OS routes to a browser**. Whether it lands in the same tab or a new one: **unverified**.
   - `sessionStorage` is per-tab, so page state such as the decoded Run must be kept in `localStorage` or encoded into the callback URL itself.
4. The page reloads with `?pk=<hex>`, fetches kind 0, and shows "Post as <name>?".
5. On Submit, the page navigates to `nostrsigner:<urlencoded unsigned Claim JSON>?type=sign_event&returnType=event&callbackUrl=<page-url>?claim=`. The user approves in the signer.
6. The page reloads with the signed event, or with just the `sig` if `returnType=signature`. It then publishes the Run and the Claim.

The result is 2 app switches out and 2 back (automatic), 2 approval taps, and **2 full page reloads**. That's ≥4 context switches.

**Implementation details found in signer source** (these matter for building the `callbackUrl`):

- **Amber** splits the `nostrsigner:` query on every `&` and recognizes `type`, `pubkey`, `compressionType`, `callbackUrl`, `returnType`, `appName`, `kind`, `scope`. So a `callbackUrl` containing a raw `&` gets split apart. The callback URL should carry at most one query param, or be fully percent-encoded. How Amber decodes an encoded callback: **unverified**.
- Amber also accepts an `appName` param. It isn't in NIP-55.
- **Nowser** ([`app_links_service.dart`](https://github.com/haorendashu/nowser/blob/master/lib/provider/app_links_service.dart)):
  - Handles `nostrsigner:` URLs with `type` and `callbackUrl` on **both Android and iOS**. The iOS `Info.plist` registers the `nostrsigner` scheme.
  - Explicitly ignores `returnType` and `compressionType`, and for `sign_event` **always returns only the `sig`**. So the page must rebuild the full event itself (compute `id`, set `pubkey` from the earlier `get_public_key`).
  - Appends the result with `Uri.encodeComponent` and opens it with `launchUrl`.
- **Aegis**: registers `nostrsigner` on Android and iOS. Its documented iOS use is an x-callback-url NIP-46 connect helper (`nostrsigner://x-callback-url/auth/nip46?...`), not NIP-55 web signing. Its NIP-55 handler reads `callbackUrl` but no use of it was found. Web `callbackUrl` support: **unverified**.
- **Primal Android** (2.6.18, 2026-01-05, release notes "Android Signer (NIP-55)"): registers `nostrsigner`, but a code search found no `callbackUrl` handling. It's likely intent-only for native apps, so **web flow unverified / probably unsupported**.

**Platform availability.**

- **Android**: Amber (F-Droid, Zapstore, GitHub; latest v6.6.5, 2026-09-21), Nowser, Primal (intent-only, likely), Aegis (unverified for web).
- **iOS**: NIP-55 is an Android spec. Only Nowser (TestFlight) implements the web URL flow there, per its source. **Not tested.**

**Getting the pubkey.** `type=get_public_key` round trip, as above. NIP-55 says clients "SHOULD NOT call `get_public_key` again while the user stays logged in". A page that stores the pubkey in `localStorage` can skip step 1 on later scans, leaving one round trip per Claim.

**Security norm.** The key stays in the signer app, and the user sees the exact event. NIP-55's own note steers web apps toward NIP-46.

## 4. NIP-46 remote signing: `nostrconnect://` and `bunker://`

**Spec.** [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md).

- The page generates a disposable **client keypair**. It "might choose to store it locally", and it talks to the signer through **kind 24133** events, NIP-44 encrypted, over relays.
- Kind 24133 is in the **ephemeral** range. NIP-01: `20000 <= n < 30000` "are not expected to be stored by relays". So the page **must be connected and subscribed when the signer answers**, or it misses the reply.
- After connecting, the client "must call `get_public_key`" (per the NIP's Changes section) because `remote-signer-pubkey` ≠ `user-pubkey` in general.

**Two ways to connect a static page:**

- **`nostrconnect://` (the client starts it).**
  1. The page builds `nostrconnect://<client-pubkey>?relay=…&secret=…&perms=sign_event:<ClaimKind>&name=…&url=…`. `relay` and `secret` are required, and the page "MUST validate the `secret`" in the `connect` response.
  2. On a phone, the user can't scan a QR shown on the same phone, so the page offers it as a **tappable link**, which opens a signer app that registers the scheme, or as a copy button. The NIP-46 appendix also defines `nostrconnect_url` templates (NIP-05 / NIP-89) for redirecting to web signers.
  3. The signer sends the `connect` response to the page's relay.
  4. The user returns to the browser. That switch back is **manual**: NIP-46 defines no callback. Aegis's iOS x-callback returns only to app schemes (**unverified for https**).
  5. The page calls `get_public_key`, then later `sign_event` for the Claim.
- **`bunker://` (the signer starts it).**
  1. The user opens the signer, copies `bunker://<remote-signer-pubkey>?relay=…&secret=…`, returns, and pastes it into the page.
  2. The page sends `connect`, which "SHOULD include `optional_client_metadata`", then `get_public_key`, then `sign_event`.
  3. The secret is single-use.

**Signers that handle NIP-46, per their own source:**

| Signer | Platform | `nostrconnect://` link handler | `bunker://` | Background answering |
|---|---|---|---|---|
| **Amber** (`free` flavor) | Android | Yes: `free/AndroidManifest.xml` registers `nostrconnect`. The `offline` flavor does not. | Yes (README: NIP-46 signer) | `ConnectivityService`, `foregroundServiceType="specialUse"` |
| **Primal** | Android, iOS | Yes. Android manifest and iOS `Info.plist` both register `nostrconnect`. | **Unverified** | iOS `UIBackgroundModes: audio`. A secondary source (Nostr Compass #4) says this keeps it alive for NIP-46; purpose not confirmed in source. Android release 2.6.18 "Remote Signer (NIP-46)"; 3.0.21 "auto-reconnect in remote signer". |
| **Aegis** | iOS (TestFlight), Android | **No** `nostrconnect` scheme registered (only `aegis`, `nostrsigner`). Connects via paste, or via `aegis://x-callback-url/auth/nip46?nostrconnect=…` from an app. | Yes: "supports `bunker://` and Nostr Connect URI" | iOS `UIBackgroundModes: audio`; local relay `wss://127.0.0.1:28443` |
| **Nowser** | Android, iOS (TestFlight) | NIP-46 ✓ per README; code has nostrconnect handling. Link scheme registration **not checked**. | **Unverified** | **Unverified** |
| **nsec.app** (web signer, "Noauth") | Any browser | Web app (**nostrconnect_url flow unverified**) | Yes (README: "provides nip46 access to apps") | Service worker plus push wake-up. Its README warns: "if signer is on mobile - if your phone is locked then service worker might not wake up". Repo last pushed 2025-05-26. |
| Nostrum | iOS / Android | — | — | Reference implementation. Last push 2023-12, TestFlight/Expo builds only. Treat as stale. |

**Same-phone timing problem.** This follows from the spec plus OS behavior; the OS behavior is **unverified**.

- While the user is in the signer app, the browser tab is backgrounded. Mobile browsers may suspend its JavaScript and websockets.
- Kind 24133 replies are ephemeral. If the page's subscription is down when the signer publishes the `connect` or `sign_event` response, the reply may be lost.
- The page must be built to resubscribe and re-send on return. The request `id` is reused, and a relay that happens to still hold the event may help, but nothing guarantees it.
- On iOS, the signer app itself must still be running to answer a `sign_event` sent after the user has come back to the browser. That's why Primal and Aegis carry audio background modes.

**Getting the pubkey.** The `get_public_key` RPC after `connect`, then the kind-0 lookup above. For later scans, the page can keep the client keypair, signer pubkey, relays, and user pubkey in `localStorage` and skip the connect step. The session persists until `logout`, or until the signer drops it.

**Friction.**

- `nostrconnect://` link, first time: 1 tap on the link, then an app switch to the signer and 1 approval. Then a manual switch back. Then at Submit, `sign_event` needs the signer to approve: 1 more switch, approve, switch back, unless the signer auto-approves the pre-granted `perms=sign_event:<kind>`. That's ≥2–4 app switches, **0 page reloads**, plus relay round-trip latency.
- `bunker://`: the same, with copy/paste instead of a link tap.
- Repeat scans with a stored session: 1 `sign_event` approval (0 switches if auto-approved).

**Security norm.** This is the NIP the ecosystem frames as the web answer. NIP-55 itself says "Consider using NIP-46 … for web applications". The key never touches the page.

## Friction-ranked comparison (first use on a phone, existing key)

"Taps" counts only the signing-related steps. It excludes Submit itself and the page's own confirm prompt.

| Rank | Method | iOS | Android | App switches | Page reloads | Signing taps | Needs pre-installed | Key exposure to page |
|---|---|---|---|---|---|---|---|---|
| 1 | NIP-07 (when present) | Safari + Nostash only | Firefox + nos2x-fox / Alby only | 0 | 0 | 1–2 (prompt(s)) | Extension, in a non-default browser setup | None |
| 2 | Paste `nsec` | Yes | Yes | 1 (to fetch the key) | 0 | 1 paste | Nothing | **Full secret** |
| 2b | Paste `ncryptsec` | Yes | Yes | 1 | 0 | 1 paste + password | Nothing | Full secret after decrypt |
| 3 | NIP-46 `nostrconnect://` link | Primal (link); Aegis (paste) | Amber, Primal | 2–4, manual return | 0 (state stays in page) | 2+ approvals (fewer if perms pre-granted) | Signer app | None |
| 4 | NIP-46 `bunker://` paste | Primal?, Aegis, nsec.app | Amber, nsec.app | 2–4 plus copy/paste | 0 | 2+ approvals | Signer app or web signer | None |
| 5 | NIP-55 `nostrsigner:` + `callbackUrl` | Nowser (TestFlight) only | Amber, Nowser | 4 (2 out, 2 automatic back) | **2** | 2 approvals | Signer app | None |

Repeat scans with stored state: NIP-07 stays at 1 tap. Stored-nsec needs 0 taps. NIP-46 with a stored session needs about 1 approval. NIP-55 with a stored pubkey needs 1 round trip (1 reload).

The ranking reflects step counts from the specs and source only. Real-device behavior (tab reuse on callback, backgrounded websockets, camera-to-browser routing) is **unverified** and could reorder rows 3–5.

## Unverified items to confirm on devices before relying on them

1. The browser that iOS Camera and Code Scanner, and Android stock camera and Lens, open QR URLs in, and whether that's an in-app view without extensions.
2. Whether Amber's or Nowser's `callbackUrl` navigation reuses the existing tab or opens a new one, in Chrome for Android and in Safari.
3. What a browser does with `nostrsigner:` or `nostrconnect://` when no handler app is installed.
4. Whether iOS Safari or Android Chrome suspend websockets while the user is in the signer app, and so drop ephemeral kind-24133 replies.
5. Aegis web `callbackUrl` support; Primal `bunker://` support and web NIP-55 support; Nowser `nostrconnect://` link registration; nsec.app's `nostrconnect_url` flow.
6. Nostash's per-site permission UX on iOS.
7. How many phone users actually have any of these installed. This is unmeasured.

## Sources

- NIPs (master @ `182a13e3be`): [01](https://github.com/nostr-protocol/nips/blob/master/01.md), [07](https://github.com/nostr-protocol/nips/blob/master/07.md), [19](https://github.com/nostr-protocol/nips/blob/master/19.md), [24](https://github.com/nostr-protocol/nips/blob/master/24.md), [46](https://github.com/nostr-protocol/nips/blob/master/46.md), [49](https://github.com/nostr-protocol/nips/blob/master/49.md), [55](https://github.com/nostr-protocol/nips/blob/master/55.md), [65](https://github.com/nostr-protocol/nips/blob/master/65.md)
- Amber: [README](https://github.com/greenart7c3/Amber), [`IntentUtils.kt`](https://github.com/greenart7c3/Amber/blob/master/app/src/main/java/com/greenart7c3/nostrsigner/service/IntentUtils.kt), [`free/AndroidManifest.xml`](https://github.com/greenart7c3/Amber/blob/master/app/src/free/AndroidManifest.xml), [`main/AndroidManifest.xml`](https://github.com/greenart7c3/Amber/blob/master/app/src/main/AndroidManifest.xml)
- Nowser: [README](https://github.com/haorendashu/nowser), [`app_links_service.dart`](https://github.com/haorendashu/nowser/blob/master/lib/provider/app_links_service.dart), [`ios/Runner/Info.plist`](https://github.com/haorendashu/nowser/blob/master/ios/Runner/Info.plist)
- Aegis: [README](https://github.com/ZharlieW/Aegis), [iOS_URL_SCHEME_REDIRECTION.md](https://github.com/ZharlieW/Aegis/blob/main/iOS_URL_SCHEME_REDIRECTION.md), `ios/Runner/Info.plist`, `android/app/src/main/AndroidManifest.xml`, `lib/nostr/nips/nip55/nip55_handler.dart`
- Primal: [Android releases](https://github.com/PrimalHQ/primal-android-app/releases) (2.6.18, 3.0.21), Android `AndroidManifest.xml`, iOS [`Primal/Info.plist`](https://github.com/PrimalHQ/primal-ios-app/blob/main/Primal/Info.plist); secondary: [Nostr Compass #4](https://buttondown.com/nostrcompass/archive/nostr-compass-4/)
- Nostash [README](https://github.com/tyiu/nostash); Nostore [README](https://github.com/ursuscamp/nostore); nos2x [README](https://github.com/fiatjaf/nos2x); nos2x-fox [README](https://github.com/diegogurpegui/nos2x-fox); Alby [README](https://github.com/getAlby/lightning-browser-extension); AMO API `addons.mozilla.org/api/v5/addons/addon/{nos2x-fox,alby}/`
- Kiwi [README](https://github.com/kiwibrowser/src.next); nsec.app / Noauth [README](https://github.com/nostrband/noauth); Nostrum [README](https://github.com/nostr-connect/nostrum)
- Relay NIP-11 docs fetched 2026-09-23: `purplepag.es`, `user.kindpag.es`, `indexer.coracle.social`
- Apple: [Scan a QR code with your iPhone or iPad](https://support.apple.com/en-us/102680). Google: [Chrome Web Store help](https://support.google.com/chrome_webstore/answer/2664769)

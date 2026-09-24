# How a Claim can prove it came first (seconds, not a Bitcoin block)

Research for issue #9 (child of map #1). The question: two Claims for the same Run, both anchored by OpenTimestamps (NIP-03) to the same Bitcoin block, show as a tie. How can the leaderboard pick the rightful Claim, or shrink the tie window to seconds? Constraints: no input to the cabinet (no ROM round-trip), no single trusted party, and it must be callable from a phone browser.

- Researched 2026-09-23/24 (UTC).
- NIP texts from `nostr-protocol/nips` master @ `62d5feddb1`.
- OTS server behavior from `opentimestamps/opentimestamps-server` master @ `0508e63` (2026-08-11), plus live calls to the calendars.
- Live checks were run with `curl` sending `Origin: https://example.com`. A browser needs `Access-Control-Allow-Origin` on the response. A preflight (`OPTIONS`) only happens when the request isn't "simple", and an `application/octet-stream` or `application/timestamp-query` POST body does trigger one.
- **Unverified** marks anything not confirmed against a primary source or a live run. Nothing here was tested on a real phone.

## Bottom line

**Under the stated constraints, a same-moment filming thief can't be made to lose. The best we can do is a tie, and ordering by time can even make the thief win.** Here is the argument.

1. The Run is the only input the Claim builds on. The cabinet puts nothing about the player in it: its fields are course, act, coins, frames, a 16-bit nonce, keyId, a frozen build-epoch `created_at`, the cabinet pubkey, the tag, the event name, and the signature (`src/generated/transport_contract.js`, sm64-nostr `docs/format-v3-spec.md`).
2. The QR is broadcast optically, so a bystander's camera gets the same bytes in the same frame as the player's.
3. So the player's Claim and the thief's Claim are built from identical information. Whatever the honest page does, the thief can do at the same speed. An auto-submit script is actually faster than a player who has to put the controller down first.
4. So any "earliest wins" rule rewards the fastest submitter, not the rightful one. Finer time resolution doesn't fix a same-moment thief. It only moves the tie window, and when the thief is faster it turns "disputed" into "thief wins".

This is an argument from information symmetry. It's not a formal proof, but I found no mechanism that escapes it. Anything that breaks the symmetry needs a constraint relaxed (see "Symmetry breakers" below).

**What finer ordering does buy:** a thief who submits *later* than the player loses instead of tying, even when both land in the same Bitcoin block. That means the leaderboard rule should be "earliest wins, **but** Claims whose sub-block times are within Δ seconds of each other are *disputed*." Plain "earliest wins" at second resolution is the wrong rule.

## Ranked options

Ranked by resolution × trust × browser-callability × cost.

| # | Mechanism | Resolution | Trust | Censorship resistance | Phone browser | Cost |
|---|---|---|---|---|---|---|
| 1 | **OTS calendar time already inside the proof** (k-of-n calendars) | 1 s | Each calendar is trusted *at submission*. Once anchored, the time is fixed by Bitcoin. | Good: ≥3 independent operators; the page submits to all of them | **Yes** (verified CORS: alice, bob, finney, a.pool) | Free; already in the flow |
| 2 | RFC 3161 TSAs, several independent ones | 1 s (genTime) | Each TSA is a trusted CA-style signer; k-of-n | Moderate: the **only** CORS path found is the `rfc3161.ai.moda` proxy, a single chokepoint (it can refuse but can't forge) | Only via the proxy | Free; heavy CMS/X.509 verify code |
| 3 | Nostr witness bots (draft kind 1041, nips PR #2359) | 1 s (`created_at`) | Each witness is trusted; quorum | Good if many independent witnesses exist | Yes (WebSocket) | Someone must run the bots; none known in public (unverified) |
| — | drand beacon round in the Claim | 3 s, **not-before only** | Threshold network (League of Entropy) | Good (several mirrors) | **Yes** (verified CORS) | Free |
| ✗ | Roughtime | ~1 s, signed and chainable | Multi-server, malfeasance proofs | Good | **No**: UDP or raw TCP only | — |
| ✗ | Fast chains / Lightning | Slot or block time | The block producer orders transactions and can be bribed to front-run | Varies | Needs a wallet and fees | Fees |

### 1. OTS calendar time: already there, just unused

**Finding (verified in source and live):** every OpenTimestamps calendar commits a **1-second server clock value** into the proof path it returns. In `otsserver/calendar.py`:

```python
def submit(self, submitted_commitment):
    idx = int(time.time())
    serialized_idx = struct.pack('>L', idx)
    commitment = submitted_commitment.ops.add(OpPrepend(serialized_idx))
    ... macced_commitment = commitment.ops.add(OpAppend(mac))   # 8-byte HMAC
    macced_commitment.attestations.add(PendingAttestation(self.uri))
```

Live on 2026-09-24, I posted one 32-byte digest to each calendar and parsed the returned ops:

| Endpoint | 4-byte prepend decoded | CORS on POST `/digest` |
|---|---|---|
| `alice.btc.calendar.opentimestamps.org` | 02:50:10Z (local clock read 02:50:21Z just after) | `*` |
| `a.pool.opentimestamps.org` (aggregator → alice) | 02:51:34Z | `*` |
| `bob.btc.calendar.opentimestamps.org` | (not parsed) | `*` |
| `finney.calendar.eternitywall.com` | 02:51:36Z | `*` |
| `btc.calendar.catallaxy.com` | 02:51:37Z | **none** |

The OTS client's own `examples/two-calendars.txt.ots` shows the same thing from 2016: alice at 19:55:01Z and bob at 19:55:02Z for one digest.

**Why it's trust-minimized after anchoring:** the time value sits inside the Merkle path that the calendar later commits to Bitcoin. Once the block is mined, nobody can change it, the calendar included. Before that, the calendar *could* write any value, for example backdating for a colluding thief. Countermeasures:
- Require stamps from ≥2 (better 3) independent operators: OpenTimestamps (alice, bob), Eternity Wall (finney), and optionally catallaxy.
- Take the per-Claim **max** (or median) calendar time. A thief then has to corrupt most operators.
- Check each value against the Bitcoin block time. A calendar time later than the anchoring block is impossible, so the proof gets rejected.

**How a verifier finds the calendar's time:** the calendar's leaf is always `prepend(4 bytes) → append(8-byte HMAC) → [calendar's Merkle ops] → Bitcoin`. The submitter controls only the ops *before* the digest reaches the calendar. So a fake 4-byte prepend added by the submitter would sit *earlier* in the path, and the verifier must take the one right before the 8-byte append. **Caveat:** this layout is an implementation detail of opentimestamps-server, not a documented protocol guarantee. The HMAC can only be checked by the operator. Finney and catallaxy return the same leaf layout (observed), but whether they run the same code is unverified.

**Browser upgrade:** see the secondary questions below. GET `/timestamp/<commitment>` carries CORS on 200 but **not** on the 404 "Pending confirmation" response (verified). The browser sees a network error while the proof is pending, which is fine to treat as "not yet".

### 2. RFC 3161 timestamp authorities

- The spec ([RFC 3161](https://www.rfc-editor.org/rfc/rfc3161) §2.4.2) says `genTime` may carry fractional seconds. The optional `accuracy` field defines the error bound. If `ordering` is false, two tokens can only be ordered when their genTimes differ by more than the sum of their accuracies. If `ordering` is true, "every time-stamp token from the same TSA can always be ordered based on the genTime field, regardless of the genTime accuracy."
- **Live (2026-09-24):** freetsa.org, Sectigo, DigiCert, DFN, and rfc3161.ai.moda all returned whole-second genTime (e.g. `20260924025312Z`) with `Accuracy: unspecified`. Only **FreeTSA** set `Ordering: yes`.
- **CORS (live):** direct TSAs send no `Access-Control-Allow-Origin`: freetsa.org, Sectigo, DigiCert (http/https), SwissSign, DFN, WoTrus, IdenTrust (http). Apple, GlobalSign, Certum, Entrust, and Keynectis returned nothing usable to the probe. Several are `http://` only, which is blocked as mixed content on an https page anyway. **`rfc3161.ai.moda`** answers with CORS (it echoes the origin, and `*` on `/freetsa`) and proxies to upstream TSAs, per its `servers.json`, including per-TSA paths like `/freetsa`, `/identrust`, `/azure`. It can refuse or be down, but it can't forge an upstream TSA's signature.
- Weaker than option 1: the trust is PKI, the result is never Bitcoin-anchored, and the verifier needs CMS/X.509 parsing plus a trust store. It's still useful as a second, independent clock.

### 3. Nostr relay receipts and witness events

- Relay `OK` messages (NIP-01) are unsigned, and `created_at` is self-asserted. **No merged NIP gives signed relay receipts.** NIP-03 is the only timestamp NIP.
- Open PR [nips#2359](https://github.com/nostr-protocol/nips/pull/2359) proposes kind `1041` "Event Timestamp Attestations": a trusted third party signs an event whose `created_at` is its receipt time for the `e`-tagged event. It is explicitly "trusted-third-party … RFC 3161-style" with 1-s resolution. The earlier PR [#1737](https://github.com/nostr-protocol/nips/pull/1737) ("relay and user notaries") was closed.
- Needs independent witness bots to exist. None found in public (unverified). Same trust model as TSAs, but Nostr-native.

### Not-before anchors (drand) and "after X, before Y"

- drand quicknet: `period: 3`, genesis 1692803367 (live from `api.drand.sh/.../info`). `api.drand.sh` and `drand.cloudflare.com` both return `Access-Control-Allow-Origin: *` (verified).
- Putting the latest round's signature in the Claim proves the Claim was built after that round was published. That gives the bound "after round R (±3 s), before calendar time T."
- **Two Claims can be ordered only when their intervals don't overlap.** A thief acting within one round of the player overlaps, so there's no ordering. drand does **not** order same-moment claimants.
- **Where drand is essential:** it blocks pre-stamping (next section).

### Roughtime, fast chains

- Roughtime ([draft-ietf-ntp-roughtime-19](https://datatracker.ietf.org/doc/draft-ietf-ntp-roughtime/), still an Internet-Draft, no RFC number) carries "UDP datagrams or via TCP streams". A browser can do neither, so it's **not callable from a phone page** without a relay server. Its chained-nonce proofs *would* give a trust-minimized sub-second order if it were.
- Fast chains: the producer orders the transactions in a block, and a public mempool lets a thief pay to go first. That's worse than a tie. It also needs a wallet and fees. Lightning has no timestamping primitive. Not pursued.

## A real hole in "earliest OTS wins": pre-stamped Claims (inference)

A Nostr event id does **not** cover `sig` ([NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)). A Run id is `sha256([0,pubkey,created_at,8064,tags,content])`. Pubkey, frozen `created_at`, and tags are known per cabinet build, and the content is small integers (course, act, coins, frames u32, 16-bit nonce, keyId). A thief could enumerate plausible Run ids ahead of time, build a Claim id for each, put them all in one Merkle tree, and stamp that single root with OTS. When a record Run appears, the thief reveals the matching path, dated *before* the run happened. That beats any honest Claim. The size is roughly 2^16 nonces × a frames window × coins. That's large but Merkle-batchable (my estimate, not measured).

**Mitigations (both cheap, both needed):**
1. The Claim must commit to the Run's **signature**, e.g. carry the full Run or `sha256(run.sig)` in a tag. The rule is "Claim references Run by id + sig". A BIP-340 sig can't be predicted without the cabinet key.
2. The Claim must carry a **drand round** (not-before). This also stops pre-stamping a Claim before its drand round exists.

## Evidence that could tell the rightful scanner apart

- **Scan timing inside the Claim** (camera frames, decode time): self-reported, so a thief can forge it. No value.
- **Session continuity:** the player who Claimed this cabinet's previous Runs in the same sitting is *probably* the player. Today the Run has no session or chain field, so the leaderboard can only use the same cabinet pubkey plus the Claims' times. A ROM *output* change (not input), such as a per-boot random session id or the previous Run's id in each Run, would make this checkable. It's still a heuristic: a thief who films every Run keeps pace.
- **Symmetry breakers.** Each one needs a constraint relaxed:
  - Player input to the cabinet before or at the run: a short code derived from the player's pubkey, entered with the controller and signed into the Run. This is the only true fix, and it violates "no input".
  - Show the QR only while a controller button is held, or only briefly. This needs a ROM change and uses controller input. It only reduces filming exposure and breaks no symmetry.
  - Off-protocol evidence such as video or witnesses, for disputes.

## Secondary questions

**What is the "one specific attack" NIP-03 is marked unrecommended for?**
- **Primary sources don't say.** fiatjaf added the label in commit `861675b` (2026-05-28, "fix: sanity.", README) and in `5491bd5` (2026-05-31, into the NIP-03 body). Both commits only say "vulnerable to one specific attack, needs update". I searched the nips repo's issues and PRs for NIP-03 and OpenTimestamps and found no write-up.
- **Most likely (inference, unverified):** the id-not-covering-sig gap above. OTS proves an event *id* existed at time T, and anyone can compute an id for someone else's pubkey without the key. So an attacker can pre-stamp ids of events they can only sign later (after stealing a key, e.g. a backdated key migration; the OTS-backed migration design is discussed in nips PR #2137), or events they want to "pre-claim". The fix would be to stamp something that covers the signature.
- NIP-03's other known limit, "attestations should contain no pending proof", is a format rule, not an attack.

**Who can upgrade a pending OTS proof to Bitcoin-attested, and publish it later?**
- **Anyone who holds the pending proof.** The upgrade is an unauthenticated `GET https://<calendar>/timestamp/<commitment-hex>` (`otsserver/rpc.py get_timestamp`). The commitment is just the result of applying the proof's ops to the digest.
- Verified live: the 2016 example `incomplete.txt.ots` still upgrades from alice today (200, 699 bytes, `Access-Control-Allow-Origin: *`). So calendars keep commitments for years.
- **Anyone can then publish** the NIP-03 kind-1040 event. NIP-03 doesn't require the 1040 author to match the target event's author.
- **But without the pending proof, nobody can upgrade.** The aggregator adds a random nonce ("to ensure requester doesn't learn anything…", `calendar.py`), so the commitment can't be rebuilt from the Claim id alone.
- So the page must **persist or publish the pending `.ots`**, for example in a separate event. NIP-03's 1040 "SHOULD" contain no pending attestations, so use a different kind or a non-NIP-03 carrier. Then any bot, the leaderboard, or the player can upgrade it after about 1–2 blocks. Otherwise the proof lives only in one phone's `localStorage`. Whether a stored pending proof survives a cleared browser is unverified.

## Recommendation for the leaderboard rule (for #1 to decide)

1. The Claim tags the Run id **and** commits to the Run sig, and carries the latest drand quicknet round.
2. At Submit, the page stamps the Claim id at ≥2 independent calendars (alice or a.pool, plus finney; bob optional) and publishes the pending proofs so anyone can upgrade them.
3. The order key is the max of the calendar times, only accepted after Bitcoin anchoring. Proofs whose calendar time is later than the anchoring block's time are rejected.
4. **Earlier by more than Δ wins; within Δ is "disputed".** Pick Δ to cover calendar clock skew plus submission latency, e.g. 5–10 s; the skew figure is unmeasured. A same-moment thief still gets a dispute, never a win. A later thief loses.

# Legal boundaries

This document states what switch-web does and does not do, and what you are
responsible for. It is not legal advice. It is the application's commitment,
enforced in code and CI, restated here in plain language.

The corresponding architecture section is `ARCHITECTURE.md` Part 0. Where the two
differ, the code is the arbiter — and the code is checked.

---

## What this project is

A **generic content-mounting path**: an emulator that can read content you supply
and run it, with no knowledge of, or special handling for, any particular title.

The project ships:

- an emulation core (C++ compiled to WebAssembly)
- a browser shell (TypeScript / React)
- a development static server that sets two HTTP headers
- documentation and build tooling

The project ships **no** game content, keys, firmware, or title-specific data of
any kind, and never will.

---

## What this project will never do

These are architectural constraints, not policy preferences. Each is enforced
somewhere, and the enforcement is named.

| Commitment | Enforced by |
|---|---|
| Never bundle, link, download, or fetch game content, firmware, or keys | `tools/scan-artifacts.mjs` in CI; no fetch call anywhere in `web/src`; CSP `default-src 'self'` |
| Never make a network request at runtime beyond loading the app shell | `Content-Security-Policy` in `tools/serve/serve.mjs` and `web/vite.config.ts`; a build-time plugin fails the build on any absolute URL in emitted code |
| Never display or log key material | The keys picker returns counts and key *names* only; no code path can put a value on screen |
| Never identify a specific title in order to acquire its keys | The loader has no title database. It parses what you give it. |
| Never write outside the folder you chose | `web/src/platform/storage.ts` roots every write at your directory handle. The only origin-storage write is a directory *handle*, not content. |
| Never circumvent an access control | `rights_id` is checked against your keys and content is **refused** when absent — matching hardware, and deliberately not "fixed" |
| No telemetry, analytics, or crash upload | There is no code that sends data anywhere |

---

## Your obligations

**You must own the game you play.**

By using switch-web you represent that the content you supply was dumped from
hardware you own, and that your use complies with the law applicable where you
live. That law varies by jurisdiction and is your responsibility to understand.

switch-web provides a generic mechanism. It does not verify ownership, and it
cannot.

### What you supply, and who provides it

| Item | Source | Notes |
|---|---|---|
| Game content (`.xci`, `.nsp`, `.nca`, `.nso`, `.nro`) | Your own dump | Never shipped, never fetched |
| `prod.keys` | Your own | Never uploaded, displayed, or logged |
| Firmware | Your own, optional | Not required by the HLE boot path |

All three are read from your machine. None is transmitted anywhere.

### Online features are unavailable

Pokémon HOME, online battles, and ranked play require network services, TLS with
a valid certificate store, and account authentication. **This build stubs them.**

That is a deliberate, permanent-until-later choice rather than a missing feature:
the services return defined "network unavailable" results and the UI says so
plainly. We would rather have a clear "online features unavailable in this build"
banner than a feature that fails confusingly or that makes an accidental promise.

---

## The `rights_id` check

Content is refused unless its `rights_id` appears in the key file you supplied.

This is worth explaining, because it looks like an inconvenience and is the
opposite. It matches what the hardware does. It also means the app cannot be used
to work around a region lock: if your keys do not authorise the content, the
content does not mount, and we do not provide a mechanism to change that.

---

## DMCA and takedown posture

switch-web ships no content, so there is nothing to take down from this
repository or its release artifacts. If you believe a specific build of this
project contains Nintendo-derived data, that is a bug in our artifact scan, and
the report should include the file and its location so it can be fixed.

**Third-party content is out of scope.** This project does not host, index,
mirror, or provide access to game content, keys, or firmware from any source. If
you are looking for those, this is not the place.

---

## Automated enforcement

The compliance checklist from Part 0, and where each item is checked:

| # | Requirement | Check |
|---|---|---|
| 1 | Zero bytes of Nintendo-derived data in repo and artifacts | `npm run scan` — file names, container magic at exact offsets, and 128-bit key literals |
| 2 | CI greps the artifact tree for key/ROM signatures | `.github/workflows/ci.yml` runs the scanner over `web/dist` |
| 3 | First-run UI states you must own the game | `web/src/ui/Onboarding/OnboardingScreen.tsx` — the attestation checkbox **gates** the folder picker |
| 4 | No outbound network calls at runtime | CSP `default-src 'self'`, plus a build-time plugin that fails on any absolute URL in emitted code |
| 5 | Respect `rights_id` | Content mounting refuses a title whose `rights_id` is absent from your keys |

`npm run scan` is runnable locally and reports exactly what it checked, so the
guarantee is auditable rather than asserted:

```sh
npm run scan                          # source tree
node tools/scan-artifacts.mjs --artifact web/dist   # build output
node tools/scan-artifacts.mjs --json  # machine-readable
```

### How the scanner avoids being useless

A scanner that greps for the *word* `header_key` would fail on this repository,
because the documentation discusses NCA layouts, key derivation, and container
formats in detail. A scanner disabled in that case is a scanner nobody should
trust.

So the content check matches **binary signatures at specific offsets** — `XCI`'s
`HEAD` at `0x100`, `NSP`'s `PFS0` at `0x0`, `NCA3`/`NCA2`/`NCA0` at `0x200`,
`NSO0` at `0x0` — plus banned filenames and content-shaped extensions, plus a
`32-hex-digit name = 32-hex-digit value` key-literal pattern in binary files. It
cannot fire on prose, and it does fire on real game data.

---

## A note on what is not here

There is no title-key database, no firmware blob, no "recommended settings per
title ID" that implies knowledge of specific content, and no code path that
special-cases a particular title.

This is a deliberate design constraint, not an oversight. A generic
content-mounting path is what makes the project defensible; a title-aware one
would not be.

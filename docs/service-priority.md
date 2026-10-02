# HLE service matrix

The priority list from `ARCHITECTURE.md` Part 3.4, ordered by *"the title will not
boot / will visibly break without it"*, with per-title coverage.

**Status key**

| Symbol | Meaning |
|---|---|
| `—` | Not started |
| `S` | Stub: returns a defined result so init paths never crash |
| `P` | Partial |
| `D` | Done |

Phase 0 implements none of these. The matrix exists now because the *ordering* is
the design decision, and because "every unhandled command logged once with its
service name" is the debugging strategy that decides whether Phase 2 takes weeks
or months.

---

## The matrix

### P0 — without these, no title launches

| Service | Purpose | Status | Pokémon relevance |
|---|---|---|---|
| `fssrv` | File system service (server side of `fs` IPC) | — | Saves, RomFS reads, caches. Everything. |
| `fs` | File system client IPC | — | Same. |
| `ldr` | Loader / process memory / relocations | — | Title launch. |
| `ns` | Namespace / title management | — | Title launch, save mount. |
| `bsd` + `nwm` + `nifm` | Network, wireless | — | **Stub in v1**, but the stubs must exist so init does not fail. |

### P1 — without these, a title boots but is not playable

| Service | Purpose | Status | Pokémon relevance |
|---|---|---|---|
| `hid` | Gamepad, touch, SixAxis | — | **All gameplay.** The `hid` state struct already exists in the ABI; the service does not. |
| `vi` | Display | — | **All rendering.** Also supplies the vsync interval the frame pacer honours. |
| `nvdrv` | GPU driver | — | **All rendering.** NVN command queue. |
| `aud` + `audren` control | Audio | — | Music, SFX. The ring and worklet exist; the DSP does not. |
| `am` + `am2` + `ncm` | Applet lifecycle, content | — | Focus state, save flush, "software closed" applet. |
| `bc` | Bond / background controller | — | CPU scheduling, frequency. |

### P2 — some IPC paths need them

| Service | Purpose | Status | Pokémon relevance |
|---|---|---|---|
| `pcv` / `pcvsys` / `pcvsession` | Parcel (shared memory) | — | Some IPC paths. |
| `bcat` | Crypto (aes/sha/ssl) | — | TLS for online. Stub in v1. |
| `ptm` | Time | — | Progression and timing. Mostly stub. |
| `socket` | TCP / UDP | — | HOME / online only. |
| `nfc` | NFC | — | HOME physical-card features. Stub. |
| `pdm` | Photo / Playdia | — | Rarely touched. Stub. |
| `wlan` | Wi-Fi | — | Online only. Stub. |

### P3 — everything else

`bluetooth`, `bts`, `rc`, `ndas`, `dsp`, `per`, `erdr`, `dtls`, `insights`, and
`libnx` internals. Status: —.

All of P2/P3 must return **defined** results so a missing feature degrades to
"off", never to a crash. See "Two HLE rules" below.

---

## Per-title coverage

Which services each target actually touches. This is the document that turns
"we need `bc`" into "we need `bc` because Let's Go calls it during init and hangs
if the reply is malformed".

| Title | Engine | Critical | Likely-needed | Stubs only |
|---|---|---|---|---|
| Let's Go Pikachu / Eevee | Unity IL2CPP | `fs`, `hid`, `vi`, `nvdrv`, `aud` | `ncm`, `am`, `bc`, `ptm`, `pcv` | `bsd`, `socket`, `wlan`, `nfc` |
| Sword / Shield | UE4 | `fs`, `hid`, `vi`, `nvdrv`, `aud` | `bc`, `pcv`, `am`, `ptm`, `bcat` | `bsd`, `socket`, `wlan` |
| Legends: Arceus | UE4 | as SwSh | as SwSh + heavier streaming | as SwSh |
| Scarlet / Violet | Unity IL2CPP | `fs`, `hid`, `vi`, `nvdrv`, `aud` | `bc`, `ncm`, `am`, `ptm` | `bsd`, `socket`, `wlan`, `nfc` |

The "likely-needed" column is a hypothesis from engine behaviour, not
measurement. It is expected to be wrong in places, which is the point: it gives
Phase 2 a starting guess, and the log-driven loop below corrects it.

---

## Two HLE rules that decide debugging pain

Both from Part 3.4, both load-bearing:

### 1. Log every unhandled command ID exactly once, with its service name

An unknown-command spam detector is the fastest route to a booting title. Boot,
collect the first unknown command, implement it, repeat.

What makes this work in practice:

- **Once per command ID, not once per call.** A title in a retry loop can call
  one unknown command thousands of times per second; logging each one produces a
  log too large to read and buries the second unknown command.
- **With the service name.** `cmd 0x000A` alone is not actionable;
  `fssrv: cmd 0x000A` tells you which header to open.
- **Not deduplicated across titles.** Per-title dedup, so a title that works and a
  title that does not have independent logs.

### 2. Every stub returns a defined success or failure

A missing service must degrade to "feature off", never to a crash. And where a
value matters, it must be *self-consistent*: games branch on these, and a
wrong-but-consistent value is invisible while a random one causes bugs.

Concretely:

- A stub that returns a handle must return a handle that stays valid.
- A stub that returns a count must return a count consistent with the buffer it
  claims to have filled.
- A stub that returns "unsupported" must return it *consistently*, not
  intermittently, so the game's retry logic converges.

---

## The development loop

Phase 2's actual method, per Part 7 risk 8:

```
1. Enable verbose IPC logging.
2. Boot a title from user-supplied files.
3. Collect the FIRST unknown command.
4. Implement it.
5. Repeat until it boots.
```

This is called **boot-log-driven development**, and it is the reason the
"log once" rule above matters so much. The alternative — reading a reference
implementation cover to cover and hoping you got everything — does not work on a
service surface this wide.

### Making it fast

- Unknown-command log entries go to the worker log, which the Diagnostics screen
  already renders.
- The log is capped at 500 entries in a ring, so a runaway loop cannot exhaust
  memory.
- Coverage is tracked per title in this file, so "does Let's Go still need `bc`?"
  is answerable rather than remembered.

---

## Status tracking

Update the Status column as services land. The rule for marking something done:

- Every command the target actually issues returns a defined result, **and**
- running the title with that service enabled produces no behaviour change versus
  a plausible stub.

A service that is implemented but crashes on one unhandled command is `P`, not
`D`.

# switch-web

A browser-native Nintendo Switch emulator. 100% client-side: no server performs
emulation, no user data leaves the device, and no game content is fetched by the
app.

**You supply your own legally-dumped game, keys, and firmware.** This project
ships none of them and never will. See [LEGAL.md](LEGAL.md).

**Status: Phase 0 foundations.** The platform is built and verified. No
emulation is implemented yet — that is Phase 1 onward.

---

## Current status

| | |
|---|---|
| Phase | **0 — foundations** (gate partially met; the two picker gates need a user gesture) |
| Architecture | [ARCHITECTURE.md](ARCHITECTURE.md) — the design document this implements |
| What runs | Four workers, each hosting a WASM core over a shared arena; a real WebGPU adapter probe; a real SPSC audio ring with an AudioWorklet; a real shared-memory HID state; the full settings shell |
| What does not | The interpreter, the JIT, the GPU backend, the HLE kernel, and the loader are all later phases |

The Phase 0 gates, as measured in the Diagnostics screen:

| Gate | Result |
|---|---|
| `crossOriginIsolated === true` | **pass** |
| WASM core instantiates in each worker type | **pass** — 4/4 |
| main → worker → main round trip < 1 ms | **pass** — p95 0.10 ms over 64 samples |
| Folder picker flow | needs a user gesture |
| `prod.keys` picker flow | needs a user gesture |
| CI artifact scan | runs in CI; `npm run scan` locally |

---

## Quick start

```sh
npm install
npm run build      # builds the stub core, then the web app
npm run preview    # serves web/dist with the required headers on :8080
```

Open <http://localhost:8080>.

**You must use the preview server**, not `file://` and not a plain static host.
`SharedArrayBuffer` does not exist outside a cross-origin-isolated document, and
without it there is no way to share one WASM memory across workers. If you get the
headers wrong, the app says so explicitly rather than failing obscurely.

If you would rather use your own server, it must send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

For development with hot reload:

```sh
npm run dev        # Vite dev server, which sets the same headers
```

Requirements: **Chromium** (Chrome or Edge). WebGPU,
`showDirectoryPicker`, and `SharedArrayBuffer` are all mature there; Firefox does
not implement the directory picker and would force the IndexedDB save fallback.

---

## Building the real core

Emscripten is **not required** to run this project. Without it, the build produces
a hand-encoded `core.wasm` stub that implements the Phase 0 ABI and nothing else.
It exists so the plumbing — worker boot, ABI handshake, shared memory, region
mapping, the latency gate — is verifiable on any machine.

To build the real core:

```sh
npm install -g emsdk
emsdk install latest && emsdk activate latest

emcmake cmake -S core -B core/build -DSW_BUILD_WASM=ON
cmake --build core/build

cp core/build/core.wasm web/public/core.wasm
```

The stub is never overwritten if a real build is present, so this is a safe
operation. The app labels which core it loaded in Diagnostics; the stub's build id
contains "stub" and the UI says so.

Host-native tests, which are much faster to iterate than a browser rebuild:

```sh
cmake -S core -B core/build-host -DSW_BUILD_TESTS=ON
cmake --build core/build-host
ctest --test-dir core/build-host --output-on-failure
```

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server with COOP/COEP |
| `npm run build` | Stub core + production web build |
| `npm run preview` | Serve `web/dist` with the required headers |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run gen:abi` | Regenerate `gen/abi.json` and `gen/abi.ts` from the C headers |
| `npm run build:stub-core` | Rebuild the hand-encoded stub core |
| `npm run scan` | Part 0 artifact scan |
| `npm run verify` | Headless Phase 0 gate verification (needs Playwright) |
| `npm test` | Typecheck + artifact scan |

---

## Layout

```
core/                C++ emulation core (Emscripten build + host test build)
  include/core/      Public headers — the ABI source of truth
  src/               Implementation, by subsystem
  wasm/              Emscripten glue and per-worker entry points
  test/unit/         Host-native tests
web/                 TypeScript + React shell
  src/platform/      Capabilities, workers, storage, input, audio, protocol
  src/ui/            Screens
  src/workers/       The four worker entry points
gen/                 Generated ABI mirrors (checked in, CI-verified)
tools/               serve.mjs, ABI generator, stub-core builder, artifact scan
docs/                abi.md, service-priority.md, compat-matrix.md, shader-notes.md
```

`core/` is the source of truth. The TypeScript ABI mirrors under `gen/` are
**generated**, not hand-written, and CI fails if they are stale.

---

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The full design: feasibility verdict, subsystem designs, phased roadmap, top-10 risks, open questions |
| [LEGAL.md](LEGAL.md) | Boundaries, your obligations, and how each one is enforced |
| [docs/abi.md](docs/abi.md) | The C ABI and SAB layout contract |
| [docs/service-priority.md](docs/service-priority.md) | HLE service matrix and per-title coverage |
| [docs/compat-matrix.md](docs/compat-matrix.md) | Per-title status, difficulty, and known issues |
| [docs/shader-notes.md](docs/shader-notes.md) | Maxwell→WGSL path, quirks, and the divergence catalogue |

---

## Roadmap

Phases 0–6 from `ARCHITECTURE.md`, with each phase gated on a measurable criterion.

| Phase | Contents | Gate, in one line |
|---|---|---|
| **0** ✅ | Toolchain, shell, workers, shared arena, CI | Headers set, core boots in 4 workers, round trip < 1 ms |
| **1** | AArch64 interpreter, MMU, NSO/NRO loader | ≥ 99% instruction conformance; 100M instructions vs QEMU/Unicorn with zero unexplained mismatches |
| **2** | The WASM-emitting JIT, HLE kernel, P0/P1 services, minimal WebGPU | JIT beats the interpreter; one commercial title boots to its title screen |
| **3** | Maxwell→WGSL, shader cache, audren DSP, save states | Let's Go playable end to end at a sustained 30 fps |
| **4** | Multi-core CPU workers, UE4 paths, DRS stability | Sword/Shield in an overworld at a stable 30 fps |
| **5** | Heavy streaming I/O | Legends: Arceus reaches a large streamed area |
| **6** | Modern Unity renderer, 60 fps budget | Scarlet/Violet boots and is playable at reduced settings |

The first two gates are the ones that matter most:

- **Phase 1** establishes that the CPU model is *correct*, against an oracle.
- **Phase 2** establishes that the JIT is *faster than the interpreter*. If it is
  not, the architecture is wrong, and everything downstream is wasted.

---

## Honest assessment

This is a multi-year project, not a weekend one. The riskiest part is the CPU JIT:
an AArch64 JIT that emits WebAssembly fast enough to hide compile cost, with a
64-bit guest memory model inside a 32-bit heap and deep guest stacks without host
stack overflow.

Part 1's verdict, unchanged: **Let's Go Pikachu/Eevee playable end to end is the
realistic V1.** Sword/Shield at 30 fps is V2 with real effort. Arceus is a stretch.
Scarlet/Violet is a research project.

The reason Let's Go is first is worth repeating because it is counter-intuitive:
it is not the easiest title, it is the easiest *per unit of required correctness*.
A locked 30 fps target is a 2x budget discount, and a 2018 Unity title has a
small, well-understood shader set. Scarlet/Violet is also Unity, but 60 fps plus
modern renderer features plus an open world makes it harder than the UE4 titles.

---

## Contributing

Phase 0 is complete; Phase 1 is the AArch64 interpreter. Before starting on any
subsystem, read the corresponding section of `ARCHITECTURE.md` — the design
decisions and their reasoning are there, and several are counter-intuitive enough
that rediscovering them the hard way would cost weeks.

The one rule that is not negotiable: **Part 0's boundaries are enforced in CI, not
by convention.** If a change would require them to be relaxed, that is a signal
about the design, not an obstacle to it.

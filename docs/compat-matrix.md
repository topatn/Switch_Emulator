# Compatibility matrix

Per-title status, settings, and known issues. The source of truth for what the
Library screen's status badges mean.

**Status badges are not interchangeable.** This is the most important thing on
this page:

| Badge | Meaning |
|---|---|
| **Playable** | Menu → overworld → battle → save → reload, end to end, with the save intact. Only this one means "works". |
| **Boots to title screen** | Reaches a menu. Nothing else is known to work. |
| **Boots** | Runs some code before failing. Useful for debugging, not for playing. |
| **Not yet supported** | Known to fail, no diagnosis yet. |
| **Needs keys** | Blocked on `prod.keys`. |
| **Needs firmware** | Blocked on firmware (should not occur on the HLE boot path). |

---

## Summary

From Part 1.2, ranked hardest-last.

| Rank | Title | Engine | Native fps | Difficulty | In-browser verdict | Phase |
|---|---|---|---|---|---|---|
| 1 | Let's Go Pikachu / Eevee | Unity IL2CPP | 30 | Lowest | Realistic | 3 |
| 2 | Sword / Shield | UE4 | 30 (dynamic 720p–1080p) | Medium | Plausible, effort-heavy | 4 |
| 3 | Legends: Arceus | UE4 | 30–60 (dynamic) | High | Unlikely | 5 (stretch) |
| 4 | Scarlet / Violet | Unity IL2CPP | 60 | High | Least likely | 6 (research) |

### Why the ranking is what it is

Unity targets are *simpler to get right* (no custom renderer surprises, small
shader counts, an easier NVN surface) but can demand *more performance*. UE4
targets are *harder to code* but have a *friendlier 30 fps lock*.

So the order is: Let's Go first (simple **and** 30 fps), Sword/Shield second
(harder code, comfortable budget), Arceus and Scarlet/Violet last (hard **and**
expensive).

The irony worth noting: Scarlet/Violet is Unity like Let's Go, but a 60 fps target
plus modern Unity renderer features plus an open world makes it *harder* than the
UE4 titles. Unity's advantage is engine simplicity, not performance.

---

## Why a locked 30 fps is decisive

From Part 1.2, and it is the single most important fact for planning:

> A locked 30 fps target is a 2x budget discount versus a locked 60 fps target
> *only if* the game's GPU cost dominates. For Switch titles it usually does, and
> the CPU side (4x Cortex-A57) is the part our JIT must replace. A JIT reaching
> ~40–60% of native A57 throughput is enough for 30 fps titles and definitively
> not enough for 60 fps titles.

This is why Phase 1 gates on "JIT beats the interpreter" rather than on a MIPS
target, and why no effort has been spent on a 60 fps path.

---

## Per-title detail

### 1. Let's Go Pikachu / Eevee (2018)

- **Engine:** Unity IL2CPP
- **Rendering:** forward, small passes, modest post stack, no open world
- **CPU:** mostly single-threaded-ish, few streaming threads
- **Status:** — (Phase 3)
- **Recommended settings:** native resolution on a discrete GPU

**Why first.** Single-region scenes, tiny streamed data, a small shader set, no
open world, modest VRAM. Unity titles are the friendliest target: no engine-level
custom renderer surprises, small fixed-function surface, low shader count. A locked
30 fps leaves roughly 2x headroom.

**Known problem areas**

| Area | What to expect |
|---|---|
| Shader-heavy effects | Weather and day/night transitions spawn one-off effect shaders. The persistent cache is mandatory; a first-run shader storm is a UX event, not a bug. |
| Unity IL2CPP specifics | Large metadata sections, heavy initialisation, and 2–4 GB of managed heap growth at boot. **Tests the sparse memory and growth path early** — which is why this is a good first target despite being first. |
| Save cadence | Frequent small save blobs. Must survive a tab crash. |

**Phase 3 gate:** menu → overworld → wild battle → capture → save → quit →
reload with the save intact, all on a discrete GPU. Sustained 30 fps in the
overworld for ≥ 10 minutes with < 5 ms frame-time variance. Shader cache warm:
run 2 boots to gameplay with ~0 live pipeline compiles. No audio underruns in a
30-minute session. Save states: 10 consecutive cycles with no desync.

### 2. Sword / Shield (2019)

- **Engine:** Unreal Engine 4
- **Rendering:** deferred-ish, many large shaders, heavy post (bloom/DOF/TAA-class)
- **CPU:** parallel — render thread plus task-graph workers
- **Status:** — (Phase 4)
- **Recommended settings:** resolution scale 0.5 on integrated GPUs

**The project's true milestone.** Reaching a *stable* frame here, not just a
running one.

**Known problem areas**

| Area | What to expect |
|---|---|
| Dynamax | Spawns one-off effect shaders. The classic translation stress case. |
| Dynamic resolution | The game picks its own internal resolution each frame from timing it measures. **Our timing must be stable and plausible or DRS oscillates visibly.** This makes frame pacing and tick accuracy correctness features, not polish. |
| UE4 specifics | Runtime "shader code" blobs, PSO precompilation at boot (slow, pipeline-heavy first boot), strict GPU-state assumptions, and self-created worker threads that spin — which punishes a naive `Atomics.wait` design. |
| Multithreading | Requires Topology 2 (per-core workers) to work properly. Topology 1 can boot but will underperform. Expect a "runs but slow" milestone before "runs correctly". |

**Resolution scale composes multiplicatively with guest DRS.** At guest DRS 0.8
and host scale 0.66, the real render target is 53% of native. This is stated in the
Graphics settings screen because it is the most common source of "why does this
look so soft".

**Phase 4 gate:** boots to title and into a route, then an overworld area.
Sustained, *stable* 30 fps for ≥ 15 minutes with DRS not visibly oscillating. Guest
spin-locks handled with no `Atomics.wait` livelock. On an intentionally
over-budget host, the auto governor lowers resolution and the session
self-stabilises.

### 3. Legends: Arceus (2022)

- **Engine:** UE4 (as SwSh, plus a large streamed open world and DRS)
- **Status:** — (Phase 5, stretch)
- **Recommended settings:** reduced host resolution scale on discrete GPUs

**Why last among the UE4 titles.** Streaming pressure, more shaders than SwSh, and
a DRS feedback loop fed by our timing jitter. The combination of streaming, DRS
oscillation, and a shader count that must all compile before a stable frame is a
brutal first target.

**Phase 5 gate:** boots and reaches a large streamed area; ≥ 30 fps at reduced host
resolution scale on a discrete GPU. I/O streaming sustains the game's demand without
hitch-induced DRS collapse over a 30-minute traversal.

### 4. Scarlet / Violet (2022)

- **Engine:** modern Unity IL2CPP
- **Native fps:** 60
- **Status:** — (Phase 6, research)
- **Recommended settings:** reduced resolution, reduced expectations

**Why last.** Modern Unity renderer features, a very large open world with aggressive
streaming, and a 60 fps budget on a *smaller* shader count than UE4 titles. The 60
fps target halves the margin immediately.

**Phase 6 gate (honest):** boots to gameplay on a discrete GPU. **60 fps is not a
committed gate.** Reaching correct, stable, playable at reduced settings is the
success criterion.

---

## Cross-cutting known issues

These affect all titles and are tracked in Part 7 rather than per title.

| Issue | Impact | Mitigation | Phase |
|---|---|---|---|
| JIT throughput | May not reach the frame rate | Measure interpreter→JIT speedup as a gate; lean on superblocks, SIMD, tail calls, register caching; on-disk code cache | 2 |
| WASM compile/instantiate cost | Frame hitches, especially cold | Superblock granularity, batch off the critical path, background pre-JIT during boot, never block a frame for a compile | 2 |
| Maxwell→WGSL divergence | Wrong or missing shaders | Correction pass, shader-stub fallback, per-shader diagnostics, divergence catalog | 3 |
| Guest memory vs wasm32 heap | Address space ceiling | Sparse arena, explicit tested resize protocol, Memory64 as a near-drop-in upgrade | 1–3 |
| Shader cache misses / adapter churn | Poor first-run UX | Cache in the user folder, adapter fingerprint in the key, honest progress, a "rebuild cache" control | 3 |
| DRS + pacing feedback loops | Visible resolution pumping | Audio-master pacing, stable guest-clocked ticks, honour the guest's vsync interval | 4 |
| Cross-origin isolation | Will not run at all | `serve.mjs`, boot-time check with an actionable diagnostic, PWA/self-host default | 0 ✅ |
| HLE service long tail | Late boot failures | Prioritised matrix, boot-log-driven development, defined stub results | 2 |
| Topology 2 difficulty | Multi-core stalls | Stay on Topology 1 through Phase 4, prototype early, shard the TLB, single-core fallback | 4 |

---

## Testing early is cheap

Once a title boots past the logo, the shader compiler becomes the profiler.
Divergence shows up as wrong geometry, black quads, or garbage textures, and the
per-shader logs turn that from a mystery into a work item.

This is why the compat matrix starts filling in at Phase 2, not Phase 3.

---

## Recording results

When a title's status changes, update this file **and** the badge it maps to. The
value of the badge set is that it is honest; a badge that overstates is worse than
no badge, because a user who is told "Boots" and then cannot play concludes the
project is broken rather than that the status was wrong.

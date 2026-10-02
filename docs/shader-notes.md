# Shader notes

Maxwell quirks, the WGSL translation path, and the divergence catalogue.

**Status: nothing implemented.** Phase 0 has no shader pipeline. This document
exists now because the compatibility list is a *design* input — it determines
whether the translator is a translation or an approximation, and that decision has
to be made before writing the translator, not discovered while debugging a black
screen.

---

## The pipeline

From Part 3.5 / Part 4.1:

```
SASS  --decode-->  internal IR  --translate-->  SPIR-V  --cross-compile-->  WGSL
                     (ours)        (ours)          (naga or SPIRV-Cross)
                         |
                         +-- Maxwell correction pass  (ours)
```

Two components are ours and unavoidable:

- **A SASS disassembler/decoder.** Nothing else can produce SPIR-V. This follows
  the approach used by nvdisasm-style decoders.
- **A Maxwell correction pass.** Because the target is not SPIR-V-consistent
  (below), a straight cross-compile is wrong in specific, enumerable ways.

One component is a choice: `naga` or `SPIRV-Cross` for SPIR-V → WGSL. `naga` also
validates WGSL at runtime, which is genuinely useful for catching a bad
translation at load time rather than as a black screen. Part 8.5 leaves this open.

Heavy tooling (batch decode, cache pre-building) stays **outside** the browser as a
host-native CLI in `core/tools/shader_prebake/`, per Part 5.

---

## Maxwell → WGSL compatibility list

The things that actually break. This is the document the correction pass is
written against.

### No DX11 robustness

`robustBufferAccess` / `robustBufferAccess2` are absent. An out-of-bounds access
returns garbage rather than zero.

Shaders that rely on graceful degradation will diverge from what Maxwell would
produce. There is no way to fix this in the translator — it is a hardware
behaviour difference. The correction pass cannot restore information the hardware
would have masked.

### Half-precision NaN, Inf, and denormals

Behaviour differs from Vulkan. Enabling relaxed precision where it does **not**
match NVIDIA causes mismatches in post-processing chains, which are exactly where
subtle numeric differences are visible.

Treat per-shader. A blanket "allow relaxed precision" is wrong for at least one of
the four targets.

### No native `f64`

WebGPU has no `f64`. Anything requiring double precision must go through software
emulation, and that software emulation must be verified — it will not match
Maxwell's.

Maxwell itself has limited `f64` support, so this mostly affects shaders that use
it incidentally.

### Wave width is 32

WebGPU subgroup support is newer than the base specification and is **not
universally available**. Emit a configurable subgroup size and keep a non-subgroup
fallback path.

Concretely: assume a shader may need to work without subgroup operations, and test
that path, or the first title that needs it will only work on your machine.

### Integer texture sampling and normalisation

Semantics differ. Sparse bindings and image atomics have no Maxwell equivalent at
all — **do not try to map them**. A shader using them came from somewhere other
than a Switch title, or is doing something the hardware does not do.

---

## The practical stance

From Part 3.5:

> Translate the common SPIR-V subset, and for anything the translator rejects,
> fall back to a **shader stub** that renders correct geometry with a constant or
> minimal approximation, and record the shader in a "known divergent" list. A
> wrong-but-plausible pixel beats a black screen.

This is the single most important decision in the GPU subsystem, and it is worth
being explicit about why:

- **A black screen is undebuggable from the user's side.** The user sees nothing
  and can report nothing useful.
- **A wrong-but-plausible pixel is self-diagnosing.** The geometry is right, so
  the user (or the overlay) can say "this object renders black" — which
  identifies the shader.
- **Both Yuzu and Ryujinx have shipped variants of this idea**, so it is
  battle-tested rather than speculative.

The cost is honesty: a stub-rendered scene is not the real scene, and the UI must
say so. `needs_stub` in `MaxwellShader` records it, and it surfaces in the
diagnostics screen.

---

## Async pipeline creation

The #1 source of visible stutter. Part 3.5's five rules, in order of importance:

### 1. Async only, and skip the draw rather than block

Use `createRenderPipelineAsync` / `createComputePipelineAsync`. All PSO creation
goes through an async request queue, never inline.

If a pipeline is not ready when a draw is recorded: **skip the draw this frame and
retry.** The game is double-buffered, so a skipped draw is a one-frame artefact.
Blocking on a synchronous `create*Pipeline` stalls the whole queue behind one
shader.

### 2. Batch by PSO

Sort draws by PSO so creation cost amortises over thousands of draws. Compare
packed pipeline-state registers by hash rather than deep-comparing descriptors —
deep comparison is itself a per-draw cost that defeats the purpose.

### 3. Persistent cache on disk

Key: `(titleId, nsoHash, decompiledHash, translatorVersion, adapterFingerprint)`.

Cache the **WGSL text** *and* the driver-side pipeline binary where available. Run
1 pays translate + compile; run 2+ pays nothing.

The adapter fingerprint is in the key deliberately: a pipeline binary from a
different driver is not merely stale, it is **wrong**. Switching GPUs invalidates
the cache, which is correct behaviour rather than a bug.

### 4. Warm-up UX

On a cold cache, show real progress ("Translating shaders… 412/900") and allow
cancel/resume. A frozen window is indistinguishable from a crash.

### 5. Per-shader error triage

Persist the disassembly plus translator diagnostics per shader, and surface them in
the UI. A divergent shader becomes a **diagnosable artefact** rather than a
mystery.

---

## Texture decode

Centralised: given `(format, tile mode, swizzle, mip)`, produce either a CPU view
or a GPU-side unpack.

| Path | When | Why |
|---|---|---|
| CPU-side block-linear re-layout (WASM) | Small / streaming cases | Simple and testable |
| Compute-shader unpack | Hot paths — large block-linear ASTC/BC surfaces | Keeps CPU cost off the critical path |
| GPU-side ASTC decode + repack | Large ASTC surfaces | WebGPU supports ASTC natively; repacking beats a large CPU decoder |
| CPU BCn decompression | BCn surfaces | Easy, and filtering is predictable |

The pragmatic split: prefer GPU-side ASTC decode+repack rather than writing a large
CPU ASTC decoder, unless profiling forces it.

---

## WebGPU limits to design around

| Limit | Consequence for us |
|---|---|
| 32-bit index buffers | Vertex indices must be emitted as 32-bit, or split draws |
| ~4 GiB per buffer | Guest VRAM is ~256 MiB pages on Switch → model it as a **page allocator sub-allocated into WebGPU buffers** |
| Uniform buffer offset alignment (256) | Large UBO ranges must be split |
| `maxUniformBufferBindingSize` | Same |
| Storage-texture format / array-layer support | Varies; keep a buffer-view or readback fallback for exotic cases |
| Guest VRAM lives in the SAB | Watch per-frame upload cost for texture-heavy scenes; use async-write for large streaming textures |

Compute is well supported and is the answer to most of these — decompression,
image ops, and unpack work.

---

## The cache key

Worth writing out because getting it wrong is expensive in both directions:

```
<user folder>/cache/shaders/<titleId>/<translatorVersion>/<shaderHash>.wgsl
```

| Component | Why it is in the key |
|---|---|
| `titleId` | Different titles have different shaders. Without it, the cache is a global blob that grows forever. |
| `translatorVersion` | Bump on any translator change. **Improvements must invalidate cleanly** — this is what makes the cache safe to improve. |
| `shaderHash` | Hash of *normalised SASS*, not of the file. The same shader in two titles is the same shader. |
| `adapterFingerprint` | A pipeline binary is driver-specific. |

Steady state: **zero** shader compilation. Phase 3's gate asserts cache hit > 99%.

Add eviction. Shader-cache disk growth is a low-severity tracked risk in Part 7,
but it is unbounded without a policy.

---

## Divergence catalogue

One row per known-divergent shader. Populated as they are found.

| Shader hash | Title | Symptom | Cause | Stubbed? | Notes |
|---|---|---|---|---|---|
| — | — | — | — | — | Empty. Phase 3. |

The point of the table is that "the scene looks wrong" becomes a lookup. Fill it
the moment something is observed, even if the cause is unknown — an unknown entry
is still more useful than nothing.

---

## Relationship to the diagnostics overlay

From Part 3.9, the GPU counters that matter, none of which exist yet:

- draws/frame
- PSO changes/frame
- pipeline compiles, split cache-hit vs live, plus ms
- translate ms
- bytes uploaded/frame
- frame GPU time

**PSO changes/frame** is the one to watch on the Unity titles. A frame with an
unusually high count usually means a pipeline cache miss, which points straight at
the cache key or the adapter fingerprint changing.

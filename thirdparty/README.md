# Third-party dependencies

Vendored code and licences. Part 5 lists this directory as "vendored deps with
licenses + notices".

## Vendored source (none yet)

No third-party source is vendored at Phase 0.

The project's own code is MIT licensed (see the SPDX headers). If emulator
internals are adapted from an existing C++ project in a later phase, that code
must be vendored **here**, with its licence and attribution, and this file must
record the provenance. Part 4.2 is explicit that prior art is the reason C++ was
chosen, so this directory will eventually matter — but it starts empty on purpose,
rather than filling it with code nobody has looked at.

## Build-time and runtime dependencies

Managed by npm (`package.json` / `package-lock.json`), not vendored. The direct
dependencies are:

| Package | Purpose |
|---|---|
| `react`, `react-dom` | UI shell (Part 4.1) |
| `vite`, `@vitejs/plugin-react` | Build and dev server |
| `typescript` | Typecheck |
| `@types/*` | Type definitions |

Everything else in `node_modules/` is transitive.

**No dependency is loaded from a CDN.** This is enforced, not merely intended:

- The build fails if any absolute `http(s)` URL appears in emitted JavaScript
  (`web/vite.config.ts`, the `switch-web:isolation-and-csp` plugin). The allowlist
  covers only URLs that are printed rather than fetched — React's error-decoder
  link and the `localhost` examples in the copy-pasteable header snippets.
- `Content-Security-Policy: default-src 'self'` is served by
  `tools/serve/serve.mjs`, which would block a CDN load at runtime even if the
  build check were bypassed.
- The font stack in `web/src/ui/styles.css` is system-only, for the same reason.

Part 0 requires "no CDN, no remote fonts, no external analytics", and Part 3.9
notes that this "conveniently reinforces the Part 0 legal posture". A project
whose entire value proposition is that nothing leaves the device cannot ship a
remote font.

## Optional

| Package | Purpose |
|---|---|
| `playwright` | Headless Phase 0 gate verification. Not a dependency of the app; `npm run verify` explains how to install it if absent. |

## Native toolchain

Not npm-managed, and not vendored:

| Tool | Purpose |
|---|---|
| Emscripten (emsdk) | Builds `core/` to WebAssembly. **Optional.** Without it the build produces a hand-encoded stub core (`tools/build-stub-core.mjs`). |
| CMake | Build manifest for both the WASM and host-native builds. |
| A C++20 compiler | Host-native tests, and the WASM build via Emscripten. |

## Licences to note

- **Emscripten** and its dependencies are distributed under their own permissive
  licences. It is a build tool; nothing it produces is linked into the core.
- **WebGPU, WebAssembly, Web Audio, AudioWorklet, File System Access** are web
  platform specifications implemented by the browser. There is no code here to
  license.

## Adding a dependency

Before adding one:

1. **Does it need to be in the browser?** If it is only a build or verification
   tool, it goes in `devDependencies` and never reaches the bundle.
2. **Does it fetch anything at runtime?** If yes, it violates Part 0 and cannot
   be added.
3. **Is it worth its size?** The bundle is currently ~226 kB (71 kB gzipped).
   That headroom is worth spending on something that earns it.
4. **Record it above**, with its purpose.

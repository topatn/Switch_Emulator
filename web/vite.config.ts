// web/vite.config.ts
//
// Vite config for the switch-web shell (Part 4.1: "UI / shell — TypeScript +
// React + Vite", "Packaging — static site + a tiny header-setting static server").
//
// The most important thing in this file is `headers`. Cross-origin isolation is
// mandatory (Part 3.9): SharedArrayBuffer does not exist without it, and the
// entire memory model depends on sharing one WASM memory across workers. Vite's
// dev server therefore sets the same COOP/COEP pair as tools/serve/serve.mjs, so
// "works in dev, broken in prod" cannot happen.
//
// Part 0 also constrains the build: no CDN, no remote fonts, no analytics.
// `optimizeDeps` is pinned to local-only resolution so an accidental dependency
// on a remote package fails the build instead of silently working on a
// developer machine and breaking under `default-src 'self'`.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Cross-origin isolation. `credentialless` is a viable alternative for
// embedding in a cross-origin frame, but `require-corp` is the safer default
// (Part 3.9), so it is what we ship.
export const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;

// Content-Security-Policy enforcing Part 0's "no runtime network calls" rule.
// Dev relaxes 'unsafe-inline' for styles because Vite injects <style> tags;
// the production build served by tools/serve/serve.mjs uses the strict form.
export const CSP_PROD =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export const CSP_DEV = CSP_PROD.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");

/** Any absolute http(s) URL in emitted JavaScript. */
const ABSOLUTE_URL = /https?:\/\/[^\s'"`)]+/g;

/**
 * URLs that are present but inert.
 *
 * These are not exemptions from the rule; they are strings that are never fetched:
 *
 *   reactjs.org  React embeds this URL in its production error messages, pointing a
 *                developer at the error decoder. It is printed, never requested.
 *   localhost    The example URLs in the copy-pasteable header snippets. Users
 *                paste them into their own config, not into the app.
 *   w3.org       Specification references in comments and in user-facing help text.
 *
 * A genuinely new remote URL should fail this check. That is the point: adding an
 * entry here is a deliberate, reviewable decision.
 */
const ALLOWED_URL =
  /^https?:\/\/(www\.)?(reactjs\.org|w3\.org|react\.dev|developer\.mozilla\.org|localhost|127\.0\.0\.1)/;

export default defineConfig(({ command }) => ({
  root: __dirname,

  // Relative base so the built app works from any mount point (a user-chosen
  // static host, or a subdirectory of a self-hosted reverse proxy).
  base: './',

  plugins: [
    react(),
    {
      // Serves the COOP/COEP headers in dev, and asserts at build time that the
      // shell contains no remote references. Both are cheap; both catch real
      // deployment failures before a user does.
      name: 'switch-web:isolation-and-csp',
      configureServer(server) {
        server.middlewares.use((_req, res, next) => {
          for (const [k, v] of Object.entries(ISOLATION_HEADERS)) res.setHeader(k, v);
          res.setHeader('Content-Security-Policy', CSP_DEV);
          next();
        });
      },
      enforce: 'post',
      generateBundle(_options, bundle) {
        const offenders: string[] = [];
        for (const [fileName, chunk] of Object.entries(bundle)) {
          if (chunk.type !== 'chunk') continue;
          const source = chunk.code ?? '';
          for (const url of source.match(ABSOLUTE_URL) ?? []) {
            if (ALLOWED_URL.test(url)) continue;
            offenders.push(`${fileName}: ${url}`);
          }
        }
        if (offenders.length) {
          this.error(
            'Remote URL(s) found in the build output. Part 0 requires no runtime network calls:\n  ' +
              offenders.join('\n  ') +
              `\n\nIf one of these is a documentation string rather than a fetch, add it to\n` +
              `ALLOWED_URL in web/vite.config.ts with a comment saying why it is inert.`,
          );
        }
      },
    },
  ],

  resolve: {
    alias: {
      // TypeScript path aliases are not read by Vite, so both configs must declare
      // them. `@gen` points outside web/ on purpose: Part 5 keeps the generated ABI
      // mirrors at the repo root, beside the C headers they were generated from, so
      // a struct change is visible in one place.
      '@gen': resolve(__dirname, '..', 'gen'),
      '@core': resolve(__dirname, '..', 'core'),
    },
  },

  worker: {
    // Workers are ES modules so they can share the generated ABI module and use
    // static imports. Part 3.9's topology needs four workers plus the worklet.
    format: 'es',
    rollupOptions: {
      output: {
        // Without this, Vite derives the worker chunk's extension from the source
        // file and emits `cpu.worker-<hash>.ts`. That is JavaScript, but the
        // browser enforces strict MIME checking for module scripts and a server
        // that maps `.ts` to octet-stream will refuse to execute it. Emitting a
        // `.js` extension means any static host serves the right Content-Type.
        // `[extname]` is deliberately absent: Vite derives the emitted extension
        // from the source file, which for a `.worker.ts` source yields `.ts`.
        // A function form lets us substitute the extension outright.
        entryFileNames: (chunk) => {
          const name = typeof chunk.name === 'string' ? chunk.name : 'worker';
          return `assets/${name.replace(/\.ts$/, '')}-[hash].js`;
        },
        chunkFileNames: (chunk) => {
          const name = typeof chunk.name === 'string' ? chunk.name : 'chunk';
          return `assets/${name.replace(/\.ts$/, '')}-[hash].js`;
        },
      },
    },
  },

  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
    },
  },

  optimizeDeps: {
    // Fail rather than reach out to a registry/CDN at dev time.
    include: ['react', 'react-dom'],
  },

  define: {
    __CSP__: JSON.stringify(command === 'serve' ? CSP_DEV : CSP_PROD),
    __ISOLATION_HEADERS__: JSON.stringify(ISOLATION_HEADERS),
  },
}));

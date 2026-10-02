#!/usr/bin/env node
// tools/serve/serve.mjs
//
// A static file server whose only notable feature is that it sets the headers
// that make the emulator possible at all.
//
// Part 3.9: "The app cannot run from file:// and cannot be served by a host that
// strips these headers. We must ship (a) a tiny static server ... and (c) a
// boot-time check ... Plan (a) + (c) for v1."
//
// This is (a). It is intentionally minimal and has no dependencies, because the
// first thing a new user should not have to do is npm-install a server. The
// headers it sets are exactly two plus a security baseline:
//
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp
//     -> the document becomes cross-origin isolated, so SharedArrayBuffer exists
//        and the shared WASM memory across workers is possible.
//
// Plus `Content-Security-Policy: default-src 'self'` because Part 0 requires that
// the running app makes no network calls, and a CSP is the only way to *enforce*
// that rather than merely intend it.
//
// Usage:
//   node tools/serve/serve.mjs [--root web/dist] [--port 8080] [--host 127.0.0.1]

import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// --- arguments ------------------------------------------------------------

function parseArgs(argv) {
  const args = { root: null, port: 8080, host: '127.0.0.1', spa: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') args.root = argv[++i];
    else if (arg === '--port') args.port = Number(argv[++i]);
    else if (arg === '--host') args.host = argv[++i];
    else if (arg === '--no-spa') args.spa = false;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
switch-web static server

  node tools/serve/serve.mjs [options]

Options:
  --root <dir>   Directory to serve. Default: web/dist if present, else web/.
  --port <n>     Port to listen on. Default: 8080.
  --host <addr>  Address to bind. Default: 127.0.0.1.
  --no-spa       Serve 404s as 404 instead of falling back to index.html.

The COOP/COEP headers below are what make the emulator work at all. Any host
that omits them will load the page and then refuse to start the core, because
SharedArrayBuffer does not exist outside a cross-origin-isolated document.

  Cross-Origin-Opener-Policy:   same-origin
  Cross-Origin-Embedder-Policy: require-corp
`);
  process.exit(0);
}

async function pickRoot() {
  if (args.root) return resolve(process.cwd(), args.root);
  const dist = join(REPO_ROOT, 'web', 'dist');
  try {
    await fs.access(dist);
    return dist;
  } catch {
    return join(REPO_ROOT, 'web');
  }
}

const ROOT = await pickRoot();

// --- headers --------------------------------------------------------------

export const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  // Tells the browser the response is safe to embed in a COEP document. Without
  // it, a strict COEP page refuses to load its own subresources in some
  // configurations.
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
};

// Part 0's "no outbound network calls at runtime", enforced rather than intended.
// 'wasm-unsafe-eval' is required for WebAssembly compilation. No CDN, no remote
// fonts, no analytics: everything is same-origin.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  // A worker chunk should always be emitted with a .js extension, but if a build
  // ever produces a .ts asset it is JavaScript and must be served as such: module
  // scripts are subject to strict MIME checking, and octet-stream is refused.
  '.ts': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** Applies every header to a response. */
function applyHeaders(res) {
  for (const [key, value] of Object.entries(ISOLATION_HEADERS)) res.setHeader(key, value);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
  res.setHeader('Content-Security-Policy', CSP);
}

/**
 * Resolves a URL path to a file inside ROOT, or null if it escapes.
 *
 * Path traversal is checked explicitly rather than relying on normalize(): a
 * server that can read outside its root is a bug regardless of who asks.
 */
function resolvePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }

  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  const candidate = resolve(ROOT, relative);
  const rootPrefix = ROOT.endsWith(sep) ? ROOT : ROOT + sep;
  if (candidate !== ROOT && !candidate.startsWith(rootPrefix)) return null;
  return candidate;
}

const server = createServer(async (req, res) => {
  applyHeaders(res);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }

  const target = resolvePath(req.url ?? '/');
  if (target === null) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let filePath = target;
  let stat = await fs.stat(filePath).catch(() => null);

  if (stat?.isDirectory()) {
    filePath = join(filePath, 'index.html');
    stat = await fs.stat(filePath).catch(() => null);
  }

  // Single-page fallback: an unknown path with no extension is a client route.
  if (!stat && args.spa && !extname(filePath)) {
    filePath = join(ROOT, 'index.html');
    stat = await fs.stat(filePath).catch(() => null);
  }

  if (!stat?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      `404 Not Found: ${req.url}\n\nServing: ${ROOT}\n\n` +
        `Did you run "npm run build" first? This server serves built files.\n`,
    );
    return;
  }

  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', stat.size);

  // Hashed assets are immutable; index.html and the core are not, because a stale
  // core is exactly the failure mode docs/abi.md warns about.
  const immutable = /\/assets\//.test(filePath.replace(/\\/g, '/'));
  res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');

  res.writeHead(200);

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  createReadStream(filePath)
    .on('error', () => res.destroy())
    .pipe(res);
});

server.listen(args.port, args.host, () => {
  const url = `http://${args.host}:${args.port}/`;
  console.log(`switch-web serving ${ROOT}`);
  console.log(`  ${url}`);
  console.log('');
  console.log('Headers set on every response:');
  for (const [key, value] of Object.entries(ISOLATION_HEADERS)) console.log(`  ${key}: ${value}`);
  console.log('  Content-Security-Policy: default-src \'self\' (+ wasm-unsafe-eval)');
  console.log('');
  console.log('Verify isolation in the browser console:');
  console.log('  crossOriginIsolated          // must be true');
  console.log('  typeof SharedArrayBuffer     // must be "function"');
  console.log('  !!navigator.gpu              // must be true');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${args.port} is already in use. Try: node tools/serve/serve.mjs --port ${args.port + 1}`);
    process.exit(1);
  }
  throw error;
});

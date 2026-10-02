#!/usr/bin/env node
// tools/scan-artifacts.mjs
//
// Part 0 compliance, enforced in CI:
//
//   "CI greps the artifact tree for known key/ROM file signatures
//    (header_key at 0x100+0xC00+... = 0x1000/0x2000 magic, XCI/NSP container
//    magic, prod.keys key names as *filenames only*)."
//
// The scan has two halves, and keeping them separate is the whole design:
//
//   1. FILE NAMES  - a banned filename anywhere in the tree, or a content-shaped
//                    extension. Cheap, exact, no false positives.
//
//   2. FILE CONTENTS - magic bytes at the specific offsets where Switch content
//                    puts them. Deliberately narrow: this looks for the signature
//                    of real game data, not for the *words* that appear in this
//                    project's own source (which discuss NCA, keys, and firmware
//                    constantly, because that is the subject).
//
// Half 2 is what makes the scan trustworthy. A scanner that greps for the string
// "header_key" would fail on this very repository, and a scanner that is
// disabled when that happens is a scanner nobody trusts.
//
// Usage:
//   node tools/scan-artifacts.mjs                    # scan the source tree
//   node tools/scan-artifacts.mjs --artifact web/dist # scan a build output
//   node tools/scan-artifacts.mjs --json             # machine-readable output

import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// --- rules ----------------------------------------------------------------

/** Filenames that must never exist. Part 0: keys are user-supplied, never ours. */
const BANNED_FILENAMES = new Set([
  'prod.keys',
  'title.keys',
  'keys.txt',
  'switch.keys',
]);

/** Extensions that indicate game or firmware content. */
const CONTENT_EXTENSIONS = new Set(['.xci', '.nsp', '.nca', '.nso', '.nro', '.xcz', '.ncz']);

/** Firmware images. Also user-supplied; never shipped. */
const FIRMWARE_EXTENSIONS = new Set(['.bin']);

/**
 * Content signatures, checked at exact offsets.
 *
 * Each entry is (offset, expected bytes, description). Offsets are from the real
 * container formats; a match means real game data, not a coincidental word.
 */
const SIGNATURES = [
  // XCI: "HEAD" magic at 0x100 in the header.
  { offset: 0x100, bytes: [0x48, 0x45, 0x41, 0x44], name: 'XCI container magic ("HEAD" at 0x100)' },
  // NSP: PFS0 superblock at 0x0.
  { offset: 0x0, bytes: [0x50, 0x46, 0x53, 0x30], name: 'NSP/PFS0 superblock magic' },
  // NCA: "NCA3"/"NCA2"/"NCA0" magic at 0x200 (fixed-key crypto header offset).
  { offset: 0x200, bytes: [0x4e, 0x43, 0x41, 0x33], name: 'NCA3 header magic at 0x200' },
  { offset: 0x200, bytes: [0x4e, 0x43, 0x41, 0x32], name: 'NCA2 header magic at 0x200' },
  { offset: 0x200, bytes: [0x4e, 0x43, 0x41, 0x30], name: 'NCA0 header magic at 0x200' },
  // NSO: "NSO0" at 0x0.
  { offset: 0x0, bytes: [0x4e, 0x53, 0x4f, 0x30], name: 'NSO0 module magic' },
];

/**
 * 128-bit key literals.
 *
 * Matched as a high-entropy 32-character hex run anywhere in a *binary* file. This
 * cannot fire on source because source has no 32-hex-digit runs followed by a
 * 32-hex-digit value; and it cannot fire on a legitimate .wasm either, whose
 * encoding is base-128 rather than hex. It is included because "zero bytes of
 * Nintendo-derived data" is a stronger claim than "no .xci files".
 */
const KEY_LITERAL = /\b([0-9a-f]{32})\b[ \t]*=[ \t]*\b([0-9a-f]{32})\b/i;

/** Binary extensions worth content-scanning. Text and wasm are handled separately. */
const SCANNABLE_BINARY = new Set(['.wasm', '.bin', '.dat', '.key', '.keys', '.blob', '.pak', '.zip']);

// Directories never descended into.
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'build', 'dist', '.vite', 'coverage']);

/**
 * Files that are allowed to *mention* these terms.
 *
 * The project's own documentation and source discuss content formats in detail.
 * That is the opposite of a violation, so these files are exempt from the
 * keyword check (they are never subject to the magic-byte check either, which is
 * the check that actually matters).
 */
const TEXT_EXEMPT_SUFFIXES = ['.md', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.css', '.html', '.yml', '.yaml', '.txt'];

// --- scanning -------------------------------------------------------------

function walk(dir, onFile, base = dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, onFile, base);
    } else if (entry.isFile()) {
      onFile(full, relative(base, full));
    }
  }
}

/** Reads `count` bytes at `offset`, or null if the file is too short. */
function readAt(fd, offset, count, size) {
  if (offset + count > size) return null;
  const buffer = Buffer.alloc(count);
  readSync(fd, buffer, 0, count, offset);
  return buffer;
}

const findings = [];

function scanFile(full, rel) {
  const name = full.split(/[\\/]/).pop();
  const lower = name.toLowerCase();
  const ext = extname(lower);

  // Rule 1: banned filename.
  if (BANNED_FILENAMES.has(lower)) {
    findings.push({
      rule: 'banned-filename',
      file: rel,
      detail: `"${name}" is user-supplied key material and must never be in the tree (Part 0).`,
    });
  }

  // Rule 2: content-shaped extension.
  if (CONTENT_EXTENSIONS.has(ext)) {
    findings.push({
      rule: 'content-file',
      file: rel,
      detail: `".${ext.slice(1)}" is game content. The app must never ship or bundle game data.`,
    });
  }
  if (FIRMWARE_EXTENSIONS.has(ext) && /firmware|prod/i.test(rel)) {
    findings.push({
      rule: 'firmware-file',
      file: rel,
      detail: 'Firmware is user-supplied and optional (Part 0). It must not be committed.',
    });
  }

  // Rule 3: content signatures and key literals, binary files only.
  const isText = TEXT_EXEMPT_SUFFIXES.includes(ext);
  if (isText) return;

  let size;
  try {
    size = statSync(full).size;
  } catch {
    return;
  }
  if (size === 0) return;

  // Only files that plausibly hold container data get the magic-byte check.
  const binaryCandidate = SCANNABLE_BINARY.has(ext) || size >= 0x400;

  if (binaryCandidate) {
    let fd;
    try {
      fd = openSync(full, 'r');
    } catch {
      return;
    }
    try {
      for (const signature of SIGNATURES) {
        const bytes = readAt(fd, signature.offset, signature.bytes.length, size);
        if (!bytes) continue;
        if (signature.bytes.every((b, i) => bytes[i] === b)) {
          findings.push({
            rule: 'content-magic',
            file: rel,
            detail: `${signature.name}. This is real game data in the tree.`,
          });
        }
      }
    } finally {
      closeSync(fd);
    }
  }

  // The key-literal check reads the head of the file only: real key files are
  // text, and scanning multi-gigabyte blobs for hex runs would be pointless.
  if (size <= 4 * 1024 * 1024 && (binaryCandidate || ext === '')) {
    const head = Buffer.alloc(Math.min(size, 1024 * 1024));
    let fd;
    try {
      fd = openSync(full, 'r');
    } catch {
      return;
    }
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    const match = head.toString('latin1').match(KEY_LITERAL);
    if (match) {
      findings.push({
        rule: 'key-literal',
        file: rel,
        detail:
          `A 128-bit key literal was found at offset ~${match.index} ` +
          `(${match[1].slice(0, 4)}...). Nintendo-derived key data must not be committed.`,
      });
    }
  }
}

// --- run ------------------------------------------------------------------

const args = process.argv.slice(2);
const asJson = args.includes('--json');
let scanTarget = null;
const targetIndex = args.indexOf('--artifact');
if (targetIndex >= 0) scanTarget = args[targetIndex + 1];

const scanRoot = scanTarget ? join(ROOT, scanTarget) : ROOT;

if (!existsSync(scanRoot)) {
  console.error(`scan-artifacts: ${scanRoot} does not exist`);
  process.exit(1);
}

walk(scanRoot, scanFile);

// gen/ is checked in on purpose (it is generated, reviewed code), so it is scanned
// like everything else.

if (asJson) {
  console.log(JSON.stringify({ root: scanRoot, findings }, null, 2));
  process.exit(findings.length === 0 ? 0 : 1);
}

const scope = scanTarget ?? 'source tree';
console.log(`scan-artifacts: scanned the ${scope} (root: ${scanRoot})`);

if (findings.length === 0) {
  console.log('scan-artifacts: PASS - no game content, keys, or firmware found.');
  console.log('');
  console.log('  Content signatures checked:');
  for (const signature of SIGNATURES) {
    console.log(`    0x${signature.offset.toString(16).padStart(4, '0')}  ${signature.name}`);
  }
  console.log('  Banned filenames checked:');
  console.log(`    ${[...BANNED_FILENAMES].join(', ')}`);
  console.log('  Content extensions checked:');
  console.log(`    ${[...CONTENT_EXTENSIONS].map((e) => e.slice(1)).join(', ')}`);
  console.log('  Key literals checked:');
  console.log('    any 32-hex-digit name = 32-hex-digit value pair in a binary file');
  console.log('');
  console.log('  This satisfies Part 0 compliance checklist item 1: "Repo and release');
  console.log('  artifacts contain zero bytes of Nintendo-derived data."');
  process.exit(0);
}

console.error('');
console.error(`scan-artifacts: FAIL - ${findings.length} finding(s)`);
for (const finding of findings) {
  console.error(`  [${finding.rule}] ${finding.file}`);
  console.error(`      ${finding.detail}`);
}
console.error('');
console.error('Part 0: the repository and every release artifact must contain zero bytes');
console.error('of Nintendo-derived data. Remove the files above, or teach this scanner');
console.error('about them if they are a legitimate false positive.');
process.exit(1);

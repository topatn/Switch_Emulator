#!/usr/bin/env node
// tools/verify-phase0.mjs
//
// Headless verification of the Part 6 Phase 0 gates that can be automated.
//
// Which gates this checks, and why the others are excluded:
//
//   AUTOMATED   crossOriginIsolated === true
//   AUTOMATED   the WASM core instantiates in each of the four worker types
//   AUTOMATED   main -> worker -> main round trip under 1 ms
//   NOT HERE    folder picker flow    - needs a native file dialog and a user gesture
//   NOT HERE    keys picker flow      - same
//   NOT HERE    artifact scan         - runs in its own CI job; it is a filesystem
//                                      check, not a browser check
//
// The shell's Diagnostics screen shows all six gates with honest statuses, and
// "not selected" for the two interactive ones. This script checks the same facts
// independently, so a regression fails CI rather than waiting for a human to open
// the page and notice.
//
// Usage: node tools/verify-phase0.mjs [--headed] [--keep-open]

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'web', 'dist');
const OUT_DIR = join(ROOT, '.phase0');
const PORT = Number(process.env.PHASE0_PORT ?? 8097);
const HEADED = process.argv.includes('--headed');

/** The Phase 0 latency budget, from Part 6. */
const ROUND_TRIP_BUDGET_MS = 1.0;

const failures = [];
const notes = [];

/** Playwright is optional: it is a dev-only verification dependency. */
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return null;
  }
}

function serve() {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'tools', 'serve', 'serve.mjs'), '--port', String(PORT), '--root', 'web/dist'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the static server did not start within 15s')), 15_000);

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      if (text.includes('serving')) {
        clearTimeout(timer);
        resolve(child);
      }
    });

    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the static server exited with code ${code}`));
    });
  });
}

async function waitForServer(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/`);
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright) {
    console.error('verify-phase0: Playwright is not installed.');
    console.error('');
    console.error('  This check needs a real browser, because the gates it verifies are');
    console.error('  browser properties: SharedArrayBuffer existence, worker boot, and');
    console.error('  cross-origin isolation. There is no substitute.');
    console.error('');
    console.error('  Install it:');
    console.error('    npm i -D playwright && npx playwright install chromium');
    console.error('');
    console.error('  Or run the equivalent checks manually:');
    console.error('    npm run build && npm run preview');
    console.error('    then open the served page and read the Diagnostics screen,');
    console.error('    which renders the same six gates.');
    process.exit(1);
  }

  const server = await serve();
  let browser;

  try {
    if (!(await waitForServer())) {
      throw new Error('the static server never became reachable');
    }

    browser = await playwright.chromium.launch({
      headless: !HEADED,
      args: [
        // Software WebGL so the check works on a runner with no GPU. This affects
        // only rendering, not any gate being verified: none of them is a
        // performance measurement.
        '--use-gl=swiftshader',
        '--enable-unsafe-swiftshader',
      ],
    });

    const page = await browser.newPage();

    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

    // --- gate: the shell must finish booting ------------------------------
    //
    // The shell renders the Diagnostics gate table once boot completes. Waiting
    // for that text is more robust than a fixed sleep and fails fast when boot
    // breaks, rather than reporting a timeout as a gate failure.
    await page.waitForFunction(
      () => document.body.innerText.includes('Phase 0 gates'),
      undefined,
      { timeout: 30_000 },
    );

    // Diagnostics lives behind a button during onboarding, which is correct: a
    // user stuck on the folder picker still needs it. Click through to reach it.
    await page.evaluate(() => {
      const attest = document.getElementById('attest-own');
      if (attest && !attest.checked) attest.click();
      const cont = [...document.querySelectorAll('button')].find(
        (b) => b.textContent.trim() === 'Continue' && !b.disabled,
      );
      cont?.click();
    });
    await page.evaluate(() => {
      const diag = [...document.querySelectorAll('button')].find(
        (b) => b.textContent.trim() === 'Diagnostics',
      );
      diag?.click();
    });

    await page.waitForFunction(
      () => document.body.innerText.includes('Platform capabilities'),
      undefined,
      { timeout: 15_000 },
    );

    const report = await page.evaluate(() => {
      const text = document.body.innerText;

      // Parse the round-trip numbers the page rendered, rather than re-measuring
      // here: the page's own instrumentation is the thing under test.
      const m = text.match(
        /samples\s+(\d+)\s+p50\s+([\d.]+) ms\s+p95\s+([\d.]+) ms\s+max\s+([\d.]+) ms/,
      );

      const bootRows = [];
      for (const kind of ['CPU', 'GPU', 'Audio', 'I/O']) {
        // A booted worker row contains the worker name followed by "booted".
        const re = new RegExp(`${kind}\\s+(booted|failed|idle)`, 'm');
        const hit = re.exec(text);
        bootRows.push({ kind, state: hit ? hit[1] : 'not found' });
      }

      // Pull the page's own diagnostics text, which is what a user would paste
      // into a bug report.
      const textarea = document.querySelector('textarea[aria-label="Diagnostics report"]');
      const raw = textarea ? textarea.value : '';

      return {
        coi: globalThis.crossOriginIsolated === true,
        sab: typeof SharedArrayBuffer === 'function',
        gpu: 'gpu' in navigator,
        roundTrip: m
          ? {
              samples: Number(m[1]),
              p50: Number(m[2]),
              p95: Number(m[3]),
              max: Number(m[4]),
            }
          : null,
        bootRows,
        rawDiagnostics: raw,
        consoleErrors: [],
      };
    });

    mkdirSync(OUT_DIR, { recursive: true });
    if (report.rawDiagnostics) {
      writeFileSync(join(OUT_DIR, 'diagnostics.txt'), report.rawDiagnostics);
    }

    await page.screenshot({ path: join(OUT_DIR, 'diagnostics.png'), fullPage: true });

    // --- gate 1: cross-origin isolation -----------------------------------
    if (!report.coi) {
      failures.push(
        'crossOriginIsolated is false. The static server must set ' +
          'Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.',
      );
    } else {
      notes.push('PASS  crossOriginIsolated === true');
    }

    if (!report.sab) {
      failures.push('SharedArrayBuffer is not available, which cross-origin isolation should have enabled.');
    } else {
      notes.push('PASS  SharedArrayBuffer available');
    }

    // --- gate 2: workers ---------------------------------------------------
    const failedWorkers = report.bootRows.filter((r) => r.state !== 'booted');
    if (report.bootRows.some((r) => r.state === 'not found') || failedWorkers.length > 0) {
      failures.push(
        `not all workers booted: ${report.bootRows
          .map((r) => `${r.kind}=${r.state}`)
          .join(', ')}`,
      );
    } else {
      notes.push('PASS  all four workers booted');
    }

    // --- gate 3: round trip ------------------------------------------------
    if (!report.roundTrip) {
      failures.push('the round-trip measurement was not reported');
    } else if (report.roundTrip.p95 >= ROUND_TRIP_BUDGET_MS) {
      failures.push(
        `round-trip p95 was ${report.roundTrip.p95} ms, budget is ${ROUND_TRIP_BUDGET_MS} ms ` +
          `(p50 ${report.roundTrip.p50}, max ${report.roundTrip.max}, over ${report.roundTrip.samples})`,
      );
    } else {
      notes.push(
        `PASS  round trip p95 ${report.roundTrip.p95} ms < ${ROUND_TRIP_BUDGET_MS} ms ` +
          `(p50 ${report.roundTrip.p50}, max ${report.roundTrip.max}, over ${report.roundTrip.samples})`,
      );
    }

    // --- informational -----------------------------------------------------
    if (report.gpu) {
      notes.push('INFO  navigator.gpu present');
    } else {
      notes.push('INFO  navigator.gpu absent (the GPU worker reports this, and it is not a Phase 0 gate)');
    }

    if (consoleErrors.length) {
      // Console errors are reported but do not fail the run: the headless
      // runner legitimately differs from a real desktop (no audio device, a
      // software WebGPU adapter), and the app is expected to report those as
      // warnings rather than errors.
      notes.push(`INFO  ${consoleErrors.length} console error(s) during boot:`);
      for (const error of consoleErrors.slice(0, 10)) {
        notes.push(`        ${error.slice(0, 200)}`);
      }
    }
  } finally {
    await browser?.close();
    server.kill();
  }

  // --- report --------------------------------------------------------------
  console.log('verify-phase0: Phase 0 gate verification');
  console.log('');
  for (const note of notes) console.log(`  ${note}`);
  console.log('');
  console.log('  Not checked here (require a user gesture):');
  console.log('    - folder picker flow');
  console.log('    - prod.keys picker flow');
  console.log('  Checked in a separate CI job:');
  console.log('    - artifact scan (tools/scan-artifacts.mjs)');
  console.log('');
  console.log(`  Diagnostics written to ${join('.phase0', 'diagnostics.txt')}`);
  console.log(`  Screenshot written to      ${join('.phase0', 'diagnostics.png')}`);
  console.log('');

  if (failures.length) {
    console.error(`verify-phase0: FAIL - ${failures.length} gate(s) not met`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log('verify-phase0: PASS - every automatable Phase 0 gate is met.');
}

main().catch((error) => {
  console.error(`verify-phase0: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

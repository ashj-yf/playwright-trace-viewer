#!/usr/bin/env node
/**
 * scripts/verify-viewer.mjs
 *
 * Independent verification harness for the bundled Playwright Trace Viewer.
 *
 * Question it answers:
 *   "Does the currently built viewer (dist/vendor/trace-viewer) actually OPEN a
 *    Playwright 1.63-era (trace schema v9) trace and RENDER it, instead of showing
 *    the 'newer version of Playwright' error?"
 *
 * How it works:
 *   1. Parses each trace zip in pure Node (no deps) and reports the schema `version`,
 *      `playwrightVersion`, and the ground-truth action/event counts.
 *   2. Serves dist/vendor/trace-viewer/ as the web root on an ephemeral 127.0.0.1 port,
 *      plus the trace zips from the same origin (the viewer's service worker fetches them).
 *   3. Drives real Google Chrome (playwright-core, devDependency) to
 *      index.html?trace=<absolute http url of the zip>.
 *   4. Asserts machine-checkably, not by eyeballing.
 *
 * Usage:
 *   node scripts/verify-viewer.mjs [trace.zip ...] [options]
 *
 * Options:
 *   --timeout <ms>      Per-trace settle timeout (default 90000)
 *   --no-selftest       Skip the synthesized "version 999" negative control
 *   --expect-error      Treat positional/default traces as expected-to-error
 *   --keep-fixtures     Do not delete the synthesized fixture
 *   --viewer-dir <dir>  Verify a different viewer build (default dist/vendor/trace-viewer)
 *   --headed            Run Chrome with a visible window
 *   --help
 *
 * Exit code: 0 if every case met its expectation, 1 otherwise.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

// 默认样本:优先使用仓库内 samples/ 下的 trace(便于他人复现),
// 其次回退到开发机上的真实 trace(存在才用)。也可用命令行参数显式指定。
const DEFAULT_TRACES = [
  ...['samples/trace-v9.zip', 'samples/trace.zip', 'samples/allure-results/trace.zip'].map((p) =>
    path.join(REPO_ROOT, p),
  ),
  '/Users/yf/Downloads/data_attachments_1df4e79321627228.zip', // schema v9, playwright 1.63.0 - the exact trace that failed
  '/Users/yf/VsCodeProjects/Playwright-Trace-Recorder-Crx/tests/test-results/screencast-smoothness/trace.zip', // schema v6 - regression control
];

const VERSION_ERROR_PHRASE = 'newer version of Playwright';

/** Make a case label unique (two different `trace.zip` files must not collide in the report). */
function uniqueLabel(existing, base, abs) {
  const taken = new Set(existing.map((c) => c.label));
  if (!taken.has(base)) return base;
  const parent = path.basename(path.dirname(abs)).replace(/[^\w.-]+/g, '_') || 'dir';
  let label = `${parent}/${base}`;
  let n = 2;
  while (taken.has(label)) label = `${parent}-${n++}/${base}`;
  return label;
}

// ---------------------------------------------------------------------------
// Minimal, dependency-free ZIP reader/writer
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Locate the End Of Central Directory record. */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * Read a zip into entries carrying their ORIGINAL compressed bytes, so entries we
 * do not modify can be copied without recompressing.
 * @returns {Array<{name:string,method:number,crc:number,compSize:number,uncompSize:number,compData:Buffer}>}
 */
function readZip(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('not a ZIP archive (End Of Central Directory not found)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error('ZIP64 archives are not supported by this harness');
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`corrupt central directory at entry ${i}`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`corrupt local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);

    entries.push({ name, method, crc, compSize, uncompSize, compData });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryData(entry) {
  if (entry.method === 0) return Buffer.from(entry.compData);
  if (entry.method === 8) return zlib.inflateRawSync(entry.compData);
  throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
}

/** Serialize entries back to a zip buffer. */
function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(e.method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.compSize, 18);
    local.writeUInt32LE(e.uncompSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, e.compData);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(e.method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.compSize, 20);
    central.writeUInt32LE(e.uncompSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + e.compData.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

// ---------------------------------------------------------------------------
// Trace inspection (ground truth straight from the zip)
// ---------------------------------------------------------------------------

/**
 * @returns {{traceEntry:string, version:number|null, playwrightVersion:string|null,
 *            type:string|null, actions:number, events:number, error?:string}}
 */
function inspectTrace(zipBuf) {
  const entries = readZip(zipBuf);
  // Prefer a top-level `trace.trace`; otherwise any entry ending in `.trace`.
  const traceEntry =
    entries.find((e) => e.name === 'trace.trace') || entries.find((e) => e.name.endsWith('.trace'));
  if (!traceEntry) throw new Error('no *.trace entry found inside the zip');

  const text = entryData(traceEntry).toString('utf8');
  const firstLine = text.split('\n', 1)[0].trim();
  let head;
  try {
    head = JSON.parse(firstLine);
  } catch {
    throw new Error(`the first line of ${traceEntry.name} is not valid JSON`);
  }

  let actions = 0;
  let events = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    // Cheap prefix test before JSON.parse to keep multi-MB traces fast.
    if (line.charCodeAt(0) !== 123 /* { */) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'before') actions++;
    else if (ev.type === 'event') events++;
  }

  return {
    traceEntry: traceEntry.name,
    type: head.type ?? null,
    version: typeof head.version === 'number' ? head.version : null,
    playwrightVersion: head.playwrightVersion ?? null,
    actions,
    events,
  };
}

/** Build a copy of a trace whose schema version is forced above any real ceiling. */
function synthesizeTooNewTrace(zipBuf, forcedVersion) {
  const entries = readZip(zipBuf);
  const target = entries.find((e) => e.name === 'trace.trace') || entries.find((e) => e.name.endsWith('.trace'));
  if (!target) throw new Error('no *.trace entry to mutate');

  const text = entryData(target).toString('utf8');
  const lines = text.split('\n');
  const head = JSON.parse(lines[0]);
  const originalVersion = head.version;
  head.version = forcedVersion;
  lines[0] = JSON.stringify(head);
  const newBuf = Buffer.from(lines.join('\n'), 'utf8');

  const mutated = entries.map((e) => {
    if (e.name !== target.name) return e; // copied verbatim, no recompression
    const compData = zlib.deflateRawSync(newBuf);
    return { name: e.name, method: 8, crc: crc32(newBuf), compSize: compData.length, uncompSize: newBuf.length, compData };
  });

  return { buffer: writeZip(mutated), originalVersion };
}

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/**
 * @param {string} rootDir directory to serve as web root
 * @param {Map<string,string>} routes extra path -> absolute file path (served from same origin)
 */
function createServer(rootDir, routes) {
  const served = { traceHits: 0, contextsFallthrough: 0 };

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }

    // A `/contexts` request reaching the server means the service worker did NOT
    // intercept it (cold load race). Record it: it is a diagnostic, not a crash.
    if (pathname === '/contexts') served.contextsFallthrough++;

    const extra = routes.get(pathname);
    if (extra) {
      if (pathname.startsWith('/__traces__/')) served.traceHits++;
      sendFile(req, res, extra, 'application/zip');
      return;
    }

    const abs = path.resolve(rootDir, '.' + pathname);
    if (abs !== rootDir && !abs.startsWith(rootDir + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let file = abs;
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    } catch {
      res.writeHead(404).end('not found');
      return;
    }
    sendFile(req, res, file, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });

  return { server, served };
}

function sendFile(req, res, file, contentType) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }

  const headers = { 'content-type': contentType, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    let start = m[1] === '' ? st.size - Number(m[2]) : Number(m[1]);
    let end = m[1] === '' || m[2] === '' ? st.size - 1 : Number(m[2]);
    start = Math.max(0, start);
    end = Math.min(st.size - 1, end);
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end();
      return;
    }
    headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
    headers['content-length'] = end - start + 1;
    res.writeHead(206, headers);
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }

  headers['content-length'] = st.size;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// Viewer metadata on disk
// ---------------------------------------------------------------------------

function readJsonVersion(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract the trace-schema ceiling the vendored viewer enforces.
 *
 * The upstream check is anchored on the version-error throw itself:
 *   1.61.1: case"context-options":{if(t.version>Ht)throw new Bn("The trace was created by a newer version ...")
 *   1.63.0: case`context-options`:if(e.version>D)throw new E(`The trace was created by a newer version ...")
 *
 * Minifiers rename and re-declare the constant (`const Ht=8`, `...,D=9,...`) and the
 * quote style differs between versions, so we anchor on the throw, read the compared
 * identifier, then take that identifier's nearest numeric assignment BEFORE the check.
 */
function extractSchemaCeiling(swSource) {
  const anchor = swSource.indexOf(VERSION_ERROR_PHRASE);
  const scope = anchor >= 0 ? swSource.slice(0, anchor) : swSource;

  const cmp = /\.version\s*>\s*([A-Za-z_$][\w$]*)/.exec(scope);
  if (!cmp) return null;

  const assignRe = new RegExp(`(?<![A-Za-z0-9_$])${cmp[1]}\\s*=\\s*(\\d+)`, 'g');
  let last = null;
  for (let m = assignRe.exec(scope); m; m = assignRe.exec(scope)) last = m;
  return last ? Number(last[1]) : null;
}

// ---------------------------------------------------------------------------
// Browser driving
// ---------------------------------------------------------------------------

const LAUNCH_STRATEGIES = [
  { label: 'chrome (channel=chrome, headless)', opts: { channel: 'chrome', headless: true } },
  { label: 'chrome (channel=chrome, headed)', opts: { channel: 'chrome', headless: false } },
  { label: 'msedge (channel=msedge, headless)', opts: { channel: 'msedge', headless: true } },
  { label: 'bundled chromium (headless)', opts: { headless: true } },
];

async function launchBrowser(chromium, headed) {
  const strategies = headed
    ? [LAUNCH_STRATEGIES[1], LAUNCH_STRATEGIES[0], { label: 'bundled chromium (headed)', opts: { headless: false } }, LAUNCH_STRATEGIES[3]]
    : LAUNCH_STRATEGIES;

  const failures = [];
  for (const s of strategies) {
    try {
      const browser = await chromium.launch({ ...s.opts, timeout: 60000 });
      return { browser, label: s.label, failures };
    } catch (err) {
      failures.push(`${s.label}: ${String(err.message).split('\n')[0]}`);
    }
  }
  throw new Error(`could not launch any browser.\n  ${failures.join('\n  ')}`);
}

/** Read every success/failure signal out of the live page. */
async function readPageState(page) {
  return page.evaluate(() => {
    const bodyText = document.body ? document.body.innerText : '';
    const metaEl = document.querySelector('.tab-metadata');
    const metaText = metaEl ? metaEl.innerText : '';
    const processingError = document.querySelector('.processing-error');
    const dialogs = [...document.querySelectorAll('dialog[open], .error, [role="alert"]')]
      .map((e) => (e.innerText || '').trim())
      .filter(Boolean);

    const num = (label) => {
      const m = new RegExp(`${label}:\\s*(\\d+)`).exec(metaText);
      return m ? Number(m[1]) : null;
    };

    return {
      bodyText,
      metaText,
      processingError: processingError ? processingError.innerText.trim() : '',
      dialogs,
      pageCount: num('pages'),
      actionCount: num('actions'),
      eventCount: num('events'),
      invalidStartTime: /start time:\s*Invalid Date/.test(metaText),
      actionRows: document.querySelectorAll('.action-title-method').length,
      actionsTreeRows: document.querySelectorAll('.actions-tree-view .action-title-method').length,
      hasActionsTab: !!document.querySelector('.tab-actions'),
      hasActionList: !!document.querySelector('.action-list-container'),
      swController: !!navigator.serviceWorker.controller,
    };
  });
}

function hasVersionError(state, logs) {
  const haystacks = [state.bodyText, state.metaText, state.processingError, ...state.dialogs, ...logs];
  return haystacks.some((t) => typeof t === 'string' && t.includes(VERSION_ERROR_PHRASE));
}

/**
 * Load one trace URL and settle until the outcome is unambiguous.
 * @returns {Promise<object>} observed state
 */
async function loadTrace(page, url, { timeoutMs, lookForVersionError }) {
  const logs = [];
  const onConsole = (m) => logs.push(`[console.${m.type()}] ${m.text()}`);
  const onPageError = (e) => logs.push(`[pageerror] ${e.message}`);

  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  try {
    const started = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const deadline = started + timeoutMs;
    let state = null;
    let stableOk = 0;

    while (Date.now() < deadline) {
      state = await readPageState(page);
      if (hasVersionError(state, logs)) break;

      // A loaded trace: metadata parsed, at least one page, and a real start time.
      const loaded =
        state.pageCount !== null &&
        state.pageCount >= 1 &&
        !state.invalidStartTime &&
        !state.processingError;

      if (loaded && lookForVersionError === false) {
        if (++stableOk >= 2) break; // require the good state to hold across two polls
      } else {
        stableOk = 0;
      }
      await page.waitForTimeout(1000);
    }

    const versionError = hasVersionError(state, logs);
    const errorDialog = state.processingError || state.dialogs.find((d) => !d.includes('must be loaded over')) || '';

    return { ...state, logs, versionError, errorDialog, elapsedMs: Date.now() - started };
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { paths: [], timeoutMs: 90000, selftest: true, expectError: false, keepFixtures: false, headed: false, viewerDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--timeout') opts.timeoutMs = Number(argv[++i]);
    else if (a === '--no-selftest') opts.selftest = false;
    else if (a === '--expect-error') opts.expectError = true;
    else if (a === '--keep-fixtures') opts.keepFixtures = true;
    else if (a === '--viewer-dir') opts.viewerDir = argv[++i];
    else if (a === '--headed') opts.headed = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    else opts.paths.push(a);
  }
  return opts;
}

const HELP = `Usage: node scripts/verify-viewer.mjs [trace.zip ...] [options]

Verifies that dist/vendor/trace-viewer actually opens the given trace zips.

Options:
  --timeout <ms>    Per-trace settle timeout (default 90000)
  --no-selftest     Skip the synthesized "version 999" negative control
  --expect-error    Treat positional/default traces as expected-to-error
  --keep-fixtures   Do not delete the synthesized fixture
  --viewer-dir <d>  Verify a different viewer build (default dist/vendor/trace-viewer)
  --headed          Run Chrome with a visible window
  --help`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const viewerDir = opts.viewerDir
    ? path.resolve(opts.viewerDir)
    : path.join(REPO_ROOT, 'dist', 'vendor', 'trace-viewer');
  const viewerIndex = path.join(viewerDir, 'index.html');

  console.log('='.repeat(78));
  console.log('Playwright Trace Viewer - bundled viewer verification');
  console.log('='.repeat(78));
  console.log(`repo                    : ${REPO_ROOT}`);
  console.log(`viewer dir              : ${viewerDir}`);

  // --- hard precondition: the build output must exist -----------------------
  if (!fs.existsSync(viewerIndex)) {
    console.error(`\nFATAL: ${viewerIndex} is missing.`);
    console.error('The extension build output does not contain the vendored viewer.');
    console.error('Run the build (e.g. `npm run build`) before verifying.');
    return 2;
  }

  // --- vendored viewer metadata --------------------------------------------
  const distVersion = fs.existsSync(path.join(viewerDir, 'VERSION'))
    ? fs.readFileSync(path.join(viewerDir, 'VERSION'), 'utf8').trim()
    : null;
  const swPath = path.join(viewerDir, 'sw.bundle.js');
  const swSource = fs.existsSync(swPath) ? fs.readFileSync(swPath, 'utf8') : '';
  const ceiling = extractSchemaCeiling(swSource);
  const pwCoreVersion = readJsonVersion(
    (() => {
      try {
        return require.resolve('playwright-core/package.json');
      } catch {
        return path.join(REPO_ROOT, 'node_modules', 'playwright-core', 'package.json');
      }
    })(),
  );

  console.log(`vendored viewer version : ${distVersion ?? '(no VERSION file)'}`);
  console.log(`schema ceiling (from sw) : ${ceiling ?? '(could not extract)'}`);
  console.log(`playwright-core in use   : ${pwCoreVersion ?? '(unknown)'}`);

  if (distVersion && pwCoreVersion && distVersion !== pwCoreVersion) {
    console.log('');
    console.log('!'.repeat(78));
    console.log(`!! STALE BUILD WARNING: dist viewer is ${distVersion} but node_modules/playwright-core is ${pwCoreVersion}.`);
    console.log('!! The build output does not match the installed dependency; testing what is on disk.');
    console.log('!'.repeat(78));
  }

  // --- collect the traces to test ------------------------------------------
  const wanted = opts.paths.length ? opts.paths : DEFAULT_TRACES;
  const usingDefaults = opts.paths.length === 0;

  /** @type {Array<{label:string,zipBuf:Buffer,file:string,expect:'load'|'version-error',info:object,synthetic?:boolean}>} */
  const cases = [];

  for (const p of wanted) {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) {
      console.log(`\nSKIP: ${abs} (does not exist)`);
      continue;
    }
    let zipBuf;
    try {
      zipBuf = await fsp.readFile(abs);
    } catch (err) {
      console.log(`\nSKIP: ${abs} (cannot read: ${err.message})`);
      continue;
    }
    let info;
    try {
      info = inspectTrace(zipBuf);
    } catch (err) {
      console.log(`\nSKIP: ${abs} (not a usable trace: ${err.message})`);
      continue;
    }
    cases.push({
      // Distinguish traces that share a basename (e.g. two different `trace.zip`).
      label: uniqueLabel(cases, path.basename(abs), abs),
      file: abs,
      zipBuf,
      info,
      expect: opts.expectError ? 'version-error' : 'load',
    });
  }

  // --- report what the traces actually are ---------------------------------
  console.log('\n--- trace files ---');
  for (const c of cases) {
    console.log(`  ${c.file}`);
    console.log(
      `      entry=${c.info.traceEntry} type=${c.info.type} version=${c.info.version} ` +
        `playwrightVersion=${c.info.playwrightVersion} actions=${c.info.actions} events=${c.info.events}`,
    );
    if (ceiling !== null && c.info.version !== null && c.info.version > ceiling) {
      console.log(`      note: version ${c.info.version} exceeds the viewer's ceiling of ${ceiling} -> cannot load`);
    }
  }
  if (!cases.length) {
    console.error('\nFATAL: no usable trace zips to verify.');
    return 2;
  }

  // --- self-test fixture: force a version above any ceiling ----------------
  let fixtureDir = null;
  if (opts.selftest) {
    const source = cases[0];
    try {
      // Written under scripts/fixtures/ (never outside the repository) and removed on exit.
      await fsp.mkdir(path.join(REPO_ROOT, 'scripts', 'fixtures'), { recursive: true });
      fixtureDir = await fsp.mkdtemp(path.join(REPO_ROOT, 'scripts', 'fixtures', 'run-'));
      const forced = 999;
      const { buffer } = synthesizeTooNewTrace(source.zipBuf, forced);
      const fixturePath = path.join(fixtureDir, 'version-999-control.zip');
      await fsp.writeFile(fixturePath, buffer);
      const info = inspectTrace(buffer);
      cases.push({
        label: 'version-999-control.zip',
        file: fixturePath,
        zipBuf: buffer,
        info,
        expect: 'version-error',
        synthetic: true,
      });
      console.log(`\n  [self-test] synthesized ${fixturePath}`);
      console.log(
        `      derived from ${source.label}, version forced to ${forced} ` +
          `(ceiling ${ceiling ?? '?'}) -> MUST trigger the version error`,
      );
    } catch (err) {
      console.log(`\n  [self-test] could not build the version-999 control: ${err.message}`);
    }
  }

  // --- start the server and the browser ------------------------------------
  const routes = new Map();
  cases.forEach((c, i) => {
    // Route names must be a single path segment: the label may contain '/' and the
    // server decodes %2F back into a separator, which would miss the Map lookup.
    c.routeName = c.label.replace(/[^\w.-]+/g, '_') || 'trace.zip';
    routes.set(`/__traces__/${i}/${c.routeName}`, c.file);
  });

  const { server, served } = createServer(viewerDir, routes);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;
  console.log(`\nserving ${viewerDir}\n     at ${base}  (trace zips served same-origin under /__traces__/)`);

  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch (err) {
    console.error(`\nFATAL: cannot import playwright-core: ${err.message}`);
    server.close();
    return 2;
  }

  let browser;
  let browserLabel;
  const launchFailures = [];
  try {
    const launched = await launchBrowser(chromium, opts.headed);
    browser = launched.browser;
    browserLabel = launched.label;
    launchFailures.push(...launched.failures);
  } catch (err) {
    console.error(`\nFATAL: ${err.message}`);
    server.close();
    return 2;
  }

  if (launchFailures.length) {
    console.log(`\nbrowser fallbacks tried before success:\n  ${launchFailures.join('\n  ')}`);
  }
  console.log(`browser                 : ${browserLabel}`);

  const results = [];

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Attach to the viewer's service worker as well, for diagnostics.
    context.on('serviceworker', (sw) => {
      sw.on('console', (m) => {
        if (m.type() === 'error') console.log(`      [sw.console.error] ${m.text().slice(0, 160)}`);
      });
    });

    const total = cases.length;
    for (let i = 0; i < total; i++) {
      const c = cases[i];
      console.log(`\n${'-'.repeat(78)}`);
      console.log(`[${i + 1}/${total}] ${c.label}`);
      console.log(`      expect: ${c.expect === 'load' ? 'TRACE LOADS AND RENDERS' : 'VERSION ERROR'}`);

      // Warm-up navigation so the service worker is installed AND controlling
      // before the trace URL is opened. Without this the page's first `/contexts`
      // fetch races SW activation and escapes to the network.
      try {
        await page.goto(base + 'index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
        const sw = await page.evaluate(async () => {
          if (!navigator.serviceWorker) return { supported: false, controller: false };
          const reg = await Promise.race([
            navigator.serviceWorker.ready,
            new Promise((r) => setTimeout(() => r(null), 20000)),
          ]);
          if (!navigator.serviceWorker.controller) {
            await new Promise((r) => {
              navigator.serviceWorker.oncontrollerchange = r;
              setTimeout(r, 15000);
            });
          }
          return { supported: true, controller: !!navigator.serviceWorker.controller, scope: reg && reg.scope };
        });
        console.log(`      service worker: supported=${sw.supported} controller=${sw.controller} scope=${sw.scope ?? '-'}`);
        if (sw.supported && !sw.controller) {
          console.log('      WARNING: service worker did not take control; the viewer cannot load the trace.');
        }
      } catch (err) {
        console.log(`      WARNING: warm-up failed: ${String(err.message).split('\n')[0]}`);
      }

      const traceUrl = `${base}__traces__/${i}/${c.routeName}`;
      const viewerUrl = `${base}index.html?trace=${encodeURIComponent(traceUrl)}`;

      let state;
      try {
        state = await loadTrace(page, viewerUrl, {
          timeoutMs: opts.timeoutMs,
          lookForVersionError: c.expect === 'version-error',
        });
      } catch (err) {
        state = {
          error: String(err.message).split('\n')[0],
          logs: [],
          versionError: false,
          bodyText: '',
          metaText: '',
          processingError: '',
          dialogs: [],
        };
      }

      const observed = state.versionError
        ? 'VERSION_ERROR'
        : state.pageCount !== null && state.pageCount >= 1 && !state.invalidStartTime
          ? 'LOADED'
          : 'NOT_LOADED';

      const expected = c.expect === 'load' ? 'LOADED' : 'VERSION_ERROR';
      let pass = observed === expected;

      // Extra fidelity checks when we expect a real load.
      const problems = [];
      if (expected === 'LOADED' && observed === 'LOADED') {
        if (state.actionCount !== c.info.actions) {
          problems.push(`metadata actions=${state.actionCount} but trace contains ${c.info.actions}`);
        }
        if (c.info.actions > 0 && state.actionRows === 0) {
          problems.push(`trace has ${c.info.actions} actions but no action rows rendered`);
        }
        if (!state.hasActionsTab) problems.push('the Actions tab is absent');
        if (state.eventCount !== null && c.info.events > 0 && state.eventCount < 1) {
          problems.push(`metadata events=${state.eventCount} but trace contains ${c.info.events}`);
        }
        if (problems.length) pass = false;
      }
      if (expected === 'VERSION_ERROR' && observed !== 'VERSION_ERROR') {
        problems.push('the version error did NOT appear');
      }
      if (state.error) problems.unshift(`page error: ${state.error}`);
      if (state.processingError && observed !== 'VERSION_ERROR') {
        problems.push(`error dialog visible: ${state.processingError.slice(0, 160)}`);
      }

      const verdict = pass ? 'PASS' : 'FAIL';
      console.log(`      trace version   : ${c.info.version} (playwrightVersion=${c.info.playwrightVersion ?? 'n/a'})`);
      console.log(`      expected        : ${expected}`);
      console.log(`      observed        : ${observed}`);
      console.log(
        `      metadata        : pages=${state.pageCount} actions=${state.actionCount} ` +
          `events=${state.eventCount} invalidStartTime=${state.invalidStartTime}`,
      );
      console.log(`      action rows     : ${state.actionRows} (actions tree: ${state.actionsTreeRows})`);
      console.log(`      service worker  : controller=${state.swController}`);
      if (state.processingError) console.log(`      error dialog    : ${state.processingError.slice(0, 240)}`);
      for (const line of (state.logs || []).filter((l) => /pageerror|console\.error/.test(l)).slice(0, 6)) {
        console.log(`      ${line.slice(0, 240)}`);
      }
      for (const p of problems) console.log(`      PROBLEM: ${p}`);
      console.log(`      => ${verdict}`);

      results.push({
        label: c.label,
        file: c.file,
        version: c.info.version,
        playwrightVersion: c.info.playwrightVersion,
        expected,
        observed,
        pass,
        problems,
        synthetic: !!c.synthetic,
      });
    }
  } finally {
    await browser.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    if (fixtureDir && !opts.keepFixtures) {
      await fsp.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // --- report --------------------------------------------------------------
  console.log(`\n${'='.repeat(78)}`);
  console.log('SUMMARY');
  console.log('='.repeat(78));
  console.log(`vendored viewer ${distVersion ?? '?'} | schema ceiling ${ceiling ?? '?'} | playwright-core ${pwCoreVersion ?? '?'}`);
  console.log(`${
    served.traceHits > 0
      ? `trace zips fetched through the service worker: ${served.traceHits}`
      : 'WARNING: the service worker never fetched a trace zip'
  }`);
  if (served.contextsFallthrough > 0) {
    console.log(`note: ${served.contextsFallthrough} /contexts request(s) escaped to the HTTP server (service worker race)`);
  }
  console.log('');

  for (const r of results) {
    const tag = r.pass ? 'PASS' : 'FAIL';
    const why = r.problems.length ? `  <- ${r.problems[0]}` : '';
    console.log(
      `[${tag}] ${r.label}  (schema v${r.version}${r.playwrightVersion ? `, playwright ${r.playwrightVersion}` : ''}, ` +
        `expected ${r.expected}, observed ${r.observed})${why}`,
    );
  }

  const failures = results.filter((r) => !r.pass);
  const expectedFailures = failures.filter((r) => r.expected === 'LOADED');
  console.log('');
  if (!failures.length) {
    console.log(`ALL ${results.length} CASE(S) PASSED`);
  } else {
    console.log(`${failures.length} of ${results.length} case(s) FAILED`);
    if (expectedFailures.length) {
      console.log('');
      console.log(`The viewer did NOT open ${expectedFailures.length} trace(s) it is expected to open:`);
      for (const r of expectedFailures) console.log(`  - ${r.file}`);
      console.log('');
      console.log('This is the expected outcome while dist/ still bundles the old viewer.');
      console.log(`Vendored viewer ${distVersion ?? '?'} caps trace schema at v${ceiling ?? '?'}; ` +
        'a version-9 trace cannot load until the vendor bump + patch re-port lands and dist/ is rebuilt.');
      if (usingDefaults) {
        console.log('(The schema v6 control passing alongside it proves the harness discriminates.)');
      }
    }
  }

  return failures.length ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`\nUNEXPECTED ERROR: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 2;
  })
  .finally(async () => {
    // 清掉自检 fixture 后可能剩下的空 scripts/fixtures 目录,保持工作区干净。
    const dir = path.join(REPO_ROOT, 'scripts', 'fixtures');
    try {
      const left = await fsp.readdir(dir);
      if (!left.length) await fsp.rmdir(dir);
    } catch {
      // 目录不存在或非空:无需处理
    }
  });

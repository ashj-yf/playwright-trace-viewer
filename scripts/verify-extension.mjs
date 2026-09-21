#!/usr/bin/env node
/**
 * 扩展端到端验证:在真实 Chrome 里加载 dist/ 这个未打包扩展,走一遍用户的真实路径。
 *
 * 与 verify-viewer.mjs 的分工:
 *   verify-viewer.mjs    以 http:// 直接打开 vendor viewer,验证"版本上限已抬到 v9";
 *                        但 http 源没有 MV3 的 CSP 限制,测不到扩展专属补丁。
 *   本脚本               以 chrome-extension:// 打开,覆盖真实的 CSP、SW、
 *                        DNR CORS 与 content script 注入链路。
 *
 * 流程:
 *   1. 起本地服务,同时提供:a) 伪 Allure 页面(含 attachment-row 结构)
 *      b) trace.zip。页面路径带 "allure",以命中默认的 urlKeywords。
 *   2. 用 launchPersistentContext 加载 dist/ 为未打包扩展。
 *   3. 打开伪 Allure 页 → content script 应注入「预览 Trace」按钮。
 *   4. 点击按钮 → 扩展新标签页打开 viewer.html?trace=…。
 *   5. 在该扩展标签页里断言:iframe 内的官方 viewer 真正渲染了 trace,
 *      且没有出现"版本过新"错误、没有 CSP 报错。
 *
 * 用法: node scripts/verify-extension.mjs [trace.zip]
 */
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');

/**
 * 解析要使用的浏览器可执行文件。
 * 品牌版 Chrome 自 137 起忽略 --load-extension(仅 Chromium / Chrome for Testing 支持),
 * 因此优先在 ms-playwright 缓存里查找 Chrome for Testing,再回退到 Playwright 自带的
 * chromium,最后回退到 channel:'chrome'(该情况下扩展很可能加载不上,会明确报错)。
 * 可用 CFT_EXE 环境变量显式指定。
 */
function resolveBrowser() {
  if (process.env.CFT_EXE) return { executablePath: process.env.CFT_EXE, source: 'CFT_EXE' };
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter((n) => n.startsWith('chromium-')).sort().reverse()) {
      const base = join(cache, d, 'chrome-mac-arm64');
      const alt = join(cache, d, 'chrome-mac');
      for (const dir of [base, alt]) {
        const app = join(dir, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        if (existsSync(app)) return { executablePath: app, source: d };
        const chrome = join(dir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
        if (existsSync(chrome)) return { executablePath: chrome, source: d };
      }
    }
  }
  return { executablePath: undefined, source: 'channel:chrome(扩展可能无法加载)' };
}

const browserChoice = resolveBrowser();
const TRACE = process.argv[2] || process.env.TRACE_ZIP;

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('缺少 dist/manifest.json,请先 npm run build');
  process.exit(2);
}
if (!TRACE || !existsSync(TRACE)) {
  console.error('需要提供一个 trace.zip 样本:');
  console.error('  node scripts/verify-extension.mjs /path/to/trace.zip');
  console.error('  或设置环境变量 TRACE_ZIP');
  process.exit(2);
}
console.log(`浏览器:       ${browserChoice.source}`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.zip': 'application/zip',
  '.json': 'application/json',
};

/** 伪 Allure 页面:结构与真实 Allure 2.x 附件行一致,默认 mime 模式即可命中。 */
const ALLURE_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Sample Allure Report</title></head>
<body>
  <div class="attachment-row" data-type="application/vnd.playwright.trace+zip" data-uid="abc">
    <div class="attachment-row__name">trace.zip</div>
    <div class="link" data-download="/data/attachments/trace.zip">2.0 MiB</div>
  </div>
</body></html>`;

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath.startsWith('/allure')) {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(ALLURE_PAGE);
    return;
  }
  if (urlPath === '/data/attachments/trace.zip') {
    // 故意不加任何 CORS 头:扩展必须靠 DNR 注入才读得到,以此验证 DNR 链路。
    res.writeHead(200, { 'Content-Type': MIME['.zip'] });
    createReadStream(TRACE).pipe(res);
    return;
  }
  res.writeHead(404).end('not found');
});

const tmp = mkdtempSync(join(tmpdir(), 'ptv-ext-'));
let context;
let failures = 0;
const notes = [];

try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  console.log(`伪 Allure 页: ${origin}/allure-report/index.html`);
  console.log(`trace:        ${origin}/data/attachments/trace.zip`);
  console.log(`trace 样本:   ${TRACE}`);
  console.log(`扩展目录:     ${DIST}`);

  const userDataDir = join(tmp, 'profile');
  // 品牌版 Chrome 从 137 起忽略 --load-extension(仅 Chromium / Chrome for Testing 支持),
  // 因此显式使用本机已安装的 Chrome for Testing;缺省时回退到 channel: 'chrome'。
  context = await chromium.launchPersistentContext(userDataDir, {
    ...(browserChoice.executablePath
      ? { executablePath: browserChoice.executablePath }
      : { channel: 'chrome' }),
    headless: true,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // 等 MV3 service worker 起来,并拿到扩展 id。
  let extId = null;
  for (let i = 0; i < 40 && !extId; i++) {
    const sw = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
    if (sw) extId = new URL(sw.url()).host;
    else await new Promise((r) => setTimeout(r, 250));
  }
  if (!extId) throw new Error('未检测到扩展 service worker(扩展可能加载失败)');
  console.log(`扩展 id:      ${extId}`);

  // ── 步骤 1:content script 注入按钮 ──
  const allure = await context.newPage();
  const allureLogs = [];
  allure.on('console', (m) => allureLogs.push(m.text()));
  await allure.goto(`${origin}/allure-report/index.html`, { waitUntil: 'load' });
  const btn = allure.locator('.atv-preview-btn');
  let injected = false;
  try {
    await btn.waitFor({ state: 'visible', timeout: 15000 });
    injected = true;
  } catch {
    injected = false;
  }
  console.log(`\n[1] content script 注入按钮: ${injected ? 'PASS' : 'FAIL'}`);
  if (!injected) {
    failures++;
    console.log('    页面日志:', allureLogs.slice(-5).join(' | ') || '(无)');
  }

  // ── 步骤 2:点击按钮 → 打开扩展预览标签页 ──
  let viewer = null;
  if (injected) {
    const popupPromise = context.waitForEvent('page', { timeout: 30000 }).catch(() => null);
    await btn.click();
    viewer = await popupPromise;
  }

  if (!viewer) {
    console.log('[2] 打开扩展预览页: FAIL(未捕获到新标签页)');
    failures++;
  } else {
    await viewer.waitForLoadState('domcontentloaded').catch(() => {});
    console.log(`[2] 打开扩展预览页: PASS (${viewer.url().slice(0, 80)}…)`);

    const logs = [];
    viewer.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    viewer.on('pageerror', (e) => logs.push(`[pageerror] ${e}`));
    // 让 iframe 内的 viewer 注册 SW、解析 zip、渲染。
    await viewer.waitForTimeout(15000);

    // ── 步骤 3:iframe 内 viewer 真正渲染 ──
    const frame = viewer.frames().find((f) => f.url().includes('vendor/trace-viewer'));
    let bodyText = '';
    let callCount = 0;
    let swController = null;
    if (frame) {
      bodyText = await frame.locator('body').innerText().catch(() => '');
      callCount = await frame
        .evaluate(() => document.querySelectorAll('.call-title, .action-title').length)
        .catch(() => 0);
      swController = await frame
        .evaluate(() => navigator.serviceWorker?.controller?.scriptURL ?? null)
        .catch(() => null);
    }

    const versionError = /newer version of Playwright/i.test(bodyText + logs.join('\n'));
    const rendered = /Actions|Network|Timeline|Metadata/i.test(bodyText);
    const loaded = !!frame && !versionError && rendered && callCount > 0;

    console.log(`[3] iframe viewer 加载 trace: ${loaded ? 'PASS' : 'FAIL'}`);
    console.log(`    frame=${frame ? 'ok' : 'MISSING'} versionError=${versionError} rendered=${rendered} actionRows=${callCount}`);
    console.log(`    sw.controller=${swController ? 'ok' : 'null'}`);
    console.log(`    文本片段: ${bodyText.slice(0, 160).replace(/\n+/g, ' | ')}`);
    if (!loaded) failures++;

    // ── 步骤 4:扩展页上不得有 CSP 违规 / 版本错误 ──
    const cspViolation = logs.some((l) => /Content Security Policy|Refused to execute inline/i.test(l));
    console.log(`[4] 无 CSP 违规(扩展页 inline script 已外部化): ${cspViolation ? 'FAIL' : 'PASS'}`);
    if (cspViolation) {
      failures++;
      console.log('    相关日志:', logs.filter((l) => /Content Security Policy/i.test(l)).slice(0, 3).join('\n              '));
    }

    if (logs.length) {
      console.log('\n    (预览页控制台,最多 12 条)');
      for (const l of logs.slice(0, 12)) console.log(`      ${l.slice(0, 160)}`);
    }
    notes.push(`actionRows=${callCount}`);
  }
} catch (e) {
  console.error('运行失败:', e);
  failures++;
} finally {
  if (context) await context.close().catch(() => {});
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? '扩展端到端全部通过' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);

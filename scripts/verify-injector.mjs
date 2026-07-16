/**
 * 验证 injector 识别逻辑:自定义 type + 名字不含 trace 也能识别。
 */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.goto(
  'http://localhost:8765/index.html#suites/61cfc8760d8b8f1aa3a572ecbe1b6d08/55ea72cb0df0085a',
  { waitUntil: 'networkidle' },
);
await page.waitForTimeout(1500);

const found = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.attachment-row')];
  const out = [];
  for (const row of rows) {
    const name =
      row.querySelector('.attachment-row__name')?.textContent?.trim() || '';
    const download =
      row.querySelector('[data-download]')?.getAttribute('data-download') || '';
    const type = row.getAttribute('data-type') || '';
    const isTraceType = /playwright-trace/i.test(type);
    const isZip = /zip/i.test(type) || /\.zip($|\?)/i.test(download);
    const hasTrace = /trace/i.test(name) || /trace/i.test(download);
    if (download && (isTraceType || (isZip && hasTrace))) {
      const url = new URL(download, location.href).href;
      if (!row.querySelector('[data-atv-injected]')) {
        const btn = document.createElement('button');
        btn.textContent = '▶ 预览 Trace';
        btn.setAttribute('data-atv-injected', '1');
        row.appendChild(btn);
      }
      out.push({
        name,
        type,
        download,
        url,
        matchedBy: isTraceType ? 'trace-type' : 'name+zip',
      });
    }
  }
  return out;
});
console.log('=== 识别到的 trace 附件 ===');
console.log(JSON.stringify(found, null, 2));

const btnCount = await page.evaluate(
  () => document.querySelectorAll('[data-atv-injected]').length,
);
console.log('注入按钮数:', btnCount);

await browser.close();

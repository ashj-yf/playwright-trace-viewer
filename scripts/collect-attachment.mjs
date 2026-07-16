import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.goto(
  'http://localhost:8765/index.html#suites/61cfc8760d8b8f1aa3a572ecbe1b6d08/55ea72cb0df0085a',
  { waitUntil: 'networkidle' },
);
await page.waitForTimeout(1500);

const result = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.attachment-row')];
  return rows.map((row) => ({
    dataType: row.getAttribute('data-type'),
    dataUid: row.getAttribute('data-uid'),
    name: row.querySelector('.attachment-row__name')?.textContent?.trim(),
    download: row.querySelector('[data-download]')?.getAttribute('data-download'),
    html: row.outerHTML.slice(0, 600),
  }));
});
console.log(JSON.stringify(result, null, 2));

await browser.close();

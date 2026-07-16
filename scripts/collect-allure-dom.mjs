import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const uid = 'c5abb60272a549df';
const suiteUid = '61cfc8760d8b8f1aa3a572ecbe1b6d08';
const base = 'http://localhost:8765/index.html';

let bestHash = null;
for (const hash of [
  `#testcase/${uid}`,
  `#suites/${suiteUid}/${uid}`,
  `#suites/${suiteUid}`,
]) {
  await page.goto(base + hash, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => ({
    hasTraceA: !![...document.querySelectorAll('a')].find(
      (a) => /trace/i.test(a.textContent || '') || /trace/i.test(a.href || ''),
    ),
    hasAttach: !!document.querySelector('[class*="attachment"]'),
    hasTestName: /test_145922|checklist/.test(document.body.innerText),
    noSelected: /No item selected/.test(document.body.innerText),
  }));
  console.log(hash, '->', JSON.stringify(info));
  if (info.hasTraceA || info.hasAttach) {
    bestHash = hash;
    break;
  }
}

if (bestHash) {
  const result = await page.evaluate(() => {
    const traceA = [...document.querySelectorAll('a')].find(
      (a) => /trace/i.test(a.textContent || '') || /trace/i.test(a.href || ''),
    );
    if (traceA) {
      let el = traceA;
      for (let i = 0; i < 6; i++) {
        if (el.parentElement) el = el.parentElement;
      }
      return {
        found: 'a',
        aOuter: traceA.outerHTML,
        aClass: traceA.className,
        aHref: traceA.href,
        aText: traceA.textContent.trim(),
        containerClass: el.className,
        container: el.outerHTML.slice(0, 5000),
      };
    }
    const reg = document.querySelector('[class*="attachment"]');
    if (reg)
      return { found: 'region', cls: reg.className, html: reg.outerHTML.slice(0, 5000) };
    return { found: 'none' };
  });
  console.log('=== 附件区 ===');
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('没找到附件区,body 文本:');
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 800));
  console.log(txt);
}

await browser.close();

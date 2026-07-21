/**
 * 截图脚本：用 Playwright 无头浏览器截取扩展的各个页面。
 * 用法：node scripts/screenshot.mjs
 * 产物输出到 docs/screenshots/
 */
import { chromium } from 'playwright-core';
import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dist = join(root, 'dist');
const outDir = join(root, 'docs', 'screenshots');

const PORT = 8766;
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.json': 'application/json',
};

// 简单的静态文件服务器
const server = createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/src/options/options.html';
  const filePath = join(dist, urlPath);
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  const ext = filePath.substring(filePath.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
});

await new Promise((resolve) => server.listen(PORT, resolve));
console.log(`Server on http://localhost:${PORT}`);

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });

try {
  // 1) 设置页面（options）
  {
    const ctx = await browser.newContext({ viewport: { width: 720, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${PORT}/src/options/options.html`, { waitUntil: 'networkidle' });
    // 预填一些默认值让截图更丰富
    await page.evaluate(() => {
      const ta = document.getElementById('trace-type-kw');
      if (ta) ta.value = 'application/vnd.playwright.trace+zip';
      const cors = document.getElementById('cors-kw');
      if (cors) cors.value = 'allure.example.com\njenkins.example.com';
    });
    await page.screenshot({ path: join(outDir, 'options-page.png'), fullPage: true });
    console.log('✅ options-page.png');
    await ctx.close();
  }

  // 2) Popup 页面（Chrome 扩展 popup 尺寸约 400x320）
  {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 320 } });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${PORT}/src/popup/popup.html`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: join(outDir, 'popup-page.png'), fullPage: true });
    console.log('✅ popup-page.png');
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
  console.log('Done.');
}

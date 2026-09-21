#!/usr/bin/env node
/**
 * 构建前置检查:public/vendor/trace-viewer/ 必须与已安装的 playwright-core 同版本。
 *
 * 为什么需要:public/vendor/ 是 gitignore 的构建输入,由 `npm install` 的 prepare
 * 钩子从 node_modules 同步。但 `npm run build` 本身不会重新同步 —— 若只更新了依赖
 * 而没重跑同步(或同步失败后残留旧产物),构建会静默打入旧版 viewer。
 * 这会导致典型故障:viewer 支持的 trace schema 版本落后于被测 Playwright,
 * 用户打开 trace 时只看到"trace 由更新版本的 Playwright 创建",而构建却一路绿灯。
 *
 * 本检查把这种"静默退化"变成构建失败。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PW_PKG = join('node_modules', 'playwright-core', 'package.json');
const VENDOR_VERSION = join('public', 'vendor', 'trace-viewer', 'VERSION');
const VENDOR_INDEX = join('public', 'vendor', 'trace-viewer', 'index.html');

if (!existsSync(PW_PKG)) {
  console.error('[check-vendor] 未找到 node_modules/playwright-core,请先 npm install');
  process.exit(1);
}

if (!existsSync(VENDOR_INDEX) || !existsSync(VENDOR_VERSION)) {
  console.error('[check-vendor] 缺少 vendor 产物,请先运行: node scripts/sync-vendor.mjs');
  process.exit(1);
}

const installed = JSON.parse(readFileSync(PW_PKG, 'utf8')).version;
const vendored = readFileSync(VENDOR_VERSION, 'utf8').trim();

if (installed !== vendored) {
  console.error(`[check-vendor] vendor 产物与依赖版本不一致:`);
  console.error(`[check-vendor]   已安装 playwright-core: ${installed}`);
  console.error(`[check-vendor]   public/vendor 产物:    ${vendored}`);
  console.error('[check-vendor] 请运行: node scripts/sync-vendor.mjs');
  process.exit(1);
}

// 顺带校验 viewer 支持的 trace schema 上限,便于排障时直接看到关键版本信息。
const sw = readFileSync(join('public', 'vendor', 'trace-viewer', 'sw.bundle.js'), 'utf8');
const ceiling = sw.match(/TraceVersionError[^,;]{0,40}[,;]\s*(?:const\s+)?(\w+)=(\d+)/);
console.log(
  `[check-vendor] ok: playwright-core@${installed}` +
    (ceiling ? `,支持 trace schema 版本 <= ${ceiling[2]}` : ''),
);

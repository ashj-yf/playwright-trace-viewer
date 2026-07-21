#!/usr/bin/env node
/**
 * 从 playwright-core 同步官方 trace-viewer 产物到 public/vendor/trace-viewer/,
 * 并 patch index.html:
 *   - 删除协议检查的 inline <script> 块。扩展运行在 chrome-extension 协议下,
 *     不在 http/https 白名单内;且 MV3 默认 CSP `script-src 'self'` 禁止 inline script,
 *     即便把条件改成 if(false) 死代码,Chrome 仍会拦截并报 CSP 错误,故整块删除。
 *
 * 由 package.json 的 prepare 脚本在 npm install 后自动调用;也可手动运行:
 *   node scripts/sync-vendor.mjs
 */
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join('node_modules', 'playwright-core', 'lib', 'vite', 'traceViewer');
const DEST = join('public', 'vendor', 'trace-viewer');
/** 匹配无属性的 inline <script>…</script> 块(第 10 行带 type/src 的外部脚本不受影响)。 */
const INLINE_SCRIPT_RE = /[ \t]*<script>[\s\S]*?<\/script>\n/;

if (!existsSync(SRC)) {
  console.error('[sync-vendor] 源不存在:', SRC);
  console.error('[sync-vendor] 请先运行: npm install');
  process.exit(1);
}

const pwVersion = JSON.parse(
  readFileSync(join('node_modules', 'playwright-core', 'package.json'), 'utf8'),
).version;

console.log(`[sync-vendor] 同步 playwright-core@${pwVersion} 的 trace-viewer 产物...`);
cpSync(SRC, DEST, { recursive: true });

// patch:删除协议检查的 inline <script> 块(CSP 禁止 inline,死代码也会报错)
const indexPath = join(DEST, 'index.html');
let html = readFileSync(indexPath, 'utf8');
if (INLINE_SCRIPT_RE.test(html)) {
  html = html.replace(INLINE_SCRIPT_RE, '');
  console.log('[sync-vendor] 已删除 index.html 的协议检查 inline script(CSP)');
} else {
  console.log('[sync-vendor] index.html 无需 patch(可能已处理或上游已改)');
}

// patch:移除 crossorigin 属性。
// 扩展在 chrome-extension:// 协议下运行,官方产物默认带有 crossorigin,
// 但 chrome-extension:// 下 crossorigin 的 CORS 校验可能导致脚本/样式加载失败,
// 且在 iframe 内嵌场景尤其容易出问题。移除所有 crossorigin 可确保资源正常加载。
const CROSSORIGIN_RE = /\s+crossorigin(?:="[^"]*")?/g;
if (CROSSORIGIN_RE.test(html)) {
  html = html.replace(CROSSORIGIN_RE, '');
  console.log('[sync-vendor] 已移除 index.html 的 crossorigin 属性');
}
writeFileSync(indexPath, html);

// patch:为 index.<hash>.js 的 SW 注册等待添加超时。
// 扩展环境下 iframe 中注册 Service Worker 可能失败或永不触发 controllerchange,
// 导致 await new Promise 永久挂起,React 无法渲染,页面空白。
// 这里添加 3s 超时并 catch 注册异常,确保即使 SW 不可用也能正常渲染 UI。
const indexJsMatch = html.match(/src="\.\/(index\.\w+\.js)"/);
if (indexJsMatch) {
  const indexJsPath = join(DEST, indexJsMatch[1]);
  let indexJs = readFileSync(indexJsPath, 'utf8');
  const SW_REG_OLD =
    'navigator.serviceWorker.register("sw.bundle.js"),navigator.serviceWorker.controller||await new Promise(h=>{navigator.serviceWorker.oncontrollerchange=()=>h()})';
  const SW_REG_NEW =
    'navigator.serviceWorker.register("sw.bundle.js").catch(()=>{}),navigator.serviceWorker.controller||await Promise.race([new Promise(h=>{navigator.serviceWorker.oncontrollerchange=()=>h()}),new Promise(h=>setTimeout(h,3e3))])';
  if (indexJs.includes(SW_REG_OLD)) {
    indexJs = indexJs.replace(SW_REG_OLD, SW_REG_NEW);
    writeFileSync(indexJsPath, indexJs);
    console.log(`[sync-vendor] 已 patch ${indexJsMatch[1]}:SW 注册超时(3s)`);
  } else {
    console.log(`[sync-vendor] ${indexJsMatch[1]} SW 注册 patch 跳过(可能已处理或上游已改)`);
  }
} else {
  console.log('[sync-vendor] 未找到 index.<hash>.js,跳过 SW 注册 patch');
}

// patch:移除 sw 对 chrome-extension:// 请求的短路透传。
// 官方 sw 的 fetch handler 对所有 chrome-extension:// 开头的请求直接 `return fetch(t)`,
// 跳过 trace 解析,导致扩展环境下 /contexts?trace=... 等 API 端点被透传给网络,
// 而这些虚拟端点没有对应实际文件,返回 ERR_FAILED,trace 无法加载。
// 移除后:API 端点(/contexts、/sha1/、/snapshotInfo/ 等)走 sw 解析;
// 导航请求(index.html)与静态资源(.js/.css)仍落到末尾 `return fetch(s.request)` 透传。
const swPath = join(DEST, 'sw.bundle.js');
let sw = readFileSync(swPath, 'utf8');
const SW_SHORTCIRCUIT = 'if(t.url.startsWith("chrome-extension://"))return fetch(t);';
if (sw.includes(SW_SHORTCIRCUIT)) {
  sw = sw.replace(SW_SHORTCIRCUIT, '');
  console.log('[sync-vendor] 已 patch sw.bundle.js:移除 chrome-extension 请求短路');
} else {
  console.log('[sync-vendor] sw.bundle.js 无需 patch(可能已处理或上游已改)');
}

// patch:外部化 snapshot 页面的 inline script,绕过 MV3 extension CSP(禁止 inline)。
// trace viewer 的 snapshot 页面(page@<sha1>)由 serveSnapshot 动态生成,内含
// `<script>ir(...)</script>` 初始化快照状态。chrome-extension:// 页面 CSP 禁止 inline,
// 该 script 被拦截导致 snapshot 视图无法渲染。这里把 inline script 提取为同源外部
// 脚本(/snapshot-script/...),由 sw 新增路由返回其内容 —— CSP 的 'self' 允许同源外部脚本。
// 时序安全:ir 内部用 window.addEventListener("load",...) 延迟处理 DOM,外部 <script src>
// (阻塞解析、加载后立即执行)能同样在 load 前注册监听。
const SW_SERVE_OLD =
  'const i=r.render();return this._snapshotIds.set(n,r),new Response(i.html,{status:200,headers:{"Content-Type":"text/html; charset=utf-8"}})';
const SW_SERVE_NEW =
  'const i=r.render();var PW_H=i.html,PW_S=PW_H.indexOf("<script>"),PW_E=PW_H.indexOf("</script>",PW_S);' +
  'if(PW_S>=0&&PW_E>PW_S){var PW_CODE=PW_H.substring(PW_S+8,PW_E),PW_U=n.replace("/snapshot/","/snapshot-script/");' +
  '(self.__pwSS=self.__pwSS||new Map()).set(PW_U,PW_CODE);' +
  'var PW_NH=PW_H.substring(0,PW_S)+\'<script src="\'+PW_U+\'"></script>\'+PW_H.substring(PW_E+9);' +
  'return this._snapshotIds.set(n,r),new Response(PW_NH,{status:200,headers:{"Content-Type":"text/html; charset=utf-8"}})}' +
  'return this._snapshotIds.set(n,r),new Response(i.html,{status:200,headers:{"Content-Type":"text/html; charset=utf-8"}})';
const SW_PING_OLD = 'if(n==="/ping")return new Response(null,{status:200});';
const SW_PING_NEW =
  'if(n==="/ping")return new Response(null,{status:200});' +
  // snapshot-script:返回外部化后的 inline script 内容
  'if(n!=null&&n.startsWith("/snapshot-script/")){var PW_C=self.__pwSS&&self.__pwSS.get(e.href);' +
  'return PW_C?new Response(PW_C,{status:200,headers:{"Content-Type":"application/javascript"}}):new Response(null,{status:404})}' +
  // snapshot:统一处理导航/子资源。扩展环境下 about:blank iframe 经 location.replace 发起的
  // snapshot 导航请求 resultingClientId 可能为空,yo 会把它当子资源透传(无实际文件 -> ERR_FAILED)。
  // 这里用 resultingClientId || clientId 兜底,无论导航/子资源都走 serveSnapshot。
  'if(n!=null&&n.startsWith("/snapshot/")){var PW_CID=s.resultingClientId||s.clientId;' +
  'if(PW_CID){var PW_R=await Fn(PW_CID,e,To);if(PW_R.errorResponse)return PW_R.errorResponse;' +
  'var PW_H2=PW_R.loadedTrace.snapshotServer.serveSnapshot(n.substring(10),e.searchParams,e.href);' +
  'return vn&&PW_H2.headers.set("Content-Security-Policy","upgrade-insecure-requests"),PW_H2}}';
if (sw.includes(SW_SERVE_OLD) && sw.includes(SW_PING_OLD)) {
  sw = sw.replace(SW_SERVE_OLD, SW_SERVE_NEW).replace(SW_PING_OLD, SW_PING_NEW);
  console.log('[sync-vendor] 已 patch sw.bundle.js:外部化 snapshot inline script(CSP)');
} else {
  console.log('[sync-vendor] snapshot CSP patch 跳过(可能已处理或上游已改)');
}
writeFileSync(swPath, sw);

// patch:为 network resource 补 _monotonicTime,修复时间轴拖选后 Network 列表被清空。
// Python Playwright 的 trace.network 用 HAR 风格 resource-snapshot(含 startedDateTime,
// 无 _monotonicTime),而 trace viewer 的 qE 用 _monotonicTime 按 selectedTime 时间窗筛选:
//   resources.filter(f => selectedTime ? !!f._monotonicTime && <在[min,max]> : true)
// 缺失 _monotonicTime 时 `!!f._monotonicTime` 为 false,拖选后全部被过滤 -> 列表空。
// 这里在 networkModel 构建 resource 时按需计算:
//   _monotonicTime = Date.parse(startedDateTime) - wallTime + startTime
// sw 解析 context-options 时 e.startTime=t.monotonicTime,与 action.startTime 同坐标系,
// 而 boundaries(He)={minimum:this.startTime, maximum:this.endTime},故与 selectedTime 对齐。
const assetsDir = join(DEST, 'assets');
const dsFiles = existsSync(assetsDir)
  ? readdirSync(assetsDir).filter((f) => f.startsWith('defaultSettingsView-') && f.endsWith('.js'))
  : [];
if (dsFiles.length === 1) {
  const dsPath = join(assetsDir, dsFiles[0]);
  let ds = readFileSync(dsPath, 'utf8');
  const DS_OLD =
    'this.resources=[...i.map(u=>u.resources)].flat().map(u=>({...u,id:`${u.pageref}-${u.startedDateTime}-${u.request.url}`}))';
  const DS_NEW =
    'this.resources=[...i.map(u=>u.resources)].flat().map(u=>({...u,id:`${u.pageref}-${u.startedDateTime}-${u.request.url}`,_monotonicTime:u._monotonicTime!=null?u._monotonicTime:(u.startedDateTime?Date.parse(u.startedDateTime)-this.wallTime+(this.startTime||0):void 0)}))';
  if (ds.includes(DS_OLD)) {
    ds = ds.replace(DS_OLD, DS_NEW);
    writeFileSync(dsPath, ds);
    console.log(`[sync-vendor] 已 patch ${dsFiles[0]}:补 network _monotonicTime`);
  } else {
    console.log('[sync-vendor] defaultSettingsView _monotonicTime patch 跳过(可能已处理或上游已改)');
  }
} else {
  console.log(`[sync-vendor] defaultSettingsView 文件数异常(${dsFiles.length}),跳过 _monotonicTime patch`);
}

writeFileSync(join(DEST, 'VERSION'), pwVersion);
console.log(`[sync-vendor] 完成 -> ${DEST}`);

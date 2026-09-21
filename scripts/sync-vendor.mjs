#!/usr/bin/env node
/**
 * 从 playwright-core 同步官方 trace-viewer 产物到 public/vendor/trace-viewer/,
 * 并对产物打上在 chrome-extension:// 下运行所需的补丁。
 *
 * 为什么必须打补丁:官方 viewer 假设自己跑在 http(s) 源上 —— SW client 语义正常、
 * 允许 inline script、modulepreload 有效、iframe 导航会产生带 URL 的 client。
 * 扩展页是 chrome-extension:// 源:MV3 的 CSP 禁止 inline script、SW 的
 * resultingClientId 语义不同、扩展资源不参与 preload cache。逐项差异都要适配。
 *
 * 设计要点(重要):
 *   每个补丁显式声明为 required 或 optional。required 补丁若匹配不到锚点,
 *   本脚本以非零码退出。上游一旦升级/minify 变量名变化,补丁会静默失效 ——
 *   这正是过去"viewer 悄悄退回旧行为、问题以别的形式复现"的根因。
 *   宁可构建失败,也不要静默跳过。
 *
 * 同步时先清空目标目录再整体复制:cpSync 不会删除上游已移除的旧文件,
 * 残留的旧 hash chunk 会让"按前缀找唯一文件"的探测逻辑失配。
 *
 * 由 package.json 的 prepare 脚本在 npm install 后自动调用;也可手动运行:
 *   node scripts/sync-vendor.mjs
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join('node_modules', 'playwright-core', 'lib', 'vite', 'traceViewer');
const DEST = join('public', 'vendor', 'trace-viewer');

if (!existsSync(SRC)) {
  console.error('[sync-vendor] 源不存在:', SRC);
  console.error('[sync-vendor] 请先运行: npm install');
  process.exit(1);
}

const pwVersion = JSON.parse(
  readFileSync(join('node_modules', 'playwright-core', 'package.json'), 'utf8'),
).version;

console.log(`[sync-vendor] 同步 playwright-core@${pwVersion} 的 trace-viewer 产物...`);

// 清空后整体复制,避免上游删除的文件残留在目标目录。
rmSync(DEST, { recursive: true, force: true });
cpSync(SRC, DEST, { recursive: true });

// ─────────────────────────── 补丁框架 ───────────────────────────

/** 目标文件内容缓存:补丁按顺序在同一份内容上叠加。 */
const files = new Map();
/** 所有补丁的执行结果,结束时统一汇报。 */
const results = [];

function load(relPath) {
  const abs = join(DEST, relPath);
  if (!existsSync(abs)) throw new Error(`目标文件不存在: ${relPath}`);
  files.set(relPath, readFileSync(abs, 'utf8'));
}

/**
 * 应用一个补丁。
 * @param {object} spec
 * @param {string} spec.file     目标文件(相对 DEST)
 * @param {string} spec.label    人类可读的补丁说明
 * @param {RegExp} spec.find     锚点;必须能匹配,否则视为补丁失效
 * @param {string|Function} spec.replace  替换内容;函数签名 (match, ...groups) => string
 * @param {boolean} [spec.required=true]  false 表示允许失效(仅告警)
 * @returns {boolean} 是否成功应用
 */
function patch({ file, label, find, replace, required = true }) {
  const before = files.get(file);
  if (before === undefined) throw new Error(`补丁目标未加载: ${file}`);
  // 每次都用新的正则,避免 lastIndex 状态在重复调用间泄漏。
  const re = new RegExp(find.source, find.flags);
  const matched = re.test(before);
  if (!matched) {
    results.push({ file, label, ok: false, required });
    return false;
  }
  const after = before.replace(new RegExp(find.source, find.flags), replace);
  if (after === before) {
    results.push({ file, label, ok: false, required });
    return false;
  }
  files.set(file, after);
  results.push({ file, label, ok: true, required });
  return true;
}

/** 校验某个补丁的最终效果确实存在于文件中(防止替换逻辑写错)。 */
function assertContains(file, label, needle) {
  const content = files.get(file);
  const ok = typeof content === 'string' && content.includes(needle);
  results.push({ file, label, ok, required: true });
  return ok;
}

/**
 * 按前缀查找唯一的产物文件(hash 化文件名每次构建都会变)。
 * @param {string} prefix 文件名前缀,如 'snapshot.'
 * @param {object} [opts]
 * @param {string} [opts.dir='assets'] 相对 DEST 的目录;传 '' 表示 DEST 根目录
 * @param {string} [opts.ext='.js']    扩展名
 * @returns {string} 相对 DEST 的路径
 */
function findOne(prefix, { dir = 'assets', ext = '.js' } = {}) {
  const absDir = dir ? join(DEST, dir) : DEST;
  const hits = readdirSync(absDir).filter((f) => f.startsWith(prefix) && f.endsWith(ext));
  if (hits.length !== 1) {
    throw new Error(
      `期望 ${dir || '.'}/${prefix}*${ext} 恰好 1 个,实际 ${hits.length} 个: ${hits.join(', ')}`,
    );
  }
  return dir ? join(dir, hits[0]) : hits[0];
}

// ─────────────────────── 定位产物文件 ───────────────────────

const indexHtml = 'index.html';
const snapshotHtml = 'snapshot.html';
const uiModeHtml = 'uiMode.html';
const swFile = 'sw.bundle.js';

load(indexHtml);
load(snapshotHtml);
if (existsSync(join(DEST, uiModeHtml))) load(uiModeHtml);

// index.html 里的 script src 与 assets/* 中的 hash chunk 需精确对应。
const indexJsName = files.get(indexHtml).match(/src="\.\/(index\.\w+\.js)"/)?.[1];
if (!indexJsName) throw new Error('index.html 中未找到 index.<hash>.js 引用');
load(indexJsName);

const snapshotJsName = findOne('snapshot.', { dir: '' });
load(snapshotJsName);

const dsFile = findOne('defaultSettingsView-');
load(dsFile);

const umFile = findOne('urlMatch-');
load(umFile);

load(swFile);

console.log(`[sync-vendor] 产物: ${indexJsName}, ${snapshotJsName}, ${dsFile}, ${umFile}`);

// ─────────────── HTML:inline script / crossorigin ───────────────

// patch:删除协议检查的 inline <script> 块。扩展运行在 chrome-extension 协议下,
// 不在 http/https 白名单内;且 MV3 默认 CSP `script-src 'self'` 禁止 inline script,
// 即便把条件改成 if(false) 死代码,Chrome 仍会拦截并报 CSP 错误,故整块删除。
// 注意锚点必须排除带 type/src 的外部脚本标签,只匹配无属性的裸 <script>。
patch({
  file: indexHtml,
  label: 'index.html 删除协议检查 inline script(CSP)',
  find: /[ \t]*<script>[\s\S]*?<\/script>\n/,
  replace: '',
});

// patch:移除 vendor HTML 里所有 crossorigin 属性。
// chrome-extension:// 下 crossorigin 的 CORS 校验可能导致脚本/样式加载失败,
// 在 iframe 内嵌场景尤其容易出问题。移除后资源正常加载。
for (const name of [indexHtml, uiModeHtml, snapshotHtml]) {
  if (!files.has(name)) continue;
  patch({
    file: name,
    label: `${name} 移除 crossorigin`,
    find: /\s+crossorigin(?:="[^"]*")?/g,
    replace: '',
  });
}

// patch:移除 snapshot.html 的 iframe sandbox 属性。
// 官方设了 sandbox="allow-same-origin allow-scripts",这种组合等于没有 sandbox,
// 在 chrome-extension:// 下会触发 Chrome 安全警告:
//   "An iframe which has both allow-scripts and allow-same-origin for its
//    sandbox attribute can escape its sandboxing."
// snapshot 内容来自 Playwright 自身的渲染器,不含用户页面原始脚本,扩展页内无需 sandbox。
patch({
  file: snapshotHtml,
  label: 'snapshot.html 移除 iframe sandbox(消除安全警告)',
  find: /\s+sandbox="allow-same-origin allow-scripts"/,
  replace: '',
});

// ─────────── SW 注册:等待 ready 而非 oncontrollerchange ───────────

// patch:index/snapshot 的 SW 注册改为等待 ready + 超时。
// 官方只检查 controller 并 await oncontrollerchange;但注册后 SW 可能处于
// installed/waiting 而非 activating,此时 controller 恒为 null、
// oncontrollerchange 不触发,后续 fetch 直接走网络 -> "Failed to fetch"。
// register().then(() => ready) 在 SW 激活后才 resolve;8s 超时兜底,
// 即使 SW 不可用也能继续渲染 UI。
// 用正则捕获引号与变量名,避免上游 minify 后变量名变化导致失配。
const swRegisterReplace = (_m, q, v) =>
  `await Promise.race([navigator.serviceWorker.register(${q}sw.bundle.js${q}).then(()=>navigator.serviceWorker.ready),new Promise(${v}=>setTimeout(${v},8e3))]).catch(()=>{})`;

// index 入口:resolver 多包了一层箭头函数 `()=>e()`。
patch({
  file: indexJsName,
  label: `${indexJsName} SW 注册改为等待 ready(8s 超时)`,
  find: /navigator\.serviceWorker\.register\((["`])sw\.bundle\.js\1\),navigator\.serviceWorker\.controller\|\|await new Promise\((\w+)=>\{navigator\.serviceWorker\.oncontrollerchange=\(\)=>\2\(\)\}\)/,
  replace: swRegisterReplace,
});

// snapshot.html 的 popout 模式同样需要 SW 才能 serve 快照内容。
patch({
  file: snapshotJsName,
  label: `${snapshotJsName} SW 注册改为等待 ready(8s 超时)`,
  find: /navigator\.serviceWorker\.register\((["`])sw\.bundle\.js\1\),navigator\.serviceWorker\.controller\|\|await new Promise\((\w+)=>navigator\.serviceWorker\.oncontrollerchange=\2\)/,
  replace: swRegisterReplace,
});

// ───────────────────── Service Worker 路由 ─────────────────────

const swSrc = files.get(swFile);
// 从 pristine 源码里抓出官方 SW 的局部变量名,替换时按名引用而不是硬编码。
const handler = swSrc.match(/async function (\w+)\((\w+)\)\{let (\w+)=\2\.request;/);
if (!handler) throw new Error('sw.bundle.js 中未找到 fetch handler 结构');
const [, , swEventVar, swReqVar] = handler;

const urlVarMatch = swSrc.match(/let (\w+)=new URL\(\w+\.url\)/);
if (!urlVarMatch) throw new Error('sw.bundle.js 中未找到 new URL(...) 局部变量');
const swUrlVar = urlVarMatch[1];

const pathVarMatch = swSrc.match(/&&\((\w+)=(\w+)\.pathname\.substring/);
if (!pathVarMatch) throw new Error('sw.bundle.js 中未找到路径局部变量');
const swPathVar = pathVarMatch[1];

// ma 只在 https 源下为 true(用于附加 upgrade-insecure-requests),扩展下恒 false。
const httpsVarMatch = swSrc.match(/(\w+)=self\.registration\.scope\.startsWith/);
const swHttpsVar = httpsVarMatch?.[1];

// patch:移除 SW 对 chrome-extension:// 请求的短路透传。
// 官方 fetch handler 对所有 chrome-extension:// 开头的请求直接 `return fetch(t)`,
// 跳过 trace 解析。扩展环境下 /contexts?trace=... 等虚拟端点被透传给网络,
// 而它们没有对应实体文件,返回 ERR_FAILED,trace 无法加载。
// 移除后:虚拟端点走 SW 解析;导航与静态资源仍落到末尾 `return fetch(...)` 透传。
patch({
  file: swFile,
  label: 'sw.bundle.js 移除 chrome-extension:// 请求短路',
  find: /if\((\w+)\.url\.startsWith\((["`])chrome-extension:\/\/\2\)\)return fetch\(\1\);/,
  replace: '',
});

// patch:/snapshot/ 与 /snapshot-script/ 路由。
//
// ① /snapshot/ 导航兜底:扩展环境下 about:blank iframe 的导航请求
//    resultingClientId 可能为空,官方据此判定"非导航",把它当子资源透传
//    (无实体文件 -> ERR_FAILED)。这里在官方 resultingClientId 判定之前插入分支,
//    用 `resultingClientId || clientId` 兜底,使快照 HTML 始终由 serveSnapshot 产出。
//    注意兜底只对 /snapshot/ 生效 —— 若把 clientId 兜底扩散到通用判定,
//    子资源请求也会被当成导航,样式/图片会全部走网络而失败。
// ② /snapshot-script/:serveSnapshot 已把 inline script 外部化为同源脚本(见下个补丁),
//    此路由返回其缓存内容。用请求 URL 作 key,与注入的 <script src> 完全一致。
const earlyRoutes = (() => {
  const cspAppend = swHttpsVar
    ? `return ${swHttpsVar}&&PW_SN.headers.append("Content-Security-Policy","upgrade-insecure-requests"),PW_SN`
    : 'return PW_SN';
  return (
    `if(${swPathVar}!=null&&${swPathVar}.startsWith("/snapshot/")){` +
    `var PW_CID=${swEventVar}.resultingClientId||${swEventVar}.clientId;` +
    `if(PW_CID){var PW_R=await ga(PW_CID,${swUrlVar},Ca);` +
    `if(PW_R.errorResponse)return PW_R.errorResponse;` +
    `var PW_SN=PW_R.loadedTrace.snapshotServer.serveSnapshot(decodeURIComponent(${swPathVar}.substring(10)),${swUrlVar}.searchParams,${swUrlVar}.href);` +
    `${cspAppend}}}` +
    `if(${swPathVar}!=null&&${swPathVar}.startsWith("/snapshot-script/")){` +
    `var PW_C=self.__pwSS&&self.__pwSS.get(${swReqVar}.url);` +
    `return PW_C?new Response(PW_C,{status:200,headers:{"Content-Type":"application/javascript"}}):new Response(null,{status:404})}`
  );
})();

patch({
  file: swFile,
  label: 'sw.bundle.js 新增 /snapshot/ 兜底与 /snapshot-script/ 路由',
  find: /if\((\w+)===(["`])\/ping\2\)return new Response\(null,\{status:200\}\);/,
  replace: (m) => m + earlyRoutes,
});

// patch:外部化 snapshot 页面的 inline script,绕过 MV3 extension CSP(禁止 inline)。
// 官方 serveSnapshot 生成 `<script nonce="…">ir(…)</script>`,但在扩展页上
// 响应头 CSP 的 nonce 无法放宽 manifest 的 `script-src 'self'` —— inline 一律被拦截,
// snapshot 视图渲染不出来。这里把 inline script 提取为同源外部脚本
// (/snapshot-script/…),并把响应 CSP 改为 `script-src 'self'`,
// 使 manifest CSP 与响应 CSP 都允许该同源脚本。
// 输出一律用字符串拼接构造,不引入反引号与模板占位符,避免二次转义问题。
patch({
  file: swFile,
  label: 'sw.bundle.js 外部化 snapshot inline script(CSP)',
  find: /let (\w+)=(\w+)\.render\(\);return this\._snapshotIds\.set\((\w+),(\w+)\),new Response\(\1\.html,\{status:200,headers:\{"Content-Type":`text\/html; charset=utf-8`,"Content-Security-Policy":`script-src 'nonce-\$\{\1\.scriptNonce\}'; object-src 'none'`\}\}\)\}/,
  replace: (m, renderVar, snapVar, hrefVar) => {
    const outer = `let ${renderVar}=${snapVar}.render();`;
    const body = `var PW_H=${renderVar}.html,PW_S=PW_H.indexOf("<script"),PW_E=PW_H.indexOf("</script>",PW_S);`;
    const externalize =
      `if(PW_S>=0&&PW_E>PW_S){` +
      `var PW_GT=PW_H.indexOf(">",PW_S),PW_CODE=PW_H.substring(PW_GT+1,PW_E),` +
      `PW_U=${hrefVar}.replace("/snapshot/","/snapshot-script/");` +
      `(self.__pwSS=self.__pwSS||new Map()).set(PW_U,PW_CODE);` +
      `var PW_NH=PW_H.substring(0,PW_S)+'<script src="'+PW_U+'"></script>'+PW_H.substring(PW_E+9);` +
      `return this._snapshotIds.set(${hrefVar},${snapVar}),new Response(PW_NH,{status:200,headers:{` +
      `"Content-Type":"text/html; charset=utf-8",` +
      `"Content-Security-Policy":"script-src 'self'; object-src 'none'"}})}`;
    const fallback =
      `return this._snapshotIds.set(${hrefVar},${snapVar}),new Response(${renderVar}.html,{status:200,headers:{` +
      `"Content-Type":"text/html; charset=utf-8",` +
      `"Content-Security-Policy":"script-src 'nonce-"+${renderVar}.scriptNonce+"'; object-src 'none'"}})}`;
    return outer + body + externalize + fallback;
  },
});

// ─────────── defaultSettingsView:网络模型与联动 ───────────

const dsSrc = files.get(dsFile);

// patch:为 network resource 补 _monotonicTime,修复时间轴拖选后 Network 列表被清空。
// Python Playwright 的 trace.network 用 HAR 风格 resource-snapshot(含 startedDateTime,
// 可能没有 _monotonicTime),而 viewer 用 _monotonicTime 按 selectedTime 时间窗筛选:
//   resources.filter(f => selectedTime ? !!f._monotonicTime && <在[min,max]> : true)
// 缺失时 `!!f._monotonicTime` 为 false,拖选后全部被过滤 -> 列表空。
// 这里在构建 resource 时按需计算:
//   _monotonicTime = Date.parse(startedDateTime) - wallTime + startTime
// sw 解析 context-options 时 startTime = monotonicTime,与 action.startTime 同坐标系,
// 而 boundaries = {minimum:startTime, maximum:endTime},故与 selectedTime 对齐。
// 为兼容上游写法变化,id 的模板字符串在这里改写为等价的字符串拼接。
patch({
  file: dsFile,
  label: `${dsFile} 补 network _monotonicTime`,
  find: /this\.resources\.push\(\{\.\.\.(\w+),id:\`\$\{(\w+)\(\1\)\?\?(\w+)\}-\$\{\1\.startedDateTime\}-\$\{\1\.request\.url\}\`\}\)/,
  replace: (_m, res, refFn, idx) =>
    `this.resources.push({...${res},id:((${refFn}(${res})??${idx})+"-"+${res}.startedDateTime+"-"+${res}.request.url),` +
    `_monotonicTime:${res}._monotonicTime!=null?${res}._monotonicTime:(${res}.startedDateTime?Date.parse(${res}.startedDateTime)-this.wallTime+(this.startTime||0):void 0)})`,
});

// patch:播放/选中 action 时 Network 列表增量联动。
// 优先级:selectedTime(拖选时间轴) > playing(播放) > highlighted action(点击/悬停)
// 拖选时精确筛选,播放/点击时从起点累积到当前位置/action 结束。
// 相关局部量都从 pristine 源码里按结构抓取,避免硬编码 minify 后的变量名。
const playback = dsSrc.match(/(\w+)=(\w+)\((\w+)\|\|\[\],(\w+),(\w+),(\w+),(\w+)\)/);
const highlighted = dsSrc.match(/(\w+)=T\.useMemo\(\(\)=>(\w+)\|\|(\w+),\[(\w+),(\w+)\]\)/);
const netCall = dsSrc.match(
  /(\w+)=(\w+)\((\w+),(\w+)\),(\w+)=(\w+)\((\w+),(\w+)\)(?=,\w+=)/,
);
if (!playback || !highlighted || !netCall) {
  throw new Error(
    'defaultSettingsView 中未找到播放/网络联动所需的结构(playback/highlighted/netCall)',
  );
}
const playbackVar = playback[1];
const boundariesVar = playback[7];
const highlightedVar = highlighted[1];
const netFilterVar = netCall[6];
const netModelVar = netCall[3];
const netTimeVar = netCall[8];

patch({
  file: dsFile,
  label: `${dsFile} 播放/选中 action 时 Network 实时联动`,
  find: /(\w+)=(\w+)\((\w+),(\w+)\),(\w+)=(\w+)\((\w+),(\w+)\)(?=,\w+=)/,
  replace: () =>
    `${netCall[1]}=${netCall[2]}(${netModelVar},${netTimeVar}),` +
    `${netCall[5]}=${netFilterVar}(${netModelVar},` +
    `${netTimeVar}?${netTimeVar}:` +
    `${playbackVar}.playing?{minimum:${boundariesVar}.minimum-1e3,maximum:${boundariesVar}.minimum+${playbackVar}.percent/100*(${boundariesVar}.maximum-${boundariesVar}.minimum)}:` +
    `${highlightedVar}?{minimum:${boundariesVar}.minimum-1e3,maximum:${highlightedVar}.endTime}:` +
    `${netTimeVar})`,
});

// patch:让 Vite 的 __vitePreload 只处理 CSS 依赖,不再注入 modulepreload。
// 动态 import 时该 helper 会为每个依赖建 <link>:CSS 用 rel=stylesheet 且会被 await
// (样式必须保留),JS 用 rel=modulepreload —— 但扩展页上这条永远不会被复用,Chrome 报
//   "not used because it is a cross-world extension resource mismatch"
// 结果 codeMirrorModule / xtermModule 各被重复读取一遍。此处把依赖列表过滤成只剩 .css。
// 属性能优化,补丁失效只降级为多一次预取,故标记 optional。
patch({
  file: dsFile,
  label: `${dsFile} __vitePreload 只保留 CSS 依赖(性能)`,
  required: false,
  find: /(=function\(\w+,(\w+),\w+\)\{let \w+=Promise\.resolve\(\);if\()\2&&\2\.length>0\)\{/,
  replace: (_m, head, deps) =>
    `${head}(${deps}=(${deps}||[]).filter(pw=>pw.endsWith(".css"))).length>0){`,
});

// ─────────────── urlMatch:协议白名单 ───────────────

// patch:urlMatch 协议白名单追加 chrome-extension:。
// snapshot.html 的 popout 模式在扩展内打开时 location.href 为 chrome-extension://,
// 该函数的协议校验只认 http:/https:,解析后 return false,iframe.src 保持 about:blank
// → 页面白屏。
patch({
  file: umFile,
  label: `${umFile} 协议白名单追加 chrome-extension:`,
  find: /\[(["`])http:\1,(["`])https:\2\]\.includes\(new URL\((\w+),(\w+)\)\.protocol\)/,
  replace: (_m, _q1, _q2, base, rel) =>
    `["http:","https:","chrome-extension:"].includes(new URL(${base},${rel}).protocol)`,
});

// patch:移除 vendor HTML 里的 modulepreload 提示。
// chrome-extension:// 页面上 modulepreload 完全无效,Chrome 明确报:
//   "A preload for '…' is found, but is not used because it is a
//    cross-world extension resource mismatch."
// 扩展资源走独立的 URL loader,不参与渲染进程 preload cache,预取响应一律被丢弃、
// 真实 import 再取一次 —— 纯重复读取 + 控制台噪音。属优化,故 optional。
for (const name of [indexHtml, uiModeHtml, snapshotHtml]) {
  if (!files.has(name)) continue;
  patch({
    file: name,
    label: `${name} 移除 modulepreload(扩展页无效预取)`,
    required: false,
    find: /[ \t]*<link rel="modulepreload"[^>]*>\n?/g,
    replace: '',
  });
}

// ──────────────────── 后置校验 ────────────────────

// 替换逻辑本身写错时,上面的 patch() 仍会报告成功(文本确实变了),
// 因此对关键产物再做一次内容断言。
assertContains(swFile, 'sw: snapshot-script 缓存已注入', '__pwSS');
assertContains(swFile, 'sw: /snapshot-script/ 路由已注入', '/snapshot-script/');
assertContains(swFile, 'sw: chrome-extension 短路已移除', 'startsWith("/snapshot/")');
if (/chrome-extension:\/\/["`]\)\)return fetch\(/.test(files.get(swFile))) {
  results.push({
    file: swFile,
    label: 'sw: chrome-extension 短路仍残留',
    ok: false,
    required: true,
  });
}
assertContains(dsFile, 'ds: _monotonicTime 已注入', '_monotonicTime:');
assertContains(umFile, 'um: chrome-extension 协议已加入', 'chrome-extension:');
assertContains(indexHtml, 'index.html: inline script 已清除', '<div id="root">');
if (/<script>[\s\S]*?<\/script>/.test(files.get(indexHtml))) {
  results.push({
    file: indexHtml,
    label: 'index.html: 仍存在 inline script',
    ok: false,
    required: true,
  });
}

// 记录 viewer 支持的 trace schema 上限(排障时最关键的版本信息)。
const ceiling = files.get(swFile).match(/TraceVersionError[^,;]{0,40}[,;]\s*(?:const\s+)?(\w+)=(\d+)/);
const traceSchemaMax = ceiling ? ceiling[2] : '未知';

// ──────────────────── 落盘 ────────────────────

for (const [rel, content] of files) {
  writeFileSync(join(DEST, rel), content);
}
writeFileSync(join(DEST, 'VERSION'), pwVersion);

// ──────────────────── 汇报 ────────────────────

console.log('');
for (const r of results) {
  const tag = r.ok ? '✓' : r.required ? '✗' : '·';
  const suffix = r.ok || r.required ? '' : '(optional,已跳过)';
  console.log(`  ${tag} ${r.label}${suffix}`);
}

const failed = results.filter((r) => !r.ok && r.required);
console.log('');
console.log(`[sync-vendor] playwright-core@${pwVersion}`);
console.log(`[sync-vendor] viewer 支持的最高 trace schema 版本: ${traceSchemaMax}`);

if (failed.length > 0) {
  console.error('');
  console.error(`[sync-vendor] 失败:${failed.length} 个必需补丁未命中锚点。`);
  console.error('[sync-vendor] 通常意味着上游产物结构已变,需按新结构更新本脚本的锚点。');
  console.error('[sync-vendor] 不要忽略此错误:补丁失效会让 viewer 在扩展环境下静默退化。');
  for (const r of failed) console.error(`[sync-vendor]   - ${r.file}: ${r.label}`);
  process.exit(1);
}

console.log(`[sync-vendor] 完成 -> ${DEST}`);

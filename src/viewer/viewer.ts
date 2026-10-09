/**
 * Trace 预览页。区分两种模式:
 *
 *   - 手动模式 (无 ?trace=): 直接加载官方 viewer，用户可拖拽/选择文件。
 *   - 注入模式 (有 ?trace=): 直接把 trace URL 作为查询参数传给 vendor iframe，
 *     由 vendor 自己的 Service Worker 负责加载（依赖 DNR 注入 CORS 头）。
 *
 *   不再通过 fetch + postMessage 中转，因为 vendor SW 无法访问 Blob URL。
 */
const metaEl = document.getElementById('meta') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const frame = document.getElementById('viewer-frame') as HTMLIFrameElement;

const INDEX_URL = chrome.runtime.getURL('vendor/trace-viewer/index.html');

const params = new URLSearchParams(location.search);
const traceUrl = params.get('trace');
const caseName = params.get('case');

if (caseName) metaEl.textContent = `用例: ${caseName}`;

// ──── 提取中占位: pending 态由 background 经 TRACE_UPLOAD_DONE 重定向本页 ────
if (!traceUrl && params.get('pending') === '1') {
  document.body.classList.add('loading');
  statusEl.textContent = '正在从报告页提取 Trace…';
// ──── 手动模式: 无 trace URL，直接渲染 ────
} else if (!traceUrl) {
  frame.src = INDEX_URL;
} else {
  // ──── 注入模式: 把 trace URL 直接传给 vendor iframe ────
  document.body.classList.add('loading');
  statusEl.textContent = '正在加载 Trace…';

  // vendor trace viewer 通过 SW 从查询参数中读取 trace URL 并加载，
  // DNR 规则已在打开此页面前由 background SW 配置好 CORS 头。
  const viewerUrl = `${INDEX_URL}?trace=${encodeURIComponent(traceUrl)}`;
  frame.src = viewerUrl;

  frame.addEventListener('load', () => {
    document.body.classList.remove('loading');
    statusEl.textContent = '';
  }, { once: true });
}

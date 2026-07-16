/**
 * Trace 预览页(壳)。
 *
 * 流程:
 *   1. 从 URL 参数取 traceUrl(由 content script 经 background 传入)。
 *   2. 直接把 traceUrl 作为 ?trace= 传给内嵌的官方 trace-viewer(index.html),
 *      由官方 viewer 的 SW 在线读取并解析,扩展层不下载、不缓存。
 *   3. 官方 viewer 通过其 Service Worker 渲染五视图。
 *
 * 跨域由 declarativeNetRequest 解决(见 background/dnr.ts):vendor SW fetch
 * 远程 trace URL 时,DNR 给响应注入 Access-Control-Allow-Origin,使跨域读取
 * 通过,故扩展层无需 blob 中转下载。
 */

const metaEl = document.getElementById('meta') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const frame = document.getElementById('viewer-frame') as HTMLIFrameElement;

const INDEX_URL = chrome.runtime.getURL('vendor/trace-viewer/index.html');

const params = new URLSearchParams(location.search);
const traceUrl = params.get('trace');
const caseName = params.get('case');

if (caseName) metaEl.textContent = `用例: ${caseName}`;

/** iframe 加载后,关闭官方页面残留的协议检查报错弹窗(已 patch,留作兜底)。 */
frame.addEventListener('load', () => {
  statusEl.textContent = '';
  try {
    (frame.contentDocument?.getElementById('fallback-error') as HTMLDialogElement | null)?.close();
  } catch {
    // 跨域无法访问时忽略
  }
});

if (traceUrl) {
  statusEl.textContent = '正在打开 trace…';
  const u = new URL(INDEX_URL);
  u.searchParams.set('trace', traceUrl);
  frame.src = u.toString();
} else {
  // 无 trace 参数(手动入口):直接显示官方 viewer 的拖拽/选择界面。
  frame.src = INDEX_URL;
}

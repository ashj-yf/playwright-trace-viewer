/**
 * Trace 预览页(壳)。
 *
 * 流程:
 *   1. 从 URL 参数取 traceUrl(由 content script 经 background 传入)。
 *   2. fetch 远程 zip -> Blob -> blob URL(扩展页有 host 权限,可跨域 fetch)。
 *   3. 把 blob URL 作为 ?trace= 传给内嵌的官方 trace-viewer(index.html)。
 *   4. 官方 viewer 通过其 Service Worker 解析 zip 并渲染五视图。
 *
 * 用 blob URL 中转是为了避免官方 SW 跨域 fetch 远程附件受 CORS 限制。
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
  try {
    (frame.contentDocument?.getElementById('fallback-error') as HTMLDialogElement | null)?.close();
  } catch {
    // 跨域无法访问时忽略
  }
});

async function loadFromUrl(url: string): Promise<void> {
  statusEl.textContent = `正在下载 trace: ${url}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    statusEl.textContent = `已下载 ${(blob.size / 1024 / 1024).toFixed(1)} MB,解析中…`;
    const blobUrl = URL.createObjectURL(blob);
    const u = new URL(INDEX_URL);
    u.searchParams.set('trace', blobUrl);
    frame.src = u.toString();
  } catch (e) {
    statusEl.textContent = `加载失败: ${(e as Error).message}`;
  }
}

if (traceUrl) {
  void loadFromUrl(traceUrl);
} else {
  // 无 trace 参数(手动入口):直接显示官方 viewer 的拖拽/选择界面。
  frame.src = INDEX_URL;
}

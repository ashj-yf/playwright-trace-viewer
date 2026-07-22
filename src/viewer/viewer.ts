/**
 * Trace 预览页(壳)。
 *
 * 流程:
 *   1. viewer.html 以扩展权限 fetch 远程 trace zip(免除 DNR/CORS 依赖)。
 *   2. 转为 Blob,通过 postMessage 传给 iframe 内的官方 trace-viewer。
 *   3. 官方 viewer 的 SW 仅处理本地 blob URL,无需跨域访问。
 */
const metaEl = document.getElementById('meta') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const frame = document.getElementById('viewer-frame') as HTMLIFrameElement;

const INDEX_URL = chrome.runtime.getURL('vendor/trace-viewer/index.html');

const params = new URLSearchParams(location.search);
const traceUrl = params.get('trace');
const caseName = params.get('case');

if (caseName) metaEl.textContent = `用例: ${caseName}`;

/** iframe 加载后下载 trace 并 postMessage 传入 */
frame.addEventListener('load', () => {
  statusEl.textContent = '';
  try {
    (frame.contentDocument?.getElementById('fallback-error') as HTMLDialogElement | null)?.close();
  } catch {
    // 跨域无法访问时忽略
  }
  if (traceUrl) loadTraceIntoFrame(traceUrl);
});

async function loadTraceIntoFrame(url: string): Promise<void> {
  statusEl.textContent = '正在下载 trace…';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    frame.contentWindow?.postMessage(
      { method: 'load', params: { trace: blob } },
      '*',
    );
    statusEl.textContent = '';
  } catch (err) {
    statusEl.textContent = `下载失败: ${err}`;
    console.error('[trace-viewer] 下载 trace 失败:', err);
  }
}

// 始终先加载 viewer 壳(不传 trace 参数),加载完成后通过 postMessage 传入 trace
frame.src = INDEX_URL;

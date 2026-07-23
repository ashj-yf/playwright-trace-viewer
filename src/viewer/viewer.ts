/**
 * Trace 预览页。区分两种模式:
 *
 *   - 手动模式 (无 ?trace=): 直接加载官方 viewer，用户可拖拽/选择文件。
 *   - 注入模式 (有 ?trace=): 扩展权限并行下载 trace + 加载 iframe，
 *     数据就绪后 postMessage 传入，全程显示 loading 态，避免闪现拖拽界面。
 *
 *   采用扩展权限 fetch 而非直接把 ?trace= 传给 iframe，
 *   是为了免除 DNR/CORS 依赖 —— iframe 内的请求受同源策略限制。
 */
const metaEl = document.getElementById('meta') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const frame = document.getElementById('viewer-frame') as HTMLIFrameElement;

const INDEX_URL = chrome.runtime.getURL('vendor/trace-viewer/index.html');

const params = new URLSearchParams(location.search);
const traceUrl = params.get('trace');
const caseName = params.get('case');

if (caseName) metaEl.textContent = `用例: ${caseName}`;

// ──── 手动模式: 无 trace URL，直接渲染 ────
if (!traceUrl) {
  frame.src = INDEX_URL;
} else {
  // ──── 注入模式: loading 态 → 下载 → postMessage → 显示 ────
  document.body.classList.add('loading');
  statusEl.textContent = '正在下载 Trace 数据…';

  void (async () => {
    const loaded = new Promise<void>((resolve) => {
      frame.addEventListener('load', () => resolve(), { once: true });
    });

    frame.src = INDEX_URL;

    try {
      const [blob] = await Promise.all([fetchTrace(traceUrl), loaded]);

      frame.contentWindow?.postMessage(
        { method: 'load', params: { trace: blob } },
        '*',
      );

      // 等一帧让 vendor 处理 postMessage 后再展示
      requestAnimationFrame(() => {
        document.body.classList.remove('loading');
        statusEl.textContent = '';
      });
    } catch (err) {
      statusEl.textContent = `下载失败: ${err}`;
      console.error('[trace-viewer] 下载 trace 失败:', err);
      // 失败后移除 loading 展示 iframe（回退到拖拽上传）
      document.body.classList.remove('loading');
    }
  })();
}

/** 以扩展权限 fetch trace zip，返回 Blob */
async function fetchTrace(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.blob();
}

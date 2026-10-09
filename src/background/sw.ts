import type { OpenTraceViewerMessage, TraceUploadDoneMessage } from '../types/shared';
import type { Settings } from '../types/shared';
import { DEFAULT_SETTINGS, normalizeSettings } from '../types/shared';
import { syncCorsRules } from './dnr';

/**
 * 从 URL 提取 hostname(不含端口),用于 CORS 域名白名单。
 */
function extractHostname(url: string): string | null {
  try {
    const u = new URL(url);
    // pw-upload:// 等 SW 内存 URL 无跨域问题,不应进 CORS 白名单
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname;
  } catch {
    return null;
  }
}

/**
 * 自动将域名添加到 CORS 白名单并同步 DNR 规则。
 * 持久化到 storage,避免用户手动配置。
 */
async function ensureCorsDomain(hostname: string): Promise<void> {
  const res = await chrome.storage.local.get('settings');
  const settings: Settings = normalizeSettings(res.settings);
  if (settings.match.corsDomains.includes(hostname)) return;
  settings.match.corsDomains.push(hostname);
  await chrome.storage.local.set({ settings });
  await syncCorsRules(settings.match.corsDomains);
}

/**
 * 监听 content script / popup 的消息。
 * 收到 OPEN_TRACE_VIEWER 时,自动将 trace URL 域名加入 CORS 白名单,
 * 再打开预览页。
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message as OpenTraceViewerMessage).type === 'OPEN_TRACE_VIEWER') {
    const msg = message as OpenTraceViewerMessage;
    // 自动提取域名并添加到 CORS 白名单,确保 vendor SW 能跨域 fetch trace。
    // pending 态下 trace 尚未上传,CORS 规则由直连回退路径兜底,不阻塞开 tab。
    const hostname = extractHostname(msg.traceUrl);
    const corsReady = hostname ? ensureCorsDomain(hostname).catch(() => {}) : Promise.resolve();

    const buildViewerUrl = (traceParam?: string): string => {
      const params = new URLSearchParams();
      if (traceParam) params.set('trace', traceParam);
      else if (msg.pendingUpload) params.set('pending', '1');
      if (msg.caseName) params.set('case', msg.caseName);
      if (msg.reportUrl) params.set('from', msg.reportUrl);
      return chrome.runtime.getURL(`src/viewer/viewer.html?${params.toString()}`);
    };

    void corsReady.then(() => {
      // pendingUpload:立即开「提取中」占位 tab 并回传 tabId,上传完成后
      // 由 TRACE_UPLOAD_DONE 重定向;否则直接开带 trace 的 tab(现行为)。
      chrome.tabs.create(
        { url: buildViewerUrl(msg.pendingUpload ? undefined : msg.traceUrl) },
        (tab) => sendResponse({ viewerTabId: tab?.id ?? null }),
      );
    });
    return true; // 异步 sendResponse
  }
  if ((message as TraceUploadDoneMessage).type === 'TRACE_UPLOAD_DONE') {
    const msg = message as TraceUploadDoneMessage;
    const params = new URLSearchParams({ trace: msg.traceUrl });
    if (msg.caseName) params.set('case', msg.caseName);
    if (msg.reportUrl) params.set('from', msg.reportUrl);
    // tab 可能已被用户关闭,失败静默
    void chrome.tabs
      .update(msg.viewerTabId, {
        url: chrome.runtime.getURL(`src/viewer/viewer.html?${params.toString()}`),
      })
      .catch(() => {});
  }
  return false;
});

/**
 * 安装/更新时初始化默认设置。若 storage 已有 settings 则保留,不覆盖;
 * 仅在缺失时写入默认值,使设置从首次安装起即持久化。
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('settings').then((res) => {
    if (!res.settings) {
      chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    }
  });
});

/**
 * SW 启动时同步 CORS DNR 规则(规则本身持久,此处为兜底,
 * 确保规则与当前设置一致;设置页保存时也会主动同步)。
 */
chrome.storage.local.get('settings').then((res) => {
  const settings = normalizeSettings(res.settings);
  void syncCorsRules(settings.match.corsDomains);
});

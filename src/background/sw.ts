import type { OpenTraceViewerMessage } from '../types/shared';
import { DEFAULT_SETTINGS, normalizeSettings } from '../types/shared';
import { syncCorsRules } from './dnr';

/**
 * 监听 content script / popup 的消息。
 * 收到 OPEN_TRACE_VIEWER 时,打开预览页并通过 URL 参数传递元信息。
 */
chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  if ((message as OpenTraceViewerMessage).type === 'OPEN_TRACE_VIEWER') {
    const msg = message as OpenTraceViewerMessage;
    const params = new URLSearchParams({ trace: msg.traceUrl });
    if (msg.caseName) params.set('case', msg.caseName);
    if (msg.reportUrl) params.set('from', msg.reportUrl);
    const viewerUrl = chrome.runtime.getURL(
      `src/viewer/viewer.html?${params.toString()}`,
    );
    chrome.tabs.create({ url: viewerUrl });
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

import type { OpenTraceViewerMessage } from '../types/shared';

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

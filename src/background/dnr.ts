/**
 * declarativeNetRequest:CORS 头注入。
 *
 * 官方 trace-viewer 的 SW 跨域 fetch 远程 trace URL 受 CORS 阻断。
 * 这里给匹配请求的响应注入 Access-Control-Allow-* 头,使 vendor SW 能直接
 * 跨域读取远程 trace,扩展层无需 blob 中转下载。
 *
 * 作用范围由设置项 `corsDomains` 控制:
 *   - 空:允许全部域名(对所有 xmlhttprequest 响应注入 CORS 头)
 *   - 非空:仅对 requestDomains 命中的域名注入
 *
 * 规则 ID 固定为 1,每次同步先移除再重建,保证与设置一致。
 */

const RULE_ID = 1;

/**
 * 根据允许的域名列表同步 DNR 规则。
 * @param corsDomains 允许的域名;空数组表示允许全部。
 */
export async function syncCorsRules(corsDomains: string[]): Promise<void> {
  const domains = [...new Set(corsDomains.map((d) => d.trim()).filter(Boolean))];
  const condition: chrome.declarativeNetRequest.RuleCondition = {
    resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
  };
  if (domains.length > 0) {
    condition.requestDomains = domains;
  }
  const rule: chrome.declarativeNetRequest.Rule = {
    id: RULE_ID,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      responseHeaders: [
        {
          header: 'Access-Control-Allow-Origin',
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: '*',
        },
        {
          header: 'Access-Control-Allow-Headers',
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: '*',
        },
        {
          header: 'Access-Control-Allow-Methods',
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: '*',
        },
      ],
    },
    condition,
  };
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: [rule],
  });
}

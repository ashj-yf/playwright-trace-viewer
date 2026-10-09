/**
 * declarativeNetRequest:CORS 头注入。
 *
 * 官方 trace-viewer 的 SW 跨域 fetch 远程 trace URL 受 CORS 阻断。
 * 这里给匹配请求的响应注入 Access-Control-Allow-* 头,使 vendor SW 能直接
 * 跨域读取远程 trace,扩展层无需 blob 中转下载。
 *
 * 作用范围由设置项 `corsDomains` 控制:
 *   - 非空:仅对 requestDomains 命中的域名注入,并同时移除
 *     Access-Control-Allow-Credentials 以防止与 * 冲突
 *   - 空(兜底):不注入,避免干扰其他网站
 *
 * 另有一条恒定的字体规则:id=2,对所有域名的 font/* 响应注入 ACAO,
 * 仅限本扩展页面(initiatorDomains)发起的请求 —— snapshot 快照里被测
 * 系统的图标字体(如 remixicon)是跨域 @font-face 加载,源站普遍不带
 * CORS 头,浏览器拒绝将响应交给字体引擎,控制台报
 * "Failed to decode downloaded font"、图标显示空白。字体不含敏感数据,
 * 仅对扩展自身页面放行,无站点副作用。
 *
 * 规则 ID 固定为 1,每次同步先移除再重建,保证与设置一致。
 */

const RULE_ID = 1;
/** 字体跨域规则 id:独立于域名白名单,始终生效。 */
const FONT_RULE_ID = 2;

/**
 * 根据允许的域名列表同步 DNR 规则。
 * @param corsDomains 允许的域名;空数组表示禁用 CORS 注入。
 */
export async function syncCorsRules(corsDomains: string[]): Promise<void> {
  const domains = [...new Set(corsDomains.map((d) => d.trim()).filter(Boolean))];

  // 未配置任何域名时,移除规则后直接返回,不对任何请求注入 CORS 头,
  // 避免 ACCESS-CONTROL-ALLOW-ORIGIN:* 覆盖其他网站已有的 CORS 配置,
  // 进而与 ACCESS-CONTROL-ALLOW-CREDENTIALS:TRUE 冲突导致跨域报错。
  // 字体规则恒定生效,与域名白名单无关(见文件头说明)
  const fontRule: chrome.declarativeNetRequest.Rule = {
    id: FONT_RULE_ID,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      responseHeaders: [
        {
          header: 'Access-Control-Allow-Origin',
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: '*',
        },
      ],
    },
    condition: {
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.FONT],
      // 仅本扩展页面(viewer/snapshot)发起的字体请求,不影响任何网站自身行为
      initiatorDomains: [chrome.runtime.id],
    },
  };

  if (domains.length === 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_ID, FONT_RULE_ID],
      addRules: [fontRule],
    });
    return;
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
        {
          // 移除 Access-Control-Allow-Credentials,避免与
          // Access-Control-Allow-Origin:* 共存导致浏览器拒绝响应
          // (CORS 规范禁止 * 与 credentials 同时使用)。
          header: 'Access-Control-Allow-Credentials',
          operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
        },
      ],
    },
    condition: {
      // 不限制 resourceTypes:iframe 内 SW 的 fetch 可能不被归类为
      // xmlhttprequest,仅通过 requestDomains 限定范围即可。
      requestDomains: domains,
    },
  };
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID, FONT_RULE_ID],
    addRules: [rule, fontRule],
  });
}

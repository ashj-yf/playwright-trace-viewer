/**
 * 插件各部分之间(runtime 消息)通信的类型定义。
 */

/** content script -> background: 请求在新标签页打开 trace 预览。 */
export interface OpenTraceViewerMessage {
  type: 'OPEN_TRACE_VIEWER';
  /** trace.zip 的 URL(Allure 附件地址)。 */
  traceUrl: string;
  /** 来源用例名,用于预览页标题。 */
  caseName?: string;
  /** 来源 Allure 报告页 URL,用于回溯。 */
  reportUrl?: string;
}

export type RuntimeMessage = OpenTraceViewerMessage;

/** trace 附件识别方式(二选一)。 */
export type MatchMode = 'mime' | 'name';

/** trace 附件识别规则(命名 / attachment_type / URL / CORS 匹配配置)。 */
export interface MatchSettings {
  /** 识别方式二选一:'mime' 按 MIME 类型关键词匹配 data-type;'name' 按文件名关键词匹配附件名/路径。 */
  matchMode: MatchMode;
  /** MIME 类型关键词:matchMode='mime' 时,附件 data-type 含此词即认定为 trace。 */
  traceTypeKeywords: string[];
  /** 文件名关键词:matchMode='name' 时,附件名/下载路径含此词即认定为 trace。 */
  nameKeywords: string[];
  /** URL 关键词:页面 URL 含此词(任一)才启用自动注入,限制只在 Allure 报告页生效。 */
  urlKeywords: string[];
  /** CORS 允许域名:控制 DNR 注入 CORS 头的目标范围。空=允许全部,非空=仅这些域名。 */
  corsDomains: string[];
}

/** 插件设置(持久化于 chrome.storage.local 的 `settings` 键)。 */
export interface Settings {
  /** 是否自动注入「预览 Trace」按钮。 */
  autoInject: boolean;
  /** trace 附件识别规则。 */
  match: MatchSettings;
}

/** 默认设置。 */
export const DEFAULT_SETTINGS: Settings = {
  autoInject: true,
  match: {
    matchMode: 'mime',
    traceTypeKeywords: ['application/vnd.playwright.trace+zip'],
    nameKeywords: ['trace'],
    urlKeywords: ['allure'],
    corsDomains: [],
  },
};

/**
 * 合并存储中的设置与默认值,补齐缺失字段(兼容旧版本/部分写入)。
 * 兼容旧版仅存 `autoInject` 布尔值的情形;旧版 `zipTypeKeywords` 已废弃,忽略。
 */
export function normalizeSettings(
  stored: Partial<Settings> | undefined,
  legacyAutoInject?: boolean,
): Settings {
  const autoInject =
    stored?.autoInject ??
    (legacyAutoInject === undefined
      ? DEFAULT_SETTINGS.autoInject
      : legacyAutoInject !== false);
  const match: MatchSettings = {
    matchMode: stored?.match?.matchMode ?? DEFAULT_SETTINGS.match.matchMode,
    traceTypeKeywords:
      stored?.match?.traceTypeKeywords ?? DEFAULT_SETTINGS.match.traceTypeKeywords,
    nameKeywords: stored?.match?.nameKeywords ?? DEFAULT_SETTINGS.match.nameKeywords,
    urlKeywords: stored?.match?.urlKeywords ?? DEFAULT_SETTINGS.match.urlKeywords,
    corsDomains: stored?.match?.corsDomains ?? DEFAULT_SETTINGS.match.corsDomains,
  };
  return { autoInject, match };
}

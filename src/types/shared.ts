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

/** trace 附件识别规则(命名 / attachment_type 匹配配置)。 */
export interface MatchSettings {
  /** attachment 的 data-type 含这些关键词之一即直接判定为 trace(约定型,不依赖附件名)。 */
  traceTypeKeywords: string[];
  /** data-type 含这些关键词之一视为 zip 类型。 */
  zipTypeKeywords: string[];
  /** 附件名/下载路径含这些关键词之一视为含 trace(配合 zipTypeKeywords 使用)。 */
  nameKeywords: string[];
}

/** 插件设置(持久化于 chrome.storage.local 的 `settings` 键)。 */
export interface Settings {
  /** 是否自动注入「预览 Trace」按钮。 */
  autoInject: boolean;
  /** trace 附件识别规则。 */
  match: MatchSettings;
}

/** 默认设置:与历史硬编码正则保持一致,升级后行为不变。 */
export const DEFAULT_SETTINGS: Settings = {
  autoInject: true,
  match: {
    traceTypeKeywords: ['playwright-trace'],
    zipTypeKeywords: ['zip'],
    nameKeywords: ['trace'],
  },
};

/**
 * 合并存储中的设置与默认值,补齐缺失字段(兼容旧版本/部分写入)。
 * 兼容旧版仅存 `autoInject` 布尔值的情形。
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
    traceTypeKeywords:
      stored?.match?.traceTypeKeywords ?? DEFAULT_SETTINGS.match.traceTypeKeywords,
    zipTypeKeywords:
      stored?.match?.zipTypeKeywords ?? DEFAULT_SETTINGS.match.zipTypeKeywords,
    nameKeywords: stored?.match?.nameKeywords ?? DEFAULT_SETTINGS.match.nameKeywords,
  };
  return { autoInject, match };
}

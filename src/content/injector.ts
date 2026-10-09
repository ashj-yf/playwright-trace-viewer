import type { MatchSettings } from '../types/shared';
import { DEFAULT_SETTINGS, normalizeSettings } from '../types/shared';
import type {
  OpenTraceViewerMessage,
  TraceUploadDoneMessage,
} from '../types/shared';
import {
  collectTraceAttachments,
  extractAllure3TestId,
  findAttachmentRow,
} from './allure3';

/**
 * 注入到 Allure 报告页面,识别 trace 附件并添加「预览 Trace」按钮。
 *
 * 识别方式(在设置页二选一):
 * 1. 按 MIME 类型:附件 data-type 命中「MIME 类型关键词」(如 application/vnd.playwright.trace+zip)。
 * 2. 按文件名关键词:附件名/下载路径命中「文件名关键词」(如 trace)。
 *
 * 仅当页面 URL 命中「URL 关键词」(默认 allure)且开启自动注入时才扫描,
 * 避免在无关页面跑 MutationObserver。
 *
 * Allure 3.x(Allure CLI 3 / allure-jenkins-plugin 3.x):
 *   SPA 路由 #<testId>,用例 JSON 在 data/test-results/<testId>.json,
 *   附件可能挂在顶层 attachments 与 setup/steps/teardown 阶段树节点上,
 *   行 DOM 以 data-tr-focus-id(=附件 id)关联。适配逻辑见 allure3.ts。
 *
 * Allure 2.x 附件区真实结构:
 *   <div class="attachment-row" data-type="application/zip" data-uid="...">
 *     <div class="attachment-row__name">trace.zip</div>
 *     <div class="link" data-download="data/attachments/xxx.zip" ...>5.9 MiB</div>
 *   </div>
 *
 * 适配 SPA:MutationObserver 防抖扫描。
 */

const BUTTON_FLAG = 'data-atv-injected';
const SCAN_DEBOUNCE_MS = 300;
const UPLOAD_BRIDGE_PAGE = 'vendor/trace-viewer/upload.html';
const UPLOAD_TIMEOUT_MS = 15000;
const STYLE_ID = 'atv-styles';

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.atv-preview-btn{
  margin-left:8px;padding:2px 10px;font-size:12px;cursor:pointer;
  border:1px solid #4a90d9;border-radius:3px;background:#4a90d9;color:#fff;
  transition:opacity .15s;line-height:1.4;white-space:nowrap;
}
.atv-preview-btn:hover{opacity:.9}
.atv-preview-btn:disabled{opacity:.6;cursor:default}
`;
  document.documentElement.appendChild(style);
}

/** 当前匹配规则与开关(由 chrome.storage.local 的 `settings` 驱动)。 */
let match: MatchSettings = DEFAULT_SETTINGS.match;
let enabled = DEFAULT_SETTINGS.autoInject;

/** 大小写不敏感的关键词命中测试。 */
function matchesAny(value: string, keywords: string[]): boolean {
  const lower = value.toLowerCase();
  return keywords.some((kw) => kw.length > 0 && lower.includes(kw.toLowerCase()));
}

/**
 * 页面是否启用注入:按用户判定方式,「URL 关键词」与「CORS 域名」两个参数
 * 合并为子串关键词列表,对完整页面 URL 匹配,任一命中即注入(全量注入);
 * 两者皆未配置时全页面生效。CORS 域名由打开预览时自动收集(见 background),
 * 覆盖 URL 关键词未覆盖的报告源(如带查询参数的过滤视图)。
 */
export function matchesPageUrl(href: string, match: MatchSettings): boolean {
  const keywords = [...match.urlKeywords, ...match.corsDomains]
    .map((kw) => kw.trim())
    .filter((kw) => kw.length > 0);
  return keywords.length === 0 || matchesAny(href, keywords);
}

/** 是否应在本页启用扫描:开关开启且页面命中匹配规则。 */
function shouldRun(): boolean {
  if (!enabled) return false;
  return matchesPageUrl(location.href, match);
}

/** 从 Allure attachment-row 提取 trace 下载 URL;非 trace 返回 null。 */
function getTraceUrlFromRow(row: HTMLElement): string | null {
  const name =
    row.querySelector('.attachment-row__name')?.textContent?.trim() || '';
  const download =
    row.querySelector('[data-download]')?.getAttribute('data-download') || '';
  const type = row.getAttribute('data-type') || '';
  const matched =
    match.matchMode === 'mime'
      ? matchesAny(type, match.traceTypeKeywords)
      : matchesAny(name, match.nameKeywords) ||
        matchesAny(download, match.nameKeywords);
  if (download && matched) {
    return new URL(download, location.href).href;
  }
  return null;
}

/** 兼容:直接 a[href] 指向 trace.zip 的情形(仅文件名模式,mime 模式无 data-type 可判)。 */
function getTraceUrlFromAnchor(a: HTMLAnchorElement): string | null {
  if (match.matchMode === 'mime') return null;
  const name = a.textContent?.trim() || '';
  const href = a.href || '';
  return matchesAny(name, match.nameKeywords) || matchesAny(href, match.nameKeywords)
    ? href
    : null;
}

/**
 * 将 trace zip 经报告页同源 fetch(自动携带登录 cookie)后,通过隐藏的
 * upload.html 桥页上传到 vendor SW 内存,返回可直接预览的 pw-upload:// URL。
 *
 * 认证型报告源(如 Jenkins)下扩展侧跨站 fetch 因 SameSite=Lax 拿不到 cookie,
 * 只能由报告页上下文取内容;任何环节失败返回 null,调用方回退直连 URL。
 */
export function uploadTraceViaSw(traceUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    let frame: HTMLIFrameElement | null = null;
    let settled = false;
    const finish = (url: string | null): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      frame?.remove();
      resolve(url);
    };
    const timer = window.setTimeout(() => finish(null), UPLOAD_TIMEOUT_MS);
    const onMessage = (ev: MessageEvent): void => {
      // 只信任 upload.html 桥页回发的消息
      if (ev.source !== frame?.contentWindow) return;
      const data = ev.data as { type?: string; ok?: boolean; url?: string } | null;
      if (data?.type === 'atv-sw-ready') {
        void fetch(traceUrl)
          .then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.blob();
          })
          .then((blob) => {
            frame?.contentWindow?.postMessage({ type: 'atv-upload', blob }, '*');
          })
          .catch(() => finish(null));
      } else if (data?.type === 'atv-sw-timeout') {
        finish(null);
      } else if (data?.type === 'atv-upload-result') {
        finish(data.ok && data.url ? data.url : null);
      }
    };
    window.addEventListener('message', onMessage);
    frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.src = chrome.runtime.getURL(UPLOAD_BRIDGE_PAGE);
    frame.addEventListener('error', () => finish(null));
    document.documentElement.appendChild(frame);
  });
}

/**
 * 点击「预览 Trace」的完整流程:先立即弹出预览 tab(pending 占位态),
 * 再在报告页异步提取/上传 trace,完成后通知 background 重定向该 tab。
 * 后台未回传 tabId(异常/旧版本)时回退为提取完成后同步打开。
 */
export async function openPreviewFlow(traceUrl: string): Promise<void> {
  const openMsg: OpenTraceViewerMessage = {
    type: 'OPEN_TRACE_VIEWER',
    traceUrl,
    caseName: document.title,
    reportUrl: location.href,
    pendingUpload: true,
  };
  let viewerTabId: number | null = null;
  try {
    const res = (await chrome.runtime.sendMessage(openMsg)) as {
      viewerTabId?: number;
    } | undefined;
    if (typeof res?.viewerTabId === 'number') viewerTabId = res.viewerTabId;
  } catch {
    // 后台不可用时走同步回退
  }
  // 上传成功得 pw-upload:// 内存地址;失败回退原始直连 URL
  const uploadedUrl = viewerTabId !== null ? await uploadTraceViaSw(traceUrl) : null;
  const finalUrl = uploadedUrl ?? traceUrl;
  if (viewerTabId !== null) {
    const doneMsg: TraceUploadDoneMessage = {
      type: 'TRACE_UPLOAD_DONE',
      viewerTabId,
      traceUrl: finalUrl,
      caseName: document.title,
      reportUrl: location.href,
    };
    try {
      await chrome.runtime.sendMessage(doneMsg);
      return;
    } catch {
      // 重定向失败(tab 已关等):回退重开
    }
  }
  await chrome.runtime
    .sendMessage({
      ...openMsg,
      pendingUpload: undefined,
      traceUrl: finalUrl,
    })
    .catch(() => {});
}

function injectButton(container: HTMLElement, traceUrl: string): void {
  if (container.querySelector(`[${BUTTON_FLAG}]`)) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '▶ 预览 Trace';
  btn.className = 'atv-preview-btn';
  btn.setAttribute(BUTTON_FLAG, '1');
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // 扩展被重新加载/更新后,旧页面的 content script 上下文会失效,
    // chrome.runtime 不可用;提示用户刷新页面,避免抛 Extension context invalidated。
    if (!chrome.runtime?.id) {
      btn.disabled = true;
      btn.textContent = '扩展已更新,请刷新页面';
      return;
    }
    btn.disabled = true;
    btn.textContent = '加载中…';
    // 先弹预览 tab(pending 占位),报告页异步提取上传后由后台重定向加载
    void openPreviewFlow(traceUrl).finally(() => {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = '▶ 预览 Trace';
      }, 1000);
    });
  });
  container.appendChild(btn);
}

/** Allure 3 用例 JSON 缓存(testId -> 原始对象);筛选每次现算,改关键词即时生效。 */
const allure3TestCaseCache = new Map<string, unknown>();

/**
 * Allure 3 报告用例页注入:
 * 1. 从 #<testId> 路由取用例数据 data/test-results/<testId>.json(同源 fetch);
 * 2. 按当前规则筛出 trace 附件,构造 data/attachments/<id><ext> 绝对 URL;
 * 3. 按 data-tr-focus-id 定位附件行并插入按钮(行未渲染时等待下次 DOM 变化)。
 */
async function scanAllure3(): Promise<void> {
  const testId = extractAllure3TestId(location.hash);
  if (!testId) return;
  let testCase = allure3TestCaseCache.get(testId);
  if (testCase === undefined) {
    try {
      const jsonUrl = new URL(`data/test-results/${testId}.json`, location.href).href;
      const res = await fetch(jsonUrl);
      if (!res.ok) return;
      testCase = await res.json();
      allure3TestCaseCache.set(testId, testCase);
    } catch {
      return; // 网络/JSON 异常时静默,DOM 再变化时重试
    }
  }
  for (const att of collectTraceAttachments(testCase, match)) {
    const row = findAttachmentRow(document, att);
    if (row) injectButton(row, new URL(att.url, location.href).href);
  }
}

let scanTimer: number | undefined;
function scan(): void {
  if (!shouldRun()) return;
  if (scanTimer) window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => {
    // 1. Allure 2.x attachment-row
    document.querySelectorAll<HTMLElement>('.attachment-row').forEach((row) => {
      const url = getTraceUrlFromRow(row);
      if (url) injectButton(row, url);
    });
    // 2. 兼容 a[href] 形式
    document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
      const url = getTraceUrlFromAnchor(a);
      if (url) injectButton(a.parentElement || a, url);
    });
    // 3. Allure 3.x 用例页(data/test-results JSON 驱动)
    void scanAllure3();
  }, SCAN_DEBOUNCE_MS);
}

chrome.storage.local.get(['settings', 'autoInject']).then((res) => {
  const settings = normalizeSettings(res.settings, res.autoInject);
  match = settings.match;
  enabled = settings.autoInject;
  injectStyles();
  if (!shouldRun()) return;
  scan();
  new MutationObserver(() => scan()).observe(document.body, {
    childList: true,
    subtree: true,
  });
  // Allure 3 SPA 通过 hash 路由切换用例,不触发页面重载,
  // 显式监听以在用例切换后立即重扫
  window.addEventListener('hashchange', () => scan());
}).catch(() => {
  // 扩展上下文失效等异常时静默,避免 uncaught
});

/** 设置变更:更新规则与开关后立即重扫,使新关键词即时生效。 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const settings = normalizeSettings(changes.settings.newValue);
  match = settings.match;
  enabled = settings.autoInject;
  if (shouldRun()) scan();
});

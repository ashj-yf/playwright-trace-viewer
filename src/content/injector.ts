import type { MatchSettings } from '../types/shared';
import { DEFAULT_SETTINGS, normalizeSettings } from '../types/shared';
import type { OpenTraceViewerMessage } from '../types/shared';

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

/** 是否应在本页启用扫描:开关开启且 URL 命中关键词。 */
function shouldRun(): boolean {
  if (!enabled) return false;
  // URL 关键词为空(选填未配)时所有页面均生效;非空时仅匹配的页面生效
  if (match.urlKeywords.length === 0) return true;
  return matchesAny(location.href, match.urlKeywords);
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
    btn.textContent = '打开中…';
    const msg: OpenTraceViewerMessage = {
      type: 'OPEN_TRACE_VIEWER',
      traceUrl,
      caseName: document.title,
      reportUrl: location.href,
    };
    chrome.runtime
      .sendMessage(msg)
      .catch(() => {})
      .finally(() => {
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = '▶ 预览 Trace';
        }, 1000);
      });
  });
  container.appendChild(btn);
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

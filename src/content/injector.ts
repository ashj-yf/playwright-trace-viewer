import type { MatchSettings } from '../types/shared';
import { DEFAULT_SETTINGS, normalizeSettings } from '../types/shared';
import type { OpenTraceViewerMessage } from '../types/shared';

/**
 * 注入到 Allure 报告页面,识别 trace 附件并添加「预览 Trace」按钮。
 *
 * 识别方式(满足其一即可,规则可在 Popup 设置面板自定义):
 * 1. 约定 type(推荐):data-type 命中「Trace 类型关键词」(如 application/vnd.playwright-trace+zip),
 *    不依赖附件名。
 * 2. 兼容:data-type 命中「Zip 类型关键词」(或下载路径以 .zip 结尾),且附件名/路径命中「附件名关键词」。
 *
 * Allure 2.x 附件区真实结构:
 *   <div class="attachment-row" data-type="application/zip" data-uid="...">
 *     <div class="attachment-row__name">trace.zip</div>
 *     <div class="link" data-download="data/attachments/xxx.zip" ...>5.9 MiB</div>
 *   </div>
 *
 * 适配 SPA:MutationObserver 防抖扫描。受 Popup「自动注入」开关控制。
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

/** 从 Allure attachment-row 提取 trace 下载 URL;非 trace 返回 null。 */
function getTraceUrlFromRow(row: HTMLElement): string | null {
  const name =
    row.querySelector('.attachment-row__name')?.textContent?.trim() || '';
  const download =
    row.querySelector('[data-download]')?.getAttribute('data-download') || '';
  const type = row.getAttribute('data-type') || '';
  // 1. 约定 type(推荐):不依赖附件名
  const isTraceType = matchesAny(type, match.traceTypeKeywords);
  // 2. 兼容:zip 类型 + 名字/路径含 trace
  const isZip = matchesAny(type, match.zipTypeKeywords) || /\.zip($|\?)/i.test(download);
  const hasTrace = matchesAny(name, match.nameKeywords) || matchesAny(download, match.nameKeywords);
  if (download && (isTraceType || (isZip && hasTrace))) {
    return new URL(download, location.href).href;
  }
  return null;
}

/** 兼容:直接 a[href] 指向 trace.zip 的情形。 */
function getTraceUrlFromAnchor(a: HTMLAnchorElement): string | null {
  const name = a.textContent?.trim() || '';
  const href = a.href || '';
  const isZip = /\.zip($|\?|#)/i.test(href);
  const hasTrace = matchesAny(name, match.nameKeywords) || matchesAny(href, match.nameKeywords);
  return isZip && hasTrace ? href : null;
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
    btn.disabled = true;
    btn.textContent = '打开中…';
    const msg: OpenTraceViewerMessage = {
      type: 'OPEN_TRACE_VIEWER',
      traceUrl,
      caseName: document.title,
      reportUrl: location.href,
    };
    chrome.runtime.sendMessage(msg).finally(() => {
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
  if (!enabled) return;
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
  if (!enabled) return;
  scan();
  new MutationObserver(() => scan()).observe(document.body, {
    childList: true,
    subtree: true,
  });
});

/** 设置变更:更新规则与开关后立即重扫,使新关键词即时生效。 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const settings = normalizeSettings(changes.settings.newValue);
  match = settings.match;
  enabled = settings.autoInject;
  scan();
});

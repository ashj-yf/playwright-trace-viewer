import { DEFAULT_SETTINGS, normalizeSettings } from '../types/shared';
import type { MatchSettings, Settings } from '../types/shared';

const openBtn = document.getElementById('open-viewer') as HTMLButtonElement;
const settingsToggle = document.getElementById('settings-toggle') as HTMLButtonElement;
const settingsPanel = document.getElementById('settings-panel') as HTMLElement;
const autoInject = document.getElementById('auto-inject') as HTMLInputElement;
const traceTypeKw = document.getElementById('trace-type-kw') as HTMLTextAreaElement;
const zipTypeKw = document.getElementById('zip-type-kw') as HTMLTextAreaElement;
const nameKw = document.getElementById('name-kw') as HTMLTextAreaElement;
const resetBtn = document.getElementById('reset-settings') as HTMLButtonElement;

const KEYWORD_FIELDS: ReadonlyArray<{ el: HTMLTextAreaElement; key: keyof MatchSettings }> = [
  { el: traceTypeKw, key: 'traceTypeKeywords' },
  { el: zipTypeKw, key: 'zipTypeKeywords' },
  { el: nameKw, key: 'nameKeywords' },
];

/** 手动入口:打开空白预览页,由用户在页面内拖拽/选择 trace.zip。 */
openBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/viewer/viewer.html') });
});

/** 切换设置面板显示。 */
settingsToggle.addEventListener('click', () => {
  const willShow = settingsPanel.hasAttribute('hidden');
  settingsPanel.toggleAttribute('hidden', !willShow);
  settingsToggle.classList.toggle('active', willShow);
  settingsToggle.setAttribute('aria-expanded', String(willShow));
});

/** 把 textarea 文本按行解析为关键词数组(去空白、去重)。 */
function parseKeywords(text: string): string[] {
  return [...new Set(text.split('\n').map((s) => s.trim()).filter(Boolean))];
}

/** 读取/持久化设置(兼容旧版仅存 `autoInject` 布尔值的情形)。 */
chrome.storage.local.get(['settings', 'autoInject']).then((res) => {
  const settings = normalizeSettings(res.settings, res.autoInject);
  autoInject.checked = settings.autoInject;
  for (const { el, key } of KEYWORD_FIELDS) {
    el.value = settings.match[key].join('\n');
  }
});

function saveSettings(): void {
  const match: MatchSettings = {
    traceTypeKeywords: parseKeywords(traceTypeKw.value),
    zipTypeKeywords: parseKeywords(zipTypeKw.value),
    nameKeywords: parseKeywords(nameKw.value),
  };
  const settings: Settings = { autoInject: autoInject.checked, match };
  chrome.storage.local.set({ settings });
}

autoInject.addEventListener('change', saveSettings);
for (const { el } of KEYWORD_FIELDS) {
  el.addEventListener('change', saveSettings);
}

resetBtn.addEventListener('click', () => {
  autoInject.checked = DEFAULT_SETTINGS.autoInject;
  for (const { el, key } of KEYWORD_FIELDS) {
    el.value = DEFAULT_SETTINGS.match[key].join('\n');
  }
  saveSettings();
});

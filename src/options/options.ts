import { DEFAULT_SETTINGS, normalizeSettings } from '../types/shared';
import type { MatchMode, Settings } from '../types/shared';
import { syncCorsRules } from '../background/dnr';

const autoInject = document.getElementById('auto-inject') as HTMLInputElement;
const modeMime = document.getElementById('mode-mime') as HTMLInputElement;
const modeName = document.getElementById('mode-name') as HTMLInputElement;
const traceTypeKw = document.getElementById('trace-type-kw') as HTMLTextAreaElement;
const nameKw = document.getElementById('name-kw') as HTMLTextAreaElement;
const urlKw = document.getElementById('url-kw') as HTMLTextAreaElement;
const corsKw = document.getElementById('cors-kw') as HTMLTextAreaElement;
const resetBtn = document.getElementById('reset-settings') as HTMLButtonElement;
const saveBtn = document.getElementById('save-settings') as HTMLButtonElement;
const hint = document.getElementById('hint') as HTMLElement;
const errorMsg = document.querySelector('#cors-field .error-msg') as HTMLElement;

let dirty = false;
let flashTimer: number | undefined;

/** 把 textarea 文本按行解析为关键词数组(去空白、去重)。 */
function parseKeywords(text: string): string[] {
  return [...new Set(text.split('\n').map((s) => s.trim()).filter(Boolean))];
}

function currentMode(): MatchMode {
  return modeMime.checked ? 'mime' : 'name';
}

/** 根据 radio 选中态,禁用未选中的关键词框,直观体现二选一。 */
function applyMode(): void {
  const mode = currentMode();
  traceTypeKw.disabled = mode !== 'mime';
  nameKw.disabled = mode !== 'name';
  traceTypeKw.closest('.field')?.classList.toggle('inactive', mode !== 'mime');
  nameKw.closest('.field')?.classList.toggle('inactive', mode !== 'name');
}

function showHint(text: string, cls: 'dirty' | 'saved'): void {
  hint.textContent = text;
  hint.className = `hint-text ${cls}`;
  hint.hidden = false;
}

function markDirty(): void {
  dirty = true;
  if (flashTimer) {
    window.clearTimeout(flashTimer);
    flashTimer = undefined;
  }
  showHint('有未保存的更改', 'dirty');
}

function flashSaved(): void {
  dirty = false;
  showHint('已保存', 'saved');
  if (flashTimer) window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    hint.hidden = true;
  }, 1500);
}

function fillForm(settings: Settings): void {
  autoInject.checked = settings.autoInject;
  modeMime.checked = settings.match.matchMode === 'mime';
  modeName.checked = settings.match.matchMode === 'name';
  traceTypeKw.value = settings.match.traceTypeKeywords.join('\n');
  nameKw.value = settings.match.nameKeywords.join('\n');
  urlKw.value = settings.match.urlKeywords.join('\n');
  corsKw.value = settings.match.corsDomains.join('\n');
  applyMode();
}

function readForm(): Settings {
  return {
    autoInject: autoInject.checked,
    match: {
      matchMode: currentMode(),
      traceTypeKeywords: parseKeywords(traceTypeKw.value),
      nameKeywords: parseKeywords(nameKw.value),
      urlKeywords: parseKeywords(urlKw.value),
      corsDomains: parseKeywords(corsKw.value),
    },
  };
}

chrome.storage.local.get(['settings', 'autoInject']).then((res) => {
  fillForm(normalizeSettings(res.settings, res.autoInject));
  dirty = false;
  hint.hidden = true;
});

autoInject.addEventListener('change', markDirty);
modeMime.addEventListener('change', () => {
  applyMode();
  markDirty();
});
modeName.addEventListener('change', () => {
  applyMode();
  markDirty();
});
traceTypeKw.addEventListener('input', markDirty);
nameKw.addEventListener('input', markDirty);
urlKw.addEventListener('input', markDirty);
corsKw.addEventListener('input', () => {
  // 用户开始输入时清除必填校验错误
  corsKw.classList.remove('empty');
  errorMsg.classList.remove('show');
  markDirty();
});

function validateCorsDomains(): boolean {
  const domains = parseKeywords(corsKw.value);
  if (domains.length === 0) {
    corsKw.classList.add('empty');
    errorMsg.classList.add('show');
    return false;
  }
  corsKw.classList.remove('empty');
  errorMsg.classList.remove('show');
  return true;
}

saveBtn.addEventListener('click', () => {
  if (!validateCorsDomains()) return;
  const settings = readForm();
  chrome.storage.local.set({ settings }, () => {
    flashSaved();
    void syncCorsRules(settings.match.corsDomains);
  });
});

resetBtn.addEventListener('click', () => {
  fillForm(DEFAULT_SETTINGS);
  markDirty();
});

window.addEventListener('beforeunload', (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

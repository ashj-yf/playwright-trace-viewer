const openBtn = document.getElementById('open-viewer') as HTMLButtonElement;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;

/** 手动入口:打开空白预览页,由用户在页面内拖拽/选择 trace.zip。 */
openBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/viewer/viewer.html') });
});

/** 打开设置页(独立标签页)。 */
settingsBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') });
});

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('chrome', {
  runtime: { getURL: (p: string) => `chrome-extension://ext-id/${p}` },
});

const loadViewer = async (query: string) => {
  window.history.pushState({}, '', `/src/viewer/viewer.html?${query}`);
  document.body.innerHTML = `
    <span class="meta" id="meta"></span><div id="status"></div><iframe id="viewer-frame"></iframe>`;
  vi.resetModules();
  await import('../src/viewer/viewer');
};

describe('viewer 预览页', () => {
  it('pending=1:显示提取中状态,不加载 iframe', async () => {
    await loadViewer('pending=1&case=demo');
    const frame = document.getElementById('viewer-frame') as HTMLIFrameElement;
    const status = document.getElementById('status') as HTMLElement;
    expect(frame.getAttribute('src')).toBeNull();
    expect(status.textContent).toContain('提取');
    expect(document.body.classList.contains('loading')).toBe(true);
  });

  it('带 trace:照常传给 vendor iframe 加载', async () => {
    await loadViewer(`trace=${encodeURIComponent('pw-upload://u1')}&case=demo`);
    const frame = document.getElementById('viewer-frame') as HTMLIFrameElement;
    expect(frame.src).toContain('chrome-extension://ext-id/vendor/trace-viewer/index.html');
    expect(frame.src).toContain(encodeURIComponent('pw-upload://u1'));
  });

  it('无参数:手动模式直接渲染 vendor 页面', async () => {
    await loadViewer('');
    const frame = document.getElementById('viewer-frame') as HTMLIFrameElement;
    expect(frame.src).toContain('vendor/trace-viewer/index.html');
  });
});

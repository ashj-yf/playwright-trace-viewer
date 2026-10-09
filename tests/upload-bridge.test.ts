// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

// injector 模块加载即访问 chrome API,必须先 stub 再动态 import
vi.stubGlobal('chrome', {
  runtime: {
    id: 'ext-id',
    getURL: (p: string) => `chrome-extension://ext-id/${p}`,
    sendMessage: vi.fn(async () => {}),
  },
  storage: {
    local: { get: vi.fn(async () => ({})) },
    onChanged: { addListener: vi.fn() },
  },
});

const { uploadTraceViaSw } = await import('../src/content/injector');

const findBridgeFrame = (): HTMLIFrameElement | null =>
  [...document.querySelectorAll('iframe')].find((f) =>
    f.src.includes('vendor/trace-viewer/upload.html'),
  ) ?? null;

/** 等待桥 iframe 真正创建(waitFor 对 null 视为成功,必须抛错驱动重试)。 */
const waitForBridgeFrame = async (): Promise<HTMLIFrameElement> => {
  for (let i = 0; i < 100; i++) {
    const f = findBridgeFrame();
    if (f) return f;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('bridge frame 未创建');
};

const postFromFrame = (frame: HTMLIFrameElement, data: unknown): void => {
  window.dispatchEvent(
    new MessageEvent('message', { data, source: frame.contentWindow }),
  );
};

const blobOf = (body = 'zip-bytes') => new Blob([body], { type: 'application/zip' });

describe('uploadTraceViaSw', () => {
  it('成功链路:SW ready -> 同源 fetch blob -> 桥上传 -> 返回 pw-upload URL 并清理 iframe', async () => {
    const fetchMock = vi.fn(async () => new Response(blobOf()));
    vi.stubGlobal('fetch', fetchMock);

    const pending = uploadTraceViaSw('https://report/data/attachments/a.zip');
    const frame = findBridgeFrame();
    expect(frame).not.toBeNull();
    expect(frame?.src).toBe('chrome-extension://ext-id/vendor/trace-viewer/upload.html');

    postFromFrame(frame!, { type: 'atv-sw-ready' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('https://report/data/attachments/a.zip');

    // 上传请求由桥页发出(同源 fetch 'upload'),结果经 postMessage 回传
    postFromFrame(frame!, { type: 'atv-upload-result', ok: true, url: 'pw-upload://u1' });

    await expect(pending).resolves.toBe('pw-upload://u1');
    expect(findBridgeFrame()).toBeNull(); // iframe 已清理
  });

  it('桥页 SW 超时 -> 返回 null(回退直连)', async () => {
    const p = uploadTraceViaSw('https://report/a.zip');
    const frame = findBridgeFrame()!;
    postFromFrame(frame, { type: 'atv-sw-timeout' });
    await expect(p).resolves.toBeNull();
    expect(findBridgeFrame()).toBeNull();
  });

  it('上传结果失败 -> 返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(blobOf())));
    const p = uploadTraceViaSw('https://report/a.zip');
    const frame = findBridgeFrame()!;
    postFromFrame(frame, { type: 'atv-sw-ready' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    postFromFrame(frame, { type: 'atv-upload-result', ok: false, error: 'HTTP 500' });
    await expect(p).resolves.toBeNull();
  });

  it('同源 fetch 非 200 -> 返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    const p = uploadTraceViaSw('https://report/a.zip');
    const frame = findBridgeFrame()!;
    postFromFrame(frame, { type: 'atv-sw-ready' });
    await expect(p).resolves.toBeNull();
    expect(findBridgeFrame()).toBeNull();
  });

  it('整体超时 -> 返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(blobOf())));
    vi.useFakeTimers();
    try {
      const p = uploadTraceViaSw('https://report/a.zip');
      const frame = findBridgeFrame()!;
      postFromFrame(frame, { type: 'atv-sw-ready' });
      await vi.advanceTimersByTimeAsync(20000);
      await expect(p).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
      }
  });

  it('忽略非桥页来源的 message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(blobOf())));
    const p = uploadTraceViaSw('https://report/a.zip');
    const frame = findBridgeFrame()!;
    postFromFrame(frame, { type: 'atv-sw-ready' });
    // 伪造第三方窗口来源,不应触发 fetch
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'atv-upload-result', ok: true, url: 'pw-upload://evil' },
        source: window,
      }),
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    postFromFrame(frame, { type: 'atv-upload-result', ok: true, url: 'pw-upload://u2' });
    await expect(p).resolves.toBe('pw-upload://u2');
  });
});

describe('openPreviewFlow(先弹 tab 再异步上传)', () => {
  const pushState = () =>
    window.history.pushState({}, '', '/allure/#abc'); // jsdom 禁跨 origin pushState

  it('立即开 pending tab,上传完成后 TRACE_UPLOAD_DONE 重定向', async () => {
    pushState();
    const sendMock = vi.mocked(chrome.runtime.sendMessage);
    sendMock.mockReset().mockResolvedValueOnce({ viewerTabId: 9 }).mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(blobOf())));

    const flow = import('../src/content/injector').then(({ openPreviewFlow }) =>
      openPreviewFlow('https://qe.example.com/allure/data/attachments/a.zip'),
    );
    // OPEN 消息应立即发出(pendingUpload),不等上传
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    expect(sendMock.mock.calls[0][0]).toMatchObject({
      type: 'OPEN_TRACE_VIEWER',
      pendingUpload: true,
      traceUrl: 'https://qe.example.com/allure/data/attachments/a.zip',
    });

    // 驱动桥上传成功
    const frame = await waitForBridgeFrame();
    postFromFrame(frame, { type: 'atv-sw-ready' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    postFromFrame(frame, { type: 'atv-upload-result', ok: true, url: 'pw-upload://u1' });

    await flow;
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
    expect(sendMock.mock.calls[1][0]).toMatchObject({
      type: 'TRACE_UPLOAD_DONE',
      viewerTabId: 9,
      traceUrl: 'pw-upload://u1',
    });
  });

  it('上传失败 -> TRACE_UPLOAD_DONE 回退原始直连 URL', async () => {
    pushState();
    const sendMock = vi.mocked(chrome.runtime.sendMessage);
    sendMock.mockReset().mockResolvedValueOnce({ viewerTabId: 11 }).mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 403 })));

    const { openPreviewFlow } = await import('../src/content/injector');
    const flow = openPreviewFlow('https://qe.example.com/a.zip');
    const frame = await waitForBridgeFrame();
    postFromFrame(frame, { type: 'atv-sw-ready' });
    await flow;
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
    expect(sendMock.mock.calls[1][0]).toMatchObject({
      type: 'TRACE_UPLOAD_DONE',
      viewerTabId: 11,
      traceUrl: 'https://qe.example.com/a.zip',
    });
  });

  it('后台未回传 tabId -> 回退同步打开(无 pending)', async () => {
    pushState();
    const sendMock = vi.mocked(chrome.runtime.sendMessage);
    sendMock.mockReset().mockResolvedValueOnce(undefined).mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(blobOf())));

    const { openPreviewFlow } = await import('../src/content/injector');
    await openPreviewFlow('https://qe.example.com/a.zip');
    expect(sendMock).toHaveBeenCalledTimes(2);
    const last = sendMock.mock.calls[sendMock.mock.calls.length - 1][0] as Record<string, unknown>;
    expect(last.type).toBe('OPEN_TRACE_VIEWER');
    expect(last.pendingUpload).toBeUndefined();
  });
});

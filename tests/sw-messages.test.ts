// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createdTabs: { url: string; id: number }[] = [];
const updatedTabs: { id: number; url: string }[] = [];
let tabSeq = 0;
let messageListener: ((msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void) | null = null;

vi.stubGlobal('chrome', {
  runtime: {
    getURL: (p: string) => `chrome-extension://ext-id/${p}`,
    onInstalled: { addListener: vi.fn() },
    onMessage: { addListener: (fn: typeof messageListener) => (messageListener = fn) },
  },
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn() },
  },
  tabs: {
    query: vi.fn(async () => [] as { index: number }[]),
    create: vi.fn((opts: { url: string }, cb: (tab: { id: number }) => void) => {
      const tab = { url: opts.url, id: ++tabSeq };
      createdTabs.push(tab);
      cb(tab);
    }),
    update: vi.fn(async (id: number, opts: { url: string }) => {
      updatedTabs.push({ id, url: opts.url });
    }),
  },
  declarativeNetRequest: {
    updateDynamicRules: vi.fn(async () => {}),
    RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
    HeaderOperation: { SET: 'set', REMOVE: 'remove' },
  },
});

await import('../src/background/sw');

const send = (msg: unknown, sender: unknown = {}) =>
  new Promise<unknown>((resolve) => {
    // listener return false 表示无异步响应,直接 resolve
    const keep = messageListener!(msg, sender, resolve);
    if (!keep) resolve(undefined);
  });

beforeEach(() => {
  createdTabs.length = 0;
  updatedTabs.length = 0;
  vi.mocked(chrome.tabs.create).mockClear();
});

describe('OPEN_TRACE_VIEWER', () => {
  it('pendingUpload:立即开 pending 态 tab(不带 trace)并回传 viewerTabId', async () => {
    const res = (await send({
      type: 'OPEN_TRACE_VIEWER',
      traceUrl: 'https://qe.example.com/allure/data/attachments/a.zip',
      caseName: 'demo',
      reportUrl: 'https://qe.example.com/allure/#abc',
      pendingUpload: true,
    })) as { viewerTabId: number };

    expect(res.viewerTabId).toBe(createdTabs[0].id);
    expect(createdTabs[0].url).toContain('src/viewer/viewer.html?');
    expect(createdTabs[0].url).toContain('pending=1');
    expect(createdTabs[0].url).toContain('case=demo');
    expect(createdTabs[0].url).not.toContain('trace=');
  });

  it('非 pending:开带 trace 参数的 tab(现行为保持)', async () => {
    const res = (await send({
      type: 'OPEN_TRACE_VIEWER',
      traceUrl: 'https://r.example.com/a.zip',
    })) as { viewerTabId: number };
    expect(createdTabs[0].url).toContain(encodeURIComponent('https://r.example.com/a.zip'));
    expect(res.viewerTabId).toBe(createdTabs[0].id);
  });
});

describe('TRACE_UPLOAD_DONE', () => {
  it('把 pending tab 重定向为带 pw-upload URL 的完整 viewer 地址', async () => {
    await send({
      type: 'TRACE_UPLOAD_DONE',
      viewerTabId: 77,
      traceUrl: 'pw-upload://u1',
      caseName: 'demo',
      reportUrl: 'https://r.example.com/allure/',
    });
    await vi.waitFor(() => expect(updatedTabs.length).toBe(1));
    expect(updatedTabs[0]).toEqual({
      id: 77,
      url: expect.stringContaining('src/viewer/viewer.html?'),
    });
    expect(updatedTabs[0].url).toContain(encodeURIComponent('pw-upload://u1'));
    expect(updatedTabs[0].url).not.toContain('pending');
  });
});


describe('预览 tab 位置(紧贴报告 tab 之后依次插入)', () => {
  it('无既有预览 tab -> 插在父 tab 紧右侧', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValueOnce([]);
    await send({ type: 'OPEN_TRACE_VIEWER', traceUrl: 'https://r.example.com/a.zip' }, { tab: { index: 3, windowId: 1 } });
    expect(chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ index: 4 }),
      expect.any(Function),
    );
    expect(chrome.tabs.query).toHaveBeenCalledWith(
      { windowId: 1, url: 'chrome-extension://ext-id/src/viewer/viewer.html*' },
    );
  });

  it('父 tab 右侧已有连续预览 tab -> 依次排在其后', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValueOnce([{ index: 4 }, { index: 5 }] as never);
    await send({ type: 'OPEN_TRACE_VIEWER', traceUrl: 'https://r.example.com/a.zip' }, { tab: { index: 3, windowId: 1 } });
    expect(chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ index: 6 }),
      expect.any(Function),
    );
  });

  it('紧邻位置被其他 tab 占用 -> 连续序列断开,插回父 tab 紧右侧', async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValueOnce([{ index: 6 }] as never);
    await send({ type: 'OPEN_TRACE_VIEWER', traceUrl: 'https://r.example.com/a.zip' }, { tab: { index: 3, windowId: 1 } });
    expect(chrome.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ index: 4 }),
      expect.any(Function),
    );
  });

  it('无 sender.tab(如 popup 触发) -> 不指定位置,走默认', async () => {
    await send({ type: 'OPEN_TRACE_VIEWER', traceUrl: 'https://r.example.com/a.zip' });
    const opts = vi.mocked(chrome.tabs.create).mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(opts.index).toBeUndefined();
  });
});

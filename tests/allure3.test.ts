// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MatchSettings } from '../src/types/shared';
import {
  collectTraceAttachments,
  extractAllure3TestId,
  findAttachmentRow,
} from '../src/content/allure3';

const FIXTURE_DIR = resolve(__dirname, 'fixtures');
// 结构取自真实 Allure 3.16.0 报告(DMS #101):
// 顶层 attachments 仅含用例级 png/txt 索引,trace 由 pytest fixture 在
// teardown 阶段 attach,只挂在 teardown[].steps[] 树节点上。
const nestedCase = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, 'allure3-test-result-nested.json'), 'utf8'),
);
const rowsHtml = readFileSync(resolve(FIXTURE_DIR, 'allure3-attachment-rows.html'), 'utf8');

const mimeMatch = (keywords: string[]): MatchSettings => ({
  matchMode: 'mime',
  traceTypeKeywords: keywords,
  nameKeywords: [],
  urlKeywords: ['allure'],
  corsDomains: [],
});
const nameMatch = (keywords: string[]): MatchSettings => ({
  matchMode: 'name',
  traceTypeKeywords: [],
  nameKeywords: keywords,
  urlKeywords: ['allure'],
  corsDomains: [],
});

describe('extractAllure3TestId', () => {
  it('从真实用例路由 #<32hex> 提取 testId', () => {
    expect(extractAllure3TestId('#038cf21e2fb1e33ad9e4b3207c4a2cdf')).toBe(
      '038cf21e2fb1e33ad9e4b3207c4a2cdf',
    );
  });

  it('提取大写十六进制 testId 并保持原样', () => {
    expect(extractAllure3TestId('#ABCDEF0123456789ABCDEF0123456789')).toBe(
      'ABCDEF0123456789ABCDEF0123456789',
    );
  });

  it.each(['', '#', '#/', '#/overview', '#tree=abc', '#038cf21e-setup'])(
    '非用例路由 %s 返回 null',
    (hash) => {
      expect(extractAllure3TestId(hash)).toBeNull();
    },
  );
});

describe('collectTraceAttachments', () => {
  it('mime 模式:收集 teardown 步骤树中的 trace 附件并构造 URL', () => {
    const result = collectTraceAttachments(
      nestedCase,
      mimeMatch(['application/vnd.playwright.trace+zip']),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: '78eaacf27db5499ce0cf169e7b208562',
      contentType: 'application/vnd.playwright.trace+zip',
      url: 'data/attachments/78eaacf27db5499ce0cf169e7b208562.zip',
    });
  });

  it('mime 关键词子串可命中', () => {
    const result = collectTraceAttachments(nestedCase, mimeMatch(['playwright.trace']));
    expect(result).toHaveLength(1);
  });

  it('name 模式:附件名/originalFileName 命中即收集(含深层嵌套步骤)', () => {
    const result = collectTraceAttachments(nestedCase, nameMatch(['操作追踪']));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('78eaacf27db5499ce0cf169e7b208562');
  });

  it('name 模式按 originalFileName 兜底命中', () => {
    const result = collectTraceAttachments(
      nestedCase,
      nameMatch(['bb113460-d801-4ef1-9d08']),
    );
    expect(result).toHaveLength(1);
  });

  it('同一附件 id 在顶层与树中多处引用时去重', () => {
    const result = collectTraceAttachments(nestedCase, mimeMatch(['trace+zip']));
    expect(result.map((a) => a.id)).toEqual(['78eaacf27db5499ce0cf169e7b208562']);
  });

  it('顶层非 trace 附件不命中 mime 关键词时不收集', () => {
    expect(collectTraceAttachments(nestedCase, mimeMatch(['video/mp4']))).toEqual([]);
  });

  it('attachments 缺失或非对象时不崩溃,返回空数组', () => {
    expect(collectTraceAttachments({}, mimeMatch(['trace']))).toEqual([]);
    expect(collectTraceAttachments(undefined, mimeMatch(['trace']))).toEqual([]);
    expect(
      collectTraceAttachments({ steps: [{ type: 'step' }, null] }, mimeMatch(['trace'])),
    ).toEqual([]);
  });
});

describe('findAttachmentRow', () => {
  it('按 data-tr-focus-id 精确定位附件行(不误中 <testId>-setup 阶段行)', () => {
    document.body.innerHTML = rowsHtml;
    const row = findAttachmentRow(document, {
      id: '78eaacf27db5499ce0cf169e7b208562',
      name: '操作追踪 - test_148491_metadata_combo_filter__20261008_183429__FAILED.zip',
    });
    expect(row).toBeInstanceOf(HTMLElement);
    expect(row?.getAttribute('data-testid')).toBe('test-result-attachment-header');
  });

  it('data-tr-focus-id 缺失时按附件名文本兜底定位', () => {
    document.body.innerHTML = rowsHtml.replace(/data-tr-focus-id="[^"]*"/g, '');
    const row = findAttachmentRow(document, {
      id: '78eaacf27db5499ce0cf169e7b208562',
      name: '操作追踪 - test_148491_metadata_combo_filter__20261008_183429__FAILED.zip',
    });
    expect(row).toBeInstanceOf(HTMLElement);
    expect(row?.textContent).toContain('application/vnd.playwright.trace+zip');
  });

  it('行不存在时返回 null', () => {
    document.body.innerHTML = rowsHtml;
    expect(
      findAttachmentRow(document, { id: 'not-exist', name: 'not-exist' }),
    ).toBeNull();
  });
});

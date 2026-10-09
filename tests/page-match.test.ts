// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('chrome', {
  runtime: { id: 'ext-id', getURL: (p: string) => `chrome-extension://ext-id/${p}`, sendMessage: vi.fn(async () => {}) },
  storage: { local: { get: vi.fn(async () => ({})) }, onChanged: { addListener: vi.fn() } },
});

const { matchesPageUrl } = await import('../src/content/injector');
const { extractAllure3TestId } = await import('../src/content/allure3');

const matchOf = (partial: { urlKeywords?: string[]; corsDomains?: string[] } = {}) => ({
  matchMode: 'mime' as const,
  traceTypeKeywords: ['application/vnd.playwright.trace+zip'],
  nameKeywords: ['trace'],
  urlKeywords: partial.urlKeywords ?? [],
  corsDomains: partial.corsDomains ?? [],
});

describe('matchesPageUrl(URL 关键词 ∪ CORS 域名)', () => {
  it('URL 关键词子串命中即注入', () => {
    expect(
      matchesPageUrl(
        'https://qe.lenovows.com/view/web/job/DMS/101/allure/?status=failed#categories/abc',
        matchOf({ urlKeywords: ['allure'] }),
      ),
    ).toBe(true);
  });

  it('URL 关键词不命中但 CORS 域名子串命中 -> 注入', () => {
    expect(
      matchesPageUrl(
        'https://qe.lenovows.com/view/web/job/DMS/101/allure/?status=failed',
        matchOf({ urlKeywords: ['report.example.com'], corsDomains: ['qe.lenovows.com'] }),
      ),
    ).toBe(true);
  });

  it('CORS 域名命中 URL 任意位置(子域/路径/查询参数)即注入', () => {
    expect(
      matchesPageUrl('https://ci.qe.lenovows.com/allure/', matchOf({ corsDomains: ['qe.lenovows.com'] })),
    ).toBe(true);
    expect(
      matchesPageUrl('https://proxy.example.com/view?from=qe.lenovows.com', matchOf({ corsDomains: ['qe.lenovows.com'] })),
    ).toBe(true);
  });

  it('CORS 域名大小写与空白不敏感', () => {
    expect(
      matchesPageUrl('https://qe.lenovows.com/x', matchOf({ corsDomains: ['  QE.LenovoWS.com '] })),
    ).toBe(true);
  });

  it('两个维度都不命中 -> 不注入', () => {
    expect(
      matchesPageUrl('https://other.example.com/page', matchOf({ urlKeywords: ['allure'], corsDomains: ['qe.lenovows.com'] })),
    ).toBe(false);
  });

  it('关键词与域名均为空 -> 全页面生效(现行为保持)', () => {
    expect(matchesPageUrl('https://any.example.com/x', matchOf())).toBe(true);
  });
});

describe('extractAllure3TestId(带路由前缀)', () => {
  it('真实路由 #categories/<testId> 可提取(用户实测 URL)', () => {
    expect(extractAllure3TestId('#categories/ae4e0293930c25db2ccebc6d6a75cf08')).toBe(
      'ae4e0293930c25db2ccebc6d6a75cf08',
    );
  });

  it('#categories/<testId>?query 变体可提取', () => {
    expect(extractAllure3TestId('#categories/038cf21e2fb1e33ad9e4b3207c4a2cdf?status=failed')).toBe(
      '038cf21e2fb1e33ad9e4b3207c4a2cdf',
    );
  });

  it('分类视图首页 #categories 不误提取', () => {
    expect(extractAllure3TestId('#categories')).toBeNull();
    expect(extractAllure3TestId('#/categories')).toBeNull();
  });
});

describe('extractAllure3TestId(hash 带查询/路径后缀)', () => {
  it('#<testId>?status=failed 仍可提取', () => {
    expect(extractAllure3TestId('#038cf21e2fb1e33ad9e4b3207c4a2cdf?status=failed')).toBe(
      '038cf21e2fb1e33ad9e4b3207c4a2cdf',
    );
  });

  it('#<testId>/sub 路径后缀仍可提取', () => {
    expect(extractAllure3TestId('#038cf21e2fb1e33ad9e4b3207c4a2cdf/sub')).toBe(
      '038cf21e2fb1e33ad9e4b3207c4a2cdf',
    );
  });

  it('阶段行后缀(-setup)不误提取', () => {
    expect(extractAllure3TestId('#038cf21e-setup')).toBeNull();
  });
});

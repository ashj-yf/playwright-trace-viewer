// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

const updateDynamicRules = vi.fn(async () => {});
vi.stubGlobal('chrome', {
  runtime: { id: 'ext-id' },
  declarativeNetRequest: {
    updateDynamicRules,
    RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
    HeaderOperation: { SET: 'set', REMOVE: 'remove' },
    ResourceType: { FONT: 'font' },
  },
});

const { syncCorsRules } = await import('../src/background/dnr');

const lastCall = () => updateDynamicRules.mock.calls.at(-1)![0];

describe('syncCorsRules 字体跨域规则', () => {
  it('未配置 CORS 域名时仍保留字体规则(snapshot 图标字体跨域)', async () => {
    await syncCorsRules([]);
    const call = lastCall();
    expect(call.removeRuleIds).toEqual([1, 2]);
    expect(call.addRules).toHaveLength(1);
    const fontRule = call.addRules[0] as Record<string, any>;
    expect(fontRule.id).toBe(2);
    expect(fontRule.condition.resourceTypes).toEqual(['font']);
    expect(fontRule.condition.initiatorDomains).toEqual(['ext-id']);
    const headers = fontRule.action.responseHeaders as { header: string; value?: string }[];
    expect(headers.find((h) => h.header === 'Access-Control-Allow-Origin')?.value).toBe('*');
  });

  it('配置域名时域名规则与字体规则并存', async () => {
    await syncCorsRules(['qe.lenovows.com']);
    const call = lastCall();
    expect(call.addRules).toHaveLength(2);
    expect((call.addRules[0] as Record<string, any>).condition.requestDomains).toEqual(['qe.lenovows.com']);
    expect((call.addRules[1] as Record<string, any>).id).toBe(2);
  });
});

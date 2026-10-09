/**
 * Allure 3 报告(Allure CLI 3.x / allure-jenkins-plugin 3.x)适配:
 * 用例数据位于 data/test-results/<testId>.json,附件文件位于 data/attachments/<id><ext>,
 * 行 DOM 以 data-tr-focus-id(=附件 id)关联。本模块为纯逻辑,不依赖 chrome API,
 * 便于单测;content script 接线见 injector.ts。
 *
 * Allure 3.16 实测结构(fixture 见 tests/fixtures/allure3-test-result-nested.json):
 *   - 用例路由 hash 为 #<32hex testId>,JSON 键为 setup/steps/teardown 阶段树;
 *   - 阶段树的 steps 数组中 step 与 attachment 条目({link, type:"attachment"})混排;
 *   - pytest fixture 在 teardown 阶段 attach 的 trace 只挂树节点,
 *     顶层 attachments 仅是用例级附件的部分索引(且与树中条目重复引用)。
 * 因此收集必须递归整棵阶段树,并按附件 id 去重。
 */
import type { MatchSettings } from '../types/shared';

/** 命中的 trace 附件(相对报告根的 URL,含原始 contentType)。 */
export interface Allure3TraceAttachment {
  /** 附件 id(data/attachments 文件名去扩展)。 */
  id: string;
  /** 附件展示名。 */
  name: string;
  /** 附件 MIME 类型。 */
  contentType: string;
  /** 相对报告根的附件 URL,如 data/attachments/<id>.zip。 */
  url: string;
}

/** Allure 3 用例数据中 attachments[].link 的关键字段。 */
interface Allure3AttachmentLink {
  id?: string;
  ext?: string;
  contentType?: string;
  name?: string;
  originalFileName?: string;
}

/** Allure 3 用例 JSON 的附件入口与阶段树(setup/steps/teardown)。 */
type Allure3TestCase = {
  attachments?: unknown;
  setup?: unknown;
  steps?: unknown;
  teardown?: unknown;
} | null;

/** 阶段树节点:自身可为附件条目,或为可再嵌子节点(steps/attachments)的步骤。 */
type Allure3TreeNode = {
  link?: unknown;
  steps?: unknown;
  attachments?: unknown;
} | null;

/** 大小写不敏感的关键词命中测试(与 injector 同规则)。 */
function matchesAny(value: string, keywords: string[]): boolean {
  const lower = value.toLowerCase();
  return keywords.some((kw) => kw.length > 0 && lower.includes(kw.toLowerCase()));
}

/**
 * 从 location.hash 提取 Allure 3 用例路由的 testId。
 * 用例页 hash 为 #<32位hex> 或带路由前缀(#categories/<32位hex> 等)。
 * 非用例页(#、#/categories、#tree=abc 等)返回 null。
 */
export function extractAllure3TestId(hash: string): string | null {
  // 用例路由形态:#<testId>(树视图)或 #categories/<testId> 等带路由前缀
  // (?status=failed 过滤入口经 SPA 初始化即变为 categories 路由,实测),
  // 亦可能带查询/路径后缀。取路径中首个纯十六进制段(8+ 位):固定词段
  // (categories/overview 等)均非纯 hex,不会误提取;-setup 阶段行同理。
  const path = hash.replace(/^#/, '').split('?')[0];
  for (const seg of path.split('/')) {
    if (/^[0-9a-fA-F]{8,}$/.test(seg)) return seg;
  }
  return null;
}

/** 从 Allure 3 用例 JSON 中按匹配规则筛出 trace 附件。 */
export function collectTraceAttachments(
  testCase: unknown,
  match: MatchSettings,
): Allure3TraceAttachment[] {
  const tc = testCase as Allure3TestCase;
  if (!tc) return [];
  const result: Allure3TraceAttachment[] = [];
  const seen = new Set<string>();
  const push = (link: Allure3AttachmentLink): void => {
    if (typeof link.id !== 'string' || link.id.length === 0) return;
    const contentType = link.contentType ?? '';
    const name = link.name ?? '';
    const originalFileName = link.originalFileName ?? '';
    const matched =
      match.matchMode === 'mime'
        ? matchesAny(contentType, match.traceTypeKeywords)
        : matchesAny(name, match.nameKeywords) ||
          matchesAny(originalFileName, match.nameKeywords);
    // 顶层 attachments 与阶段树存在同一附件的重复引用,按 id 去重
    if (!matched || seen.has(link.id)) return;
    seen.add(link.id);
    result.push({
      id: link.id,
      name,
      contentType,
      url: `data/attachments/${link.id}${link.ext ?? ''}`,
    });
  };
  if (Array.isArray(tc.attachments)) {
    for (const entry of tc.attachments) {
      const link = (entry as Allure3TreeNode)?.link as Allure3AttachmentLink | undefined;
      if (link) push(link);
    }
  }
  // setup/steps/teardown 阶段树:step 与 attachment 条目混排,步骤可再嵌子步骤
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      const entry = node as Allure3TreeNode;
      if (!entry) continue;
      if (entry.link) push(entry.link as Allure3AttachmentLink);
      walk(entry.steps);
      walk(entry.attachments);
    }
  };
  walk(tc.setup);
  walk(tc.steps);
  walk(tc.teardown);
  return result;
}

/**
 * 定位附件在页面中的行元素:
 * 首选 data-tr-focus-id 精确匹配(Allure 3 的稳定关联属性,不受 CSS 哈希类影响);
 * 兜底按附件名精确文本向上找含按钮的行容器(属性名变化时仍可用)。
 */
export function findAttachmentRow(
  root: ParentNode,
  attachment: { id: string; name: string },
): HTMLElement | null {
  // 属性值逐个比对而非拼进选择器,规避特殊字符注入问题
  const rows = root.querySelectorAll<HTMLElement>('[data-tr-focus-id]');
  for (const row of rows) {
    if (row.getAttribute('data-tr-focus-id') === attachment.id) return row;
  }
  // 兜底:文本精确等于附件名的节点,向上最多爬 6 层找包含按钮的容器
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent?.trim() !== attachment.name) continue;
    let el = node.parentElement;
    for (let i = 0; i < 6 && el; i++) {
      if (el.querySelector('button')) return el;
      el = el.parentElement;
    }
  }
  return null;
}

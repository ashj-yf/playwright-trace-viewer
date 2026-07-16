# Allure Trace Viewer Chrome 插件需求文档（PRD）

## 1. 概述

开发一个 Chrome 浏览器扩展，用于在 Allure 测试报告中直接预览 Playwright 生成的 trace 压缩包（`trace.zip`），免去「下载 zip → 命令行执行 `npx playwright show-trace`」的繁琐流程，提升测试报告的排查效率。

---

## 2. 背景与动机

- **Allure 报告**：业界广泛使用的测试报告框架，常与 Playwright 配合。`allure-playwright` 适配器会把 `trace.zip` 作为附件挂到用例上。
- **Playwright Trace**：包含截图、DOM 快照、网络请求、控制台日志、动作时间线等，体积小信息量大，是定位失败用例的关键物证。
- **现状痛点**：
  1. Allure 只把 trace 当普通附件，点击只能下载，无法在线查看。
  2. 官方查看方式 `npx playwright show-trace trace.zip` 需要本地有 Node 环境和 Playwright。
  3. 官方在线版 `trace.playwright.dev` 可拖拽预览，但需手动下载再上传，且存在数据外泄顾虑。
- **目标用户**：QA 工程师、测试开发、研发同学——日常在浏览器里看 Allure 报告并定位用例失败原因。

---

## 3. 目标与非目标

### 目标
- 在 Allure 报告页面识别 trace 附件，将其改造为「可一键预览」的入口。
- 在浏览器内完成 trace 解析与渲染，无需本地命令行、无需上传到外部服务。
- 预览体验对齐 Playwright 官方 Trace Viewer 的核心能力。

### 非目标（首期不做）
- 不做 trace 文件的编辑/修改。
- 不做 Allure 报告本身的其他增强（如截图增强、视频内嵌等）——聚焦 trace。
- 不替代官方 Trace Viewer 的全部高级功能（如性能分析的高级视图）。
- 首期不支持 Firefox / Edge 之外浏览器（先做 Chrome / Chromium 系）。

---

## 4. 用户场景

### 场景 A：在线预览（主流程）
1. 用户打开公司部署的 Allure 报告页面（`https://allure.internal/xxx`）。
2. 进入某失败用例详情，附件区有 `trace.zip`。
3. 附件旁出现插件注入的「▶ 预览 Trace」按钮。
4. 点击后在新标签页打开 Trace Viewer，加载并渲染该 trace。
5. 用户在时间线、Screenshots、DOM、Network、Console 间切换定位问题。

### 场景 B：本地静态报告
- 用户直接用浏览器打开本地生成的 `allure-report/index.html`（`file://` 协议）。插件同样能识别并提供预览。

### 场景 C：手动打开 trace
- 用户从其他渠道拿到一个 `trace.zip`，点击插件图标弹出的面板里选择/拖拽文件即可预览（兜底入口，不依赖 Allure）。

---

## 5. 功能需求

按优先级标注：**P0** = MVP 必做，**P1** = 紧随其后，**P2** = 远期增强。

### 5.1 Trace 入口识别与注入（P0）
| 编号 | 需求 | 说明 |
|------|------|------|
| F1.1 | 自动识别 trace 附件 | 在 Allure 用例详情页，根据附件名（含 `trace`）、MIME（`application/zip`）、或自定义命名约定，识别出 trace 附件。 |
| F1.2 | 注入预览按钮 | 在识别到的附件条目旁插入「预览 Trace」按钮，样式与 Allure 风格协调。 |
| F1.3 | 链接拦截 | 点击预览按钮时，不触发默认下载，改为由插件接管：fetch 该附件字节流并交给 Viewer。 |
| F1.4 | SPA 路由适配 | Allure 是 SPA，切换用例时需重新扫描 DOM（MutationObserver / 路由 hook）。 |

### 5.2 Trace 预览器（P0）
| 编号 | 需求 | 说明 |
|------|------|------|
| F2.1 | 新标签页打开 Viewer | 插件提供独立 HTML 页面（`trace-viewer.html`），承载 trace 渲染。 |
| F2.2 | 核心视图 | 对齐官方：**时间线 Timeline**、**截图 Screenshots**、**快照 Snapshots（DOM 树 + 高亮）**、**网络 Network**、**控制台 Console**、**源码 Source**。 |
| F2.3 | 文件加载 | 支持从 URL（Allure 附件）和本地文件（拖拽/选择）两种来源加载 zip。 |
| F2.4 | 离线自包含 | Viewer 所需资源全部打包进插件，不依赖任何外部 CDN。 |

### 5.3 与 Allure 深度集成（P1）
| 编号 | 需求 | 说明 |
|------|------|------|
| F3.1 | 用例上下文透传 | 预览页标题/页头显示来源用例名、Allure 报告链接，方便回溯。 |
| F3.2 | 多 trace 支持 | 同一用例挂多个 trace（重跑场景）时，提供切换列表。 |
| F3.3 | 报告全局扫描 | 在 Allure 首页提供「含 trace 的失败用例」快速过滤/跳转。 |

### 5.4 体验增强（P1/P2）
| 编号 | 颜色 | 需求 |
|------|------|------|
| F4.1 | P1 | 错误动作在时间线高亮（直接定位到失败 step）。 |
| F4.2 | P1 | 加载中进度反馈（大 zip 解析较慢）。 |
| F4.3 | P2 | 历史 trace 记录（IndexedDB 缓存最近 N 个，含元数据）。 |
| F4.4 | P2 | 快捷键（上/下切换 action、空格播放截图序列）。 |
| F4.5 | P2 | 主题适配（Allure 暗/亮色）。 |

### 5.5 设置与权限（P1）
| 编号 | 需求 | 说明 |
|------|------|------|
| F5.1 | Popup 设置页 | 开关：是否自动注入按钮、是否使用内嵌预览 vs 新标签页、trace 识别规则自定义。 |
| F5.2 | 权限最小化 | 仅申请必要 host 权限；支持用户配置生效的 Allure 域名白名单。 |

---

## 6. 技术方案

### 6.1 Trace 渲染方案选型（关键决策）

| 方案 | 说明 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| **A. 内嵌官方 trace.playwright.dev** | 用 iframe 嵌入官方在线 viewer，postMessage 传 zip | 实现极简 | 数据上传外部，隐私/内网不可用 | ❌ 不满足离线/隐私 |
| **B. 打包 Playwright trace-viewer** | 抽取 `packages/trace-viewer` 前端产物打包进插件 | 官方体验、自包含 | 产物体积大、需跟进上游升级 | ✅ **推荐 MVP 采用** |
| **C. 自研轻量解析器** | 解析 `trace.trace`（JSON Lines）后自渲染 | 体积小、可控 | 工作量巨大、能力难对齐 | ⏸ 远期备选 |

> **推荐 B**：MVP 阶段将 Playwright 官方 trace viewer 的静态产物（HTML/JS/CSS）作为插件资源，`chrome.runtime.getURL` 打开即可，解析逻辑直接复用官方。后续如需瘦身再评估 C。

### 6.2 Allure 报告结构对接

- **附件存储**：`allure-report/data/attachments/<hash>-trace.zip`。
- **用例元数据**：`allure-report/data/test-cases/<uid>.json`，其中 `attachments[].name` / `attachments[].type` 用于识别 trace。
- **页面 DOM**：附件区为动态渲染，需 MutationObserver 监听 `.attachments` 容器变化后注入按钮。

### 6.3 数据流

```
Allure 页面 [content script]
   │ 识别 trace 附件 → 注入「预览」按钮
   │ 点击 → fetch(attachmentUrl) → ArrayBuffer
   ▼
[background service worker]
   │ 消息中转 + 可选缓存
   ▼
[trace-viewer.html] (插件页面)
   │ 接收 zip → 解析 → 渲染官方 Viewer
```

### 6.4 Manifest V3 架构

```
manifest.json
  ├─ content_scripts        → alluer-injector.js (识别 + 注入按钮)
  ├─ background.service_worker → sw.js (消息路由/缓存)
  ├─ action (popup)         → popup.html (设置 + 手动入口)
  ├─ web_accessible_resources → trace-viewer.html 及其静态资源
  └─ permissions            → host 权限、storage、tabs
```

### 6.5 关键技术风险点

1. **CORS / file:// 限制**：`file://` 打开本地 Allure 报告时，content script fetch 附件可能被同源策略拦截——需用 `chrome.runtime` 消息让 background 代为 fetch（background 对 file:// 无同源限制需验证，必要时引导用户从 http 服务托管）。
2. **trace viewer 体积**：官方产物解压后可能数 MB，影响插件安装体积——评估是否裁剪 Source Map / 未用模块。
3. **上游升级跟随**：Playwright trace 文件格式可能随版本演进，Viewer 需定期同步官方解析逻辑，否则新版 trace 解析失败。
4. **Manifest V3 service worker 生命周期**：大文件 fetch 可能被 SW 回收打断，需用 `chrome.alarms` 保活或改在页面侧 fetch。

---

## 7. 非功能性需求

| 维度 | 要求 |
|------|------|
| 性能 | 50MB 以内 trace.zip 在 5s 内完成加载并首屏可交互。 |
| 兼容性 | Chrome 114+（Manifest V3）；支持 Chromium 系 Edge。 |
| 安全 | 不向任何外部服务上传 trace 内容；权限遵循最小化。 |
| 隐私 | 所有数据驻留浏览器本地；历史缓存可选关闭、可一键清除。 |
| 可维护 | trace viewer 与 Allure 注入逻辑解耦，各自可独立升级。 |
| 国际化 | 首期中文 UI，结构上预留 i18n。 |

---

## 8. 里程碑计划

| 阶段 | 交付物 | 预估 |
|------|--------|------|
| **M1 - MVP** | 方案 B 跑通：Allure 页面注入按钮 → 新标签页预览 trace，覆盖核心视图 | 1–2 周 |
| **M2 - 体验完善** | 错误动作高亮、加载反馈、SPA 适配、设置页、手动拖拽入口 | 1 周 |
| **M3 - 深度集成** | 多 trace 切换、用例上下文透传、报告全局过滤 | 1 周 |
| **M4 - 增强** | 历史缓存、快捷键、主题、可选自研解析瘦身 | 视情况 |

---

## 9. 待确认问题（需与使用者对齐）

1. **部署环境**：公司 Allure 是 https 托管还是本地 file:// 打开为主？（影响 CORS 方案）
2. **trace 识别规则**：目前附件名是否统一含 `trace`？是否有自定义标签？需要采集真实样本确认。
3. **预览位置**：新标签页 vs Allure 页内浮层（iframe/popup）——前者更稳，后者体验更连贯，倾向哪种？
4. **隐私边界**：是否接受 MVP 阶段临时用官方 `trace.playwright.dev`（方案 A）快速验证，再切换到方案 B？还是必须一步到位离线？
5. **多浏览器**：是否近期就需要 Edge 商店上架？
6. **Playwright 版本**：团队主要用的 Playwright 版本范围？（决定 viewer 对齐哪个上游版本）

---

## 10. 验收标准（MVP）

- [ ] 在 https 托管的 Allure 报告中，失败用例的 trace 附件旁出现「预览 Trace」按钮。
- [ ] 点击按钮在新标签页打开 Viewer，3s 内开始渲染、10s 内可交互（常规 trace）。
- [ ] Viewer 至少可用：Timeline、Screenshots、Snapshots、Network、Console 五个视图。
- [ ] 全程不向外部域名发送 trace 内容（可用 DevTools Network 验证）。
- [ ] 在 Allure 内切换多个用例，按钮能正确重新注入。
- [ ] Popup 提供手动选择本地 trace.zip 的兜底预览入口。

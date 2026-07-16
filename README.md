# Playwright Trace Viewer

> 在 Allure 报告中直接预览 Playwright trace 压缩包的 Chrome 扩展

[![Release](https://img.shields.io/github/v/release/ashj-yf/playwright-trace-viewer?include_prereleases)](https://github.com/ashj-yf/playwright-trace-viewer/releases)

## 为什么需要

Allure 报告会把 Playwright 生成的 `trace.zip` 当作普通附件，点击只能下载。要查看 trace，传统方式有三种痛点：

- 官方命令 `npx playwright show-trace trace.zip` 需要本地 Node 环境和 Playwright；
- 在线版 `trace.playwright.dev` 需要先下载再手动上传，且有数据外泄顾虑，内网报告不可用；
- Allure 本身不支持在线预览 trace。

本扩展把 Playwright 官方 Trace Viewer 的前端产物打包进插件，在 Allure 报告页识别 trace 附件并注入「预览 Trace」按钮，点击即在新标签页内离线渲染，**无需命令行、无需上传外部服务**。

## 特性

- **自动注入**：在 Allure 用例详情页识别 trace 附件，旁注「▶ 预览 Trace」按钮，适配 Allure SPA 路由切换。
- **离线自包含**：官方 Trace Viewer 资源全部内置，不依赖任何外部 CDN，内网报告可用。
- **多来源加载**：支持从 Allure 附件 URL 加载，也支持在 Popup 中手动拖拽/选择本地 `trace.zip`。
- **对齐官方体验**：时间线、Screenshots、DOM 快照、Network、Console、Source 等核心视图。
- **识别规则可配**：通过附件 MIME 类型、附件名关键词自定义 trace 识别规则，适配不同团队约定。
- **支持本地报告**：`file://` 协议打开的本地 `allure-report/index.html` 同样可用。

## 安装

### 方式一：从 Release 下载（推荐）

1. 前往 [Releases 页面](https://github.com/ashj-yf/playwright-trace-viewer/releases)，下载最新版本的 `playwright-trace-viewer-vX.Y.Z.zip`。
2. 解压 zip 到任意目录。
3. 打开 Chrome，访问 `chrome://extensions`，右上角开启「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择解压后的目录。

### 方式二：从源码构建

```bash
git clone https://github.com/ashj-yf/playwright-trace-viewer.git
cd playwright-trace-viewer
npm install   # 会自动执行 prepare 脚本,同步官方 trace-viewer 产物
npm run build
```

构建产物在 `dist/`，按上面第 3、4 步加载该目录即可。

## 使用方式

### 在 Allure 报告中预览

1. 打开 Allure 报告（在线部署或本地 `file://` 均可）。
2. 进入含 trace 附件的用例详情页，附件旁会自动出现「▶ 预览 Trace」按钮。
3. 点击按钮，新标签页打开 Trace Viewer 并加载该 trace。

### 手动打开 trace 文件

点击浏览器工具栏的扩展图标，在弹出的 Popup 中点击「手动打开 Trace 文件」，在打开的预览页内拖拽或选择本地 `trace.zip` 即可。此入口不依赖 Allure，适合从其他渠道拿到的 trace。

### 配置识别规则

点击 Popup 右上角齿轮图标展开设置面板：

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| 自动注入预览按钮 | 关闭后不在 Allure 页面注入按钮 | 开启 |
| Trace 类型关键词 | attachment 的 MIME 含此词即判定为 trace（约定型，不依赖附件名） | `playwright-trace` |
| Zip 类型关键词 | MIME 含此词视为 zip 类型 | `zip` |
| 附件名关键词 | 附件名/路径含此词视为含 trace（配合 zip 类型使用） | `trace` |

识别逻辑（满足其一即判定为 trace）：
- MIME 命中「Trace 类型关键词」；
- MIME 命中「Zip 类型关键词」且附件名/路径命中「附件名关键词」。

每项关键词按行分隔，修改后即时生效并重新扫描页面。

## 开发

### 环境要求

- Node.js 20+
- Chrome / Chromium 浏览器

### 常用命令

```bash
npm install        # 安装依赖(自动同步官方 trace-viewer 产物到 public/vendor)
npm run dev        # 启动 Vite 开发模式(HMR)
npm run build      # 构建生产产物到 dist/
npm run typecheck  # TypeScript 类型检查(不产出来)
```

> `public/vendor/trace-viewer/` 是从 `playwright-core` 同步的官方产物，已被 `.gitignore` 忽略，由 `scripts/sync-vendor.mjs` 在 `prepare` 阶段自动生成。升级 Playwright 版本只需改 `package.json` 中的 `playwright-core` 依赖并重新 `npm install`。

### 项目结构

```
src/
├── manifest.json              # Chrome MV3 清单
├── background/sw.ts           # Service Worker:消息中转,打开预览页
├── content/injector.ts        # Content Script:识别 trace 附件并注入按钮
├── popup/                     # 工具栏 Popup:设置 + 手动入口
│   ├── popup.html
│   ├── popup.ts
│   └── popup.css
├── viewer/                    # Trace 预览页(壳)
│   ├── viewer.html
│   ├── viewer.ts
│   └── viewer.css
└── types/shared.ts            # 跨模块共享的类型与默认设置
public/
└── vendor/trace-viewer/       # 官方 trace-viewer 产物(prepare 时同步,不入库)
scripts/
└── sync-vendor.mjs            # 同步 + patch 官方产物(移除 MV3 不兼容的 inline script)
```

### 数据流

```
Allure 页面 [content script]
   │ 识别 trace 附件 → 注入「预览」按钮
   │ 点击 → sendMessage(OPEN_TRACE_VIEWER)
   ▼
[background service worker]
   │ 打开 viewer.html?trace=<url>
   ▼
[viewer.html]
   │ fetch 远程 zip → Blob → blob URL
   │ iframe 内嵌官方 trace-viewer 加载 blob URL → 渲染
```

用 blob URL 中转是为了绕过官方 viewer 的 Service Worker 跨域 fetch 限制--扩展页拥有 host 权限可直接 fetch 远程附件。

## 发版

项目使用 [release-please](https://github.com/googleapis/release-please) 自动管理版本与发布：

1. 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)（`feat:` / `fix:` / `chore:` 等）；
2. push 到 `main` 后，release-please 自动创建/更新一个 Release PR；
3. 合并该 PR 即自动打 tag、生成 Changelog、创建 GitHub Release，并由 CI 构建上传 `playwright-trace-viewer-vX.Y.Z.zip`。

> 版本号同时维护在 `package.json` 与 `src/manifest.json`，由 release-please 自动同步。由于 Chrome 扩展版本号不支持预发布后缀，prerelease 版本需手动通过 `gh release create --prerelease` 创建。

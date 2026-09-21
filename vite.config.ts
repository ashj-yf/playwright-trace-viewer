import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(
  readFileSync(new URL('./src/manifest.json', import.meta.url), 'utf-8'),
);

// viewer.html 仅在 manifest 的 web_accessible_resources 中声明,crxjs 不会把它当作
// 入口编译(只原样复制),导致其 <script type="module" src="./viewer.ts"> 加载未编译的
// .ts,Chrome 扩展协议下 MIME 为 application/octet-stream,module script 严格校验失败。
// 这里显式将其声明为 Rollup 入口,交由 Vite 编译并改写 script 引用。
const viewerHtml = fileURLToPath(
  new URL('./src/viewer/viewer.html', import.meta.url),
);

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // chrome-extension:// 页面上 modulepreload 完全无效。Chrome 会报:
    //   "A preload for '...' is found, but is not used because it is a
    //    cross-world extension resource mismatch."
    // 扩展资源走独立的 URL loader,不参与渲染进程的 preload cache,
    // 预加载的响应一律被丢弃、真实 import 再取一次 —— 纯粹的重复读取 + 控制台噪音。
    // 关掉后同时省掉 modulepreload-polyfill chunk(Chrome 原生支持,polyfill 本就空跑)。
    modulePreload: false,
    rollupOptions: {
      input: { viewer: viewerHtml },
    },
  },
});

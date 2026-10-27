import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { biliProxy } from './scripts/vite-bili-proxy.ts'

// https://vite.dev/config/
export default defineConfig({
  // biliProxy：B 站 api / 播放地址的同源代理（cookie + Referer 只能由服务端转发，见该文件注释）
  plugins: [react(), biliProxy()],
  // dev server 端口钉死 5173：tauri.conf.json 的 devUrl 是静态字符串，而 Vite 在 5173
  // 被占用时会自动顺移到 5174 —— 那时 `npm run tauri dev` 连的是一个空窗口。
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // 内容包与归档是 190 MB+ 的纯数据，不是前端源码。让 chokidar 盯着它们有两个后果：
      // 一是全量扫描慢，二是别的工具在这些目录里建临时文件时 watcher 抛 EBUSY，
      // 而 Vite 的 watch 错误是**未捕获**的 —— 整个 dev server 直接退出（表现为「localhost 打不开了」）。
      //
      // 编辑器的原子写入会先在**同目录**建 `.文件名.<pid>.<hash>.tmpdir/` 再 rename，
      // 那个 tmpdir 就在 src/ 里，同样会触发 EBUSY 把 dev server 打死（实测踩过）。
      // 所以隐藏的临时目录/文件也要一起忽略。
      ignored: [
        '**/content-packs/**',
        '**/med-archive/**',
        '**/dist/**',
        '**/.*.tmpdir/**',
        '**/*.tmp',
      ],
    },
  },
  // 相对 base：适配 GitHub Pages 子路径（https://<user>.github.io/<repo>/）
  // 部署到根路径的时同样可用，本地 dev 不受影响。
  base: './',
  resolve: {
    alias: {
      // @react-pdf-viewer/core 内部会 `require('pdfjs-dist')` 拿 PDFWorker / renderTextLayer /
      // SVGGraphics。必须保证它和我们（core/pdfLib）拿到的是同一份 pdfjs：
      // - pdfjs 4.x 删掉了 renderTextLayer / SVGGraphics → viewer 静默失败；
      // - 打包时若各自解析成不同实例，worker 配置也对不上，同样空白。
      // 统一指向 3.x 的入口文件。
      'pdfjs-dist': fileURLToPath(new URL('./node_modules/pdfjs-dist/build/pdf.js', import.meta.url)),
    },
  },
  optimizeDeps: {
    // pdfjs 3.x 是 UMD/CJS 产物，显式声明依赖让 Vite 做 CJS → ESM 互操作，
    // 否则浏览器里 import 拿到的是空对象。
    include: ['pdfjs-dist'],
  },
})

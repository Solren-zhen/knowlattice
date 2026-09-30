import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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

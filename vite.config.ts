import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 相对 base：适配 GitHub Pages 子路径（https://<user>.github.io/<repo>/）
  // 部署到根路径的时同样可用，本地 dev 不受影响。
  base: './',
})

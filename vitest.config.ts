import { defineConfig } from 'vitest/config';

// core 逻辑测试：纯 Node 环境，localStorage 用 setup 里的内存垫片。
// views 冒烟测试（.tsx）：文件内 pragma 指定 jsdom 环境，配合 fake-indexeddb。
// 挂 react 插件——Workspace 冒烟测试要渲染 JSX 并支持懒加载 chunk 的动态导入。
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    setupFiles: ['src/__tests__/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});

import { defineConfig } from 'vitest/config';

// core 逻辑测试：纯 Node 环境，localStorage 用 setup 里的内存垫片。
// views 冒烟测试（.tsx）：文件内 pragma 指定 jsdom 环境，配合 fake-indexeddb。
// 挂 react 插件——Workspace 冒烟测试要渲染 JSX 并支持懒加载 chunk 的动态导入。
import react from '@vitejs/plugin-react';

// 外层 shell 可能带着 NODE_ENV=production（本机就是），vitest 只在「未设置」时
// 才补 NODE_ENV=test，于是 react 解析到 cjs/react.production.js——生产构建不导出
// React.act，RTL 退到已废弃的 react-dom/test-utils.act，DOM 测试整体报
// 「React.act is not a function」。测试环境下必须钉到 development 解析。
process.env.NODE_ENV = 'test';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    setupFiles: ['src/__tests__/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // benchmark 默认 include 是 **/*.bench.ts，会把 .pack-staging/ 里的源码副本也扫进来，
    // 同一份基准跑两遍。收窄到 src 下。
    benchmark: {
      include: ['src/**/*.bench.ts'],
    },
  },
});

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
    /**
     * 单测总预算。默认 5s，而这个仓库的用例大量在「等一条真实异步链走完」：
     * 打开库要读全部笔记 + 媒体 + 跑一遍 Markdown 自动修正，写入走 fake-indexeddb，
     * 导入要逐文件分流。整套 150+ 文件并行跑（每个文件一个 worker）时，机器负载会把某一次等待
     * 推过默认值 —— 表现为「单跑全绿、整套偶尔红」的假红，比真 bug 更消耗人。
     *
     * 这里统一放宽**等待上限**，断言条件一个字没改：条件不成立照样失败，判定力不变。
     * （RTL 的 waitFor / findBy* 上限在 src/__tests__/setup.ts 里一起放宽——那两处必须匹配：
     *  单测预算必须大于用例里所有等待之和，否则先到点的永远是 vitest 自己的超时。）
     */
    testTimeout: 20_000,
    // benchmark 默认 include 是 **/*.bench.ts，会把 .pack-staging/ 里的源码副本也扫进来，
    // 同一份基准跑两遍。收窄到 src 下。
    benchmark: {
      include: ['src/**/*.bench.ts'],
    },
  },
});

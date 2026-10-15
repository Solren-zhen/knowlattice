# KNOWLATTICE · 工作规则（dsh 会话自动注入）

> 本文件被 dsh 的 `agent-instructions` 自动注入。只写硬约束。

## 一、项目结构（已核实）

TypeScript 前端 + Tauri 桌面壳的知识/笔记类应用。

| 位置 | 内容 |
|---|---|
| `src/` | 前端源码（含 `views/`、`index.css`） |
| `src-tauri/` | Tauri（Rust）侧 |
| `public/` | 静态资源 |
| `scripts/` | 构建辅助脚本（`clean-dist.mjs`、`copy-pdf-worker.mjs`、`assert-public-dist.mjs`、`pack.mjs`、`tauri.mjs`） |
| `docs/` | 文档 |
| `vendor/` | 第三方（勿手改） |

命令（根目录）：`npm run dev`（vite） / `npm run build`（`tsc -b && vite build` + 产物断言） / `npm run lint`（oxlint） / `npm run test`（vitest run） / `npm run bench` / `npm run pack` / `npm run tauri`。

## 二、本项目的硬约束

1. **UI 改动必须可验证**：改样式/布局/交互后，说明如何看效果（dev 起来看哪个视图/面板），并跑 `npm run lint` + `npm run test`。
2. **不要一次重写大组件**。历史上出现过同一文件（`views/AiAgentPanel.tsx`）被反复改 20+ 次、越改越乱。做法：先读全文 → 列最小改动点 → 一次改一处 → 说明改了什么。
3. `prebuild`/`predev` 会跑脚本复制 pdf worker 与清理 dist；不要绕过它们直接改 `dist/`。
4. 不要手改 `vendor/` 与 `node_modules/`。
5. 依赖版本保持不动，除非用户明确要求升级。
6. 涉及 Tauri 侧改动时，先确认前端与 Rust 两侧的接口契约，再改任一侧。

## 三、通用纪律（同 Desktop/AGENTS.md）

不猜接口、不模糊执行、不臆想业务、不造接口、不跳过验证（给真实命令与输出）、不破坏架构、不假装理解、不盲目修改。未经要求不 commit/push。汇报格式：改了什么（文件:行）→ 验证命令与结果 → 遗留与不确定项。

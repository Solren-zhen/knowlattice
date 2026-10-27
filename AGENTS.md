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
| `src/views/railCatalog.tsx` | **导航轨条目与分组的唯一清单**（`RailKey` 必须与 Workspace 的 `openFeature` 一一对应，漏一个编译不过） |
| `src/views/Workspace.tsx` | **各面板开关的唯一出口**（`openFeature` / `railOrder` 高亮优先级 / `paletteCommands`） |
| `src/index.css` | **布局与视觉的唯一出口**（无 CSS Modules、无 Tailwind；改样式只在这里） |
| `src/views/useDockSplit.ts` | 右侧「视频+AI 笔记」那一栏的尺寸状态（宽度 + 视频块高度） |
| `src/views/usePanelDrag.ts` | 其余浮窗的拖动/缩放位置与尺寸 |
| `src/core/qbank.ts` · `src/storage/qbank.ts` | 题库领域逻辑 / IndexedDB 持久化（含 legacy 迁移标记 `legacy-banks-v1`） |
| `src/__tests__/architecture.test.ts` | **架构不变量的可执行版本**（分层方向、console.log、Tauri 依赖），下面第三节就是它的文字版 |
| `vitest.config.ts` · `src/__tests__/setup.ts` | 测试预算：`testTimeout` 与 RTL `asyncUtilTimeout` **必须同步调**（单测预算要大于用例里所有等待之和） |

命令（根目录）：`npm run dev`（vite） / `npm run build`（`tsc -b && vite build` + 产物断言） / `npm run lint`（oxlint） / `npm run test`（vitest run） / `npm run bench` / `npm run pack` / `npm run tauri`。

## 二、本项目的硬约束

1. **UI 改动必须可验证**：改样式/布局/交互后，说明如何看效果（dev 起来看哪个视图/面板），并跑 `npm run lint` + `npm run test`。
2. **不要一次重写大组件**。历史上出现过同一文件（`views/AiAgentPanel.tsx`）被反复改 20+ 次、越改越乱。做法：先读全文 → 列最小改动点 → 一次改一处 → 说明改了什么。
3. `prebuild`/`predev` 会跑脚本复制 pdf worker 与清理 dist；不要绕过它们直接改 `dist/`。
4. 不要手改 `vendor/` 与 `node_modules/`。
5. 依赖版本保持不动，除非用户明确要求升级。
6. 涉及 Tauri 侧改动时，先确认前端与 Rust 两侧的接口契约，再改任一侧。

## 三、布局与层级（硬约束，对应 `src/__tests__/architecture.test.ts`）

1. **分层方向**：`core` 与 `storage` 都不得 import `views`（视图调用它们才是正常方向）；`core` 只允许 `import type` 的 Tauri 依赖；生产代码不得 import 测试、不得留 `console.log`。破坏即测试红。
2. **高度链每层都要 `min-height: 0`**：`.card.c-edit` → `.note-split` → `.editor-wrap` → `.editor-host` → `.cm-scroller`。flex 子项缺这一行，它就会被内容撑成内容高度，滚动容器随之 `scrollHeight == clientHeight`——表现是「滚轮上下都不动」，而内容还被上层 `overflow:hidden` 裁掉。
3. **一个盒子只允许一套尺寸来源**：浮窗自身 resize（内联 width/height）与容器 resize（列宽 + CSS 变量）不能同时管同一个元素；内联样式优先，会把容器顶爆（实测视频块被拖到 908px、超出整栏 288px，之后分隔条一起失效）。右侧功能栏的尺寸只由 `useDockSplit` 管。
4. **z-index 阶梯**（改前先查用途，别插队）：导航轨 30 · AI 面板原 84 · 遮罩/`--z-panel` 86 · **右侧功能栏 89** · toast 93 · 对话框 95 · 快速搜索 100。浮层必须高于遮罩（86），否则在「学习 → 题库练习」这类全屏面板里会被半透明 + blur 压住：看得见、点不到。
5. **改基础规则前先搜同名覆盖**：`@media` 里常另有一套边距/尺寸（例：`.video-note-wrap` 的 8px 窄屏覆盖），只改基础那条不会生效。

## 四、已知陷阱（都真踩过，附判据）

| 现象 | 判据 | 根因 |
|---|---|---|
| 面板里滚轮上下都不动 | 祖先链上 `scrollHeight == clientHeight` | 某层缺 `min-height:0`（三-2） |
| 面板发暗、发糊、点不到 | 面板 `z-index` 低于遮罩 | 层级排序错（三-4） |
| 网格被顶爆、边缘溢出 | `el.getAttribute('style')` 里出现 width/height | 两套尺寸系统（三-3） |
| 单测绿、真浏览器里丢 | jsdom 会执行 `setState` updater，真浏览器对「返回同一引用」会跳过 | 副作用写进 updater；改成「先算 next → 写 ref → 再 setState」 |
| 测试里拖拽/点击无反应 | 合成 `PointerEvent` 的 `pointerId` 不是活动指针 | `setPointerCapture` / `releasePointerCapture` 抛 `NotFoundError`；测试里打桩，且写盘不要放在 release 之后 |

## 五、通用纪律（同 Desktop/AGENTS.md）

不猜接口、不模糊执行、不臆想业务、不造接口、不跳过验证（给真实命令与输出）、不破坏架构、不假装理解、不盲目修改。未经要求不 commit/push。汇报格式：改了什么（文件:行）→ 验证命令与结果 → 遗留与不确定项。

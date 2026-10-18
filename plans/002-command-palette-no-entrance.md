# 002 — Ctrl+K 命令面板不再有入场动画，并清掉三处失效声明

- **Status**: TODO
- **Commit**: 147af4e
- **Severity**: HIGH
- **Category**: §1 Purpose & frequency ＋ §7 Cohesion
- **Estimated scope**: 1 file, 4 处改动（`src/index.css`）

## Problem

### 2a. 命令面板每次都播 420ms 入场

`src/index.css:6460-6462`（现状）：

```css
.panel, .qs-modal, .notice-panel {
  animation: panel-in var(--t-enter) var(--ease-glide);
}
```

配合 `src/index.css:6428` 的 `--t-enter: 420ms;` 与 `src/index.css:6456-6459`：

```css
@keyframes panel-in {
  from { opacity: 0; transform: translateY(14px) scale(0.972); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
```

`.qs-modal` 就是 Ctrl+K 快速搜索面板（`src/views/QuickSearch.tsx`，从 `src/views/Rail.tsx` 触发），它是一个 100+/天的键盘开关。它每次打开都上浮 14px 并缩放。命令面板的通行做法是**不动画**（Raycast 就是没有），因为用户按 Ctrl+K 时已经知道自己要什么，动画只是在延迟输入。

### 2b. 三条被覆盖的入场声明是死代码

同一批元素上各有一条更早的 `animation` 声明，与 6460 的选择器**权重相同**（都是 0,1,0），后写的赢，所以这三条永远不生效：

- `src/index.css:1260` — `.qs-modal { animation: pop-in var(--t-med) var(--ease-back); }`
- `src/index.css:4390` — `.notice-panel { animation: modal-in var(--t-slow) var(--ease-back); }`
- `src/index.css:5097` — `.panel { animation: pop-in var(--t-slow) var(--ease-back); }`

实际生效的一直是 420ms 的 `panel-in`，而不是这三处想要的 260ms `--ease-back`。留着它们会让人以为面板是 260ms 入场的。

## Target

把 `.qs-modal` 从组规则里排除（它不再有任何入场动画），`.panel` 与 `.notice-panel` 保持现状，并删掉三条死声明。

> **执行后更正（实测发现）**：`.qs-modal` 的元素是 `class="panel qs-modal"`（`src/views/QuickSearch.tsx:162`），
> **同时匹配 `.panel`**。所以只从选择器列表里摘掉 `.qs-modal` 是无效的 —— `.panel` 仍然命中它，动画照播。
> 必须用 `:not(.qs-modal)` 从 `.panel` 一侧排除。下面的 target 已按此更正。
> （`.notice-panel` 是独立的 class，见 `src/views/SafetyNotice.tsx:36`，不带 `.panel`，无需特殊处理。）

```css
/* target — 替换 src/index.css:6460-6462 */
/* Ctrl+K 命令面板是 100+/天的键盘开关：按 §1 不加入场动画（Raycast 同款做法）。
   它必须用 :not(.qs-modal) 排除 —— 该元素同时带 .panel 类。
   .panel / .notice-panel 属于「偶发」层级，保留 panel-in。 */
.panel:not(.qs-modal), .notice-panel {
  animation: panel-in var(--t-enter) var(--ease-glide);
}
```

同时删除 `src/index.css:1260`、`src/index.css:4390`、`src/index.css:5097` 这三行 `animation` 声明（只删 `animation` 那一行，各自规则块里的其他属性一律保留）。

**结果**：`.panel` 与 `.notice-panel` 的入场行为与改动前**完全一致**（仍是 420ms `panel-in`）；只有 `.qs-modal` 从"420ms 上浮缩放"变成"立即出现"。

## Repo conventions to follow

- 这个仓库已经有"某类元素不动画"的写法：`src/index.css:6464` 的 `.morphing .panel, .morphing .notice-panel { animation: none; }`，以及 `src/index.css:6504` 的 reduced-motion 关闭块。用同样的显式 `animation: none` 或直接不给规则，都符合本仓库习惯。
- 遮罩淡入保持不动：`src/index.css:1248` 的 `animation: fade-in var(--t-fast) var(--ease);` 只有 130ms，属于"偶发"层级，是对的，**不要动**。
- 不要在计划里发明新曲线：本次不新增任何缓动或时长令牌。

## Steps

1. 删除 `src/index.css:1260` 的整行 `.qs-modal { animation: pop-in var(--t-med) var(--ease-back); }`。
2. 删除 `src/index.css:4390` 的整行 `.notice-panel { animation: modal-in var(--t-slow) var(--ease-back); }`。
3. 删除 `src/index.css:5097` 的整行 `.panel { animation: pop-in var(--t-slow) var(--ease-back); }`。
4. 把 `src/index.css:6460` 的选择器 `.panel, .qs-modal, .notice-panel` 改为 `.panel, .notice-panel`，并按上面的 target 补一句说明注释。
5. 确认 `src/index.css:6504` 的 reduced-motion 块里 `.panel, .qs-modal, .notice-panel { animation: none; }` **保留原样**（`.qs-modal` 留在那里无害）。

## Boundaries

- 不要改 `--t-enter: 420ms`：它还被 `src/index.css:6561` 的 `radar-in` 使用，删了会破坏雷达图入场。
- 不要改 `@keyframes pop-in` / `modal-in` / `panel-in` 的定义 —— 它们仍被别处使用（`pop-in` 用于 `src/index.css:1374/2005/2842`，`modal-in` 用于 `src/index.css:4378` 的定义）。
- 不要动 `.qs-modal.panel`（`src/index.css:5138`）、`.morphing .qs-modal`（`6248`）、`.sheet .qs-modal`（`6311`）这三条布局/形态规则。
- 不要动 `QuickSearch.tsx` 的任何代码 —— 本次只是移除入场动画，不改组件。
- 删行前先确认行号内容与上文引用一致；不一致就**停下来报告**。

## Verification

- **Mechanical**: 根目录跑 `npm run lint` 与 `npm run test`。
- **Feel check**: `npm run dev`，然后：
  - 按 `Ctrl+K`：面板应当**立即出现**，不再有上浮与缩放。连按几次开/关，确认没有延迟感。
  - 打开「学习统计」（左栏「学习」组）：它走 `.panel`，应当**仍有**上浮入场，且手感与改动前一致 —— 这是本次最重要的回归检查。
  - 触发一次会弹通知面板的操作（`.notice-panel`，例如导入/导出反馈），确认入场仍在。
  - 在 DevTools 里检查 `.qs-modal` 元素的计算样式，`animation-name` 应为 `none`。
- **Done when**: Ctrl+K 无入场动画，`.panel` 与 `.notice-panel` 入场与改动前不可区分，文件里不再有指向 `.qs-modal` / `.panel` / `.notice-panel` 的失效 `animation` 声明。

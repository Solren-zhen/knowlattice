# 009 — 答题翻页不再瞬移

- **Status**: TODO
- **Commit**: 147af4e
- **Severity**: HIGH
- **Category**: §8 Missed opportunities（状态变化瞬移）
- **Estimated scope**: 1 个 tsx 改 1 行 ＋ 1 个 css 新增 1 条规则

## Problem

答题时切换上一题/下一题，题干、选项、解析在**同一帧内整体换掉**，没有任何过渡。

`src/views/QuizView.tsx:552`（现状）：

```tsx
          <div className="panel__body quiz-body">
```

推进索引的地方：
- `src/views/QuizView.tsx:381` — `setIdx((i) => i + 1);`（作答后自动进入下一题）
- `src/views/QuizView.tsx:504` — `← 上一题` 按钮：`onClick={() => setIdx((i) => Math.max(0, i - 1))}`
- `src/views/QuizView.tsx:508` — `下一题 →` 按钮：`onClick={() => setIdx((i) => i + 1)}`

`.quiz-body` 与 `.quiz-stem` 在 `src/index.css` 里**只有布局规则，没有任何 animation 或 transition**（相关规则在 `src/index.css:2863`、`2873` 一带）。

为什么重要：这是学习闭环里**重复次数最多**的动作 —— 一晚上可能按几百次「下一题」。整块内容无提示地瞬移，用户会有一瞬间分不清"是换题了还是页面闪了"。这类"防止突兀变化"正是动效该做的事，也正是这个仓库自己声明的用途（`src/index.css:3`："动效只传达状态"）。

## Target

给内容区一个极短的上浮淡入，让"换了一题"这件事被看见，但不拖慢节奏。

`src/views/QuizView.tsx:552`：

```tsx
/* target */
          <div className="panel__body quiz-body" key={idx}>
```

`src/index.css` 新增（放在 `src/index.css:2863` 一带 `.quiz-body` 布局规则之后）：

```css
/* target — 新增 */
/* 换题：极短上浮淡入，让「内容变了」被看见。用 key={idx} 触发重挂载，
   所以这里必须是 animation 而不是 transition（transition 不会重播）。 */
.quiz-body {
  animation: quiz-step-in var(--t-fast) var(--ease-out);
}
@keyframes quiz-step-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
```

要点：
- 用 `var(--t-fast)`（130ms）与 `var(--ease-out)`，都是既有令牌，不新增曲线/时长。
- 位移只有 `4px`（远小于半个行高），只动 `opacity` 与 `transform`（合成层属性）。
- 这里是 `animation` 而非 `transition`：`key={idx}` 会重挂载节点，重挂载后 transition 不会播，animation 会。

## Repo conventions to follow

- 极短上浮入场的既有范例：`src/index.css:1404-1410` 的 `rise-in`（`translateY(6px)` 配 `--t-slow`），以及 `src/index.css:6443-6453` 的视口显现（`translateY(12px) scale(0.99)`）。本次取比它们更短、更小的值，因为这是高频动作。
- 用 `key` 触发重挂载的做法在本仓库已有先例可循（列表项普遍带 `key`）。
- 动画只动 `opacity` / `transform`，与 `src/index.css:105-111` 的 `--tr-interact` 取向一致。

## Steps

1. 在 `src/views/QuizView.tsx:552` 的 `<div className="panel__body quiz-body">` 上添加 `key={idx}`。
2. 在 `src/index.css` 的 `.quiz-body` 布局规则之后新增 `@keyframes quiz-step-in` 与 `.quiz-body` 的 animation 规则。
3. 确认 `.quiz-body` 没有别的 `animation` 声明会被覆盖（搜索 `quiz-body`）。

## Boundaries

- **不要**给 `.quiz-stem` / `.quiz-opts` / `.quiz-explain` 分别加动画 —— 整块一起动一次就够，分层动会让换题读起来很吵。
- **不要**改作答反馈的动画：`mark-pop`（`src/index.css:1956-1961`，计划 001 会改）与 `shake`（`1955`）**不要动**。`key={idx}` 会让它们随重挂载重播 —— 这是预期行为（新题本来就要重新落位）。
- **不要**改 `idx` 的推进逻辑（`QuizView.tsx:381/504/508`）。
- **不要**动 `.quiz-progress`（计划 006 会处理它的流光）。
- **不要**引入新令牌或新依赖。
- 若 `QuizView.tsx:552` 的结构与引用不一致，或 `.quiz-body` 上有既有 animation，**停下来报告**。

## Verification

- **Mechanical**: 根目录跑 `npm run lint` 与 `npm run test`。注意 `src/views/__tests__/` 下有 DOM 测试，确认没有因重挂载而失败。
- **Feel check**: `npm run dev`，进「题库练习」，然后：
  - 连续按「下一题 →」五六次：每次内容应**轻微上浮淡入**，不应瞬移；节奏不应被拖慢（130ms 应该几乎无感）。
  - 按「← 上一题」：同样有过渡。
  - 作答后自动进入下一题（`QuizView.tsx:381` 的路径）：确认过渡也在，且 ✓/✗ 标记的落位没有被吃掉。
  - **键盘路径重点查**：用 `空格` 揭示答案、`A/S/D/F` 评分（`ReviewView` 同族的键盘操作），确认换题后键盘仍可用、焦点没有丢到 `body` 上。
  - 多选题里连点选项，确认不会因为重挂载而丢掉已选状态。
  - 打开 reduced-motion 模拟：换题应变成瞬时（全局兜底会压平 animation-duration，这是既有行为）。
- **Done when**: 换题有可感知但不拖沓的过渡，且键盘操作、选项状态、答题反馈三者都没有回归。

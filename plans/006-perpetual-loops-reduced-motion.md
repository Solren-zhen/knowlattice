# 006 — 常驻无限动画补上 reduced-motion 开关

- **Status**: TODO
- **Commit**: 147af4e
- **Severity**: HIGH
- **Category**: §6 Accessibility ＋ §5 Performance
- **Estimated scope**: 1 file, 1 个新媒体查询块（`src/index.css`）

## Problem

四处 `infinite` 循环动画**不在任何 reduced-motion 块里**。全文件共有 11 个 `prefers-reduced-motion` 块（行 190、1840、1928、4118、5604、5987、6318、6502、6588、6677、6748），这四处一个都没被覆盖。

1. **编辑器"未保存"圆点** —— `src/index.css:614-623`：
```css
.dirty-dot {
  display: inline-block;
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
  margin-left: 6px;
  animation: pulse 2s var(--ease-in-out) infinite;
}
@keyframes pulse { 50% { opacity: 0.35; transform: scale(0.85); } }
```
只要笔记未保存，它就在编辑器工具栏里一直脉动 —— 也就是**整个写作过程**。而且它同时动 `opacity` 和 `transform`（scale 0.85）。

2. **答题进度条流光** —— `src/index.css:4429-4434`：
```css
.quiz-progress { height: 4px; }
.quiz-progress i {
  background: linear-gradient(90deg, var(--accent), #a5b4fc, var(--accent));
  background-size: 200% 100%;
  animation: progress-shimmer 2.2s linear infinite;
}
@keyframes progress-shimmer { 0% { background-position: 0% 0; } 100% { background-position: 200% 0; } }
```
整个答题过程常驻，而进度条的**宽度**本身已经表达了进度。

3. **载入骨架扫光**（两处）—— `src/index.css:5403` 与 `5423`：`.loading::after` 与 `.loading-inline__bar` 都用 `animation: mv-sheen 1.15s linear infinite;`。

4. **AI 流式光标** —— `src/index.css:3846`：`.agent-msg.streaming::after { … animation: agent-caret 1s steps(2) infinite; }`。

**注意**：全局兜底块（`src/index.css:190-195`）只压 `animation-duration`，**压不住 `animation-iteration-count: infinite`**，所以循环会继续跑，只是每一圈被压到 0.01ms —— 是否真的还在消耗合成器时间取决于 WebView2 的实现，无法从代码判断。可以确定的是：仓库**主动**关掉了 `ring-spin`、`glow-breathe`（`5990-5991`）、`update-notice-sweep`（`6750`）、`agent-coach-pulse`、`agent-typing`（`4119`），唯独漏了这四处。

## Target

新增一个 reduced-motion 块，放在 `src/index.css:5987-5993` 那个块**之后**（贴近它处理的同类元素，便于将来一起维护）：

```css
/* target — 新增 */
/* 常驻循环动画的降级：这些是装饰性重复，reduced-motion 下应停下。
   全局兜底只压 animation-duration，压不住 infinite 的迭代次数，所以必须显式关。
   保留的：agent-caret（见下）—— 它表达「仍在流式输出」，属于状态而非装饰。 */
@media (prefers-reduced-motion: reduce) {
  .dirty-dot { animation: none; }
  .quiz-progress i { animation: none; }
  .loading::after,
  .loading-inline__bar { animation: none; }
}
html.no-motion .dirty-dot,
html.no-motion .quiz-progress i,
html.no-motion .loading::after,
html.no-motion .loading-inline__bar { animation: none; }
```

**明确保留** `agent-caret`（`src/index.css:3846`）：它是一个 1 字符宽的插入符闪烁，用来表达"AI 还在输出"。按规则"reduced-motion 是减少而非归零，保留有助于理解的过渡"，这条留着。若你要一并关掉，需在计划外说明理由。

## Repo conventions to follow

- 同区块的既有写法就是范例 —— `src/index.css:5987-5993`：
```css
@media (prefers-reduced-motion: reduce) {
  .stagger-item { animation: none; }
  .press-released { animation: none; }
  .dash-card[data-tilt-active]::before,
  [data-tilt-active] .card-glow { animation: none; }
  [data-tilt-active] { transform: none; }
}
```
- 这个仓库**同时**维护 `@media (prefers-reduced-motion: reduce)` 与 `html.no-motion` 两条路径（见 `src/index.css:6502-6515`、`6677`、`6748`），新增块必须两条都写。
- 保留状态类反馈的原则写在 `src/index.css:5985` 的注释里："按下态保留（它传达的是状态，不是装饰）"。

## Steps

1. 在 `src/index.css:5993`（那个 reduced-motion 块的收尾大括号）之后插入上面的 `@media` 块。
2. 紧接着插入 `html.no-motion` 版本。
3. 确认没有与既有块重复声明同一选择器 —— 新增的四个选择器（`.dirty-dot`、`.quiz-progress i`、`.loading::after`、`.loading-inline__bar`）都不在现有 11 个块里。

## Boundaries

- **不要**改全局兜底块 `src/index.css:190-195` —— 那是计划 007 的范围，两个计划会冲突。先做 006 再做 007，或反之，不要同时改。
- 不要动 `agent-caret`（`3846`）。
- 不要动这四处的**静止观感**：只加降级开关，不改正常态下的动画参数。
- 不要动已有的 11 个 reduced-motion 块的内容。
- 不要动任何 `.tsx` —— 这四处全部由 CSS 驱动。

## Verification

- **Mechanical**: 根目录跑 `npm run lint` 与 `npm run test`。
- **Feel check**: `npm run dev`，然后：
  - 打开任一笔记，改一个字让"未保存"圆点出现。在 DevTools 的 **Rendering 面板**把 `prefers-reduced-motion` 设为 `reduce`：圆点应当**停止脉动**，但仍**可见**（它表达未保存状态）。
  - 进「题库练习」答一题，让进度条出现。同样开 reduced-motion：流光应停止，进度条仍显示宽度。
  - 触发一次载入态（例如导入一个大文件），开 reduced-motion 确认骨架条不再扫光但仍可见。
  - 关掉 reduced-motion，确认四处动画都恢复正常。
  - 另开一次验证 `html.no-motion` 路径：在 DevTools 控制台执行 `document.documentElement.classList.add('no-motion')`，重复上述检查。
- **Done when**: 两个降级路径下四处循环都停止，且对应的静态视觉信息（圆点、进度宽度、骨架条）全部保留。

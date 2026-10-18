# 004 — 导航轨 hover 从三个动效收敛到一个

- **Status**: TODO
- **Commit**: 147af4e
- **Severity**: HIGH
- **Category**: §1 Purpose & frequency ＋ §7 Cohesion
- **Estimated scope**: 1 file, 3 处改动（`src/index.css`）

## Problem

鼠标扫过导航轨时，同一个按钮上**同时**跑三个动效：按钮整体上浮放大、图标上抬放大、标签侧移。

`src/index.css:4647-4651`（现状）：
```css
.rail-btn:hover {
  background: var(--panel-deep); color: var(--text);
  box-shadow: var(--shadow-xs);
  transform: translateY(-1px) scale(1.02);
}
```

`src/index.css:6488-6497`（现状）：
```css
/* 带图标的按钮：hover 时图标轻微上抬放大，给出「可点」的动能 */
.btn > svg, .btn-small > svg, .btn-icon > svg { transition: transform var(--t-fast) var(--ease-spring); }
.btn:hover > svg, .btn-small:hover > svg { transform: translateY(-1px) scale(1.08); }

/* ---- 6. 导航轨 hover 物理：图标上抬放大 + 标签侧移 ---- */
.rail-btn svg { transition: transform var(--t-fast) var(--ease-spring); }
.rail-btn:hover svg { transform: translateY(-1px) scale(1.1); }
.rail--expanded .rail-label {
  transition: transform var(--t-fast) var(--ease-glide), color var(--t-fast) var(--ease);
}
.rail--expanded .rail-btn:hover .rail-label { transform: translateX(2px); }
```

为什么重要：导航轨在频率表里属于"每天数十次"的层级，规则是**删掉或大幅削减**；而这里三个动作同时发生，其中图标还用了一条过冲 1.4 的回弹曲线（`--ease-spring: cubic-bezier(0.34, 1.4, 0.5, 1)`，定义在 `src/index.css:6427`）。在其余部分都克制、静止时"一律不产生 transform"（见 `src/index.css:6417` 的自述）的应用里，这是全仓库**唯一** scale-on-hover 的地方，读起来是"活泼"而不是这个产品要的"利落"。

顺带一个内部矛盾：`--ease-spring` 的注释自称"一点点回弹"，而 `--ease-back` 的注释把过冲上限写成"刻意小到几乎读不出来"（`src/index.css:98-99`）。两条曲线过冲量差约 10 倍，实际落在最显眼位置的是大的那条。

## Target

hover 只保留**状态指示**（底色、文字色、阴影），移除全部位移：

```css
/* target — 替换 src/index.css:4647-4651 */
.rail-btn:hover {
  background: var(--panel-deep); color: var(--text);
  box-shadow: var(--shadow-xs);
}
```

```css
/* target — 替换 src/index.css:6492-6497（整段删除，含注释标题） */
```

即：删掉 `.rail-btn svg { transition: transform … }`、`.rail-btn:hover svg { transform: … }`、以及 `.rail--expanded .rail-btn:hover .rail-label { transform: translateX(2px); }` 三处位移规则。

`.rail--expanded .rail-label` 那条 `transition` 规则（`6494-6496`）要**保留 `color` 部分**，只去掉 `transform`：

```css
/* target */
.rail--expanded .rail-label {
  transition: color var(--t-fast) var(--ease);
}
```

## Repo conventions to follow

- 这个仓库里"hover 只改颜色"的正确范例到处都是，例如 `src/index.css:2053`、`3859`，以及 `.rail-home:hover { color: var(--accent); background: var(--accent-soft); }`（`src/index.css:4574`）。
- 状态指示类 hover 用 `--tr-interact`（`src/index.css:108-111`）已经覆盖颜色/背景/描边/阴影，`.rail-btn` 的过渡属性不用改。
- 按下态**不动**：`.rail-btn:active`（`src/index.css:4652-4656`）是传达状态的，保留。

## Steps

1. 删除 `src/index.css:4650` 的 `transform: translateY(-1px) scale(1.02);` 一行（保留同一规则块里的 background / color / box-shadow）。
2. 删除 `src/index.css:6492` 与 `6493` 两行（`.rail-btn svg` 与 `.rail-btn:hover svg`）。
3. 删除 `src/index.css:6497` 的 `.rail--expanded .rail-btn:hover .rail-label { transform: translateX(2px); }` 整行。
4. 把 `src/index.css:6494-6496` 的 `.rail--expanded .rail-label` 过渡改为只保留 color。
5. 删除 `src/index.css:6491` 的区块注释标题 `/* ---- 6. 导航轨 hover 物理：图标上抬放大 + 标签侧移 ---- */`，或改写成"hover 只保留状态指示"。

## Boundaries

- **不要**动 `.rail-btn` 的基础 `transition`（在 `src/index.css:521-530` 一带）与 `.rail-btn:active`。
- **不要**动 `.btn > svg` / `.btn-small > svg` / `.btn-icon > svg`（`src/index.css:6488-6489`）—— 那是普通按钮的图标动能，本次只处理导航轨。若你想一并处理，另开计划。
- **不要**动 `--ease-spring` 令牌本身（`src/index.css:6427`）—— 它还被 `src/index.css:6561` 的 `radar-in`、`6584` 的 toast 落位等 10 处使用。
- **不要**动 `.rail-btn--graph:hover`（`4661-4667`）的颜色规则。
- 不要改 `Rail.tsx`。

## Verification

- **Mechanical**: 根目录跑 `npm run lint` 与 `npm run test`。
- **Feel check**: `npm run dev`，然后：
  - 鼠标从上到下扫过整条导航轨：按钮**只应改变底色/文字色/阴影**，不应有任何位移或缩放。
  - 展开导航轨（点左上角折叠按钮），再扫一遍，确认标签不再侧移。
  - 在 DevTools 的 Animations 面板把速度调到 10%，确认 hover 期间没有 transform 参与过渡。
  - 回归检查：按住导航按钮，按下态仍应有 93% 缩放与内阴影（本次没动它）。
  - 在 DevTools 里对 `.rail-btn` 计算样式确认：hover 时 `transform` 为 `none`。
- **Done when**: 导航轨 hover 期间 `transform` 恒为 `none`，且按钮仍能明确读出 hover 状态。

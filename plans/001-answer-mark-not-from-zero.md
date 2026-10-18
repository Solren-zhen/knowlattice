# 001 — 答案标记不再从零面积长出

- **Status**: TODO
- **Commit**: 147af4e
- **Severity**: HIGH
- **Category**: §3 Physicality & origin
- **Estimated scope**: 1 file, 1 keyframe（`src/index.css`）

## Problem

答题后出现的 ✓ / ✗ 标记，从 `scale(0)` 开始播放 —— 一个完全不透明的对勾从一个零面积的点胀出来。

`src/index.css:1956-1961`（现状）：

```css
@keyframes mark-pop {
  from { transform: scale(0); }
  78% { transform: scale(1.14); } /* 过冲写进关键帧（一次性、幅度受控） */
  to { transform: scale(1); }
}
.opt-mark { display: inline-block; animation: mark-pop 320ms var(--ease); }
```

关键帧里**没有 `opacity`**，所以标记从第一帧起就是全不透明的。

这不是"看不见所以不算"——标记是条件挂载的，每次答题都会新建一个节点，动画必然从第 0 帧完整播放：

- `src/views/QuizView.tsx:490` — `{right.includes(i) && <span className="opt-mark">✓</span>}`
- `src/views/QuizView.tsx:637-638` — `{answered && right && <span className="opt-mark">✓</span>}` / `{answered && chosen && !right && <span className="opt-mark">✗</span>}`

为什么重要：这是全应用**频率最高**的动效（每答一题、多选模式下每点一个选项都可能触发），而 `scale(0)` 是全文件唯一一处真正到达零面积的缩放。现实里没有东西是从"无"里长出来的，读者会读成"闪了一下"而不是"落位"。

## Target

起点抬到 `scale(0.9)`，并补上 `opacity: 0`，让标记是**淡入 + 落位**而不是从零胀出：

```css
/* target */
@keyframes mark-pop {
  from { opacity: 0; transform: scale(0.9); }
  78% { transform: scale(1.14); }
  to { opacity: 1; transform: scale(1); }
}
.opt-mark { display: inline-block; animation: mark-pop 320ms var(--ease); }
```

**不要改的**：`78%` 的 `scale(1.14)` 过冲有注释论证过（"一次性、幅度受控"），保留；`320ms` 与 `var(--ease)` 也不动 —— 本次只修起点，不做时长重估。

## Repo conventions to follow

- 起点缩放 + 透明度淡入，仓库已有合规范例：`src/index.css:6456-6459` 的 `panel-in` 用 `scale(0.972)` 配 `opacity: 0`，同样是一次性入场。
- 一次性确认类动效的过冲写法：`src/index.css:5920-5925` 的 `press-rebound`。
- 缓动一律用令牌（`--ease` / `--ease-out` / `--ease-in` / `--ease-in-out` / `--ease-back`，定义在 `src/index.css:100-104`），不要手打 cubic-bezier。

## Steps

1. 打开 `src/index.css`，定位第 1956 行的 `@keyframes mark-pop`。
2. 把 `from { transform: scale(0); }` 改为 `from { opacity: 0; transform: scale(0.9); }`。
3. 把 `to { transform: scale(1); }` 改为 `to { opacity: 1; transform: scale(1); }`。
4. 其余行（`78%` 那行、`.opt-mark` 规则、注释）一字不动。

## Boundaries

- 只改 `mark-pop` 这一个关键帧。不要动 `.opt-mark` 的选择器、时长、缓动。
- 不要动同一区块的 `@keyframes shake` 与 `.opt.wrong`（`src/index.css:1950-1955`）—— `linear` 抖动有注释论证过。
- 不要动 `QuizView.tsx`：标记的挂载条件是对的，问题在关键帧。
- 不要引入新依赖，不要顺手改别的 keyframes。
- 如果 `src/index.css:1956-1961` 的内容与上面的引用不一致（commit 之后有漂移），**停下来报告**，不要自行发挥。

## Verification

- **Mechanical**: 在仓库根目录跑 `npm run lint` 与 `npm run test`，两者都应通过且无新增告警。
- **Feel check**: `npm run dev`（已钉死 5173 端口），进「题库练习」，答一题，盯住正确答案旁的 ✓：
  - 它应该是**淡入着落位**，而不是"啪"地从一个点胀开；
  - 在 DevTools 的 Animations 面板把播放速度调到 10%，确认第 0 帧上标记是**透明且 90% 大小**，不是零面积。
  - 多选题里连点两个选项，确认每个 ✓ 都独立淡入，不互相打断。
  - 在 Rendering 面板打开 `prefers-reduced-motion: reduce`，确认标记直接出现（全局兜底会把 `animation-duration` 压到 0.01ms，这是既有行为，本次不改）。
- **Done when**: 第 0 帧不再有零面积元素，且 ✓/✗ 的落位手感与改动前一致。

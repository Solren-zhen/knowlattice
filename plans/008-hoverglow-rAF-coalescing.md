# 008 — hoverGlow 用 rAF 合并指针写入

- **Status**: TODO
- **Commit**: 147af4e
- **Severity**: HIGH
- **Category**: §5 Performance
- **Estimated scope**: 1 file, 约 15 行（`src/core/hoverGlow.ts`）

## Problem

列表行的指针跟随流光，在**每一条**原始 `pointermove` 事件上同步写两个自定义属性，没有任何帧合并。

`src/core/hoverGlow.ts:85-88`（现状）：

```ts
    const p = glowPoint(rect, e.clientX, e.clientY);
    next.style.setProperty('--glow-x', `${p.x.toFixed(1)}px`);
    next.style.setProperty('--glow-y', `${p.y.toFixed(1)}px`);
  }
```

监听是直接挂在 `document` 上的（`src/core/hoverGlow.ts:97`）：

```ts
  document.addEventListener('pointermove', onMove, { passive: true });
```

两个变量被 `background-image: var(--glow-paint)` 消费（`src/index.css:6624-6628` 一带的 `radial-gradient`），所以每次写入都会让该行的样式失效并重绘渐变。

为什么重要：高刷新率鼠标每秒可产生 125+ 个 `pointermove` 事件，而一帧只显示一次。**同一个仓库里的其他动效模块都做了 rAF 门控** —— `cardTilt.ts`、`motionChoreography.ts`、`navIndicator.ts` 都把写入放在 `requestAnimationFrame` 回调里；只有这里漏了。所以这是不一致的疏漏，不是刻意的取舍。

**诚实的限度**：我无法从代码判断这个渐变重绘的实际开销有多大。这里报告的是规则违例与仓库内部不一致，不是实测掉帧。

## Target

把每帧多次写入合并成每帧一次。保持所有既有行为不变（谁被点亮、什么时候熄灭、`drop()` 的清理语义）。

```ts
/* target — 在模块作用域内、onMove 之前新增 */
  // 每帧最多写一次：pointermove 的频率高于刷新率，逐事件写入会让渐变重绘多次
  let glowFrame = 0;
  let pendingGlow: { el: HTMLElement; x: number; y: number } | null = null;

  function flushGlow() {
    glowFrame = 0;
    if (!pendingGlow) return;
    const { el, x, y } = pendingGlow;
    pendingGlow = null;
    el.style.setProperty('--glow-x', `${x.toFixed(1)}px`);
    el.style.setProperty('--glow-y', `${y.toFixed(1)}px`);
  }
```

`onMove` 里把两行写入替换为：

```ts
/* target — 替换 src/core/hoverGlow.ts:86-87 */
    pendingGlow = { el: next, x: p.x, y: p.y };
    if (!glowFrame) glowFrame = requestAnimationFrame(flushGlow);
```

并在 `drop()` 里取消挂起的帧（避免元素已熄灭却还被写一次）：

```ts
/* target — drop() 开头 */
    if (glowFrame) { cancelAnimationFrame(glowFrame); glowFrame = 0; }
    pendingGlow = null;
```

## Repo conventions to follow

- rAF 合并的既有范例就在隔壁模块：`src/core/cardTilt.ts` 与 `src/core/navIndicator.ts`。执行前**先读一遍 `src/core/cardTilt.ts` 的 rAF 结构**并模仿它的命名与清理方式，而不是自创风格。
- 同一个文件里已经有 rAF 合并的先例可参照思路：`src/core/selectionGlide.ts:92-96` 的 `schedule()`：

```ts
    /** 合并触发的重测（一次批处理里可能改多处 class） */
    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(place);
    }
```

- 动效门控走 `motionAllowed()` / `subscribeMotionAllowed()`（本文件 `src/core/hoverGlow.ts:103` 已在用），**不要**改这套机制。
- 本仓库的动效参数与纯逻辑集中放 `src/core/*.ts` 并且**带单测**（见 `src/core/motion.ts` 的文件头注释：为什么自己写而不用动画库）。若本次改动引入了可测的纯逻辑，考虑补测试；纯 rAF 调度不必。

## Steps

1. 完整读一遍 `src/core/hoverGlow.ts`（约 117 行）。
2. 在 `onMove` 之前加入 `glowFrame` / `pendingGlow` / `flushGlow` 三样（按上面的 target）。
3. 把 `src/core/hoverGlow.ts:86-87` 的两行 `setProperty` 替换为入队 + 调度。
4. 在 `drop()` 开头加入取消挂起帧与清空 pending 的两行。
5. 检查 `onOut`（`src/core/hoverGlow.ts:90-95`）与 `window` 上的 `blur` / `scroll` / `resize` 监听（`100-102`）是否都经由 `drop()` —— 若是，第 4 步已覆盖全部清理路径；若有旁路，一并补上。

## Boundaries

- **只改写入调度，不改任何视觉参数**：`glowPoint()`、`--glow-paint` 的渐变定义、`--glow-x/y` 的单位与精度（`.toFixed(1)`）全部不动。
- 不要改 `hasFinePointer()` / `motionAllowed()` / `subscribeMotionAllowed()` 的门控逻辑。
- 不要动 `src/index.css` 里 `.glow-*` 相关的样式。
- 不要顺手把 `pointermove` 改成 `pointerrawupdate` 或加节流时间常数 —— 本次只做帧合并。
- 不要动 `cardTilt.ts` / `navIndicator.ts` / `motionChoreography.ts`。
- 如果 `hoverGlow.ts` 的实际结构与上面引用的行号/函数名不一致（commit 之后有漂移），**停下来报告**。

## Verification

- **Mechanical**: 根目录跑 `npm run lint` 与 `npm run test`。仓库已有 `src/core/__tests__/motionWiring.dom.test.ts` 覆盖动效接线，确认全绿。
- **Feel check**: `npm run dev`，然后：
  - 打开一个带流光的列表（Ctrl+K 搜索结果，或「待办清单」左侧分组），鼠标**快速来回扫**：流光应**跟手**，不应出现卡顿、掉帧或滞后于指针。
  - 在 DevTools 的 Performance 面板录 3 秒快速扫动，确认主线程上没有每帧多次的样式重算尖峰（对比改动前的录制）。
  - 鼠标移出列表：流光应立即熄灭，**不应**在移出后还残留一次位置跳变（这是第 4 步取消挂起帧要防的情况）。
  - 快速在多个行之间移动：任意时刻**只有一行**亮着。
  - 打开 reduced-motion 模拟：流光应完全不出现（既有门控，本次没改）。
- **Done when**: 每帧最多一次属性写入，且流光的跟手程度与熄灭行为与改动前不可区分。

# 012 — 滑动墨迹改走合成层（不再过渡 width/height）

- **Status**: TODO
- **Commit**: 147af4e
- **Severity**: HIGH
- **Category**: §5 Performance（过渡布局属性）
- **Estimated scope**: 1 个 ts（约 12 行）＋ 1 条 css 规则
- **Confidence**: MEDIUM —— 见 Boundaries 里的形变风险，需要实测确认

## Problem

Ctrl+K 搜索结果与待办清单分组用的"滑动墨迹"，过渡的是 **`width` 和 `height`** —— 两个布局属性。

`src/index.css:6651-6662`（现状）：

```css
.glide-ink {
  position: absolute; left: 0; top: 0; z-index: 0;
  border-radius: 12px;
  background: var(--accent-soft);
  border: 1px solid var(--border-accent);
  box-shadow: 0 2px 10px var(--accent-soft);
  opacity: 0; pointer-events: none;
  will-change: transform;
  transition:
    transform var(--t-med) var(--ease-spring),
    width var(--t-med) var(--ease-spring),
    height var(--t-med) var(--ease-spring),
    opacity var(--t-fast) var(--ease);
}
```

写入方是 `src/core/selectionGlide.ts:86-88`（现状）：

```ts
      ink.style.transform = `translate(${box.left.toFixed(2)}px, ${box.top.toFixed(2)}px)`;
      ink.style.width = `${box.width.toFixed(2)}px`;
      ink.style.height = `${box.height.toFixed(2)}px`;
```

`place()` 由 `MutationObserver` 经 `schedule()` 触发（`selectionGlide.ts:92-108`），而 `.active` 的切换由方向键驱动（`QuickSearch.tsx` 的 ArrowUp/ArrowDown）。也就是说：**每按一次方向键，就有一帧布局 + 绘制 + 合成**，而这个列表是键盘导航路径（每天数十次）。

`selectionGlide.ts:83` 已经为"首次落位"做过一次 `transition: none` 的一帧绕过，说明作者知道这个元素上有过渡。

## Target

位置与尺寸都走 `transform`，过渡列表里去掉 `width` / `height`。

`src/core/selectionGlide.ts` — 记录基准尺寸，之后用 `scale` 表达尺寸变化：

```ts
/* target — 在 place() 之前的模块作用域内新增 */
    let baseW = 0;
    let baseH = 0;
```

```ts
/* target — 替换 src/core/selectionGlide.ts:86-88 */
      if (!baseW || !baseH) {
        // 基准尺寸只定一次：墨迹自己的宽高此后不再变，尺寸变化交给 scale 表达
        baseW = Math.max(1, box.width);
        baseH = Math.max(1, box.height);
        ink.style.width = `${baseW.toFixed(2)}px`;
        ink.style.height = `${baseH.toFixed(2)}px`;
      }
      const sx = (box.width / baseW).toFixed(4);
      const sy = (box.height / baseH).toFixed(4);
      ink.style.transform =
        `translate(${box.left.toFixed(2)}px, ${box.top.toFixed(2)}px) scale(${sx}, ${sy})`;
```

`src/index.css:6659-6663` — 过渡只留 `transform` 与 `opacity`：

```css
/* target */
  transition:
    transform var(--t-med) var(--ease-spring),
    opacity var(--t-fast) var(--ease);
```

要点：
- `transform-origin` 必须保持左上角，否则 `scale` 会从中心放大导致位移错位。`.glide-ink` 是 `position: absolute; left: 0; top: 0`，`transform-origin` 默认是 `50% 50%` —— **必须显式写 `transform-origin: 0 0;`**，否则墨迹会跑偏。
- `translate` 在前、`scale` 在后：先位移到目标位置，再以自身左上角为原点缩放。顺序不能颠倒。

## Repo conventions to follow

- `transform-origin` 的既有写法：`src/index.css:6546-6548`（`.dash-bar { transform-origin: bottom center; }` 等）—— 本仓库只在需要时显式声明，格式一致。
- `--t-med`（200ms）与 `--ease-spring`（`cubic-bezier(0.34, 1.4, 0.5, 1)`，`src/index.css:6427`）**保持不动** —— 本次只改"动哪些属性"，不改手感参数。
- `will-change: transform` 已经在 `.glide-ink` 上（`6658`），改完之后它才真正名副其实。

## Steps

1. 完整读一遍 `src/core/selectionGlide.ts`（约 164 行），确认 `place()` / `schedule()` / `inkBox()` 的既有结构与 `placed` 标志的用法。
2. 在 `place()` 的闭包作用域内加入 `baseW` / `baseH`（注意：要在 `place` 之外、模块或订阅作用域内，使其在多次 `place()` 之间保持）。
3. 按上面的 target 替换 `selectionGlide.ts:86-88`。
4. 在 `src/index.css` 的 `.glide-ink` 规则里加入 `transform-origin: 0 0;`。
5. 把 `.glide-ink` 的过渡列表改为只含 `transform` 与 `opacity`。
6. 确认 `place()` 里"首次落位不许从 (0,0) 滑过来"的一帧绕过（`selectionGlide.ts:80-85`）仍然有效 —— 它现在还要兼顾"基准尺寸首次设定"这一帧。

## Boundaries

- ⚠️ **形变风险**：非等比 `scale` 会**一起缩放** `border-radius: 12px` 与 `border: 1px`。列表行高度一致时看不出问题；**若出现多行（换行）的行，圆角会被拉成椭圆、描边会变粗或变细**。
  - 执行后**必须**在 Ctrl+K 结果里搜出长短不一的条目（含很长的笔记标题，让它换行），盯着墨迹看圆角与描边。
  - **若确认有多行条目且形变可见**：停下来报告，不要自行发明补丁（例如改用 `clip-path`、给墨迹内嵌一个反缩放的内层、或退回 `height` 过渡）—— 这需要重新选方案。
- **不要**改 `--t-med` / `--ease-spring` / `--t-fast`。
- **不要**改 `.glide-ink` 的颜色、描边、圆角、阴影。
- **不要**改 `src/index.css:6670-6675` 的 `html.glide-ink-on` 系列规则（活动项不再自画底色的那几条）。
- **不要**动 `src/index.css:6677` 的 reduced-motion 块（`.glide-ink { transition: none; }`）—— 保留。
- **不要**给 `selectionGlide.ts` 加 `motionAllowed()` 门控 —— `src/index.css:6615` 注明它不门控是刻意的。
- 如果 `selectionGlide.ts` 的结构与引用不一致，**停下来报告**。

## Verification

- **Mechanical**: 根目录跑 `npm run lint` 与 `npm run test`。仓库**已有** `src/core/__tests__/selectionGlide.test.ts`，它会检查墨迹的定位方式 —— 若该测试断言的是 `style.width` / `style.height`，它**应该失败**，这是预期的：把断言更新为 `transform` 里的 `scale`，并在报告里说明改了哪几行。
- **Feel check**: `npm run dev`，然后：
  - 按 `Ctrl+K`，用 `↑`/`↓` 在结果里快速移动：墨迹应**平滑跟手**，不应有卡顿；位置必须**精确套住**当前活动行（左上角对齐，不能有半行偏移 —— 这是 `transform-origin` 写错时最典型的症状）。
  - 打开「待办清单」左侧分组，同样用键盘上下移动。
  - 在 DevTools 的 Performance 面板录 3 秒连续按方向键，确认每帧不再有 layout 阶段（对比改动前的录制）。
  - 在 DevTools 里选中 `.glide-ink`，确认 `transition-property` 只剩 `transform, opacity`，且 `transform-origin` 为 `0px 0px`。
  - **形变检查**：搜出一条会换行（两行）的长标题，停在它上面，盯住墨迹的圆角与 1px 描边 —— 不应被拉伸。
  - 首次打开 Ctrl+K 时，墨迹**不应**从左上角 (0,0) 滑过来。
- **Done when**: 方向键导航时墨迹位置精确、无 layout 过渡，且圆角/描边在单行与多行条目上都无形变。

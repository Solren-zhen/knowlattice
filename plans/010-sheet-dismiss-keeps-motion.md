# 010 — 抽屉关闭不再硬切

- **Status**: TODO
- **Commit**: 147af4e
- **Severity**: HIGH
- **Category**: §4 Interruptibility
- **Estimated scope**: 1 file, 约 25 行（`src/views/BottomSheet.tsx`）

## Problem

底部抽屉（`.sheet`）的拖拽、吸附、回弹都用真正的解析弹簧，**唯独关闭是硬切**：刚测出来的速度被丢掉，组件当帧卸载。

`src/views/BottomSheet.tsx:169-192`（现状）：

```tsx
  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (!drag?.claimed) return;
    const geometryNow = geometryRef.current;
    const rest = sheetRestY(geometryNow);
    const y = yRef.current;
    if (y > rest + CLOSE_OVERSHOOT) {
      onClose();
      return;
    }
    const velocity = velocityFromSamples(samplesRef.current);
    const target = resolveSheetTarget(y, velocity, geometryNow);
    // 已经停在最下面那一档时再往下甩：直接关（抽屉的常规退出方式）
    if (target >= rest && velocity > CLOSE_FLICK) {
      onClose();
      return;
    }
    springTo(target);
  };

  if (!open) return null;
```

`onClose()` 把 `open` 置 false，而 `src/views/BottomSheet.tsx:192` 是 `if (!open) return null;` —— 所以被关掉的抽屉**一帧内消失**。速度恰好在它最大的那一刻被丢弃。同一文件的打开路径（`BottomSheet.tsx:108-120`）与拖拽中松手（`:189` 的 `springTo`）都正确使用了弹簧。

为什么重要：抽屉是手势驱动的，用户往下甩的时候手是"带着劲"的 —— 硬切读起来像"页面崩了一下"。而且用户能看到两种截然不同的退场：慢慢拖到底 → 松手（走弹簧），快速甩 → 瞬间消失。同一个手势两种结果，手感不一致。

## Target

关闭走一段**短的退场过渡**，然后卸载。曲线与时长沿用仓库既有的退场语汇。

在组件内新增关闭态：

```tsx
/* target — 新增（放在现有 useState 附近） */
  const [closing, setClosing] = useState(false);
```

```tsx
/* target — 新增函数 */
  /** 关闭：先播一段退场，再真正卸载。
      速度在松手那一刻最大，直接卸载会把它丢掉 —— 退场至少要把「往下走」这件事演完。 */
  const beginClose = useCallback(() => {
    if (!motionAllowed()) { onClose(); return; }
    stopAnim();
    setClosing(true);
    const el = sheetRef.current;
    if (el) {
      el.style.transition = 'transform var(--t-exit) var(--ease-in)';
      el.style.transform = 'translateY(110%)';
    }
    window.setTimeout(onClose, 170);
  }, [onClose]);
```

把 `BottomSheet.tsx:179` 与 `:186` 的 `onClose();` 换成 `beginClose();`，并把遮罩点击（`BottomSheet.tsx:196` 的 `<div className="sheet-backdrop" onClick={onClose} />`）也换成 `beginClose`。

`setTimeout` 的 `170ms` = `--t-exit`（160ms）留 10ms 余量。**不要**依赖 `transitionend` 单独触发（元素可能因别的属性变化而不触发，或在不支持时永不触发）；超时是保底，若你要更严谨，用 `transitionend` ＋ 超时双保险。

## Repo conventions to follow

- **退场用 `--ease-in` 是本项目已记录的刻意决定**，用户已明确拍板保持现状，不要改成 `--ease-out`。既有范例是 `src/index.css:1854-1863` 的 `.mv-toast`：

```css
  transition: opacity var(--t-exit) var(--ease-in), transform var(--t-exit) var(--ease-in);
```

  以及 `src/index.css:1851-1853` 的说明注释。
- 时长令牌：`--t-exit: 160ms`（`src/index.css:115`，注释写明"退场比进场快一档：消失的元素不需要被看清"）。
- JS 侧动效必须用 `motionAllowed()` 门控 —— 这是本仓库所有动效模块的统一做法（`cardTilt.ts:45`、`countUp.ts:62`、`pressFeedback.ts:65`、`viewMorph.ts:47` 等）。本文件应当已经在用，**先确认 import 与用法**。
- `stopAnim()` 是本文件既有的函数（`BottomSheet.tsx:139` 已调用过），直接复用。

## Steps

1. 完整读一遍 `src/views/BottomSheet.tsx`（约 214 行），确认 `sheetRef`、`stopAnim`、`motionAllowed`、`yRef`、`useCallback` 的既有用法与命名。
2. 新增 `closing` 状态与 `beginClose` 函数（按上面的 target，命名与风格对齐文件现有写法）。
3. 把 `BottomSheet.tsx:179` 与 `:186` 的 `onClose();` 替换为 `beginClose();`。
4. 把 `BottomSheet.tsx:196` 遮罩的 `onClick={onClose}` 替换为 `onClick={beginClose}`。
5. 确认 `if (!open) return null;`（`192`）保留 —— 它仍是最终的卸载点，只是现在由 `beginClose` 的定时器触发。
6. 若组件在 `closing` 期间仍会响应指针事件，给根元素加上禁用（例如 `pointer-events: none`），避免退场途中再次被拖动。

## Boundaries

- **不要**改拖拽阈值与判定：`DRAG_SLOP`、`CLOSE_FLICK`、`CLOSE_OVERSHOOT`（`BottomSheet.tsx:47-51`）全部保持原值。本次只处理"关闭时的退场"，不改"什么算关闭"。
- **不要**改打开路径（`BottomSheet.tsx:108-120`）与拖拽中松手的 `springTo`。
- **不要**改 `src/core/sheet.ts` 与 `src/core/motion.ts` 里的弹簧预设、橡皮筋、吸附锚点。
- **不要**把退场曲线改成 `--ease-out`（见上文）。
- **不要**动 `--t-exit` 令牌。
- 不要改抽屉的布局或标记结构（除第 6 步可能需要的 class/属性）。
- 如果 `BottomSheet.tsx` 的结构与引用不一致（commit 之后有漂移），**停下来报告**。

## Verification

- **Mechanical**: 根目录跑 `npm run lint` 与 `npm run test`。仓库有 `src/views/__tests__/` 下的 DOM 测试，确认没有因新增状态而失败。
- **Feel check**: `npm run dev`，打开任一底部抽屉（例如移动端宽度下的待办/章节选择），然后：
  - **快速往下甩**：抽屉应**滑出去**再消失，不应一帧不见。
  - **慢慢拖到底再松手**：应与改动前手感一致（走弹簧吸附，然后退场）。
  - **点遮罩关闭**：同样应有退场。
  - 在 DevTools 的 Animations 面板把速度调到 10%，逐帧看退场，确认是 160ms 且方向是向下（`translateY(110%)`）。
  - 退场途中尝试再次拖动抽屉：**不应**能拖（第 6 步）。
  - 打开 reduced-motion 模拟：应直接关闭（`motionAllowed()` 为 false 时走 `onClose()` 立即卸载），不应有残留的半透明抽屉。
  - 反复开关 10 次，确认没有抽屉叠影或残留节点。
- **Done when**: 三种关闭路径（甩、拖到底、点遮罩）都有可感知的向下退场，且拖拽与吸附的手感没有回归。

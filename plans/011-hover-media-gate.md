# 011 — 位移类 hover 加触控门控

- **Status**: TODO
- **Commit**: 147af4e
- **Severity**: HIGH
- **Category**: §6 Accessibility（未门控的 hover 位移）
- **Estimated scope**: 1 file, 7 条规则搬进媒体查询（`src/index.css`）
- **依赖**: 计划 003 / 004 / 005 先落地（它们会删掉本计划清单里的 4 条规则，见下）

## Problem

全文件**没有任何** `@media (hover: hover)` / `(pointer: fine)` / `(pointer: coarse)` 门控 —— `grep` 结果为 0。但有若干条 hover 规则在**移动元素**，在触屏上点按会先触发一次 hover，于是内容在手指底下跳一下。

规则要的就是这个门控（触屏上 tap 会触发假 hover）。**JS 侧已经做对了**：`cardTilt.ts:45`、`hoverGlow.ts:54`、`motionChoreography.ts:170` 都检查了 `hasFinePointer()`；只有 CSS 层没有。这个应用确实有面向触控的界面：`.sheet` 拖拽、`AnatomyViewer3D`、`MindMapView`，以及窄到 360px 的断点。

需要门控的规则（**已排除**会被计划 003/004/005 删除的条目）：

| 行 | 规则 |
|---|---|
| `1434` | `.rate:hover { transform: translateY(-2px); box-shadow: var(--shadow-sm); }` |
| `4443` | `.rate:hover { transform: translateY(-2px) scale(1.01); }` |
| `4487` | `.bank-item:hover { transform: translateY(-1px); }` |
| `4488` | `.excerpt-item:hover { transform: translateY(-1px); }` |
| `5538` | `.pathway-swatch:hover { transform: scale(1.12); }` |
| `6489` | `.btn:hover > svg, .btn-small:hover > svg { transform: translateY(-1px) scale(1.08); }` |
| `6581` | `.btn-primary:hover .btn-trail { transform: translate(2px, -1px) scale(1.06); background: rgba(255, 255, 255, 0.3); }` |

**不在本计划范围**（由别的计划处理，不要重复）：
- `4586` `.rail-logo:hover` → 计划 003 删除（死类名）
- `6484` `.btn-primary:hover::before` → 计划 005 删除（扫光下线）
- `6493` `.rail-btn:hover svg`、`6497` `.rail--expanded .rail-btn:hover .rail-label` → 计划 004 删除

## Target

把这 7 条规则原样搬进一个媒体查询，**值一字不改**：

```css
/* target — 新增块，位置见 Steps */
/* 触控设备上 tap 会先触发一次 hover，位移会让内容在手指底下跳。
   与 JS 侧的 hasFinePointer()（cardTilt / hoverGlow / motionChoreography）对齐。 */
@media (hover: hover) and (pointer: fine) {
  .rate:hover { transform: translateY(-2px); box-shadow: var(--shadow-sm); }
  .bank-item:hover { transform: translateY(-1px); }
  .excerpt-item:hover { transform: translateY(-1px); }
  .pathway-swatch:hover { transform: scale(1.12); }
  .btn:hover > svg, .btn-small:hover > svg { transform: translateY(-1px) scale(1.08); }
  .btn-primary:hover .btn-trail { transform: translate(2px, -1px) scale(1.06); background: rgba(255, 255, 255, 0.3); }
}
```

**`4443` 那条要特别小心**：`src/index.css:1434` 与 `4443` 是**同一个选择器 `.rate:hover` 的两条不同声明**（分别在复习页与考试中心）。两条都要搬，且**保持它们在原文件里的先后顺序** —— 后写的会覆盖先写的，搬进同一个块里时顺序不能颠倒。

## Repo conventions to follow

- 这个仓库对媒体查询的**位置有明确要求**，并写下了理由 —— `src/index.css:4738`：

> 位置必须放在 `.rail-btn` / `.rail-logo` 等基础规则**之后**：媒体查询不加权重

  所以新增的 `@media` 块必须放在它所覆盖的规则**之后**，否则会被同权重的基础规则盖掉。最省事且最安全的做法：把每条规则**就地**包进自己的 `@media (hover: hover) and (pointer: fine) { … }`，而不是集中放到文件末尾。
- 本仓库已有"就地包媒体查询"的先例，可以照抄格式（例如 `src/index.css:4831-4849` 一带的断点块）。
- 不要把 `:active` 或颜色类 hover 搬进去 —— 触屏上按下反馈和变色是需要的。

## Steps

1. **先确认计划 003 / 004 / 005 已落地**（`4586`、`6484`、`6493`、`6497` 应已不存在）。若未落地，**停下来报告**，不要提前处理这四条。
2. 对表中前 5 条规则（`1434`、`4443`、`4487`、`4488`、`5538`），**就地**各自包一层 `@media (hover: hover) and (pointer: fine) { … }`，规则内容与顺序不动。
3. 对 `6489` 与 `6581` 同样就地包一层。
4. 全文搜索 `:hover`，逐条确认：**只有含 `transform` 的 hover 被包**；纯颜色/背景/阴影的 hover 保持原样。
5. 确认包完之后，被包规则仍在它们的基础规则之后（防止被覆盖）。

## Boundaries

- **只搬不改**：`translateY(-2px)`、`scale(1.12)` 等值一律不动。这是门控，不是重新设计。
- 不要给**颜色类** hover 加门控 —— 触屏上变色是需要的反馈。
- 不要动 `:active` / `:focus-visible` / `.on` / `[data-tilt-active]` 相关规则。
- 不要动 `src/index.css:203-207` 的 `:focus-visible` 全局规则。
- 不要改任何 `.ts` / `.tsx`：JS 侧的门控已经正确。
- 不要顺手新增 `(pointer: coarse)` 分支或做"触屏专用样式"——本次只加门控。
- 不要动 `.sheet`、`AnatomyViewer3D`、`MindMapView` 的既有触控样式。

## Verification

- **Mechanical**: 根目录跑 `npm run lint` 与 `npm run test`。另外跑 `grep -c "hover: hover" src/index.css`，期望为 7（或与落地后的规则数一致）。
- **Feel check**: `npm run dev`，用 DevTools 的**设备模拟**切到触屏（例如 iPhone 尺寸，并开启触摸模拟），然后：
  - 点按「间隔复习」的评分按钮（`.rate`）：**不应**有上抬位移，但颜色/描边反馈仍在。
  - 点按题库列表项、摘录项：**不应**有位移。
  - 点按主按钮（`.btn-primary`）：不应有尾迹位移，但按压反馈仍在。
  - 在「医学通路」里点色板（`.pathway-swatch`）：不应放大，但选中态仍要清楚。
  - 切回桌面指针模式（鼠标），重复上述操作：**位移应全部恢复**。这是本计划最重要的回归检查 —— 门控不能误伤桌面。
  - 窄到 360px 宽度再看一遍，确认窄屏（通常是触控）下没有位移。
- **Done when**: 触屏模拟下位移类 hover 全部不触发，鼠标下全部照常，颜色/按下反馈在两种模式下都在。

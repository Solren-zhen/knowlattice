# 003 — 给 rail-home 补上按下态，并删除指向死类名的规则

- **Status**: TODO
- **Commit**: 147af4e
- **Severity**: HIGH
- **Category**: §3 Physicality & origin（按下反馈）
- **Estimated scope**: 1 file, 2 处改动（`src/index.css`）

## Problem

主导航轨最上面那个"回到主界面"按钮（也是品牌标），**没有任何按下反馈**。原因是它的按下规则写在一个**全仓库无人使用的类名**上。

`src/index.css:4585-4588`（现状）：

```css
.rail-logo svg { width: 34px; height: 34px; filter: drop-shadow(0 3px 12px rgba(79, 70, 229, 0.45)); transition: filter var(--t-fast) var(--ease); }
.rail-logo:hover { transform: translateY(-1px) scale(1.06); }
.rail-logo:hover svg { filter: drop-shadow(0 6px 20px rgba(79, 70, 229, 0.65)); }
.rail-logo:active { transform: scale(0.95); }
```

`rail-logo` 在全仓库（排除 `node_modules` / `dist` / `.git` / `vendor`）只出现在 `src/index.css` 里 —— **没有任何 `.tsx` / `.ts` 使用它**。真正的元素是：

`src/views/Rail.tsx:126`：
```tsx
<button className="rail-home" data-tip="回到主界面" aria-label="回到主界面" onClick={p.onHome}>
```

而 `.rail-home` 自己的规则（`src/index.css:4568-4575`）只有基础态和 hover，**没有 `:active`**：

```css
.rail-home {
  width: 42px; height: 42px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: var(--r-md);
  background: transparent; color: var(--muted); cursor: pointer;
}
.rail-home:hover { color: var(--accent); background: var(--accent-soft); }
.rail-home > svg { width: 22px; height: 22px; }
```

为什么重要：这是全应用使用最频繁的导航控件，它 hover 有反应、按下没反应，手感上就是"这个按钮坏了"。同轨的 `.rail-btn` 有完整的按下态，两者并排出现，差异很容易被察觉。

## Target

给 `.rail-home` 加上与 `.rail-btn` 一致的按下态，并删掉四条死规则。

```css
/* target — 追加到 src/index.css:4575 之后（.rail-home > svg 那行下面） */
/* 按下反馈：与 .rail-btn:active（src/index.css:4652-4656）同一套按压令牌。
   注意 .rail-logo 是历史遗留类名，全仓库无人使用，其规则已删除。 */
.rail-home:active {
  transform: scale(var(--press-scale-sm));
  box-shadow: var(--press-inset);
  transition-duration: var(--press-dur);
}
```

`.rail-home` 已经通过共享规则拿到过渡属性（`src/index.css:4577-4584` 的 `.rail-logo, .rail-home { … transition: var(--tr-interact); }`），所以补上 `:active` 后按下/松开会自动形成"按下 90ms 快、松开 130ms"的不对称 —— 这正是仓库既有的正确做法，不需要额外写 transition。

**要删除的四行**（`src/index.css:4585-4588`）：

```css
.rail-logo svg { … }
.rail-logo:hover { … }
.rail-logo:hover svg { … }
.rail-logo:active { … }
```

删掉后 `rail-logo` 只剩 `src/index.css:4577` 和 `4743` 两处共享选择器里的名字。**这两处的 `.rail-logo` 也一并从选择器里摘掉**，让 `.rail-logo, .rail-home { … }` 变成 `.rail-home { … }`。

## Repo conventions to follow

- 按下态的既有范例就是隔壁：`src/index.css:4652-4656`

```css
.rail-btn:active {
  transform: translateY(0) scale(var(--press-scale-sm));
  box-shadow: var(--press-inset);
  transition-duration: var(--press-dur);
}
```

- 按压令牌定义在 `src/index.css:118-126`：`--press-scale-sm: 0.93`（42px 图标按钮专用档，注释写明"小控件要更大的差值才有同样的按下去手感"）、`--press-inset`、`--press-dur: 90ms`。
- `.rail-home` 与 `.rail-btn` 尺寸同为 42px，所以用 `--press-scale-sm` 这一档，**不要**用 `--press-scale`（0.96，那是常规按钮档）。

## Steps

1. 在 `src/index.css:4575`（`.rail-home > svg { width: 22px; height: 22px; }`）之后插入上面的 `.rail-home:active` 规则与注释。
2. 删除 `src/index.css:4585-4588` 四行 `.rail-logo*` 规则。
3. 把 `src/index.css:4577` 的 `.rail-logo, .rail-home {` 改为 `.rail-home {`。
4. 把 `src/index.css:4743` 的 `.rail-logo, .rail-home { margin-bottom: 6px; }` 改为 `.rail-home { margin-bottom: 6px; }`。
5. 全文件搜索 `rail-logo`，确认结果为 0（`src/index.css:4738` 的注释里提到过这个名字，那是说明文字，可以保留或顺手更正）。

## Boundaries

- **不要**把 `.rail-logo svg` 的 34px 尺寸"改名"给 `.rail-home`：`.rail-home > svg` 是 22px（`src/index.css:4575`），两者是不同设计意图，改名会让图标变成 34px。
- **不要**把 `.rail-logo:hover { transform: … scale(1.06) }` 改名给 `.rail-home`：`.rail-home` 的 hover 已经有颜色反馈（`src/index.css:4574`），本次不新增 hover 位移。
- 不要动 `.rail-btn` 的任何规则。
- 不要动 `src/views/Rail.tsx`。
- 不要引入新令牌 —— `--press-*` 四个令牌都已存在。
- 如果 `rail-logo` 在别处（例如 `public/`、`index.html`、Tauri 侧）确有使用，**停下来报告**，不要删规则。

## Verification

- **Mechanical**: 根目录跑 `npm run lint` 与 `npm run test`。另外跑一次 `grep -rn "rail-logo" src/`，期望输出为 0（注释除外）。
- **Feel check**: `npm run dev`，然后：
  - 用鼠标**按住**左上角"回到主界面"按钮不放：按钮应当有轻微的下压（缩到 93%）与内阴影；松开时弹回。
  - 与旁边任一导航按钮（如「目录」）并排对比，两者的按下手感应当一致 —— 这是本计划的验收重点。
  - 在 DevTools 里选中该按钮，确认计算样式中 `transition-duration` 在按下时是 `90ms`。
  - 打开 reduced-motion 模拟，确认按下态**仍然存在**（按下传达的是状态，不是装饰 —— 见 `src/index.css:5985` 的既有注释）。
- **Done when**: "回到主界面"有与 `.rail-btn` 一致的按下反馈，且 `rail-logo` 不再是任何规则的唯一选择器。

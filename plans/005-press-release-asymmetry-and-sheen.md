# 005 — 按压与松开的时间关系正过来；主按钮扫光下线

- **Status**: TODO
- **Commit**: 147af4e
- **Severity**: HIGH
- **Category**: §4 Interruptibility（不对称时序）＋ §2 Easing & duration
- **Estimated scope**: 1 file, 2 处改动（`src/index.css`）

## Problem

### 5a. 按下瞬间、松开慢 —— 不对称关系反了

`src/index.css:1932-1945`（现状）：

```css
.btn-small::after, .btn-icon::after, .btn-primary::after, .opt::after {
  content: '';
  position: absolute; inset: 0;
  border-radius: inherit;
  background: currentColor;
  opacity: 0;
  pointer-events: none;
  transition: opacity 450ms var(--ease);
}
.btn-small:active::after, .btn-icon:active::after, .btn-primary::after, .opt:active::after {
  opacity: 0.14;
  transition: none;
}
```

按下时 `transition: none`（涟漪瞬间出现），松开时 `450ms` 淡出。

规则要的是相反的关系：**刻意的相位（按下、长按、危险确认）慢，系统的响应要快**。这里刻意的相位是瞬时的，系统的响应却是全文件最长的非装饰时长（450ms，超过 300ms 的 UI 预算）。用户松手后还会看着那层灰雾在按钮上挂将近半秒。

### 5b. 主按钮每次 hover 都播 600ms 装饰扫光

`src/index.css:6478-6485`（现状）：

```css
.btn-primary { position: relative; overflow: hidden; isolation: isolate; }
.btn-primary::before {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(105deg, transparent 38%, rgba(255, 255, 255, 0.34) 50%, transparent 62%);
  transform: translateX(-130%);
  transition: transform var(--t-sheen) var(--ease-glide);
}
.btn-primary:hover::before { transform: translateX(130%); }
.btn-primary:disabled::before { display: none; }
```

`--t-sheen: 600ms`（`src/index.css:6430`）。`.btn-primary` 是保存/提交/确认这类主操作按钮，一天要 hover 很多次，而扫光不传达任何状态。600ms 也是全文件最长的时长。

## Target

### 5a — 松开压到 120ms

```css
/* target — 替换 src/index.css:1939 */
  transition: opacity 120ms var(--ease);
```

`120ms` 落在规则的"按钮按压反馈 100–160ms"区间内，且比 `--t-fast: 130ms` 略快 —— 与"退场比进场快一档"的既有取向一致（`src/index.css:115` 的 `--t-exit: 160ms` 注释）。

### 5b — 扫光整段删除

删除 `src/index.css:6471-6485` 整块（含 `/* ---- 5. 主按钮扫光 + 图标动能 ---- */` 标题注释与 `.btn-primary::before` 相关四行）。`.btn-primary { position: relative; overflow: hidden; isolation: isolate; }`（`6477`）是扫光专用的，一并删除 —— **但要先确认没有别的东西依赖它**（见 Steps 第 3 步）。

同时删除 `src/index.css:6430` 的 `--t-sheen: 600ms;` 令牌：全文件对它的引用只有 `6482` 一处，删掉扫光后它就是死令牌。

`.btn > svg` / `.btn-small > svg` / `.btn-icon > svg` 的图标动能（`6487-6489`）**保留** —— 那是普通按钮的，不在本次范围。

## Repo conventions to follow

- 进场/退场用不同曲线与时长的既有范例：`src/index.css:1854-1863` 的 `.mv-toast` —— 基础态写退场（`opacity var(--t-exit) var(--ease-in)`），`.on` 态写进场（`220ms var(--ease-out)`），注释在 `1851-1853` 解释了理由。本计划的 120ms 只是把涟漪的退场收进预算，**不改变仓库既有的 `--ease` 用法**。
- 时长令牌定义在 `src/index.css:112-115`：`--t-fast: 130ms` / `--t-med: 200ms` / `--t-slow: 260ms` / `--t-exit: 160ms`。
- 主按钮的按压反馈在 `src/index.css:348-352`，用的是一套正确的按压令牌，**不要动**。

## Steps

1. 把 `src/index.css:1939` 的 `transition: opacity 450ms var(--ease);` 改为 `transition: opacity 120ms var(--ease);`。
2. 删除 `src/index.css:6471-6485` 整块扫光规则与它的标题注释。
3. 删除 `src/index.css:6477` 的 `.btn-primary { position: relative; overflow: hidden; isolation: isolate; }` —— **删除前先搜索全文件**：若 `overflow: hidden` / `isolation: isolate` 在别处对 `.btn-primary` 有依赖（例如子元素需要被裁剪），则保留这一行只删 `::before` 部分，并在计划外说明。
4. 删除 `src/index.css:6430` 的 `--t-sheen: 600ms;` 一行。
5. 全文搜索 `t-sheen`，确认结果为 0。

## Boundaries

- 不要动 `.btn-primary:disabled` 的样式（`6485` 之外还有别处）。
- 不要动 `.btn > svg` / `.btn-small > svg` / `.btn-icon > svg` 的图标动能。
- 不要动 `--ease-glide` 令牌 —— 它还有 7 处使用（面板入场、视口显现等）。
- 不要动 `--t-enter` / `--t-reveal` 令牌。
- 不要顺手改 `:active::after` 那块的 `transition: none`（按下瞬时是对的，本次只调松开）。
- 不要改任何 `.tsx`。

## Verification

- **Mechanical**: 根目录跑 `npm run lint` 与 `npm run test`。跑一次 `grep -rn "t-sheen" src/`，期望为 0。
- **Feel check**: `npm run dev`，然后：
  - 找一个主操作按钮（例如编辑器的「保存」，或任意 `.btn-primary`）。**按住不放**：灰雾应瞬间出现。**松手**：灰雾应在约 0.12 秒内消失，不再拖尾。
  - 把鼠标移到该按钮上：**不应再有白光扫过**。反复 hover 几次确认。
  - 在 DevTools 的 Animations 面板把速度调到 10%，逐帧看松手过程，确认退场没有超过 160ms。
  - 回归检查：普通按钮（`.btn` / `.btn-small`）的图标 hover 动能仍应在（本次没删）。
  - 检查 `.btn-primary` 的子元素没有被 `overflow` 改动裁掉（特别是带 kbd 角标的主按钮，见 `src/index.css:3550-3551`）。
- **Done when**: 松开涟漪在 120ms 内收干净，主按钮 hover 无扫光，且 `.btn-primary` 的布局与改动前一致。

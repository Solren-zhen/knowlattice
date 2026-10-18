# 007 — reduced-motion 不再把颜色反馈一起清零

- **Status**: TODO
- **Commit**: 147af4e
- **Severity**: HIGH
- **Category**: §6 Accessibility
- **Estimated scope**: 1 file, 1 个规则块（`src/index.css`）
- **Confidence**: MEDIUM —— 这是本次改动里最需要实测的一条，见 Verification

## Problem

`src/index.css:190-195`（现状）：

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

这条 `*` 规则把**每一个元素**的 `transition-duration` 压成 0.01ms，于是 41 处 `transition: var(--tr-interact)`（定义在 `src/index.css:108-111`，覆盖 `color` / `background-color` / `border-color` / `box-shadow` / `transform` / `opacity` / `fill` / `stroke`）全部变成硬切。

规则要的是：**减少而非归零 —— 保留有助于理解的过渡，去掉位置变化**。这里的实现把两者一起砍了：悬停变色、焦点描边、按下内阴影这些**传达状态**的过渡，在用户明确要求"少动效"时反而消失了。

后果不是"少动效"，而是"界面变成硬切" —— 对晕动敏感的用户来说，颜色瞬变本身并不比淡变更舒适，而反馈的可读性反而下降了。

## Target

把兜底从"压所有过渡时长"改成"**把过渡属性收窄到颜色/透明度一类**，并给一个短时长"。这样位置类过渡（`transform` / `width` / `height`）被整个摘掉，而颜色类过渡以 120ms 保留。

```css
/* target — 替换 src/index.css:190-195 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    /* 关键帧一律压平：入场、抖动、循环位移都不该播 */
    animation-duration: 0.01ms !important;
    /* 延迟必须显式清零：兜底压不住 animation-delay，列表项会白等半秒 */
    animation-delay: 0ms !important;
    /* 过渡只保留颜色/透明度一类：transform / width / height 被摘掉，
       位置变化消失；悬停变色、焦点描边、按下反馈仍以 120ms 过渡。 */
    transition-property: color, background-color, border-color, box-shadow, opacity, fill, stroke !important;
    transition-duration: 120ms !important;
    transition-delay: 0ms !important;
  }
}
```

同时把 `html.no-motion` 路径按同一口径改写（`html.no-motion` 的兜底块在 `src/index.css:6502-6515` 一带，实际选择器请以文件为准）。

## Repo conventions to follow

- 规则原文与范例（`AUDIT.md` §6）：reduced-motion 下保留 `animation: fade 0.2s ease` 这类只动透明度的过渡，只去掉位移。
- 这个仓库**自己**已经承认延迟需要单独清零，并写下了理由 —— `src/index.css:5985-5986`：

> 延迟必须显式清零：全局兜底只压 animation-duration，压不住 animation-delay，否则列表项要等半秒才出现。

  本计划把这件事从"每个块各自处理"提升到全局处理，与那条注释的意图一致。
- 令牌 `--tr-interact`（`src/index.css:108-111`）已经是"只动 paint/compositor 层"的属性集，本计划只是把它在 reduced-motion 下进一步收窄到非位移部分。

## Steps

1. 用上面的 target 替换 `src/index.css:190-195` 整个 `@media (prefers-reduced-motion: reduce)` 块。
2. 找到 `html.no-motion` 的全局兜底块（`src/index.css:6502` 一带），按同一口径改写（把 `transition-duration: 0.01ms !important` 换成 `transition-property` 收窄 + `120ms`）。
3. 检查现有 11 个 reduced-motion 块里那些**更具体**的规则（例如 `5988` 的 `.stagger-item { animation: none }`、`6504` 的 `.panel, .qs-modal, .notice-panel { animation: none }`、`5990-5991` 的 `dash-card` 关闭）—— **全部保留不动**，它们比全局规则更精确。
4. 注意 `animation-delay: 0ms !important` 新增后，`src/index.css:6503` 与 `5988` 那两处"显式清零延迟"的规则变成冗余但无害，**本次不删**，避免扩大改动面。

## Boundaries

- 这是一个全局规则，**风险最高的一条**。若实测发现某处依赖 `transition-duration` 被压平（例如某个元素靠 0.01ms 达成"瞬变"效果），**停下来报告**，不要为了让它好看而逐处打补丁。
- 不要改 `src/index.css:108-111` 的 `--tr-interact` 定义本身。
- 不要动 11 个既有 reduced-motion 块的内容。
- 不要动任何 `.tsx`：JS 侧的动效模块各自用 `motionAllowed()` 自行门控（`cardTilt.ts:45`、`countUp.ts:62`、`navIndicator.ts:62`、`motionChoreography.ts:106/170/273`、`pressFeedback.ts:65`、`hoverGlow.ts:54`、`theme.ts:33`、`viewMorph.ts:47`），本次不改。
- `selectionGlide.ts` 是唯一**不**门控的模块，且 `src/index.css:6615` 注明是刻意的 —— 不要顺手给它加门控。
- 不要与计划 006 同时执行（两者都改 reduced-motion 相关代码，见 006 的 Boundaries）。

## Verification

- **Mechanical**: 根目录跑 `npm run lint` 与 `npm run test`。这个仓库有动效相关测试（`src/core/__tests__/motionWiring.dom.test.ts`、`navIndicator.test.ts`、`selectionGlide.test.ts`），务必确认全绿。
- **Feel check**（本次必做，且要**逐视图**过）: `npm run dev`，在 DevTools 的 Rendering 面板切 `prefers-reduced-motion: reduce`，然后：
  - **位移应当消失**：鼠标扫过导航轨、列表行、按钮 —— 不应有任何位移/缩放。按 Ctrl+K —— 面板不应有上浮。
  - **颜色反馈应当保留**：悬停按钮时底色/文字色应在约 120ms 内**渐变**过去，而不是"啪"地跳变。这是本计划的验收核心。
  - **焦点可见性**：用 Tab 键遍历，`:focus-visible` 的 2px 描边仍应出现（`src/index.css:203-207`）。
  - **按下反馈仍在**：按住按钮，内阴影与缩放应仍生效（缩放是 `transform`，会被本规则摘掉；内阴影是 `box-shadow`，会保留 —— 这是预期行为，确认视觉上仍读得出"按下"）。
  - 逐个视图过一遍：知识首页、目录/编辑器、题库练习、待考清单、学习统计、AI 问答。**任何一处在 reduced-motion 下变成硬切或出现异常闪烁，都记下来报告。**
- **Done when**: reduced-motion 下位移全部消失、颜色/焦点/按下反馈仍以短过渡呈现，且全量测试通过。

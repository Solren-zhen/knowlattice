# HelixMind 借鉴审计（对照 KNOWLATTICE）

审计对象：`C:\Users\甄朝晖\Desktop\HelixMind-完整包\HelixMind-完整包`
审计范围：顶层 9 份文档、`scripts/` 全部脚本、`src/` 36 个功能域（505 源文件 / 302 测试文件）、`src/styles/` 与 `src/app/routes/`。
对照基线：KNOWLATTICE v0.2.2（`src/core`、`src/views`、`src/storage`、`src/styles`、`scripts/`）。

---

## 0. 结论

**不值得借鉴的是功能——KNOWLATTICE 的功能面更全**（agent 治理、pomodoro、viewMorph、adaptiveQuality、hoverGlow、citation 校验等都是 HelixMind 没有的）。

**值得借鉴的是它把"约定"变成"门禁"的那一套**：HelixMind 有 5 个可执行脚本 + 3 份自动生成报告，让「包体不能涨」「hooks 不能写在早退之后」「对比度不能掉」「AI 解析不能抛异常」从文档里的自觉变成 CI 里的红灯。KNOWLATTICE 目前只有 `architecture.test.ts` 与 `audit-motion.mjs` 两条静态线，其余靠人眼。

优先级总表：

| # | 项 | 类型 | 现状差距 | 成本 |
|---|---|---|---|---|
| P0-1 | 产物体积门禁 | 脚本 | 无任何体积约束 | 半天 |
| P0-2 | hooks 顺序静态扫描 | 脚本 | oxlint 查不到 | 1 小时 |
| P0-3 | AI 脏样本回归表 | 测试 + 报告 | 无固化样本 | 1 天 |
| P0-4 | 对比度 / 层级断言 | 测试 | 纯靠肉眼 | 半天 |
| P0-5 | 界面规则静态自审 | 测试 | 只查分层 | 半天 |
| P1-1 | 反链升级为可修复引用 | 功能 | `linkIndex` 是 50 行骨架 | 1–2 天 |
| P1-2 | 生成内容 grounding 校验 | 功能 | 无 | 半天 |
| P1-3 | Agent 原地打转防护 | 功能 | 无 | 半天 |
| P1-4 | 面板悬停/空闲预取 | 体验 | 点击才开始下载 | 半天 |

> **落地状态（2026-11-03）**：以上 9 项均已实现，证据见文末 §7「落地记录」。


---

## 1. P0：五个可执行门禁

### 1.1 产物体积预算 `scripts/size-budget.mjs`

**HelixMind 做了什么**（`scripts/size-budget.mjs`，11 KB；说明见 `PERFORMANCE.md`）

- 读 `dist/assets/*.js`，逐文件算原始 + gzip 体积。
- 靠 `dist/.vite/manifest.json`（`vite.config.ts` 里 `build.manifest: true`）把 chunk 分成「产品 / pdfjs / 3D / 写作面板 / `?raw` 源码快照」，**缺 manifest 直接报错退出，不猜**。
- 六类阈值：主包 ≤200 KB、单 chunk ≤450 KB、产品总量 ≤1.65 MB、各按需重依赖单列一条、首屏 js 请求数 ≤8。
- 首屏请求数是**从 `index.html` 出发沿静态 `import` 闭包真实遍历**出来的，动态 `import` 不算——这一点比"看构建报告"准得多。
- 超预算非零退出，可直接挂 CI；`--json` 给机器读。

**为什么 KNOWLATTICE 需要**

`scripts/assert-public-dist.mjs` 是**泄密守卫**（私有题库、备份、密钥、本机路径），与体积完全正交。目前没有任何东西阻止一次 PR 把 3 MB 的表格库或第二个 PDF 引擎塞进主包——而 KNOWLATTICE 是 Tauri 桌面应用，冷启动直接吃这个体积。

**怎么搬**

1. `vite.config.ts` 加 `build.manifest: true`（只影响构建产物，无运行时影响）。
2. 抄脚本；改两处适配：
   - `base: './'` 下 `index.html` 的资源是 `./assets/...`，`firstLoadRequests()` 的 `/<script src="\/?assets\//` 正则要放宽成 `["']\.?\/?assets\/`。
   - 分类正则按 KNOWLATTICE 的 chunk 名重写（`xlsx`、`sql.js`、`pdfjs`、`tesseract`、`three`、`niivue`、`docx-preview` 各一条线）。
3. 首构建跑一次，按实测 + 余量定阈值，写进 `package.json` 的 `build` 链尾。

**代价**：首次要人工定 4–6 个数；之后每次加依赖都会被拦一次，这正是目的。

---

### 1.2 hooks 顺序静态扫描 `scripts/hooks-order-check.mjs`

**HelixMind 做了什么**

- 自己写了一个轻量 tokenizer：抹掉注释与字符串（保留换行与花括号），再按行累计 `{` `}` 深度。
- 找出每个函数体的**顶层** `return` / `if (...) return`，与**首个 hook 调用行**比较；`return` 在前就报。
- 输出 `文件:行 组件名 ← 早退语句 (首个 hook 在第 N 行)`，有命中 `exit 1`；支持 `--domain` 与 `--json`。

**为什么 KNOWLATTICE 需要**

这是 React #310（`Rendered more hooks than during the previous render`）的静态前兆，而 **oxlint 抓不到**——它不是语法错误，是"两次渲染走了不同分支"的运行时约束。KNOWLATTICE 里 `Workspace.tsx`(123 KB)、`QuizView.tsx`(90 KB)、`AiAgentPanel.tsx`(89 KB) 这类巨型组件，`if (!data) return <Loading/>` 写在 hook 之前的概率不低。

**怎么搬**：脚本零依赖、不读项目约定，直接放到 `scripts/`，加进 `npm run lint` 之后。若有历史命中，先 `--json` 出一份清单，按域分派修（不要为了变绿改脚本）。

**代价**：1 小时，其中大半是修存量命中。

---

### 1.3 AI 输出脏样本回归表 `src/features/ai/eval.ts`

**HelixMind 做了什么**

- 把 36 条「模型会怎么坏」固化成表：JSON 前后带中文废话 / ```json 围栏 / 单引号 / 尾逗号 / 全角引号与全角逗号 / 两个 JSON 连写 / 20k 长文 / 截断围栏 / 空响应 / 括号不配对；工具块缺 name、坏块后跟好块、一次三个；SSE 夹 `: ping`、CRLF、无 `[DONE]` 截断、`[DONE]` 后垃圾；假模型直接抛网络错误。
- 判定只有三值：`ok`（解析出合法结构）/ `error`（给出明确 `LlmError`）/ `throw`（**永远算失败**）。
- 跑的是真实解析路径（`tryParseModelJson` / `extractToolCalls` / `createSseParser`），不是给解析器写 mock。
- `scripts/robustness-report.ts` 生成 `AI_ROBUSTNESS.md` 入库，含「脏在哪 → 期望 → 实际」逐条表格与已知边界。

**为什么 KNOWLATTICE 需要**

`src/core/aiPatch.ts` 对 `find_text` 的锚文本归一化**比 HelixMind 更强**（保守到"只有唯一命中才放行"），但那解决的是"改写落点"，不是"模型整体输出格式"。`aiAgent.ts` / `aiCommands.ts` / `aiTools.ts` 里对模型返回的 JSON 解析只有零散单测，没有一张"已知会坏"的样本表——于是每次改提示词或换模型，坏法都是线上第一次遇到。

**怎么搬**

1. 样本表落到 `src/core/__tests__/aiParse.robustness.test.ts`，用 `it.each` 表驱动，判定复用 Core 现有解析函数；断言"不抛异常且给出可判定结果"。
2. 报告脚本可选：先不生成 md，等表稳定再生成，避免同时维护两个真相。

**代价**：1 天（样本选取比写代码贵）。收益是回归可判定：以后模型换一版，跑一次就知道哪类坏法退化了。

---

### 1.4 视觉规格写成断言 `src/features/platform/a11yAudit.ts`

**HelixMind 做了什么**

- `parseColor` / `relativeLuminance` / `contrastRatio` / `contrastLevel` 全是纯函数，零依赖，支持 `#rgb`、`#rrggbb`、`rgb()/rgba()`。
- `auditTheme(tokens)` 直接吃 `tokens.css` 的变量表，检查正文/卡片/次要文字/主按钮/错误/成功/警告 8 组配对。
- 更狠的是 `glassSpec.test.ts` / `inkTheme.test.ts`：把「纸面 L\* 与玻璃合成 L\* 的差 ≥4」「宣纸对浓墨 ≥12:1」写成断言，注释原文是"以后谁把纸调回近白、或把 tint 提到接近纸的明度，CI 会先拦住他——不用再等人眼复核"。

**为什么 KNOWLATTICE 需要**

`src/styles/` 是 17 个 partial 的顺序级联（`00-foundation` … `17-integrity`）+ `07-hero-theme.css` 的明暗两套。**问题是这些数字目前只活在注释里**——`00-foundation.css:29` 写着「白字压在 `#6366f1` 上只有 4.47:1 不达 AA，`#5f63ee` 达到 4.66:1」，`:41` 写着「困难 2.02 / 简单 2.26 / 重来 3.39 / 危险 4.40」，全是手算的。手算会过期：改一次背景色、换一个 tint，注释不会跟着报错。

`scripts/audit-motion.mjs` 只查「@keyframes 是否定义 / var 是否定义 / infinite 是否用单向缓出」，管的是动效能不能跑，不是能不能读。也就是说：**这套注释级约束缺一个执行器**。

**怎么搬**

1. `src/core/color.ts`：抄 `parseColor` / `relativeLuminance` / `contrastRatio`（约 60 行，纯函数零依赖）。
2. `src/__tests__/contrast.test.ts`：读 `src/styles/00-foundation.css` 与 `07-hero-theme.css`，正则抽出实际令牌名——**注意 KNOWLATTICE 用 `--text` / `--text-2` / `--muted` / `--bg` / `--panel` / `--bg-raised` / `--accent` / `--accent-ink`，不是 `--ink` / `--surface`**。断言：
   - `--text` 对 `--bg`、`--text` 对 `--bg-raised` ≥ 4.5:1；
   - `--text-2` / `--muted` 对 `--bg-raised` 与 `--panel` ≥ 4.5:1；
   - `--accent-ink` 对 `--accent`、`--success-ink` / `--danger-ink` 对各自主色 ≥ 4.5:1；
   - `--danger-text` / `--amber-text` / `--success-text` 对各自 6–12% 淡底 ≥ 4.5:1（淡底要按 alpha 与父色合成后再算，不能直接拿原色比）。
3. 暗色主题另起一组（`07-hero-theme.css` 里对应选择器）。
4. 有余力再加一条"浮层与底面的亮度差 ≥N"，这是 `DESIGN.md` §2.2 那条"纸必须比玻璃暗一档"的同构检查。

**代价**：半天。第一个断言大概率会红——那说明注释里的手算已经过期，是真问题，不是脚本错了。希望保留的例外必须写成测试里的白名单条目并写理由，不要改断言阈值。

---

### 1.5 界面规则静态自审 `src/features/qa/audit.ts` + `QA_REPORT.md`

**HelixMind 做了什么**

- 9 条规则：路由缺 loading / 空态 / 错误捕获、按钮无可访问名、图片缺 alt、输入框缺 label、链接无文本、危险操作缺二次确认、hash 链接形式。
- 三级定级（error / warn / info），**豁免必须带证据字符串**（报告里逐条贴出那段 JSX），不是"这条先跳过"。
- 报告每次重跑覆盖，`error` 清零才算收口；正文里明确写"误报口径：文本启发式不解析 AST，命中只代表需要人看一眼"。

**为什么 KNOWLATTICE 需要**

`src/__tests__/architecture.test.ts` 管的是**分层方向**（core/storage 不得 import views）与禁用符号（console.log、测试文件混入生产），不管 UI 语义。而 KNOWLATTICE 里 `clickable()`（`src/views/a11y.ts`）这种"给 div 补 role+tabIndex"的写法，本质是在绕过"可点的必须是 button"这条规则——它补了语义，但没有一条断言阻止它继续扩散。

**怎么搬**

不要搬那个 18 KB 的全仓扫描页（还要 `?raw` 快照，见 §3.5）。只搬 3 条规则，写成 vitest 正则，放进 `architecture.test.ts` 旁边：

- `danger-confirm`：`delete`/`清空`/`remove` 类回调附近必须出现 `Confirm`/`confirm(` 调用（按文件级粗判，宁可误报）。
- `a11y-button-text`：`<button>` 自闭合或空内容且无 `aria-label`。
- `a11y-input-label`：`<input>` 无 `aria-label` 且不在 `<label>` 内且同文件无 `htmlFor` 配对。

**代价**：半天；误报用"豁免必须带理由注释"的方式压，不要删规则。

---

## 2. P1：四个值得改的功能点

### 2.1 反链：从"索引"升级为"可修复的引用管理"

**HelixMind**（`src/features/notes/backlinks.ts`，7 KB）

- `contextWindow(text, index, 40)`：命中位置前后各 40 字，超长补 `…`，空白折叠——反链列表能直接读，不用点进去。
- `BacklinkKind = link | block | unresolved`：区分普通双链、块引用（`#^anchor`）、**失效链接**。
- `suggestTarget()`：先找标题完全匹配 → 再找包含关系（取最短）→ 最后编辑距离，阈值 `max(1, floor(len/3))`；**不猜超出阈值的**。
- `applyFix()`：替换时保留 `#anchor` 与 `|label`，只改目标名。
- 忽略清单键是 `noteId + "::" + raw`（同一篇里的同一个坏链），存 `meta` 命名空间键。

**KNOWLATTICE 现状**：`src/core/linkIndex.ts` 文件头自述"M3 预留骨架，~50 行自写"，只有 `outgoing` / `incoming` / `updateLinksForPath`，**没有失效检测、没有上下文、没有修复建议**。所以"双链"目前只能显示"谁引用了谁"，不能回答"我哪里链错了"。

**怎么搬**（在 `linkIndex.ts` 增量加，不改已有 API）

- `linkIndex` 是 `path` 键，没有 note id / title；加一层 `titleIndex: Map<normalizedTitle, path>`，`unresolved` = 目标名既不在 path 也不在 title。
- `contextWindow` / `editDistance` 直接抄（纯函数、无依赖）。
- 修复入口挂在 `Preview.tsx` 或 `HistoryPanel.tsx` 旁边，不要新开面板。

**代价**：1–2 天，主要在"目标名 → path"的解析口径要和现有 wiki 解析统一。

---

### 2.2 生成内容的 grounding 校验

**HelixMind**（`src/features/quiz/cause.ts`）

- 错因固定四类 + `unknown`："宁可给 unknown，也不要猜"；模型给的 `cause` 越界或理由为空，**一律降级为 unknown**，不抛给界面。
- 对照卡校验更硬：两个知识点必须 `normalizeForMatch` 后**真实出现在用户自述里**，长度 2–24，两者不能相同，维度不足 2 条直接拒绝——"宁可不生成也不编造知识点"。

**KNOWLATTICE 现状**：`aiPatch.ts` 有锚文本匹配（改写落点），但**生成类**产物（卡片提示、出题、学习建议）没有"必须引用真实来源"的校验。`agentSkills.ts` 有"建议卡交用户决定"，属于审批，不是 grounding。

**怎么搬**：给 `propose_card_hints` / 出题这条链加同构校验——生成物里引用的笔记路径、小节标题、题目 id 必须出现在本次 `read_note` / `search_notes` 的真实返回里；否则降级为"建议"而不是落库。实现上就是一个 `Set` + 一次归一化比较。

**代价**：半天。收益是"模型编了一个不存在的小节"从线上事故变成可预期拒绝。

---

### 2.3 Agent 原地打转防护

**HelixMind**（`src/features/agent/loopGuard.ts`，2.2 KB）

- `repeatKey(name, args)`：参数**递归按键名排序**后序列化，保证"同样内容得到同样 key"；循环引用退化成"同名即同参"。
- 同名同参允许 2 次，第 3 次起拦截；回填话术明确给出三条出路："换参数、换工具、或直接基于已有结果回答"——不是简单报错。
- 纯函数 + 计数器，不依赖运行时，可单独测。

**KNOWLATTICE 现状**：`agentGovernance` 有 risk / approval / verification / rollback，比 HelixMind 细得多；但**没有同名同参计数**。`aiBudget.ts` 注释里只写了"宁可靠近上限，也不要让它原地打转"——这句话目前没有代码支撑。

**怎么搬**：在 `agentRuntime` 的工具执行前插一道 `repeatKey` 计数；超限时**不当作失败**，回填一条 no-op 观察结果，让模型自己纠正（当作失败会触发重试，反而加重打转）。

**代价**：半天，含 6–8 条单测。

---

### 2.4 面板预取：悬停 120 ms + 空闲拉主路径

**HelixMind**（`src/features/shell/routePrefetch.ts` + `README`）

- 悬停停留 `120 ms` 才预取；滚轮划过换项**取消上一个计时器**；`pointerType === "touch"` 或 `(hover: none)` 不预取；键盘 `focus` 等同停留。
- 空闲 2 s 预取 5 条主路由，且**全页生命周期只排一次**（模块级 `idleScheduled` 标记）。
- 纯逻辑（`createHoverPrefetcher`）与 React hook 分离，前者可单测。

**KNOWLATTICE 现状**：`panelRegistry` 的 lazy 组件在**点击时**才开始下载 chunk。大面板（`QuizView` 90 KB、`AnatomyViewer3D` 42 KB、`AiAgentPanel` 89 KB）首次打开会有明显空窗，而导轨悬停是极强的意图信号。

**怎么搬**：`src/views/usePanelPrefetch.ts`，在 `Rail.tsx` 的 `onPointerEnter` / `onFocus` 上调 `panelRegistry` 里对应项的 import 工厂；touch 设备与 `prefers-reduced-motion` 无关（这是网络预取，不是动画），但 `navigator.connection.saveData` 时要跳过。

**代价**：半天。Tauri 本地加载快，收益集中在低端机与首次冷启动。

---

## 3. 明确不建议搬

| 项 | 原因 |
|---|---|
| **pomodoro / 专注计时** | KNOWLATTICE `src/core/pomodoro.ts` 已按真实时间戳记账，且有长短休息与跨天口径；HelixMind 的 `focusTimer.ts` 是它的简化版。**反向参考，不要搬。** |
| **Agent 治理** | KNOWLATTICE 有 `RiskLevel` / `VerificationStatus` / `TriggeredBy` / `rolled_back`，比 HelixMind 的 `ask\|auto` + `plan\|act` 完整。只有 §2.3 的 loop guard 是真缺口。 |
| **命令面板懒加载** | KNOWLATTICE `Workspace.tsx:99` 注释写明"轻量面板，Ctrl+Shift+P 要零延迟"，是有意的静态引入。为 7 KB 改掉这个取舍不划算。 |
| **`?raw` 源码快照审计页** | `PERFORMANCE.md` 自述这是最大的风险项：680 文件 3.57 MB、上千个 1–2 KB chunk。KNOWLATTICE 用 vitest 正则做静态审计，成本低两个数量级。 |
| **hash 路由 + `import.meta.glob` 自动收集** | 那是为 45 个 Web 页面设计的；KNOWLATTICE 是"导轨 + 面板"制，`panelRegistry` 单一清单已经解决同一问题（加面板只改一行）。搬过来等于重做外壳。 |
| **纸墨 / 液态玻璃视觉体系** | 是 HelixMind 的品牌方向（生宣、花青、帘纹、四级玻璃），与 KNOWLATTICE 现有视觉无关。**但方法可以借**：把 ΔL\* 与对比度写成断言，见 §1.4。 |
| **research 本地 bridge** | KNOWLATTICE 走 Tauri Rust 侧，不需要回环 Node 服务。唯一可借的是 `start-research.mjs` 的**身份探测**（`/__research_identity` 返回 `{service, protocol, workspace 哈希}`，用于区分"自己的 dev server"与"端口被别的服务占了"），可移植到 `scripts/` 的 dev 启动器。 |

---

## 4. 文档体系（低成本高收益）

HelixMind 的文档不是说明书，是**可复核的证据**。三处值得抄格式：

1. **`PRODUCT.md` 的证据表**：三列「证据 / 数值或位置 / **复核方式**」。
   例：`测试 | 299 个文件通过 / 2881 条用例 | npx vitest run（2026-11-03 本机）`。
   KNOWLATTICE 的 `README.md` 目前没有任何体积/测试/启动数字——不是没有，是没登记。

2. **`RUNBOOK.md` 的环境表**：每行「要求 / 实测」，实测列写具体版本（`v24.18.0` / `12.0.2`）。这比"Node 20+"有用得多。

3. **`features-gen.mjs`**：从路由表 + 目录结构**重算** `FEATURES.md`（路由数 / 功能域 / 源文件 / 行数 / 测试文件数），并注明"改完路由重跑此脚本覆盖本文件"。
   KNOWLATTICE 没有可重算的功能地图；`routes-report.mjs` 同理（扫描 `export default RouteDef[]` 出 markdown 清单）。

**代价**：每个 1–2 小时，主要是把已有数字填进去。

---

## 5. 建议落地顺序

**第 1 周（全部是新增文件，零功能风险）**

1. `hooks-order-check.mjs`（1 h，先出 `--json` 清单）
2. `size-budget.mjs` + `build.manifest: true`（半天）
3. `contrast.test.ts` + `core/color.ts`（半天）
4. AI 脏样本表（1 天）
5. 3 条界面规则断言（半天）

**第 2 周（动功能代码，需回归）**

6. loop guard（半天）
7. 生成内容 grounding（半天）
8. 面板预取（半天）
9. 反链升级（1–2 天，最后做，因为它动的是解析口径）

---

## 6. 许可证与边界

- 两边都是 **GPL-3.0-only**（HelixMind `package.json:4`、KNOWLATTICE `package.json:5`），代码互搬在许可上一致。
- 但 **HelixMind 的 `AGENTS.md` §1 把"读取/复制本机既有项目源码"列为比赛红线**，§1b 只单向允许它从旧 `Desktop\HelixMind` 取行为模板。所以：**只能 HelixMind → KNOWLATTICE 单向搬**；不要把 KNOWLATTICE 的代码回填进 HelixMind，那会直接踩它的合规条款。
- 本文所有"值得搬"的判断都基于阅读源码与文档，**未在 KNOWLATTICE 上实际运行过任何 HelixMind 脚本**；体积阈值、hooks 命中数、对比度失败项都需要落地时实测后确定。

---

## 7. 落地记录（2026-11-03）

九项全部实现。数字均为本机实测，不是估计。

| 项 | 新增 / 修改 | 关键实测 |
|---|---|---|
| P0-1 体积门禁 | `scripts/size-budget.mjs`、`vite.config.ts`（`build.manifest: true`）、`package.json`（build 链尾 + `sizebudget`） | 主包 657.5 KB / 700；产品总量 2761.2 KB / 3481.6；编辑器 1110 KB / 1200；影像 3667 KB / 4300；PDF 689 KB / 800；文档表格 468 KB / 1200；Agent 449 KB / 800；首屏 4 个 js 请求 / 8 |
| P0-2 hooks 扫描 | `scripts/hooks-order-check.mjs`，接进 `npm run lint` | 扫 273 个源文件 / 301 个 hook 组件，命中 **0**；用探针文件验证检测器真的报错（exit 1）后删除 |
| P0-3 脏样本表 | `src/core/__tests__/aiRobustness.test.ts` | 34 条（参数 JSON 11 / 工具调用回放 7 / 锚文本 9 / SSE 与网络 7），**发现并修掉 1 个真缺陷**：模型给 `null` 参数时 `riskFor` 抛 TypeError |
| P0-4 对比度断言 | `src/core/color.ts`、`src/__tests__/contrast.test.ts` | 26 条断言（13 对 × 明暗两主题）全绿——CSS 注释里手算的比值经复核成立；半透明淡底按 alpha 合成后再算 |
| P0-5 界面自审 | `src/__tests__/uiRules.test.ts` | R6 按钮名 0 命中；R7 图片 alt 0 命中；R8 无标签输入框 **46 个 / 21 文件**，按文件计数登记为存量债务（只降不升）；R9 破坏性操作全部有 `confirmBox` |
| P1-1 反链明细 | `src/core/backlinks.ts`、`src/core/vault.ts`（新增 `backlinkHits`）、`Workspace.tsx` 关联面板、`01-editor.css` | 24 条单测；面板现在显示「来源 · 第 N 行 + 原文摘录」，解析不到但名字等于当前标题的标「可能失效」 |
| P1-2 grounding | `src/core/grounding.ts`、`aiStudyLog.ts`、`AiAgentPanel.tsx` | 15 条单测；`propose_study_log` 落库前校验 `[[双链]]`，解析不到就回填错误让模型改；不传 resolver 时行为不变 |
| P1-3 loop guard | `src/core/loopGuard.ts`、`agentRuntime.ts` | 12 条单测；连续同名同参第 3 次拦截并回填「换参数/换工具/直接回答」，不记审计、不算失败 |
| P1-4 面板预取 | `src/views/panelPrefetch.ts`、`Rail.tsx`（`onPrefetch`）、`Workspace.tsx` | 悬停/聚焦预取 14 个重面板 chunk；空闲预取 quiz/review/mistakes 三块，全生命周期只排一次；`saveData` 下不预取 |

**已知未做**：P0-5 的 46 个无标签输入框只是登记为债务，没有逐个补 `aria-label`；目标文件清单在 `uiRules.test.ts` 的 `INPUT_DEBT` 里，修一个就把数字改小。


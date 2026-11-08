# HelixMind-提交 深度借鉴审计（对照 KNOWLATTICE）

> 审计对象：`C:\Users\甄朝晖\Desktop\HelixMind-提交\helixmind`
> 对照基线：KNOWLATTICE 当前工作区（`src/core`、`src/views`、`src/styles`、`scripts/`）
> 方法：静态阅读源码、测试、脚本与文档，逐项对照 KNOWLATTICE 同名能力；**未修改任何代码，未执行构建或测试**。
> 前序记录：`docs/helixmind-borrowing-audit.md`（2026-11-03，针对旧版「完整包」）。本文只写**那次之后仍然成立、且尚未落地**的增量，不重复已完成的 9 项。

---

## 0. 结论

1. **HelixMind 这版的价值不在“功能更多”**，而在三处：
   - 把“做题记录”推进成“诊断 → 处方”的评估闭环（难度校准、自适应抽题、薄弱章节×错因矩阵）；
   - 把“病例题组”推进成“分阶段互动病例”（问诊 → 检查 → 诊断 → 处置 → 评分）；
   - 一批很具体的工程/体验细节（全局划词引用、Plan/Act 运行时约束、上下文压缩、焦点管理、全屏走查）。

2. **Agent 侧 KNOWLATTICE 已经领先，不要照抄**：治理元数据、动作日志、审批/proposal、yolo、陪练/导师模式、trace 都比 HelixMind 完整。HelixMind 只有 3 个点值得补：`plan/act` 模式、历史压缩、全局划词。

3. **最划算的是一组“学习诊断闭环”**：难度校准 + 自适应练习 + 薄弱矩阵共用同一份 `attempts / causes` 数据，都是纯函数，能在一个迭代内落地，并且直接改变用户下一步做什么。

4. **明确不建议搬的**：Barnes-Hut 四叉树、虚拟列表、会话续聊、CJK token 估算、Dock 多标签。原因见 §5，多数是 KNOWLATTICE 已有更合适的实现，或收益不足以抵消改动面。

> 迁移边界：HelixMind 的 `AGENTS.md` 与 `scripts/compliance-check.mjs` 明确要求“只作行为参考，不复制代码/样式/测试”。本报告只提取**机制与参数**，落地时按 KNOWLATTICE 的分层、命名和测试风格重写。

---

## 1. 规模与差异（先看量级）

| 维度 | HelixMind-提交 | KNOWLATTICE 当前 | 备注 |
| --- | --- | --- | --- |
| 路由 | 45 个 / 8 组（`node scripts/routes-report.mjs` 实测） | 31 个面板（`panelRegistry.ts`；`docs/FEATURES.md` 的 33 为旧生成值） | HelixMind 用 hash 路由 + 自动收集 |
| 功能域 | 35 个 `src/features/*` | 核心域集中在 `src/core` + `src/views` | 组织方式不同，不直接可比 |
| 源文件 | 992 个（其中 ts/tsx 865） | 539 个（ts/tsx） | 本版约为旧审计 505 文件的两倍 |
| 测试文件 | 308 个 | 266 个 | 两边都有高覆盖传统 |
| 脚本 | 21 个 `.mjs/.ts` | 18 个 | HelixMind 多出路由报告、全站走查、合规/相似度 |
| 文档 | 顶层 9 份 + `docs/plans`、`docs/research` | `docs/` 20+ 份 | HelixMind 的 DESIGN.md 达 43 KB |

**判断**：HelixMind 的“大”主要来自把每个功能做成独立域（`features/<域>/{logic,store,view,css,__tests__}`）。KNOWLATTICE 的“紧凑”来自 `core` 纯函数 + `views` 面板。**不要为了对齐目录而重构**；只借它把“纯逻辑 / 存储 / 视图”分开的具体做法。

---

## 2. 优先级总表

| 优先级 | 项 | 类型 | KNOWLATTICE 现状 | 估算成本 | 主要收益 |
| --- | --- | --- | --- | --- | --- |
| P0-1 | 题目难度实证校准 | 纯函数 + 一个面板 | 只有 FSRS 难度估计，没有“标称 vs 实测” | 1–2 天 | 组卷/排序不再凭感觉 |
| P0-2 | 自适应练习队列 | 纯函数 + 入口 | 无自适应难度（`adaptiveQuality` 是渲染） | 1–2 天 | 把正确率稳定在 70% 附近 |
| P0-3 | 薄弱章节×错因矩阵 | 纯函数 + 报表 | 章节掌握度、错因分布各自独立 | 0.5–1 天 | 从“哪章差”到“为什么差、下一步做什么” |
| P0-4 | 全屏面板焦点收口 | a11y 基础设施 | 15 个 `PanelOverlay` 视图未接入统一焦点陷阱 | 0.5–1 天 | 键盘/读屏可用，32 处遮罩一次受益 |
| P0-5 | 走查脚本补溢出与截图 | 脚本 | `ui-interact` 查崩溃，不查横向溢出/留图 | 0.5 天 | 视觉回归有证据，窄屏问题提前暴露 |
| P1-1 | 分阶段互动病例训练 | 新面板 + 数据 | 只有 A3/A4 共用题干，无互动流程 | 3–5 天 + 数据 | 临床推理训练，差异化明显 |
| P1-2 | 全局划词自动引用 | 基础设施 + 面板 | 只有显式 `onAskAi`，无全局监听 | 1–2 天 | 降低“问 AI”的摩擦，且有回执 |
| P1-3 | Plan / Act 双模式 | Agent 运行时 | 有审批/白名单，无计划模式 | 0.5–1 天 | “先想清楚再动手”变成运行时约束 |
| P1-4 | 会话历史压缩 | Agent 运行时 | 只裁工具结果，不压历史 | 1 天（先确认 pi 引擎） | 长会话不爆预算、不丢任务 |
| P2-1 | 成稿引用确定性闸门 | 纯函数 | `citeVerify` 校验引文，不校验编号范围 | 0.5 天 | 导出前挡住“编造引用位置” |
| P2-2 | 数据来源 provenance | 流程/脚本 | 导入有格式校验，缺来源/许可字段 | 0.5 天 | 外部资料可追溯，降低版权风险 |
| P2-3 | 本地重活桥的边界模型 | 架构参考 | Tauri 侧已有 fs/shell，无 Node 桥 | 条件触发 | 将来接 pandoc/typst 时有安全蓝本 |

> 建议节奏：**先做 P0-1/2/3 一组**（共享数据、同一批测试），再做 P0-4/P0-5；P1 按用户价值排序，病例训练单独排期。

---

## 3. P0：先做的五件

### P0-1 题目难度实证校准（declared vs observed）

**HelixMind 证据**

- `src/features/quiz/calibration.ts:8`：`MIN_ATTEMPTS_FOR_CALIBRATION = 3`，样本不足不下结论。
- `calibration.ts:31`：标称难度对应期望正确率 `1→0.85、2→0.72、3→0.55`；`:34` 提供 `expectedAccuracy()`。
- `calibration.ts:76`：`calibrate()` 逐题输出 `ok / tooEasy / tooHard / unrated`，并给出 `delta` 与一句话说明。
- `calibration.ts:128`：`calibrationSummary()` 汇总四类计数；`calibration.ts:135` 的 `applySuggestedDifficulty()` 只改 `difficulty` 一个字段，可一键采用。
- 测试覆盖在 `src/features/quiz/__tests__/advanced.test.ts` 与 `round3.test.ts`（分别为 24 / 51 个 `it`，含校准与自适应）。

**机制**

不是“让用户再标一次难度”，而是用真实作答反推：

- 3 次以上才判定，避免一题定生死；
- 正确率 ≥85% 判“标称偏易”，≤ 期望值减一档判“标称偏难”；
- 结论带证据（正确率、建议难度），不是一句“这题太难”。

**KNOWLATTICE 现状与差距**

- `src/core/qbank.ts:28` 的 `QuizQuestion` **没有 `difficulty` 字段**；`src/core/qbankTags.ts:6,56-60` 的“难度”来自 FSRS 的 `stat.difficulty`（1–10），是模型估计，不是作者标称。
- 因此不能直接照搬“标称 vs 实测”。两条路：
  1. **推荐**：给 `QuizQuestion` 增加可选 `difficulty?: 1 | 2 | 3`（与 `answers`、`explanations`、`groupStem` 一样的增量字段），导入/导出/备份透传；未标称的题不参与校准。
  2. 不改 schema：把 FSRS 三档（`difficultyBand`）当“标称”，校准“模型说难但大家做对”的题。语义弱一些，但零迁移。

**落地**

- 新增 `src/core/qbankCalibration.ts`（纯函数）：`questionStats`、`calibrate`、`calibrationSummary`、`suggestedDifficulty`。
- 在题库工具/学习报告加一个“题目体检”表：题干、标称、实测正确率、建议、一键采用。
- 复用 `qbankStats.loadStats()` 的逐题记录，不新建 store。

**验收**

- 0/2 次作答 → `unrated`；3 次且 85% → `ok` 或 `tooEasy` 边界明确；60% 边界有测试。
- 一键采用只改 `difficulty`，题干预、选项、统计不变；导出再导入字段不丢。
- 定向：`npx vitest run src/core/__tests__/qbankCalibration.test.ts`。

**风险**：给 `QuizQuestion` 加字段会波及导入/导出的形状校验；按 KNOWLATTICE 既有“可选增量”惯例做，避免改 `answer/options` 这类既有字段。

---

### P0-2 自适应练习队列（目标正确率 70%）

**HelixMind 证据**

- `src/features/quiz/adaptive.ts:4-8`：`DEFAULT_TARGET_ACCURACY = 0.7`、`ADAPTIVE_BAND = 0.1`、`RECENT_WINDOW = 20`。
- `adaptive.ts:27` 的 `nextDifficulty()`：高于目标 +10% 升一档，低于目标 −10% 降一档，带死区防抖动。
- `adaptive.ts:68` 的 `adaptivePick()`：排除已出题、优先没做过的题、返回一句 `reason`（页面直接显示）。
- `adaptive.ts:108` 的 `adaptiveQueue()`：未作答时用“目标正确率假设”推进难度，先排出梯度，不要求用户先答完。

**机制**

把“随机抽题”换成“按最近 20 次正确率调节难度”，并解释为什么抽这道题。死区 10% 是关键：没有它，正确率会在 70% 上下每題抖一次。

**KNOWLATTICE 现状与差距**

- 无自适应难度。`src/core/adaptiveQuality.ts` 是渲染分辨率自适应；`src/core/reviewPlan.ts` 是复习时间规划，不是抽题难度。
- `QuizView` 的组卷按章节/难度/题型配额（`composing`），是静态蓝图，不随作答实时调整。

**落地**

- 在 `src/core/qbankAdaptive.ts` 实现 `recentAccuracy` / `nextDifficulty` / `adaptivePick` / `adaptiveQueue`，输入用现有 `QStat` 与题目列表。
- `QuizView` 增加“智能练习”入口：默认目标 70%，显示“最近正确率 78% → 升到难度 3”的理由；答完一题后下一次抽题重算。
- 默认练习模式不变，避免改变既有用户路径。

**验收**

- 纯函数测试：连续高正确率升档、连续低正确率降档、70%±10% 保持；无重复题；题库耗尽返回明确 `reason`。
- 交互验收：1440×900 与 380 宽各走 5 题，难度理由可见，退出再进能续上。
- 定向：`npx vitest run src/core/__tests__/qbankAdaptive.test.ts`。

**风险**：小样本（<5 次）波动大；沿用 HelixMind 的“样本不足按当前难度”策略，不要一上来就跳档。

---

### P0-3 薄弱章节 × 错因交叉矩阵

**HelixMind 证据**

- `src/features/quiz/weakness.ts:36` 的 `chapterCauseMatrix()`：章节 × 错因计数，只统计能关联到题目的错因记录。
- `weakness.ts:60` 的 `weakChapterReport()`：输出每章作答数、正确率、主要错因、未做题数、`nextStep`。
- `weakness.ts:119`：`nextStep` 是可直接显示的一句话（“先重练本章错题再刷新题” / “回到基础题，把错因对比卡过一遍”）。

**机制**

把“章节正确率”和“错因分布”两张表合成一张：某章低分，主要原因是什么，下一步做什么。它不新增数据，只改变聚合方式。

**KNOWLATTICE 现状与差距**

- `src/core/qbankStats.ts:312` 的 `ChapterMastery` 已有章节正确率与 `weak` 阈值；`src/core/mistakes.ts:20-27` 已有四类错因；`src/core/studyReport.ts:296-305` 已把薄弱章节写进报告。
- **但没有“章节 × 错因”矩阵**：`MistakeBook.tsx` 分别用 `chapterHeat` 与 `reasonCounts`，两条信息不在一个格子里；也没有 `untouched` 与 `nextStep`。

**落地**

- 在 `src/core/studyReport.ts` 或新 `qbankDiagnosis.ts` 加纯函数 `chapterCauseMatrix` / `weakChapterReport`，复用 `MASTERY_MIN_SEEN`、`MISTAKE_REASONS`。
- `MistakeBook` 增加一个可折叠矩阵（行=章节，列=四类错因，末列=正确率/未做/建议）；`StudyReportPanel` 的 Markdown 报告加一段同样内容。
- KN 的题支持多章节（`chapters?: string[]`），需要明确口径：**建议矩阵按 `chaptersOf()` 展开，同一题在每章各记一次**，与 `chapterMastery` 现有口径一致；否则会和报告里的章节正确率对不上。

**验收**

- 未关联题目的错因不计入；矩阵总数 = 可关联错因数。
- 同一题多章节时，各章计数与 `chapterMastery` 的 `seen` 口径一致。
- 空库/无错因/样本不足三种空态都有明确文案。
- 定向：`npx vitest run src/core/__tests__/studyReport.test.ts`（或新增诊断测试）。

**风险**：多章节口径最容易出“同一错因被算两次”的误解；在 UI 上标注“按章节展开，可重复计入”，并在测试里锁住。

---

### P0-4 全屏面板焦点收口

**HelixMind 证据**

- `src/features/shell/routeFocus.ts`：切路由后把焦点交给 `h1`、滚回顶部；`routeTransition` 负责 pending 态，`RouteFallback` 提供 `role="status" aria-busy` 的骨架。
- 它把“焦点跟着页面走”当成路由外壳的职责，不是每个页面各自处理。

**KNOWLATTICE 现状与差距**

- `src/views/DialogSurface.tsx:116-117` 已有 `role="dialog"` + `aria-modal="true"`，`:20/:104/:107` 有可聚焦元素查询与 Tab 首尾循环，是成熟的焦点陷阱。
- 但 `src/views/PanelOverlay.tsx:43` 只是遮罩，**没有 role / aria-modal / 初始焦点 / 焦点归还**。
- 目前 `DialogSurface` 只覆盖 10 个视图；**15 个使用 `PanelOverlay` 的视图没有接入统一焦点陷阱**（其中 `CommandPalette` / `QuickSearch` 只做了初始聚焦，没有 Tab 循环与关闭归还）：`BrainAtlasView`、`CommandPalette`、`ConvertView`、`CourseWorkshopView`、`DraftGen`、`HistoryPanel`、`ImageLibrary`、`ImportView`、`MedRefView`、`MistakeBook`、`QuickSearch`、`ReciteView`、`TagBrowser`、`VocabView`、`WordDrillView`。
- `AiAgentPanel` 是常驻浮层，也不在 `DialogSurface` 体系内。

**落地**

- 把 `DialogSurface` 里的焦点陷阱抽成 `useFocusTrap(ref, { initial, restore })`（或直接让 `PanelOverlay` 内部渲染 `DialogSurface` 的语义壳），保留 `escStack` 的显式栈不变。
- 默认初始焦点：面板标题（`h1/h2`）或关闭按钮；关闭后归还给打开它的按钮。
- 对 `AiAgentPanel` 单独处理：打开时焦点进输入框，但不抢用户正在别处输入时的焦点（只在由“问 AI”按钮触发时聚焦）。

**验收**

- 参数化 DOM 测试：逐个打开 15 个面板，`document.activeElement` 在面板内；Tab 从最后一个可聚焦元素回到第一个；Esc 关闭后焦点回到触发按钮。
- 不改变现有 `escStack` 行为：嵌套面板一次 Esc 只关最上层。
- 定向：`npx vitest run src/views/__tests__/panelFocus.dom.test.tsx`。

**风险**：`PanelOverlay` 是 32 处共用出口，改它会影响所有面板；先加可选行为 + 单测，再逐个视图切换，不要一次性全改。

---

### P0-5 走查脚本补横向溢出与截图

**HelixMind 证据**

- `scripts/ui-sweep.mjs:110-111`：每个路由执行 `document.documentElement.scrollWidth > window.innerWidth + 1`，把 `overflowX` 与 `scrollW` 写进报告。
- 同脚本从 `src/app/routes` 源码提取路由清单，用 Chrome CDP 逐页打开、收集 console/exception、截图；另有 `sweep-quiz.mjs` 做“种数据 → 截多状态（含悬停/窄屏）”。

**KNOWLATTICE 现状与差距**

- `scripts/ui-interact.mjs:77-78` 已收集 `pageerror` 与 `console.error`，`:145-147` 检查空主区与 ErrorBoundary，已经能回答“点了崩不崩”。
- **不检查横向溢出，也不留截图**；`scripts/screenshots.mjs` 有截图，但只覆盖固定几屏，不是按面板清单全覆盖。
- 因此“窄屏把面板顶爆”这类问题仍靠人眼。

**落地**

- 扩展 `ui-interact.mjs`：每个面板打开后记录 `scrollWidth/clientWidth`、`documentElement.scrollWidth`，在 1440×900 与 380×844 两档各截一张图到 `.yanagent/evidence/` 或 `ui-interact/shots/`。
- 复用现有 `SKIP_WORDS` / `HEAVY` 跳过破坏性与重面板；溢出先记为 warning，连续两次出现再升 error，避免一次性红一片。
- 报告 JSON 增加 `overflow` 与 `screenshot` 字段，便于后续对比。

**验收**

- 跑一次全量：报告包含每个已打开面板的 `overflowX`、`scrollW`、截图路径；已知重面板仍被跳过。
- 人为把某面板宽度改到 200px，脚本能报出溢出（自测）。
- 命令：`BASE_URL=http://localhost:5175 node scripts/ui-interact.mjs`。

**风险**：无头浏览器对 3D/PDF/视频面板不稳定，沿用现有 `HEAVY` 跳过策略，不强行覆盖。

---

## 4. P1：值得做，但要单独排期

### P1-1 分阶段互动病例训练

**HelixMind 证据**

- `src/features/casework/types.ts:65`：`SessionStep = "interview" | "examine" | "diagnose" | "treat" | "result"`，流程是硬状态机。
- `CaseworkView.tsx`（348 行）：问诊 → 检查 → 诊断 → 处置 → 结果；问过的问题、开过的检查、选过的处置分别累计。
- `casework/logic.ts:8-11`：`PASS_SCORE=80`、诊断 60、关键处置 25、关键问诊 15、误选处置 −5/项；`:45` 的 `evaluateCase()` 是纯函数，返回分项得分、漏问、漏处置、误选与正确诊断。
- `casework/store.ts`：只存 `attempts/best/last/passed` 四个数，localStorage，失败不影响使用。
- 测试：`logic.test.ts` 10 个 `it` + `caseworkView.test.tsx` 3 个 `it`。
- 数据：`public/clinic/cases.json`，`scripts/case-import.mjs:125` 写入 `provenance`，并有 `NOTICE`。

**KNOWLATTICE 现状与差距**

- `src/core/qbank.ts:85-87` 与 `:521-523` 已支持 A3/A4 共用题干（`groupStem/groupNo/groupTotal/groupId`），**但只是“一段材料 + 若干小问”**，没有“先问诊、再开检查、再诊断、再处置”的互动流程，也没有按关键问诊/关键处置评分。
- 现有题库的病例组可以直接作为素材来源，不必从零造数据。

**两条落地路径**

1. **完整版**：新增 `src/views/CaseworkView.tsx` + `src/core/casework.ts`（评分纯函数）+ `src/storage`（进度）；数据沿用 HelixMind 的 schema（病例、问诊项、检查项、诊断、关键处置）。成本 3–5 天 + 数据整理。
2. **轻量版**：只做“病例材料 + 分步问答 + 关键点自评”，复用现有 A3/A4 组，不引入新数据格式。成本 1–2 天，但训练感弱。

**验收**

- 评分边界：诊断错但处置全 → 40 分左右；诊断对、关键处置全、关键问诊一半 → 约 92 分；误选 4 项 → 扣 20。
- 流程：不能跳步；中途退出不丢已问项；完成后进度落盘，重进可重练。
- 无障碍：每个步骤有标题与说明，键盘可完成全流程。
- 定向：`npx vitest run src/core/__tests__/casework.test.ts`。

**风险**：病例内容涉及医学准确性与版权；只使用自制/已授权材料，并在导入文件里保留 `provenance` 与 NOTICE。

---

### P1-2 全局划词自动引用（带回执）

**HelixMind 证据**

- `src/features/agent/selectionBridge.ts:17`：`MIN_SELECTION_CHARS = 4`，少于 4 字不打扰。
- `:21`：`SKIP_SELECTOR = "[data-no-quote], .agent"`，排除输入框、Agent 面板自身、显式禁区。
- `:53` 的 `readLiveSelection()`：折叠选区、跨节点选区、来源标签（`data-quote-source` → 最近标题 → 区域标题 → “当前页面”）都有处理。
- `:84` 的 `watchSelection()`：`selectionchange` + `pointerup/keyup` 防抖 160ms，同一段文字不重复回调。
- README 还规定：输入框上方必须有引用卡片（来源 + 字数 + 原文预览 + 取消），发出后气泡内保留引用条；`MAX_QUOTE_CHARS = 4000`，超出部分省略并注明。

**KNOWLATTICE 现状与差距**

- `src/views/agentChat.ts:16` 已有 `QuoteSelection`（text/path/ask），`AiAgentPanel` 有 `pendingQuote` 与引用卡；编辑器、错题本、题库、复习卡通过 `onAskAi` 显式传入。
- **没有全局 `selectionchange` 监听**：`src/views/PdfSplitView.tsx:276` 只在 PDF 分屏里读选区。用户在笔记/题库里划词后打开 AI 面板，面板看不到那段文字。
- 这正是 HelixMind README 强调的“先划词再展开是常见顺序，只靠事件会看起来没看见”。

**落地**

- 新增 `src/core/liveSelection.ts`（纯 DOM，不依赖 React）：`readLiveSelection`、`watchSelection`、`sourceOf`。
- `AiAgentPanel` 挂载时先读一次当前选区，再订阅；输入框上方显示引用卡；用户手动引用优先，页面选区不叠加。
- 上限 4000 字，卡片显示实际字数；设置里加“划词时自动带进提问”开关，关闭后不挂监听。
- 排除输入框、面板自身、`[data-no-quote]`；Agent 面板内复制回答不触发。

**验收**

- 在笔记/题库/PDF 划词 → 打开面板，引用卡显示来源与字数；在输入框内划词不触发；在 Agent 回答里划词不触发。
- 选超长段落 → 只带 4000 字并注明省略；关闭开关后不再出现引用卡。
- 定向 DOM 测试：`npx vitest run src/core/__tests__/liveSelection.test.ts`。

**风险**：`selectionchange` 在拖选时高频触发；必须防抖并做“同文不重复”判断，否则面板会抖。

---

### P1-3 Plan / Act 双模式（运行时约束，不是提示词）

**HelixMind 证据**

- `src/features/agent/governance.ts:147`：`AgentMode = "plan" | "act"`；`:156` 的 `planModeFeedback()` 明确回填“当前是计划模式，工具没有执行，请把改动写成方案”。
- `:172` 的 `approvalPlan()` 区分 `interactive` 与自动放行；白名单检查独立于 `writeMode`，auto 只免点击，不放宽权限。
- runtime 在 `mode === "plan"` 时**拒绝写工具**：不弹审批、不执行、回填说明；只读工具照常。README 强调这是运行时约束，不是提示词里的一句劝告。

**KNOWLATTICE 现状与差距**

- `src/core/agentGovernance.ts` 已有 `requiresConfirmation`、`approvalStatus`、执行/验证状态、回滚钩子与白名单（`:26/:50/:71/:231`）。
- **没有 `plan` 模式**：全局搜索 `AgentMode / 计划模式 / 执行模式` 无命中。现在只能靠提示词或用户自己克制。
- 现有 `propose_*` 两段式已经能“先出 diff 再落库”，所以加模式的成本很低。

**落地**

- `agentChat.ts` 的 `AgentPrefs` 增加 `mode: 'plan' | 'act'`（按会话持久化，默认 `act`，避免改变老用户行为）。
- 在 `agentGovernance` 的执行入口判断：`mode === 'plan'` 时，对 `toolType === 'write'` 直接返回 `rejected` + `planModeFeedback`，不进入审批队列；只读工具继续。
- UI 在面板顶部显示“计划/执行”切换与说明；切到执行时不需要重新发一遍任务。

**验收**

- 计划模式下让 Agent 写笔记：不产生提案卡、不写库，消息里出现“当前是计划模式…”。
- 切到执行模式后同一任务可以正常出 diff；只读工具在两种模式下都能用。
- 定向：`npx vitest run src/core/__tests__/agentGovernance.test.ts`（补 plan 分支）。

**风险**：工具分类必须准确；现有治理元数据已经区分 `toolType`，直接复用，不要另立一套名单。

---

### P1-4 会话历史压缩（护住首条任务）

**HelixMind 证据**

- `src/features/agent/contextUsage.ts:93`：单条工具结果上限 3000 字符，超出截断并提示“用更具体的参数重调”。
- `:117`：`COMPRESS_AT = 0.7`，占用到 70% 就压，不等爆窗。
- `:146` 的 `compressForAgent()`：保留 system + **首条用户任务** + 最近 8 条，中间折成摘要；`:161` 明确“只丢一两条时不压，摘要本身也要花 token”。
- 摘要会写“已压缩 N 条：M 次提问、K 条工具结果，要旧数据请重新调用工具，不要凭记忆编”。

**KNOWLATTICE 现状与差距**

- `src/core/aiBudget.ts:35` 的 `trimToolResults()` 只处理工具结果：从最新往回累加，超 40k 的更早结果换成占位说明；单条 `capToolResult` 保留首尾。
- **没有对“用户/助手历史消息”的压缩**；`aiBudget.ts` 的注释也承认“工具结果是唯一会无上限长大的输入”，但长会话里用户消息同样会累积。
- 需要先确认 `@earendil-works/pi-agent-core` 是否已自带上下文裁剪；如果已有，只补内置引擎路径，避免双份逻辑。

**落地**

- 在 `src/core/aiBudget.ts` 增加纯函数 `compressHistory(messages, budget, { keepRecent: 8, threshold: 0.7 })`：保留 system、首条非工具 user、最近 N 条；不足 3 条可丢时不压。
- 返回 `{ messages, dropped, summary, before, after }`，UI 只显示“已压缩 N 条 / 约省 X token”；界面里的完整历史不动。
- 摘要文案明确“旧数据请重新调用工具”，防止模型凭记忆编。

**验收**

- 构造 60 条历史：压缩后 system + 首条任务 + 最近 8 条仍在；`dropped < 3` 时原样返回。
- 压缩只作用于发给模型的 `wire`，`ChatItem` 列表与导出不变。
- 长会话（>40 轮）不再因上下文超限丢最早任务。
- 定向：`npx vitest run src/core/__tests__/aiBudget.test.ts`。

**风险**：pi 引擎可能已有自己的窗口管理；先读依赖文档/源码确认，再决定是否只改内置引擎。

---

## 5. P2：条件触发，不要现在做

### P2-1 成稿引用确定性闸门

- `src/features/research/server/report-gate.mjs:41` 的 `validateManuscript()`：`:54` 参考文献空条目 → error；`:61` 正文引用编号超出参考文献范围 → error（“典型的编造引用位置”）；`:67` 有参考文献但正文未引用 → warning；样本量/p 值只提示不阻断。
- KNOWLATTICE 的 `src/core/citeVerify.ts` 已经能逐字核验引文（exact/partial/fabricated/not_found），比 HelixMind 更强；但**不检查编号范围与空条目**。
- 只有当 KNOWLATTICE 增加“手稿/论文导出”时才值得补；纯函数 0.5 天，接到导出前。

### P2-2 外部数据的 provenance

- HelixMind 的 `scripts/case-import.mjs:125` 在生成的 JSON 里写 `provenance`，并配 `public/clinic/NOTICE`；`AGENTS.md` 对第三方资产有逐项例外与署名链。
- KNOWLATTICE 导入教材/题库时，建议至少记录：来源、许可、抓取/转换脚本、生成时间；数据包与 NOTICE 一起走。属于流程改进，不是功能。

### P2-3 本地重活桥的边界模型（仅将来接 Node 工具时）

- `src/features/research/server/bridge.mjs`：只监听回环；Origin 白名单按“回环 + 任意端口”而不是写死 5180；`MAX_BODY = 12MB`；provider 白名单（deepseek/kimi/shared）；`commandPath()` 用 `where/which` 解析；`controlledEnv` 控制子进程环境；临时目录清理；长任务用 job + 轮询。
- KNOWLATTICE 是 Tauri 桌面端，已有 fs/shell 权限，**现在不需要 Node 桥**；如果将来接 pandoc/typst/PDF 重排，再参考这套边界，不要直接搬一个常驻 HTTP 服务进来。

---

## 6. 明确不建议搬（含理由）

| 项 | HelixMind 的做法 | 为什么不建议 |
| --- | --- | --- |
| Barnes-Hut 四叉树 | `notes/quadtree.ts`，O(n²) → O(n log n)，1000 节点误差 <1% | KNOWLATTICE 的 `GraphView` 用 `force-graph`（`package.json`），库内部已有力导向优化；自己再写一套只会多一份要维护的近似算法，且要和库的坐标/缩放对齐。 |
| 虚拟列表 | `VirtualRows` 超过 200 条才虚拟滚动，固定行高 | KNOWLATTICE 搜题结果已硬截 60 条（`QuizView.tsx:1622`），题库列表按库/章节聚合，没有“一次铺几千行”的页面；先测再决定，不要为假想规模加复杂度。 |
| 会话续聊 / trace | 20 个会话、60 条消息、单条 6000 字 | KNOWLATTICE 已有 `AgentSession` 持久化（`agentChat.ts:24` 的 `SESSIONS_LIMIT=20`）、`agentTrace` 与 intent/重复检测；再搬一套会形成第二套会话模型。 |
| CJK token 估算 | 汉字 1 token、ASCII 3.5 字符/token | KNOWLATTICE 已经按 CJK 单独计数（`aiAgent.ts:110-113`），只是 ASCII 用 4 而不是 3.5；差异 <15%，不值得改。 |
| Dock 多标签 | 右栏可堆叠多个面板标签 | KNOWLATTICE 的面板是 `panelRegistry` 单例互斥 + `useDockSplit` 宽度记忆，多标签会和“整屏模态互斥”语义打架；现有视频+AI 笔记共存已够用。 |
| 桌宠 / VRM | `@pixiv/three-vrm`、`features/pet` | 与学习主线无关，新增 3D 依赖会推高主包/按需包预算；不符合当前产品边界。 |
| 完整科研 Node 桥 | Word/Typst/PDF 导出、引用追踪、任务队列 | 体量大、打包与安全成本高；KNOWLATTICE 的科研需求尚未到“成稿排版”这一步。 |
| 合规相似度门禁 | shingle Jaccard 对比本机既有项目 | 这是 HelixMind 比赛期的自我约束，不应把“和别的项目像不像”变成 KNOWLATTICE 的常规门禁；可借“依赖白名单”这一条习惯。 |

---

## 7. 建议落地顺序

### 第 1 周：学习诊断闭环（P0-1/2/3）

1. `qbankCalibration.ts` + 单测（纯函数先绿）。
2. `qbankAdaptive.ts` + 单测。
3. `chapterCauseMatrix` / `weakChapterReport` + 单测。
4. 三个入口接到题库工具/错题本/学习报告；默认路径不变。
5. 一次真实数据走查：导入 1 个 ≥200 题的库，答 20 题，确认校准、抽题理由、矩阵数字互相对得上。

**为什么打包做**：三者共用 `QStat` 与 `MISTAKE_REASONS`，分开做会重复读数据、重复写阈值；一起做只新增一个诊断模块。

### 第 2 周：体验与 Agent（P0-4/5、P1-2/3/4）

1. 焦点收口（先抽 hook + 单测，再逐视图接）。
2. `ui-interact` 补溢出与截图。
3. 全局划词引用（先笔记 + 题库，再 PDF）。
4. Plan/Act（治理层先加，UI 后加）。
5. 历史压缩（确认 pi 引擎后决定范围）。

### 独立排期：互动病例（P1-1）

先做“轻量版”验证用户是否愿意按阶段走，再决定是否投入完整病例数据。数据整理往往比代码更耗时。

---

## 8. 验收命令

按 KNOWLATTICE 的既有链路，**每项改动至少跑定向测试 + lint**；合并前跑全量：

```bash
npx tsc -b
npm run lint
npx vitest run
npm run build
npm run test:e2e
```

- 纯函数项（P0-1/2/3、P1-3/4）：定向 `vitest` + `tsc -b`。
- 面板/交互项（P0-4、P1-1/2）：定向 DOM 测试 + 1440×900 / 380×844 浏览器走查，记录横向溢出量。
- 脚本项（P0-5）：`BASE_URL=... node scripts/ui-interact.mjs`，检查 `report.json` 的 `overflow` 与截图路径。
- 既有基线：lint 的 2 条 `researchPlot` warning 属已知；体积预算约 700 KB，改动后不得为过检放宽阈值。

---

## 9. 证据索引

### HelixMind（可借鉴机制的出处）

| 主题 | 文件:行 |
| --- | --- |
| 难度校准阈值与判定 | `src/features/quiz/calibration.ts:8,31,76,128,135` |
| 自适应目标/死区/窗口 | `src/features/quiz/adaptive.ts:4,6,8,27,68,108` |
| 章节×错因矩阵与下一步 | `src/features/quiz/weakness.ts:36,60,119` |
| 互动病例状态机 | `src/features/casework/types.ts:65` |
| 病例评分公式 | `src/features/casework/logic.ts:8-11,45` |
| 病例数据 provenance | `scripts/case-import.mjs:125` |
| 全局划词桥 | `src/features/agent/selectionBridge.ts:17,21,53,84` |
| Plan/Act 运行时 | `src/features/agent/governance.ts:147,156,172` |
| 历史压缩护首条任务 | `src/features/agent/contextUsage.ts:93,117,146,161` |
| trace 上限与学习小结 | `src/features/agent/trace.ts:9,11,12,54` |
| 全站走查溢出 | `scripts/ui-sweep.mjs:110-111` |
| 成稿引用闸门 | `src/features/research/server/report-gate.mjs:41,54,61,67` |
| 四叉树（明确不搬） | `src/features/notes/quadtree.ts:1-6` |
| 虚拟列表（暂不搬） | `src/features/quiz/virtualList.ts`、`VirtualRows.tsx` |
| 设计规则→验收 | `DESIGN.md:313`（inkTheme 12 条）、`:346`（六条硬规则） |

### KNOWLATTICE（差距/现状的出处）

| 主题 | 文件:行 |
| --- | --- |
| 题目模型无标称难度 | `src/core/qbank.ts:28-96` |
| 难度来自 FSRS | `src/core/qbankTags.ts:6,56-60` |
| 章节掌握度 | `src/core/qbankStats.ts:312-360` |
| 四类错因 | `src/core/mistakes.ts:20-27` |
| 学习报告薄弱章节 | `src/core/studyReport.ts:296-305` |
| 共用题干 A3/A4 | `src/core/qbank.ts:85-87,521-523` |
| 会话持久化上限 | `src/views/agentChat.ts:16,24` |
| 显式引用类型 | `src/views/agentChat.ts:16` |
| 只有 PDF 内读选区 | `src/views/PdfSplitView.tsx:276` |
| 只裁工具结果 | `src/core/aiBudget.ts:35-56` |
| 无 Plan/Act | 全库搜索 `AgentMode / 计划模式` 无命中 |
| 焦点陷阱只覆盖 10 视图 | `src/views/DialogSurface.tsx:20,104,107,116-117` |
| 15 个 overlay 未用陷阱 | `src/views/PanelOverlay.tsx:43` + §3 P0-4 清单 |
| 走查不查溢出 | `scripts/ui-interact.mjs:77-78,145-147` |
| 搜题结果截 60 | `src/views/QuizView.tsx:1622` |
| Dock 键盘缩放已有 | `src/views/useDockSplit.ts:342` |

---

## 10. 一句话建议

**先把“答题数据 → 难度诊断 → 自适应抽题 → 薄弱章节×错因处方”做成一条闭环（P0-1/2/3），再用 P0-4/P0-5 补齐可访问性与视觉回归；互动病例作为独立产品迭代，不要和诊断闭环混在一个 PR 里。** Agent 侧只补 Plan/Act、历史压缩、全局划词三个缺口，其余保持 KNOWLATTICE 现有优势。

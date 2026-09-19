# 晶格 · KnowLattice

一款为医学生而生、也适合所有学习者的**本地优先个人知识笔记软件**。当前为**纯 Web 版**（存储走 IndexedDB，后续套 Tauri 壳零改动）。

## 运行

```bash
npm install
npm run dev      # http://localhost:5173
```

其他命令：`npm run build`（类型检查 + 打包）、`npm run lint`（oxlint）、`npm run preview`（预览构建产物）。

## 已实现功能

### 笔记核心（M1~M3）

- 三栏主界面：章节树 | CodeMirror 编辑器 | 实时预览
- 新建笔记自动填 frontmatter 模板（aliases/tags/chapter/source/created）
- 「属性: 内容」键值对在预览中自动加粗
- Ctrl+S 保存；删除笔记；图片粘贴保存到 `_attachments/`
- `[[双链]]`：输入自动补全（文件名/标题/alias），点击跳转，反链面板
- Ctrl+K 快速搜索：标题模糊匹配 + 全文搜索（MiniSearch + 中文 bigram）+ 最近打开排序

### 3D 解剖图谱（M5）

- 基于 [Anatria-3D](https://github.com/Nurkan1/Anatria-3D)（Apache-2.0 代码 + CC BY-SA 4.0 模型，HuBMAP 人类参考图谱源）
- 12 系统 × 3478 结构，Draco 压缩 GLB 按系统懒加载，three.js 原生渲染
- 结构中英文对照搜索；点击结构 ↔ 笔记双向打通（无笔记时一键创建并自动填 chapter）
- 合规：保留 NOTICE 与 manifest 内 attribution 展示

### 间隔复习 SRS（M6）

- 原子笔记自动生成复习卡（正面 = 标题 + 属性键，背面 = 内容）
- FSRS（ts-fsrs）遗忘曲线调度，每日复习队列；口诀卡片优先提示口诀

### 真题锚点 + 错题本（M7）

- 笔记 frontmatter `exam:` 字段标记历年真题
- 错题归档到章节，薄弱点直达对应原子笔记

### 知识图谱（三期）

- 类 Obsidian 全库双链网络图：笔记为节点、`[[双链]]` 为边，canvas 力导向布局
- 拖拽节点重新布局、滚轮缩放、空白平移；悬停高亮邻域，单击节点直达笔记
- 节点颜色按一级章节区分，节点大小 = 连接度

### 题库练习（三期）

- 导入 JSON 题库（文件或粘贴，兼容中英文字段名，格式见「题库练习」面板内说明）
- 随机组卷逐题作答：选择题点击判分，简答题显示答案后自判
- 答错且题目标注了关联笔记时，自动收录进错题本；结果页错题可直达笔记
- 项目根目录附 `样例题库.json` 可直接导入体验

### 新手引导（M8 · 医学生零门槛）

- 新建笔记向导：选「概念/疾病/机制/检查/口诀/空白」类型，自动生成对应骨架填空
- 编辑器格式工具栏：撤销 / 重做 / 加粗 / 列表 / 缩进 / 双链 / 口诀按钮，悬停查看快捷键
- 行内格式快捷键（与工具栏按钮同一段实现）：**Ctrl/⌘+B 加粗**、**Ctrl/⌘+H 高亮**、**Alt+K 插入双链**（都是两个键）；加粗/高亮再按一次即取消，空选区按下会插入占位文字并选中它（直接打字即替换）。双链插入后自动弹出笔记名候选（含 alias），回车即可连上。撤销/重做仍为 Ctrl/⌘+Z、Ctrl+Shift+Z、Ctrl+Y
- 所见即所得混合预览：光标所在行显示源码，其余行实时渲染排版（标题/列表/引用/加粗/双链等），眼睛按钮切换
- 首次启动自动创建「三分钟上手」示例笔记；空状态三步教学

### AI 助手（M8）

- 侧栏内嵌免费网页 AI 问答（Kimi / 智谱清言 / 通义千问 / 元宝 可内嵌，DeepSeek 需新窗口），避免学习时来回切屏

### 智能草稿（M9）

- 粘贴讲义段落或导入 PDF（pdf.js 提取文字），一键生成原子笔记骨架（识别定义/来源/机制/作用/分类/鉴别等语义）
- **自动识别序号序列**（1、/一、/A./①），教材编号结构原样保留为有序列表
- 人工审核修改后入库，自动按章节归类

### PDF 讲义对照视图（M9）

- 左侧 react-pdf-viewer 渲染 PDF 原版（可选中文本层/缩放/翻页/搜索），上次使用的 PDF 自动恢复；Word(.docx) 由 docx-preview 还原排版
- 划选重点 → 右侧生成**原文摘录**（自动清理 PDF 中文排版空格，不再拆分为“作用 / 要点 / 内容”）
- 可新建笔记，或选择已有目标笔记连续追加多段摘录；保存后自动保留目标笔记，避免重复写入上一段
- **摘录历史**：划选记录自动留存，可回填编辑、标记已入库状态
- 示例文件 `public/sample-lecture.pdf` 可直接体验完整流程

### 数据管理

- 一键备份/恢复（.json，含 SRS 进度/题库/错题；v2 格式，旧版备份兼容导入，旧版 dataURL 附件自动迁移为 Blob）
- **导出为 md 文件夹(.zip)**：真实 Markdown 目录结构（含 [[双链]]/frontmatter 与图片附件原文件），可直接用 Obsidian/记事本打开——数据永不锁定
- 存储适配器抽象：`storage/web.ts`（IndexedDB：笔记 files store + 附件 attachments store）↔ `storage/tauri.ts`（M4 接入）

## 项目进度

> 最近更新：2026-09-18 · 入口包 `dist/assets/index-*.js` 约 321 KB（gzip 105 KB；图谱/PDF/公式等按需分块加载），`npm test`（275 项）、`npm run build` 与 `npm run lint` 均通过。

### 最近更新（2026-09-18）

- **通路图 + 简易表格收口**：两项新能力做了一轮可用性与可读性精修，不改语义。
- **通路图泳道标题对比度**：标题色改为「原色向正文色混合 30%」，浅/深主题自动适配；实测浅色最差 4.73:1、深色最差 7.96:1（≥ WCAG AA 4.5:1），用户在笔记里写的 `#hex` 同样自适应。渲染器改用**内容派生的稳定 SVG id**并按源码缓存结果，同一张图不再每次重渲染都生成新 id、重复拼 SVG。
- **简易表格**：选择器格子由 16px 放大到 20px、间距 5px（24px 节距，命中 WCAG 2.2 目标尺寸下限）；菜单改为锚定触发按钮并做视口夹紧，不再依赖工具栏硬编码高度；工具栏 `▦` 控件与全站统一到 28px。
- **渲染纯度**：编辑器表格面板所依赖的选区移出渲染期读取，改由 CodeMirror `updateListener` 同步，面板打开后选区变化能即时反映到「转成表格」入口。
- **设计出口**：新增 `--font-hand` 字体变量，通路图手写字体不再内联硬编码。

### 最近更新（2026-09-15）

- **面板排版收敛到 6 级标尺**：功能面板此前 26 种字号散在 184 处声明里，同一个「按钮」角色出现过 12 / 12.5 / 13 / 13.3 / 13.5px，同一个「小字说明」出现过 11 / 11.5 / 12 / 12.5px。现在 `:root` 只留 `--fs-micro / caption / control / body / title / lead` 六级，同角色在任何面板同字号、同字重、同行高。
- **修掉表单控件的字体泄漏**：`button` / `input` / `select` / `textarea` 默认不继承排版，此前只给 button 补了 `font-family`，于是输入框与下拉框实测解析成 **Arial 13.3333px**、纯图标按钮吃 UA 的 13.3333px。改为一次性 `font: inherit`，控件文字回归面板字体（实测各面板 UA 泄漏 0 处）。
- **脑图谱汉化**：Harvard-Oxford 117 个脑区（96 皮层 + 21 皮层下）补齐中文名，左右由基名派生；列表以中文为主标签、英文原名进悬停提示与坐标读数，检索中英文皆可。
- **「三分钟上手」升级为真正的上手文档**：从原来的一页速记扩成九节（建第一篇 → 三个动作 → 快捷键总表 → 讲义转笔记 → 间隔复习 → 题库错题 → 图谱 → 数据备份），每条都写清点哪里、按哪个键。老用户库里那篇若仍是当初自动生成的原样（一个字没改），下次打开会静默升级；改过或已删除则一律不动。
- **行内格式快捷键**：加粗 / 高亮 / 双链此前只能点工具栏或手打标记，现在 **Ctrl/⌘+B**、**Ctrl/⌘+H**、**Alt+K** 都是「一个修饰键 + 一个键」；加粗与高亮做成开关（再按一次取消），空选区按下插入占位文字并选中。三键与工具栏按钮共用 `core/mdFormat.ts` 里的同一段纯函数，避免「点按钮能取消、按快捷键只会再套一层」。顺带修掉全局 `Ctrl+K` 快速搜索对带修饰键组合的误判（并让它尊重编辑器已处理的按键），以及双链插入后中文输入等不到候选补全的问题。
- **左侧导航轨图标重绘**：取消「同一形状叠两层（淡填充 + 描边）」的旧画法——20px 下那层淡填充就是一片灰，描边从 1.4 到 2.1 不等。现在一个形状一条路径、统一 24 网格 / 1.75 描边，剪影可辨；同时修正语义：目录改用章节树（原先误用「文件夹+向下箭头」即导出图标）、解剖图谱加断面线、格式转换去掉会被读成「刷新」的圆环，并修掉 `IconFolderIn` 与 `IconFolder` 共用同一组路径（导入箭头方向根本没反过来）的缺陷。

### 最近更新（2026-09-08）

- **PDF 对照摘录优化**：摘录改为保留原文，修复 PDF 文本层导致的中文间异常空格。
- **同笔记多次摘录**：可选择已有目标笔记连续追加；连续划选会先合并到待保存草稿，保存后清空草稿，避免新划选覆盖未保存内容或重复追加。

### 已完成

- **M1~M3 笔记核心**：三栏界面、frontmatter 模板、`[[双链]]` 补全与反链、Ctrl+K 全文搜索、编辑器撤销/重做
- **M5 3D 解剖图谱**：Anatria-3D 数据，12 系统 × 3478 结构，与笔记双向打通
- **M6 间隔复习**：FSRS（ts-fsrs）调度、每日队列、.apkg / .txt 导出
- **M7 真题锚点 + 错题本**：`exam:` 标记、章节薄弱点热力图
- **三期**：知识图谱（force-graph）、题库练习（JSON/Word/Excel 导入 + 随机组卷 + 错题收录）
- **M8 新手引导 + AI 侧栏**：类型向导、所见即所得混合预览、内嵌网页 AI
- **M9 智能草稿 + PDF/Word 对照**：结构化智能草稿、原文摘录、同笔记多次追加、摘录历史、docx-preview 原版排版
- **数据管理**：备份/恢复、导出 md 文件夹(.zip)、IndexedDB 双库（笔记 + Blob 附件）
- **性能与体验打磨**：主包瘦身（2.63MB → 778KB）、重依赖懒加载、树虚拟滚动、搜索/链接索引增量更新、附件 Blob 化、全文索引异步分块构建、QuickSearch top 20、撤销/重做按钮
- **部署路径兼容**：资源路径全部改为基于 `import.meta.env.BASE_URL`，适配 GitHub Pages / 国内静态托管子路径
- **撤销/重做**：编辑器工具栏新增撤销/重做按钮，快捷键 Ctrl/⌘+Z、Ctrl+Shift+Z、Ctrl+Y

### 待定 / 未继续

- **Tauri 桌面封装**：已生成 `src-tauri/` 草稿（Cargo.toml / tauri.conf.json / capabilities / main.rs），**未安装依赖、未构建、未验证**。用户决定先自行体验 Web/PWA 后再决定是否继续封装。
- **PWA 启用**：manifest/图标已就绪，Service Worker 仍停用，待部署方案确定后再开。

### 下一步候选（按优先级）

1. 图片附件批量导入（医学联合约 1GB 图片 → vault，预览显示）
2. 决定体验分发方式：国内静态托管 + PWA（发链接）或 Tauri 桌面包（离线安装）
3. 学习打卡细化（日历/周报）
4. WebDAV 同步（坚果云免费版）



## 目录结构

```
src/
├─ core/
│  ├─ vault.ts         # 文件树 + 文档/附件缓存 + 备份/恢复
│  ├─ parser.ts        # frontmatter 解析（带缓存）/ 笔记模板
│  ├─ linkIndex.ts     # 双链/反链索引（增量更新）
│  ├─ searchIndex.ts   # MiniSearch + 中文 bigram（异步分块构建）
│  ├─ anatomy.ts       # 解剖 manifest/中文词典加载（3D 图谱共享数据层）
│  ├─ srs.ts           # FSRS 复习调度 + .apkg 导出
│  ├─ mistakes.ts      # 错题归档
│  ├─ qbank.ts         # 题库导入解析 + 组卷
│  ├─ noteGen.ts       # 智能草稿规则引擎
│  ├─ pdfLib.ts        # pdf.js 懒加载 + 最近 PDF
│  ├─ anki.ts          # Anki .apkg 打包（sql.js）
│  ├─ stats.ts / demo.ts / theme.ts / tooltip.ts / livePreview.ts
├─ storage/            # 存储适配器（web = IndexedDB 双库 / tauri = fs 占位）
└─ views/              # Workspace / ChapterTree / Editor / Preview / QuickSearch
                       # AnatomyBrowser / AnatomyViewer3D / ReviewView / MistakeBook
                       # GraphView（知识图谱）/ QuizView（题库练习）
                       # MindMapView / PdfSplitView / DraftGen / TodoView / TagBrowser / Dashboard / AiPanel
```
> 另：`src-tauri/` 为 Tauri 桌面封装草稿，当前**未启用/未构建**，待体验 Web 版后再决定是否继续。

## 打包与分发

### 网页版（推荐，发链接就能用）

```bash
npm install
npm run build
```

- dist/ 是纯静态产物，上传到任意静态托管即可（GitHub Pages / Vercel / 对象存储）。
- 已内置 PWA 清单：手机浏览器可「添加到主屏幕」当 App 用。
- 数据只存在本机浏览器（IndexedDB）：换设备或清缓存会丢，请定期「导出备份」。

### 离线便携包（发给别人，接收方零安装）

```bash
npm run pack                 # 构建 + 打成一个 zip
npm run pack -- --no-build   # 跳过构建，用现有 dist
npm run pack -- --data 某份备份.json   # 指定随包资料
```

产出仓库根目录 `KnowLattice-离线版-YYYY-MM-DD.zip`，结构：

```
Start-KnowLattice.bat   双击启动（内部起一个只监听 127.0.0.1 的小服务，无依赖、无需安装）
server.ps1           该服务本体（Windows 自带 PowerShell 5.1 即可）
app/                 构建产物（全部功能，离线可用）
data/notes-and-qbanks.json   随包笔记 + 题库（由备份 .json 合并而来）
README.txt           给接收方的一页说明
THIRD-PARTY-NOTICES.md
```

- 为什么需要一个小服务：产物是 ES module + WASM，浏览器用 `file://` 打开会被 CORS 拦，必须经 HTTP 提供；服务只绑定本机回环地址，不联网、不上传数据。
- 随包资料来自仓库根目录的 `knowlattice-*.json`（应用导出的备份），按 `files` 路径**去重合并**、`qbanks` 合并；因此多份备份会被合成一份。
- 想带上「应用里刚改过的最新笔记」：先在应用里「⋯ → 备份到 .json」，再 `npm run pack -- --data <刚导出的文件>`。

### 桌面版（Tauri，可选）

```bash
npm i -D @tauri-apps/cli
npm run tauri build
```

- 需在目标系统本机构建（Windows 出安装包、macOS 出 dmg），并安装 Rust 与系统构建工具。
- 当前存储仍走 IndexedDB（storage/tauri.ts 为占位），套壳即可运行。

## 第三方数据与许可

完整清单见 THIRD-PARTY-NOTICES.md 与 public/*/NOTICE。要点：

- 3D 解剖模型：Anatria-3D / Z-Anatomy / BodyParts3D（CC BY-SA 4.0 / 2.1 JP）。
- 脑图谱：MNI152 模板 + Harvard-Oxford 分区，科研用途，商用前请核对条款。
- 依赖库：anydoc（MIT）、niivue（BSD-2）、pdf.js（Apache-2.0）等。

## 已知限制

- 扫描版 PDF 无文字层时无法提取，请先 OCR。
- xlsx 依赖走 SheetJS CDN，网络受限时可能装不上。
- 不要跨平台拷贝 node_modules，换系统请删掉重装。

## 本轮新增

- 脑图谱：MNI152 模板 MRI + Harvard-Oxford 脑区，3D 与断层同坐标对照。
- 转换器新增 anydoc（WASM）引擎，Word / PDF 转 Markdown 更稳。
- 14 个功能界面统一面板骨架（全屏 / 浮层两类）。

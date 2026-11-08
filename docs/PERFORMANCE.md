# PERFORMANCE · 体积、时延与测试预算

> 数字来自本机实测（Windows 11 / Node 24 / 2026-11-04）。机器不同会浮动；
> 这里记的是「预算线 + 当前值」，不是不可变的验收值。

## 一条命令

```bash
npm run build        # tsc -b + vite build + 产物断言 + 体积预算
npm run bench        # vitest bench --run（5000 篇合成笔记的性能基线）
npm test             # 全量单测（267 个文件通过 / 4 个跳过）
```

## 产物体积（`scripts/size-budget.mjs`）

| 项 | 实测 | 预算 |
| --- | --- | --- |
| 主包 `index-*.js` | 671.4 KB | 700.0 KB |
| 产品 JS 总量（不含按需重依赖） | 2883.6 KB | 3481.6 KB |
| 编辑器按需（CodeMirror） | 1110.1 KB | 1200.0 KB |
| 3D / 影像按需（three / niivue / numcodecs / draco） | 3667.1 KB | 4300.8 KB |
| PDF 按需（pdfjs） | 689.0 KB | 800.0 KB |
| 文档表格按需（xlsx / sql.js / mammoth / docx / tesseract / jszip） | 468.1 KB | 1200.0 KB |
| Agent 运行时按需（pi-ai / 面板） | 412.3 KB | 800.0 KB |
| 首屏 js 请求数 | 5 | 8 |

规则：
- 主包是首屏唯一必经脚本，**谁加东西谁负责**；新面板优先 `lazy()`，别静态 import 进 `Workspace`。
- 重依赖（3D / PDF / 编辑器 / 表格）必须按需 chunk，各自单列一条线。
- 超预算直接非零退出，接在 `npm run build` 链尾。

## 时延基线（`src/core/__tests__/perf.bench.ts`）

5000 篇合成笔记 / 3000 条错题，覆盖：

| 路径 | 说明 |
| --- | --- |
| `buildCards` / `buildTree` / `rebuildLinkIndex` | 全库建卡、目录树、双链索引 |
| `parseFrontmatter` | 未走缓存的 frontmatter 解析 |
| `dueQueue` / `chapterHeat` | 复习到期队列、错题章节热力 |
| `VaultSearch.sync + warm` / `search` | 全文索引全量构建与单次查询 |

只做度量，不设阈值断言：机器与 CI 抖动大，硬阈值会把噪声变成红灯。
若某项出现数量级异常，再单独排查并补一条针对性断言。

## 已知上限

- **搜索是全量索引 + MiniSearch**，不是倒排数据库；2 万篇以上要重新评估内存与构建时间。
- **图谱 / 3D / PDF 都是按需 chunk**，首次打开有下载空窗；导轨悬停预取只覆盖重面板，不覆盖这两个画布。
- **主包预算只剩 ~28 KB**：新增静态 import 前先跑 `npm run sizebudget`。

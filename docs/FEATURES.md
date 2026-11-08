# FEATURES · 功能地图（自动生成）

> 本文件由 `node scripts/features-gen.mjs` 从 `panelRegistry.ts` / `railCatalog.tsx` 与目录结构重算。
> **不要手改**：改完面板或导航后重跑脚本覆盖。

## 汇总

| 面板 | 整屏模态 | 导航轨入口 | 源文件 | 源码行数 | 测试文件 |
| --- | --- | --- | --- | --- | --- |
| 33 | 29 | 25 | 300 | 83630 | 271 |

## 面板（panelRegistry.ts）

| id | 导航轨入口 | 类型 |
| --- | --- | --- |
| `search` | `search` | 整屏模态 |
| `palette` | — | 整屏模态 |
| `history` | `history` | 整屏模态 |
| `notice` | `notice` | 整屏模态 |
| `settings` | `settings` | 整屏模态 |
| `integrity` | — | 整屏模态 |
| `quiz` | `quiz` | 整屏模态 |
| `exam` | — | 整屏模态 |
| `review` | `review` | 整屏模态 |
| `recite` | — | 整屏模态 |
| `mistakes` | `mistakes` | 整屏模态 |
| `vocab` | — | 整屏模态 |
| `words` | `words` | 整屏模态 |
| `dash` | `report` | 整屏模态 |
| `report` | — | 整屏模态 |
| `todos` | `todos` | 整屏模态 |
| `tags` | `tags` | 整屏模态 |
| `graph` | `graph` | 整屏模态 |
| `mind` | `mind` | 整屏模态 |
| `medref` | `medref` | 整屏模态 |
| `anatomy` | `anatomy` | 整屏模态 |
| `brain` | `brain` | 整屏模态 |
| `imageLib` | — | 整屏模态 |
| `import` | `import` | 整屏模态 |
| `pdf` | `pdf` | 整屏模态 |
| `convert` | `convert` | 整屏模态 |
| `course` | `course` | 整屏模态 |
| `calendar` | `calendar` | 整屏模态 |
| `video` | `video` | 可共存浮层 |
| `ai` | `ai` | 可共存浮层 |
| `agent` | — | 可共存浮层 |
| `draft` | — | 可共存浮层 |

## 导航轨（railCatalog.tsx）

### 工作区（2）

| key | 文案 |
| --- | --- |
| `tree` | 目录 |
| `search` | 搜索 |

### 学习（10）

| key | 文案 |
| --- | --- |
| `quiz` | 题库练习 |
| `review` | 间隔复习 |
| `ai` | AI 助手 |
| `video` | 视频笔记 |
| `course` | 课程工坊 |
| `words` | 单词工坊 |
| `mistakes` | 错题本 |
| `report` | 学习报告 |
| `calendar` | 学习日历 |
| `todos` | 待办 |

### 资料（5）

| key | 文案 |
| --- | --- |
| `graph` | 知识图谱 |
| `anatomy` | 3D 解剖 |
| `brain` | 脑图谱 |
| `tags` | 标签 |
| `medref` | 医学速查 |

### 工具（3）

| key | 文案 |
| --- | --- |
| `import` | 导入 |
| `convert` | 格式转换 |
| `history` | 历史版本 |

### 系统（2）

| key | 文案 |
| --- | --- |
| `settings` | 设置 |
| `notice` | 安全与隐私 |

## 目录规模

| 目录 | 文件 | 行数 |
| --- | --- | --- |
| `src/core/` | 193 | 41918 |
| `src/views/` | 79 | 29418 |
| `src/storage/` | 10 | 1455 |
| `src/styles/` | 18 | 10839 |

## 维护

- 新增面板：先改 `src/views/panelRegistry.ts`（id / rail / modal），再补 `Workspace` 的渲染分支与入口。
- 新增导航项：改 `src/views/railCatalog.tsx` 的 `RAIL_GROUPS`，`RailKey` 与 `Workspace.openFeature` 会编译检查。
- 改完重跑 `npm run features:gen`。

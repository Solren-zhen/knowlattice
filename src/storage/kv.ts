/**
 * 本地键值存储的统一入口。
 *
 * 现状：**89 个 core 模块各自直接读写 localStorage**，每个都自己写一遍
 * `try { JSON.parse(localStorage.getItem(KEY) ?? '') } catch { 回退 }`，
 * 于是同一类 bug 被修了 89 遍也没修干净：坏 JSON、隐私模式抛错、旧版本字段缺省、
 * 键名拼错（`knowlattice.tree.collapsed` 用点、其余用短横线，两套风格并存）。
 *
 * 这里给的是**最小公约数**，不是状态管理框架：
 *   - `defineStore` / `defineRawStore`：把「读-解析-校验-回退」「写-吞掉配额错误」收成一处；
 *   - `KV_KEYS` / `IDB_NAMES`：所有持久化名字的清单，供人查、供测试守。
 *
 * **不改存储格式**。老数据（裸字符串、裸数组、裸对象）读出来是同一个值，
 * 所以迁移是 1:1 的替换，不存在「升级后用户数据读不出来」这类不可逆风险。
 * 需要新格式时用 `-v2` 后缀另起一个键，由 `core/migrate.ts` 负责搬运。
 */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // Safari 隐私模式：访问 localStorage 本身就会抛
    return null;
  }
}

export interface StoreOptions<T> {
  /** 存储键（必须登记在 `KV_KEYS` 里） */
  key: string;
  /** 读不到 / 坏 JSON / 校验不过时的值 */
  fallback: T;
  /**
   * 把解析后的 unknown 归一化成 T。认不出就返回 fallback。
   * 不传 = 直接按 T 使用（适合「写进去什么读出来就是什么」的新键）。
   */
  decode?: (raw: unknown, fallback: T) => T;
}

export interface Store<T> {
  readonly key: string;
  read(): T;
  write(value: T): void;
  clear(): void;
}

export function defineStore<T>({ key, fallback, decode }: StoreOptions<T>): Store<T> {
  return {
    key,
    read() {
      const ls = storage();
      if (!ls) return fallback;
      let raw: string | null;
      try {
        raw = ls.getItem(key);
      } catch {
        return fallback;
      }
      if (raw === null) return fallback;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return fallback; // 坏 JSON（手改过 / 半截写入）当默认值，不抛给调用方
      }
      return decode ? decode(parsed, fallback) : (parsed as T);
    },
    write(value) {
      const ls = storage();
      if (!ls) return;
      try {
        ls.setItem(key, JSON.stringify(value));
      } catch {
        /* 配额满 / 隐私模式：本次会话内存里的值仍然可用，不打断用户操作 */
      }
    },
    clear() {
      const ls = storage();
      if (!ls) return;
      try {
        ls.removeItem(key);
      } catch {
        /* 同上 */
      }
    },
  };
}

/**
 * 裸字符串存储（不做 JSON 编解码）。
 *
 * 主题、字体这类「值就是一个词」的键历史上写的是裸值（`dark` 而不是 `"dark"`），
 * 用 `defineStore` 会解析失败并回退成默认值——表现是「换完主题重启又变回浅色」。
 */
export interface RawStore {
  readonly key: string;
  read(): string | null;
  write(value: string): void;
  clear(): void;
}

export function defineRawStore(key: string): RawStore {
  return {
    key,
    read() {
      const ls = storage();
      if (!ls) return null;
      try {
        return ls.getItem(key);
      } catch {
        return null;
      }
    },
    write(value) {
      const ls = storage();
      if (!ls) return;
      try {
        ls.setItem(key, value);
      } catch {
        /* 同上 */
      }
    },
    clear() {
      const ls = storage();
      if (!ls) return;
      try {
        ls.removeItem(key);
      } catch {
        /* 同上 */
      }
    },
  };
}

/**
 * 全部 localStorage 键的清单：谁在用、存什么。
 *
 * 新增键必须登记在这里（`storage/__tests__/kv.test.ts` 会核对
 * `medvault-*` 遗留只出现在迁移模块里）。命名统一用短横线，
 * 点号风格（`knowlattice.tree.collapsed` 等）是历史遗留，改键要配迁移，暂不动。
 */
export const KV_KEYS = {
  // —— 外观与偏好 ——
  'knowlattice-theme': '主题（裸值 light / dark / guofeng）· core/theme',
  'knowlattice-font': '字体（裸值 system / serif / mono）· core/theme',
  'knowlattice-highlight': '高亮色 · core/highlight',
  'knowlattice-liquid-glass': '液态玻璃折射（裸值 auto / on / off）· core/liquidGlass',
  'knowlattice-rail-expanded': '导航轨展开态 · views/Rail',
  'knowlattice-rail-open-groups': '导航轨展开的分组 · views/Rail',
  'knowlattice-recent-features': '首页最近使用（LRU 8 条）· views/featureRouting',
  'knowlattice-recents': '最近打开的笔记 · views/Workspace',
  'knowlattice-onboarded': '是否走过首次引导 · core/vault',
  'knowlattice-update-prefs': '更新检查偏好 · core/updater',
  'knowlattice-keybindings': '用户改过的快捷键（只存与默认不同的键）· core/keybindings',
  'knowlattice-vault-dir': '笔记库目录（桌面端）· storage/vaultFolder',
  'knowlattice-pet': '桌宠：显隐与停靠坐标 · core/pet',

  // —— 面板与布局尺寸 ——
  'knowlattice-panel-pos:': '浮窗位置，后缀为面板 id · views/usePanelDrag',
  'knowlattice-panel-size:': '浮窗尺寸，后缀为面板 id · views/usePanelDrag',
  'knowlattice.deck.split': '三列宽度 · views/useDeckSplit',
  'knowlattice.dock.split': '右侧栏宽度与视频块高度 · views/useDockSplit',
  'knowlattice.agent.panel.size': 'AI 笔记面板尺寸 · views/AiAgentPanel',
  'knowlattice.tree.collapsed': '目录卡片是否收成窄条 · views/Workspace',
  'knowlattice-tree-open-dirs': '章节目录树的展开目录（路径集合）· core/treeState',
  'knowlattice.video.folds': '视频笔记的折叠状态 · views/VideoNoteView',
  'knowlattice-quiz-zoom': '题库面板缩放 · views/QuizView',
  'knowlattice.quiz.bank-actions': '题库列表的抽屉状态 · views/QuizView',

  // —— 笔记与编辑 ——
  'knowlattice-history': '历史版本快照 · core/history',
  'knowlattice-recite-log': '背诵留痕（篇 / 条数 / 揭开数 / 时长）· core/reciteLog',
  'knowlattice-card-edits': '卡片自定义（改题/改答案）· core/cardEdits',
  'knowlattice-note-media': '笔记级音频 / 字幕挂载 · core/noteMedia',
  'knowlattice-excerpts': 'PDF 摘录 · views/PdfSplitView',
  'knowlattice-day-notes': '每日一句话小结（YYYY-MM-DD → 文本）· core/studyCalendar',
  'knowlattice.medSynonyms': '用户自定义等价词组 · core/medSynonyms',

  // —— 题库与复习 ——
  'knowlattice-qbanks': '题库（IndexedDB 为主，这里是清单缓存）· core/qbank',
  'knowlattice-qstats': '逐题统计 · core/qbankStats',
  'knowlattice-qcalib': '元认知校准 · core/qbankCalib',
  'knowlattice-srs': '间隔复习调度 · core/srs',
  'knowlattice-mistakes': '错题本 · core/mistakes',
  'knowlattice-vocab': '生词本 · core/vocab',
  'knowlattice-review': '复习会话状态 · core/reminder',
  'knowlattice-review-plan': '复习计划 · core/reviewPlan',
  'knowlattice-review-reminder': '复习提醒 · core/reminder',
  'knowlattice-local-recall': '本地回忆卡 · core/localRecall',
  'knowlattice-quiz-cursor': '上次练到哪一题 · core/quizCursor',
  'knowlattice-exam-history': '模拟考试记录 · core/examHistory',
  'knowlattice-daily-practice': '每日一练 · core/dailyPractice',
  'knowlattice-daily-knowledge': '每日知识点 · core/dailyKnowledge',
  'knowlattice-tutor-mastery': '导师模式掌握度台账（主题 → 等级/依据/次数/时间）· core/tutor',

  // —— 单词工坊 ——
  'knowlattice-word-drill': '单词工坊：逐词练习记录（错次 / 连对 / 到期）· core/wordDrill',
  'knowlattice-word-drill-bank': '单词工坊：自定义词库 · core/wordDrill',
  'knowlattice-word-drill-sound': '单词工坊：键盘音效开关 · core/keySound',
  'knowlattice-word-drill-daily': '单词工坊：每日新词/复习/正确率 · core/wordDrill',
  'knowlattice-word-drill-settings': '单词工坊：上次使用的词库 / 模式 / 题量与每日配额 · core/wordDrill',
  'knowlattice-word-drill-stories': '单词工坊：薄弱词成文的历史短文与逐句精读（最多 20 篇）· core/wordStory',

  // —— 统计与激励 ——
  'knowlattice-days': '打卡天数 · core/stats',
  'knowlattice-pomodoro': '番茄钟状态 · core/pomodoro',
  'knowlattice-pomodoros': '番茄钟历史 · core/pomodoro',
  'knowlattice-pomodoro-config': '番茄钟配置（时长/自动开始）· core/pomodoro',
  'knowlattice-achievements': '成就进度 · core/achievementStore',
  'knowlattice-study-log': '每日学习流水（复习 / 练题计数）· core/studyLog',
  'knowlattice-generated-cards': '由题目生成的复习卡（错题卡）· core/generatedCards',

  // —— 待办 ——
  'knowlattice-todos': '待办列表 · core/todos',
  'knowlattice-todo-filter': '待办筛选 · views/TodoView',
  'knowlattice-todo-group': '待办分组方式 · views/TodoView',
  'knowlattice-todo-module': '待办所属模块 · views/TodoView',
  'knowlattice-todo-sort': '待办排序 · views/TodoView',

  // —— 思维导图 ——
  'knowlattice-mindmap-prefs': '导图偏好 · core/mindmapPrefs',
  'knowlattice-mindmap-marks': '节点标记 · core/mindmapMarks',
  'knowlattice-mindmap-styles': '节点样式 · core/mindmapNodeStyles',
  'knowlattice-mindmap-tools': '工具栏状态 · core/mindmapToolbar',

  // —— 医学资料 ——
  'knowlattice-medref-symptoms': '症状词条 · core/medRefStore',
  'knowlattice-medref-symptoms-hidden': '隐藏的症状词条 · core/medRefStore',
  'knowlattice-medref-mnemonics': '口诀 · core/medRefStore',
  'knowlattice-medref-mnemonics-hidden': '隐藏的口诀 · core/medRefStore',
  'knowlattice-pathways': '通路模板 · core/pathwayTemplates',
  'knowlattice-pathway-templates': '用户保存的通路 · core/pathwayTemplates',
  'knowlattice-knowledge-audio': '知识点音频 · core/knowledgeAudio',

  // —— PDF / 视频 ——
  'knowlattice-pdfs': 'PDF 库 · core/pdfLib',
  'knowlattice-pdf-current': '当前打开的 PDF · core/pdfLib',
  'knowlattice-pdf-autodraft': 'PDF 自动草稿开关 · views/PdfSplitView',
  'knowlattice-pdf-colmode': 'PDF 分栏模式 · views/PdfSplitView',
  'knowlattice-video-clips': '视频片段收藏 · core/videoNotes',
  'knowlattice-bili-cookie': 'B 站登录态 · core/biliPlay',

  // —— AI 助手 ——
  'knowlattice-ai-src': 'AI 面板输入源 · views/AiPanel',
  'knowlattice-ai-agent-settings': '接口地址 / 密钥 / 教材库 · views/AgentSettingsForm',
  'knowlattice-ai-agent-prefs': '模型与权限偏好 · views/agentChat',
  'knowlattice-ai-agent-chat': '当前会话 · views/agentChat',
  'knowlattice-ai-agent-sessions': '会话列表 · views/agentChat',

  // —— 资料生成 ——
  'knowlattice-matgen-job': '资料生成任务结构（标题/大纲/已完成节；素材原文不入 KV）· core/matgen',
} as const;

/** IndexedDB 数据库名（与 localStorage 分开登记：它们不共用配额，迁移方式也不同） */
export const IDB_NAMES = {
  'knowlattice': '笔记库正文与附件 · storage/web',
  'knowlattice-qbank': '题库本体 · storage/qbank',
  'knowlattice-medbooks': '医学教材 · storage/medStore',
  'knowlattice-history': '历史版本快照 · core/history',
  'knowlattice-pathways': '通路模板 · core/pathwayTemplates',
  'knowlattice-pet': '桌宠形象 · core/petImage',
  'knowlattice-pdfs': 'PDF 书架 · core/pdfLib',
} as const;

/** 已废弃的键前缀：只允许出现在 `core/migrate.ts` 的迁移逻辑里 */
export const LEGACY_PREFIXES = ['medvault-'] as const;

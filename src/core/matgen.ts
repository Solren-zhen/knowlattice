/**
 * 资料生成（复习讲义）的纯逻辑层。
 *
 * 输入是用户导入的一批「素材」（PPT / 教材章节 / 大纲 / 往年题 / 习题库 / 已有资料，
 * 统一由视图层用既有引擎转成 Markdown 文本），输出是一份分节讲义。
 * 这里只做「拼字符串 + 算预算 + 定纪律」的活：调模型在视图层（`runAgent`，与课程工坊
 * 同一条链路），落盘走 vault。分开的理由同 courseNotes——提示词里少一句「只依据素材」，
 * 模型就会开始编教材里没有的内容，而界面看起来一切正常。
 *
 * 生成走两级流水线（用户已确认）：
 *   1) 规划：让模型读素材清单+目录摘要，产出 JSON 大纲（节标题 + 依据哪些素材）；
 *   2) 生成：逐节取相关素材片段，一次调用生成一节，进度逐节可见，失败可单独重试。
 *
 * 任务状态（标题/大纲/已生成节）持久化到 KV（登记在 KV_KEYS），素材原文**不进**
 * localStorage（轻松超配额），视图层持有在内存里，断点续跑只恢复结构不恢复素材。
 */
import { defineStore } from '../storage/kv';
import type { WireMessage } from './aiAgent';

/** 单份素材一次喂给模型的最大字符数；超出按节截取相关片段 */
export const SOURCE_BUDGET = 18_000;
/** 规划阶段每份素材最多带进提示词的目录字符数 */
export const PLAN_BUDGET = 4_000;
/** 单节正文的素材总预算（多份素材片段拼起来不超过这个数） */
export const SECTION_BUDGET = 20_000;

/** 素材种类。视图按扩展名/文件名猜测，用户可改。 */
export type MatKind = 'ppt' | '教材' | '大纲' | '考题' | '题库' | '资料';

export const MAT_KINDS: readonly MatKind[] = ['ppt', '教材', '大纲', '考题', '题库', '资料'];

/** 一份导入素材：内容已转成 Markdown 文本 */
export interface MatSource {
  id: string;
  name: string;
  kind: MatKind;
  /** 已解析的 Markdown 全文（视图层已用 anydoc/mammoth/pdfjs 转好） */
  content: string;
}

/** 大纲里的一节：模型产出，用户可改标题、可删 */
export interface MatSection {
  id: string;
  title: string;
  /** 依据哪些素材（id 列表），空 = 全部 */
  sources: string[];
  /** 状态机：未生成 / 生成中 / 已完成 / 失败（保留 error 供重试） */
  phase: 'idle' | 'running' | 'done' | 'error';
  body: string;
  error?: string;
}

/** 生成形式：lecture=复习讲义 / outline=知识大纲 / cards=速记卡 / quiz=自测题卷 */
export type MatStyle = 'lecture' | 'outline' | 'cards' | 'quiz';

export interface MatStyleDef {
  id: MatStyle;
  label: string;
  /** 一句话说明（选择器里展示） */
  hint: string;
  /** 分节生成的输出结构（模型按这段逐块输出） */
  sectionSpec: readonly string[];
  /** 分节生成的额外硬约束（编号从 6 起，接在公共约束后面） */
  sectionExtras: readonly string[];
  /** 规划提示词的侧重说明 */
  planFocus: string;
  /** 审校提示词的结构保留要求（替换默认的「四小节结构保留」） */
  reviewKeep: string;
  /** frontmatter 标签与默认目录名 */
  tag: string;
  dir: string;
}

export const MAT_STYLES: Record<MatStyle, MatStyleDef> = {
  lecture: {
    id: 'lecture',
    label: '复习讲义',
    hint: '定义/机制/易错点/自测四段式，默认形式',
    sectionSpec: [
      '请按下面四节输出：',
      '### 核心结论',
      '（3–6 条，每条一句话）',
      '### 概念与机制',
      '（定义、因果、步骤、对比；适合用列表/表格就写表格）',
      '### 易错点',
      '（素材明确提醒过、或容易混淆的点；没有就写「本节未特别强调」）',
      '### 自测问题',
      '（3–5 个能直接自问自答的问题，不要给答案）',
    ],
    sectionExtras: [],
    planFocus: '大纲按学习逻辑组织（先总后分、先机制后临床）。',
    reviewKeep: '正文里的四小节（核心结论/概念与机制/易错点/自测问题）结构保留。',
    tag: '复习讲义',
    dir: '复习讲义',
  },
  outline: {
    id: 'outline',
    label: '知识大纲',
    hint: '层级要点树，快速浏览，篇幅短',
    sectionSpec: [
      '请按下面两节输出：',
      '### 要点树',
      '（用嵌套列表组织本节全部知识点：一级 = 知识点，二级 = 关键细节；每条 ≤ 30 字，只保留干货，不写完整句子）',
      '### 关键词',
      '（5–8 个本节关键词，逗号分隔，英文术语保留原文）',
    ],
    sectionExtras: [
      '6. 大纲体的每一行都是可扫读的要点，禁止出现「综上所述」「值得注意的是」这类连接语。',
    ],
    planFocus: '大纲按素材的固有层级组织（章节/系统/分类），节内保持树状不展开论述。',
    reviewKeep: '正文里的「要点树/关键词」两小节结构保留；列表层级不得拍平。',
    tag: '知识大纲',
    dir: '知识大纲',
  },
  cards: {
    id: 'cards',
    label: '速记卡',
    hint: '问答式记忆卡，条条独立，适合突击',
    sectionSpec: [
      '对本节输出 6–12 张速记卡，每张两行、卡片之间用空行分隔：',
      '- **Q：**（一句话问题，具体到可单独回答）',
      '- **A：**（不超过 80 字的答案，含关键数字/术语；素材没讲清的写「素材未展开」）',
      '',
      '最后追加一行：',
      '- **高频考点：**（本节最可能考的 1–2 个角度，只依据考题素材；没有考题素材就写「无考题依据」）',
    ],
    sectionExtras: [
      '6. 每张卡必须能独立理解，不引用其他卡片；同一知识点不重复出卡。',
    ],
    planFocus: '大纲按「可出卡的考点」组织：一节对应一组同粒度的知识点，节标题要能直接变成卡片主题。',
    reviewKeep: '每张卡的「Q：/A：」两行结构保留。',
    tag: '速记卡',
    dir: '速记卡',
  },
  quiz: {
    id: 'quiz',
    label: '自测题卷',
    hint: '带答案与解析的练习题，考题风格',
    sectionSpec: [
      '请按下面三节输出：',
      '### 题目',
      '（5–8 题按难度递进：单选/简答/案例分析混合；题干自含，不依赖其他题；有考题素材时模仿其题型与问法）',
      '### 参考答案',
      '（逐题编号给出答案；选择题给选项字母，简答/案例给要点式答案）',
      '### 解析',
      '（逐题编号说明考点与推理链，标注该题依据哪份素材的说法；素材没覆盖的题不编造，删掉或换成素材内知识点）',
    ],
    sectionExtras: [
      '6. 每道题的考点必须能在素材里找到依据；考题素材里的原题可以改编，但连续照抄题干不得超过 30 字。',
      '7. 答案与解析的编号必须与题目一一对应，不得跳号。',
    ],
    planFocus: '大纲按题型板块与考点分布组织（如：选择题·机制类 / 简答题·鉴别类），并参考考题素材的覆盖面。',
    reviewKeep: '正文里的「题目/参考答案/解析」三小节结构保留；题号与答案编号一一对应不得错位。',
    tag: '自测题卷',
    dir: '自测题卷',
  },
};

export const MAT_STYLE_LIST: readonly MatStyleDef[] = [MAT_STYLES.lecture, MAT_STYLES.outline, MAT_STYLES.cards, MAT_STYLES.quiz];

/** 形式合法性守卫（KV 读回 / 用户传参都可能越界） */
export function asMatStyle(v: unknown): MatStyle {
  return typeof v === 'string' && v in MAT_STYLES ? (v as MatStyle) : 'lecture';
}

/** 一次生成任务的持久化状态（不含素材原文） */
export interface MatJob {
  title: string;
  createdAt: number;
  updatedAt: number;
  sections: MatSection[];
  /** 素材清单的元数据（不含 content），恢复界面用 */
  sources: Array<{ id: string; name: string; kind: MatKind; chars: number }>;
  /** 汇总时的额外要求（用户可写「重点第二章」「面向期末」等） */
  brief: string;
  /** 生成形式（lecture=复习讲义，旧数据无此字段按 lecture 处理） */
  style?: MatStyle;
}

// ---------------------------------------------------------------- 持久化

const matStore = defineStore<MatJob | null>({
  key: 'knowlattice-matgen-job',
  fallback: null,
  decode: (raw, fallback) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
    const r = raw as Record<string, unknown>;
    if (typeof r.title !== 'string' || !Array.isArray(r.sections)) return fallback;
    const style = asMatStyle(r.style);
    const sections: MatSection[] = [];
    for (const s of r.sections) {
      if (!s || typeof s !== 'object') continue;
      const v = s as Record<string, unknown>;
      if (typeof v.title !== 'string') continue;
      sections.push({
        id: typeof v.id === 'string' ? v.id : '',
        title: v.title,
        sources: Array.isArray(v.sources) ? v.sources.filter((x): x is string => typeof x === 'string') : [],
        phase: v.phase === 'done' ? 'done' : v.phase === 'error' ? 'error' : 'idle',
        body: typeof v.body === 'string' ? v.body : '',
        ...(typeof v.error === 'string' ? { error: v.error } : {}),
      });
    }
    if (!sections.length) return fallback;
    const sources: MatJob['sources'] = [];
    if (Array.isArray(r.sources)) {
      for (const s of r.sources) {
        if (!s || typeof s !== 'object') continue;
        const v = s as Record<string, unknown>;
        if (typeof v.id !== 'string' || typeof v.name !== 'string') continue;
        const kind = MAT_KINDS.find((k) => k === v.kind) ?? '资料';
        sources.push({
          id: v.id,
          name: v.name,
          kind,
          chars: Math.max(0, Math.floor(Number(v.chars) || 0)),
        });
      }
    }
    return {
      title: r.title,
      createdAt: Math.floor(Number(r.createdAt) || 0),
      updatedAt: Math.floor(Number(r.updatedAt) || 0),
      sections,
      sources,
      brief: typeof r.brief === 'string' ? r.brief : '',
      style,
    };
  },
});

export function loadMatJob(): MatJob | null {
  return matStore.read();
}

export function saveMatJob(job: MatJob | null): void {
  matStore.write(job);
}

/** 只回写节状态（updatedAt 由这里盖章）：视图里不出现 Date.now 这类不纯调用 */
export function persistSections(sections: readonly MatSection[]): void {
  const job = loadMatJob();
  if (!job) return;
  matStore.write({ ...job, sections: sections.map((s) => ({ ...s })), updatedAt: Date.now() });
}

/** 纯函数：把 running 节复位成 idle（中断后调用，避免界面一直转圈） */
export function resetRunningSections(sections: readonly MatSection[]): MatSection[] {
  return sections.map((s) => (s.phase === 'running' ? { ...s, phase: 'idle' as const } : s));
}

// ---------------------------------------------------------------- 素材预算

/**
 * 素材里挑出与某一节相关的片段。
 *
 * 规则（可单测）：
 * - 素材 ≤ SOURCE_BUDGET：整份带上（教材类可信，直接用）；
 * - 超预算：按节标题里的词挑命中的段落（标题词 ≥2 字才参与匹配，避免「的」「与」这类虚词误命中），
 *   一段都没命中时退回「开头 + 结尾」（开头常是章节总起，结尾常有小结）。
 */
export function pickSourceSlice(source: MatSource, sectionTitle: string, budget = SOURCE_BUDGET): string {
  const text = source.content || '';
  if (text.length <= budget) return text;
  // 标题切成 ≥2 字的词（按常见分隔符与虚词切）
  const terms = sectionTitle
    .split(/[\s·、，,（）()\-—/:：;；「」《》]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (terms.length) {
    const paras = text.split(/\n{2,}/);
    const hits = paras.filter((p) => terms.some((t) => p.includes(t)));
    if (hits.length) {
      // 顺序保持原文，单段再超就截段
      const out: string[] = [];
      let len = 0;
      for (const h of hits) {
        const piece = h.length > budget ? h.slice(0, budget) : h;
        if (len + piece.length > budget) break;
        out.push(piece);
        len += piece.length + 2;
      }
      if (out.length) return out.join('\n\n');
    }
  }
  return `${text.slice(0, Math.floor(budget * 0.7))}\n\n…（中间省略）…\n\n${text.slice(-Math.floor(budget * 0.3))}`;
}

/** 规划阶段：每份素材的「目录摘要」——前段 + 标题行集合，控制在 PLAN_BUDGET 内 */
export function planDigest(source: MatSource, budget = PLAN_BUDGET): string {
  const text = source.content || '';
  if (text.length <= budget) return text;
  const headingLines = text.split('\n').filter((l) => /^#{1,4}\s/.test(l) || /^[一二三四五六七八九十]+[、.．]/.test(l));
  const digest: string[] = [];
  let len = 0;
  for (const h of headingLines) {
    if (len + h.length > budget) break;
    digest.push(h);
    len += h.length + 1;
  }
  if (len < budget * 0.5) {
    // 标题行太少（比如纯文本 PPT 导出），补正文开头
    const head = text.slice(0, budget - len);
    digest.unshift(head);
  }
  return digest.join('\n').slice(0, budget);
}

// ---------------------------------------------------------------- 提示词

/** 模型常把 JSON 包进 ```json 围栏；先剥围栏再 parse */
export function stripJsonFence(text: string): string {
  const s = (text || '').trim();
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(s);
  return (m ? m[1] : s).trim();
}

/** 从模型输出里解析大纲；容忍围栏、前后废话（取第一个 [ 到最后一个 ]） */
export function parseOutline(text: string, sourceIds: readonly string[]): MatSection[] {
  const cleaned = stripJsonFence(text);
  let arr: unknown;
  try {
    arr = JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf('[');
    const last = cleaned.lastIndexOf(']');
    if (first < 0 || last <= first) throw new Error('模型没有返回可解析的大纲 JSON');
    arr = JSON.parse(cleaned.slice(first, last + 1));
  }
  if (!Array.isArray(arr)) throw new Error('大纲 JSON 不是数组');
  const idSet = new Set(sourceIds);
  const sections: MatSection[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    const title = typeof v.title === 'string' ? v.title.trim() : '';
    if (!title) continue;
    sections.push({
      id: `sec-${sections.length + 1}`,
      title: title.slice(0, 60),
      sources: Array.isArray(v.sources)
        ? v.sources.filter((x): x is string => typeof x === 'string' && idSet.has(x))
        : [],
      phase: 'idle',
      body: '',
    });
  }
  if (!sections.length) throw new Error('大纲里没有有效的节');
  return sections.slice(0, 30);
}

/** 规划提示词：只输出 JSON 数组，每项 { title, sources } */
export function buildPlanMessages(args: {
  title: string;
  brief: string;
  sources: readonly MatSource[];
  style?: MatStyle;
}): WireMessage[] {
  const style = MAT_STYLES[args.style ?? 'lecture'];
  const list = args.sources
    .map((s) => `- [${s.id}]（${s.kind}）${s.name}\n目录摘要：\n${planDigest(s)}`)
    .join('\n\n');
  return [
    {
      role: 'system',
      content: [
        `你是为医学生规划「${style.label}」的助教。你会拿到一批学习素材（PPT、教材、大纲、往年考题、习题库、已有资料）的目录摘要。`,
        `任务：规划一份${style.label}的章节大纲。`,
        '硬约束：',
        '1. 大纲要覆盖素材的核心主题。',
        `2. ${style.planFocus}`,
        '3. 节数 5–20；每节标题 ≤ 20 字，具体到知识点，不要用「概述」「总结」这类空标题。',
        '4. 每节标注依据哪些素材（sources 数组，元素是素材方括号里的编号）；拿不准就留空数组。',
        '5. 往年考题 / 习题库反映考点：把反复考的主题排前面，并在该节 sources 里包含它们。',
        '6. 只输出 JSON 数组，格式：[{"title":"…","sources":["s1","s2"]}]，不要解释、不要代码围栏。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `主题：${args.title || '（从素材推断）'}`,
        args.brief ? `额外要求：${args.brief}` : '',
        '',
        '素材清单：',
        list,
      ].filter(Boolean).join('\n'),
    },
  ];
}

/** 已完成节给后续节看的「要点摘要」：取正文前 n 字，避免各节独立生成时重复 */
export function sectionDigest(body: string, n = 220): string {
  const t = (body || '').replace(/[#>*`]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 生成提示词：一节一次调用；输出结构由形式注册表决定 */
export function buildSectionMessages(args: {
  title: string;
  brief: string;
  sectionTitle: string;
  materials: string;
  isExamStyle: boolean;
  style?: MatStyle;
  /** 跨节上下文：其他节标题 + 已完成节要点摘要（防重复、引导交叉引用） */
  crossRef?: string;
}): WireMessage[] {
  const style = MAT_STYLES[args.style ?? 'lecture'];
  const examLine = args.isExamStyle
    ? `${style.sectionExtras.length + 1}. 用户提供了往年考题/习题：结合考题素材里真实出现过的题型与角度组织本节内容。`
    : '';
  const crossLine = args.crossRef
    ? `${style.sectionExtras.length + (args.isExamStyle ? 2 : 1)}. 整份资料是多节合一的：其他节已覆盖的内容不要重复展开；确实需要提及时用一句话交叉引用（写成「见「某节标题」」），不重新解释。`
    : '';
  return [
    {
      role: 'system',
      content: [
        `你是把学习素材整理成「${style.label}」的助教，服务对象是备考的医学生。`,
        '硬约束：',
        '1. 只依据用户提供的素材，不补充素材里没有的事实、数字、指南或文献；素材没讲清楚就写「素材未展开」。',
        '2. 保留英文学术术语，首次出现给中文对照；不要改写素材已给出的定义。',
        '3. 数字、剂量、分级必须与素材原文一致，不得四舍五入或改写。',
        '4. 只输出 Markdown 正文，不要一级/二级标题（节标题由程序加），不要代码围栏，不要开场白与总结套话。',
        '5. 公式用 LaTeX（$…$ 行内、$$…$$ 独立）。',
        ...style.sectionExtras,
        examLine,
        crossLine,
      ].filter(Boolean).join('\n'),
    },
    {
      role: 'user',
      content: [
        `主题：${args.title}`,
        args.brief ? `额外要求：${args.brief}` : '',
        `本节主题：${args.sectionTitle}`,
        args.crossRef ? `本资料其他节（不要重复它们的内容）：\n${args.crossRef}` : '',
        '',
        ...style.sectionSpec,
        '',
        '素材：',
        args.materials,
      ].filter(Boolean).join('\n'),
    },
  ];
}

/** 生成单节时拼素材：该节指定的素材（没有就全部）按预算裁剪 */
export function buildSectionMaterials(
  sources: readonly MatSource[],
  section: MatSection,
  sectionBudget = SECTION_BUDGET,
): string {
  const picked = section.sources.length
    ? sources.filter((s) => section.sources.includes(s.id))
    : [...sources];
  if (!picked.length && sources.length) {
    // 断点续跑后素材是重新导入的，id 重新生成、对不上节里持久化的旧 id：
    // 与其让模型拿到空素材写出空泛的一节，不如退回全量素材（预算裁剪仍然生效）。
    picked.push(...sources);
  }
  const hasExam = picked.some((s) => s.kind === '考题' || s.kind === '题库');
  const parts = picked.map((s) => `【${s.kind} · ${s.name}】\n${pickSourceSlice(s, section.title)}`);
  // 总预算：从后往前裁（考题素材通常短，教材最长，优先保留靠前的教材原文）
  let out = '';
  let len = 0;
  for (const p of parts) {
    const room = sectionBudget - len;
    if (room <= 500) break;
    out += (out ? '\n\n' : '') + (p.length > room ? `${p.slice(0, room)}…（超出预算已截断）` : p);
    len += Math.min(p.length, room) + 2;
  }
  return `（考点相关素材存在：${hasExam ? '有' : '无'}）\n\n${out}`;
}

// ---------------------------------------------------------------- 拼装

/** 最终讲义文件名（去非法字符），与 courseNotes.safeTitle 同口径 */
export function safeMatTitle(raw: string): string {
  return (raw || '').replace(/[\\/:*?"<>|#^[]/g, '').trim().slice(0, 80) || '未命名讲义';
}

/** 汇总整份资料：frontmatter + 素材清单 + 各节正文 + 未完成节说明；目录/标签随形式 */
export function assembleMatNote(args: {
  job: MatJob;
  generatedAt?: Date;
}): string {
  const { job } = args;
  const style = MAT_STYLES[job.style ?? 'lecture'];
  const generatedAt = args.generatedAt ?? new Date();
  // 本地日期，别用 toISOString（UTC）：东八区凌晨汇编会把「资料生成于」写成前一天
  const iso = `${generatedAt.getFullYear()}-${String(generatedAt.getMonth() + 1).padStart(2, '0')}-${String(generatedAt.getDate()).padStart(2, '0')}`;
  const yml = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const srcLines = job.sources.length
    ? job.sources.map((s) => `- [${s.id}]（${s.kind}）${s.name}（${s.chars} 字）`).join('\n')
    : '-（素材清单未记录）';
  const done = job.sections.filter((s) => s.phase === 'done' && s.body.trim());
  const undone = job.sections.filter((s) => !done.includes(s));
  const body = done.map((s) => `## ${s.title}\n\n${s.body.trim()}`).join('\n\n---\n\n');
  const tail = undone.length
    ? `\n\n## 未完成\n\n${undone.map((s) => `- ${s.title}${s.phase === 'error' && s.error ? `（失败：${s.error.slice(0, 80)}）` : ''}`).join('\n')}`
    : '';
  return [
    '---',
    `title: ${yml(safeMatTitle(job.title))}`,
    `source: ${yml('KNOWLATTICE 资料生成')}`,
    `style: ${yml(style.label)}`,
    `generated: ${yml(iso)}`,
    'tags:',
    `  - ${style.tag}`,
    '  - 资料生成',
    '---',
    '',
    `# ${safeMatTitle(job.title)}`,
    '',
    `> 由 KNOWLATTICE 资料生成于 ${iso} 汇编（${style.label}）。素材 ${job.sources.length} 份，完成 ${done.length}/${job.sections.length} 节。`,
    '',
    '## 素材',
    '',
    srcLines,
    '',
    body,
    tail,
  ].join('\n');
}

/** 新任务骨架 */
export function newMatJob(title: string, sources: readonly MatSource[], brief: string, style: MatStyle = 'lecture'): MatJob {
  const now = Date.now();
  return {
    title,
    createdAt: now,
    updatedAt: now,
    sections: [],
    sources: sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, chars: s.content.length })),
    brief,
    style,
  };
}

// ---------------------------------------------------------------- 整体审校

/** 审校输入的全文预算：超出按节截断（优先保前面的节） */
export const REVIEW_BUDGET = 28_000;

/** 审校提示词：全稿通读，修衔接/重复/矛盾/套话，输出修订后的各节（## 原标题）；结构口径随形式 */
export function buildReviewMessages(args: {
  title: string;
  brief: string;
  sections: readonly MatSection[];
  style?: MatStyle;
}): WireMessage[] {
  const style = MAT_STYLES[args.style ?? 'lecture'];
  let len = 0;
  const parts: string[] = [];
  for (const s of args.sections) {
    if (!s.body.trim()) continue;
    const room = REVIEW_BUDGET - len;
    if (room <= 200) break;
    const piece = `## ${s.title}\n\n${s.body.trim()}`;
    // 单节超预算就截断该节（截断比整节跳过好：终审至少要看到它）
    parts.push(piece.length > room ? `${piece.slice(0, room)}…（超出预算已截断）` : piece);
    len += Math.min(piece.length, room) + 2;
  }
  return [
    {
      role: 'system',
      content: [
        `你是「${style.label}」的终审编辑。你会拿到一份已分节完成的${style.label}全文。`,
        '任务：通读全文，只做四类修订：',
        '1. 衔接：节与节之间缺过渡时补一句承上启下（不新增事实）。',
        '2. 重复：不同节重复讲同一件事时，保留讲得更完整的一处，另一处改成一句话交叉引用（「见「节标题」」）。',
        '3. 矛盾：两节说法冲突时，依据更具体的表述统一，不得自行编造裁决依据。',
        '4. 空话：删掉不承载信息的套话（「综上所述」「具有重要意义」这类），但保留全部事实、数字、公式与表格。',
        '硬约束：',
        `- 每节的标题原样保留（以「## 标题」开头）；节数不增不减；${style.reviewKeep}`,
        '- 不新增任何素材里没有的事实；不改数字、剂量、分级、LaTeX 公式。',
        '- 只输出修订后的全文（## 各节），不要解释、不要代码围栏。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `主题：${args.title}${args.brief ? `\n额外要求：${args.brief}` : ''}\n\n${parts.join('\n\n')}`,
    },
  ];
}

/**
 * 解析审校输出并按标题回填：模型保持原标题（约束在提示词里），但容错处理
 * 「标题两侧加粗/多空格」；匹配不到的节保持原样（不静默丢内容）。
 */
export function parseReview(text: string, sections: readonly MatSection[]): MatSection[] {
  const cleaned = stripJsonFence(text);
  // 只认「## 节标题」块；首块之前的（H1 总标题、开场白）自然被忽略
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of cleaned.split('\n')) {
    if (/^##\s+/.test(line)) {
      if (current) blocks.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current.join('\n'));
  if (!blocks.length) throw new Error('审校输出里没有找到任何「## 节标题」块');
  const norm = (s: string): string => s.replace(/[*\s]/g, '').toLowerCase();
  const byTitle = new Map<string, string>();
  for (const b of blocks) {
    const m = /^##\s+(.+)$/m.exec(b);
    if (!m) continue;
    byTitle.set(norm(m[1]), b.replace(/^##\s+.+\n?/, '').trim());
  }
  let matched = 0;
  const next = sections.map((s) => {
    const body = byTitle.get(norm(s.title));
    if (body === undefined) return s;
    matched += 1;
    return { ...s, body };
  });
  if (!matched) throw new Error('审校输出的节标题与现有大纲对不上，未应用任何修改');
  return next;
}

/**
 * B 站课程 → 讲义 / 讲师人格卡 的纯逻辑层。
 *
 * 这里只做「拼字符串」的活：提示词、frontmatter、讲义骨架、人格卡截断。
 * 抓字幕在 `biliSubtitles`，调模型在视图里（`runAgent`），落盘在 `vault`。
 * 分开的理由是这些规则能被单测钉住——提示词里少一句「只依据字幕」，
 * 模型就会开始编课程里没讲过的内容，而界面看起来一切正常。
 *
 * 剪藏格式借了 Obsidian Web Clipper 的做法：frontmatter 记 source / url / author /
 * clipped，正文只放内容。这样导出的笔记进 Obsidian 或别的工具都还能追来源。
 */
import { SOUL_PREFIX_LIMIT } from './agentSkills';
import type { WireMessage } from './aiAgent';
import { formatTime, parseTimestamp } from './subtitle';

/** 课程笔记的默认目录（vault 内的相对路径，不带前导斜杠） */
export const COURSE_DIR = 'B站课程';
/** 人格卡目录：与 agentSkills 的 SOUL_DIR 保持一致，这里只用于拼路径 */
export const PERSONA_DIR = 'AI命令/人格';

/** 单个分P一次喂给模型的最大字幕字符数；超出就切段生成，避免上下文被撑爆 */
export const TRANSCRIPT_CHUNK = 18_000;

export interface CourseMeta {
  /** B 站 BV 号；本地导入的课程没有（此时不写 bvid，也不生成跳转锚点） */
  bvid?: string;
  title: string;
  /** UP 主 / 讲师名 */
  owner?: string;
  /** 分P 数 */
  partCount: number;
  /** 总时长（秒） */
  duration: number;
  /**
   * 整门课附带的网盘 / 资料链接（可选）。
   * 网盘分享页要登录与提取码，拿不到媒体流，所以只记录、一键打开，不做下载或字幕抓取。
   */
  materialUrl?: string;
  /** 本地导入课程在 frontmatter 的 source 值；不传时写「本地导入」 */
  sourceLabel?: string;
}

export interface LectureSection {
  page: number;
  part: string;
  /** 该分P时长（秒）；未知传 0 */
  duration: number;
  /** 模型产出的 Markdown 正文（可含多个三级标题） */
  body: string;
}

export interface SkippedPart {
  page: number;
  part: string;
  reason: string;
}

/** 课程面板与视频笔记之间传递的「哪一分P」；不含秒数时从本节开头播放 */
export interface CourseVideoRef {
  bvid: string;
  page: number;
  /** 点笔记里的 [m:ss] 时带秒数；从分P行进入时没有 */
  seconds?: number;
}

/** 带显示信息的跳转目标（视频笔记标题、返回工坊时用） */
export interface CourseVideoTarget extends CourseVideoRef {
  /** 分P标题，如「发热」 */
  part?: string;
  /** 课程名，用于视频栏标题 */
  courseTitle?: string;
}

/** 课程工坊的元数据（视频笔记据此知道当前是哪个课程、哪个分P） */
export interface CourseOutline {
  bvid: string;
  title: string;
  owner?: string;
  parts: Array<{ page: number; part: string }>;
}

/**
 * 课程笔记里的「打开本节视频」锚点。
 *
 * 和视频笔记的 `#vn=秒` 同一套做法：用 fragment 而不是自定义协议，
 * 编辑器不必过外链白名单，导出到别的 Markdown 工具也不会变成死链。
 *   `#cw=BV1xx411c7mD:p3`      → 从 P3 开头播放
 *   `#cw=BV1xx411c7mD:p3:t754` → 从 P3 的 12:34 播放
 */
export const COURSE_ANCHOR_PREFIX = '#cw=';

export function courseAnchorHref(ref: CourseVideoRef): string {
  const bvid = (ref.bvid || '').trim();
  const page = Math.max(1, Math.floor(ref.page) || 1);
  const seconds = ref.seconds == null ? null : Math.max(0, Math.floor(ref.seconds));
  return `${COURSE_ANCHOR_PREFIX}${bvid}:p${page}${seconds == null ? '' : `:t${seconds}`}`;
}

export function parseCourseAnchorHref(href: string | null | undefined): CourseVideoRef | null {
  if (!href || !href.startsWith(COURSE_ANCHOR_PREFIX)) return null;
  const m = /^#cw=(BV[0-9A-Za-z]{10}):p(\d+)(?::t(\d+))?$/.exec(href);
  if (!m) return null;
  return {
    bvid: m[1],
    page: Number(m[2]),
    ...(m[3] != null ? { seconds: Number(m[3]) } : {}),
  };
}

/** 模型在讲义里写的 `[m:ss]` → 可点的课程锚点 */
const BODY_TIME_RE = /\[(\d{1,2}(?::\d{2}){1,2})\]/g;

export function linkTimeAnchors(body: string, bvid: string, page: number): string {
  return body.replace(BODY_TIME_RE, (whole, stamp: string) => {
    const seconds = parseTimestamp(stamp);
    if (seconds == null) return whole;
    return `[▶ ${stamp}](${courseAnchorHref({ bvid, page, seconds })})`;
  });
}

/** 精华里写的是 `P3 12:34`（不带方括号），同样转成可点锚点 */
const ESSENCE_TIME_RE = /\bP(\d+)\s+(\d{1,2}(?::\d{2}){1,2})/g;

export function linkEssenceAnchors(body: string, bvid: string): string {
  return body.replace(ESSENCE_TIME_RE, (whole, page: string, stamp: string) => {
    const seconds = parseTimestamp(stamp);
    if (seconds == null) return whole;
    return `P${page} [▶ ${stamp}](${courseAnchorHref({ bvid, page: Number(page), seconds })})`;
  });
}

/** 分P字幕的一行：`[m:ss] 正文` */
export interface TranscriptLine {
  stamp: string;
  seconds: number;
  text: string;
}

const TRANSCRIPT_LINE_RE = /^\[(\d{1,2}(?::\d{2}){1,2})\]\s*(.*)$/;

/** 把 cuesToTranscript 的输出拆成可点击的行；认不出的行直接跳过 */
export function transcriptLines(transcript: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const raw of (transcript || '').split('\n')) {
    const m = TRANSCRIPT_LINE_RE.exec(raw.trim());
    if (!m) continue;
    const seconds = parseTimestamp(m[1]);
    if (seconds == null) continue;
    out.push({ stamp: m[1], seconds, text: m[2] });
  }
  return out;
}

export function courseUrl(bvid: string): string {
  return `https://www.bilibili.com/video/${encodeURIComponent(bvid)}`;
}

/**
 * 文件名 / frontmatter 标题的安全化：Windows 非法字符、Markdown 链接会破坏的 `#[]` 全换成空格。
 * 不做哈希后缀——用户看得懂的名字比唯一性重要，重名由落盘层提示。
 */
export function safeTitle(raw: string): string {
  const text = (raw || '')
    .replace(/[\\/:*?"<>|#^[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return text || '未命名课程';
}

/** 把任意文本压成一行并转义双引号，供 YAML 双引号标量使用 */
function yamlString(text: string): string {
  return `"${(text || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim()}"`;
}

function isoDate(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * 网盘 / 资料链接只接受 http(s)：粘贴进来的常带空格与追踪参数，
 * 空串或非链接一律当没填，避免把「复制失败」的文本写进 frontmatter。
 */
export function normalizeMaterialUrl(raw: string | undefined | null): string {
  const text = (raw || '').trim();
  return /^https?:\/\/\S+$/i.test(text) ? text : '';
}

/** 笔记的 frontmatter：来源字段按 Web Clipper 的命名习惯，便于迁移到别的工具 */
export function buildCourseFrontmatter(meta: CourseMeta, clippedAt = new Date()): string {
  const tags = ['B站课程', '课程笔记'];
  const material = normalizeMaterialUrl(meta.materialUrl);
  const bvid = (meta.bvid || '').trim();
  return [
    '---',
    `title: ${yamlString(safeTitle(meta.title))}`,
    `source: ${yamlString(bvid ? courseUrl(bvid) : meta.sourceLabel || '本地导入')}`,
    ...(bvid ? [`bvid: ${yamlString(bvid)}`] : []),
    `author: ${yamlString(meta.owner || '')}`,
    ...(material ? [`material: ${yamlString(material)}`] : []),
    `clipped: ${isoDate(clippedAt)}`,
    'tags:',
    ...tags.map((t) => `  - ${t}`),
    '---',
  ].join('\n');
}

/** 模型常把整段答案包进 ```markdown 围栏；围栏进了笔记会变成一块代码 */
export function stripCodeFence(text: string): string {
  const s = (text || '').trim();
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(s);
  return (m ? m[1] : s).trim();
}

/** 讲义正文的单节骨架（讲次标题由视图按分P 生成，模型只负责这一节的内容） */
export function buildLectureMessages(args: {
  meta: CourseMeta;
  page: number;
  part: string;
  duration: number;
  transcript: string;
  /** 长分P 分段生成时的序号（从 1 开始） */
  chunkIndex?: number;
  chunkCount?: number;
}): WireMessage[] {
  const { meta, page, part, duration, transcript } = args;
  const total = args.chunkCount ?? 1;
  const index = args.chunkIndex ?? 1;
  const range = total > 1 ? `（这是第 ${index}/${total} 段字幕，只整理这一段）` : '';
  return [
    {
      role: 'system',
      content: [
        '你是把课堂字幕整理成可复习讲义的助教，服务对象是想把网课变成笔记的医学生。',
        '硬约束：',
        '1. 只依据用户提供的字幕，不补充字幕里没有的事实、数字、指南或文献；字幕没讲清楚就写「字幕未展开」。',
        '2. 每条要点末尾标一个时间锚点，格式 [m:ss]，时间必须直接取自字幕行首的锚点，不要自己估算。',
        '3. 保留英文学术术语，首次出现给中文对照；不要改写老师已经给出的定义。',
        '4. 只输出 Markdown 正文，不要一级/二级标题（讲次标题由程序加），不要代码围栏，不要开场白与总结套话。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `课程：${meta.title}${meta.owner ? `（${meta.owner}）` : ''}`,
        `本次内容：P${page}《${part}》，时长 ${formatTime(duration)}${range}`,
        '',
        '请按下面四节输出：',
        '### 核心结论',
        '（3–6 条，每条一句话，带 [m:ss]）',
        '### 概念与机制',
        '（把字幕里的定义、因果、步骤按讲解顺序写清楚，可用列表）',
        '### 易错点',
        '（老师明确提醒过、或容易混淆的点；没有就写「本节未特别强调」）',
        '### 自测问题',
        '（3–5 个能直接自问自答的问题，不要给答案）',
        '',
        '字幕（行首方括号是时间锚点）：',
        transcript,
      ].join('\n'),
    },
  ];
}

/**
 * 字幕按行切成不超过 `maxChars` 的若干段。
 * 只在行边界切，保证每条要点的时间锚点不会和它的正文被拆到两段；
 * 单行本身超限时也单独成段（宁可超一点，也不切碎一句话）。
 */
export function splitTranscript(transcript: string, maxChars = TRANSCRIPT_CHUNK): string[] {
  const lines = (transcript || '').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const limit = Math.max(500, maxChars);
  const chunks: string[] = [];
  let buf: string[] = [];
  let len = 0;
  for (const line of lines) {
    if (buf.length && len + line.length + 1 > limit) {
      chunks.push(buf.join('\n'));
      buf = [];
      len = 0;
    }
    buf.push(line);
    len += line.length + 1;
  }
  if (buf.length) chunks.push(buf.join('\n'));
  return chunks;
}

/** 拼出完整课程笔记：frontmatter + 课程信息 + 每分P 一节 + 未收录说明 */
export function assembleCourseNote(
  meta: CourseMeta,
  sections: readonly LectureSection[],
  skipped: readonly SkippedPart[] = [],
  clippedAt = new Date(),
): string {
  const ordered = [...sections].sort((a, b) => a.page - b.page);
  const head = buildCourseFrontmatter(meta, clippedAt);
  const material = normalizeMaterialUrl(meta.materialUrl);
  const bvid = (meta.bvid || '').trim();
  const source = bvid
    ? [
        `> 来源：B 站 · ${meta.owner || '未知 UP 主'} · ${meta.partCount} 个分P · 总时长 ${formatTime(meta.duration)}`,
        `> 原视频：${courseUrl(bvid)}`,
        ...(material ? [`> 网盘资料：${material}`] : []),
        '> 讲义只覆盖有 CC 字幕的分P；没有字幕的分P不做音频转写，列在文末。',
      ]
    : [
        `> 来源：本地导入 · ${meta.partCount} 个文件`,
        ...(material ? [`> 网盘资料：${material}`] : []),
        '> 内容来自导入的字幕/文本，没有 B 站视频可跳转，时间戳只作参考。',
      ];
  const body = ordered.map((s) => {
    const title = bvid
      ? `## P${s.page} ${s.part}${s.duration > 0 ? ` · ${formatTime(s.duration)}` : ''}`
      : `## ${s.part}`;
    const text = bvid
      ? linkTimeAnchors(stripCodeFence(s.body), bvid, s.page)
      : stripCodeFence(s.body);
    if (!bvid) return `${title}\n\n${text}`;
    const open = `> [▶ 打开本节视频](${courseAnchorHref({ bvid, page: s.page })})`;
    return `${title}\n\n${open}\n\n${text}`;
  });
  const tail = skipped.length
    ? [
        '## 未收录',
        ...skipped.map((s) => `- P${s.page}《${s.part}》：${s.reason}`),
      ].join('\n')
    : '';
  return [head, '', `# ${safeTitle(meta.title)}`, '', ...source, '', ...body, ...(tail ? ['', tail] : []), ''].join('\n');
}

/** 生成方式：精华（一页复习卡，默认） / 完整讲义（逐分P） */
export type NoteMode = 'essence' | 'lecture';

export interface PartDigest {
  page: number;
  part: string;
  /** 模型产出的要点列表，每行 `- [m:ss] ...` */
  digest: string;
}

/** 一页复习卡的字数上限（不是硬截断，写进提示词；保存时再兜底） */
export const ESSENCE_LIMIT = 1100;

/**
 * 第一级压缩：逐分P删减成「复习卡片」。
 * 关键在「只删不写」——一旦让模型自由改写，它就会把字幕重新讲一遍，
 * 用户拿到的还是长篇，只是语言更顺。
 */
export function buildDigestMessages(args: {
  meta: CourseMeta;
  page: number;
  part: string;
  transcript: string;
}): WireMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是课程编辑，任务是把一节课堂字幕删减成复习卡片。只做删减，不做扩写。',
        '只保留这五类信息：定义、机制或因果、可执行步骤、明确结论、老师强调的易错点/考点。',
        '删除：寒暄、口头禅、重复、举例的具体细节、过渡语、与考点无关的闲聊。',
        `格式：每行一条，以「分P + 时间点」开头，例如 \`- P${args.page} 12:34 要点\`；分P 不能省（用户要凭它回原视频）；每条不超过 35 个字；输出 3–8 条。`,
        '不要标题、不要开头结尾、不要补充字幕里没有的内容；宁缺毋滥。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `课程：${args.meta.title}`,
        `讲次：P${args.page}《${args.part}》`,
        '',
        '字幕（行首方括号是时间锚点）：',
        args.transcript,
      ].join('\n'),
    },
  ];
}

/**
 * 第二级压缩：把各分P要点合并成一页复习卡。
 * 按主题聚类而不是按讲次复述——这正是「精华」和「讲义目录」的区别。
 */
export function buildEssenceMessages(args: {
  meta: CourseMeta;
  digests: readonly PartDigest[];
}): WireMessage[] {
  const evidence = [...args.digests]
    .sort((a, b) => a.page - b.page)
    .map((d) => `P${d.page}《${d.part}》\n${d.digest}`)
    .join('\n\n');
  return [
    {
      role: 'system',
      content: [
        '你负责把多节课的要点合并成一张「一页复习卡」，给考前 10 分钟看。',
        '硬约束：',
        '1. 先按主题聚类，再合并同义项；不要按讲次顺序复述，不要出现「P1 讲了…」这种结构。',
        '2. 只用给出的要点，不补充、不推断、不举例；去掉重复与铺垫。',
        '3. 每个结论尽量控制在一句话内；总长度不超过 1000 字。',
        '4. 时间锚点必须写成「P<分P> m:ss」（例如 P3 12:34），分P 不能省略；锚点只在能帮助回看时保留，不能拿锚点凑字数。',
        '5. 固定用下面五节（三级标题），没有内容的小节也要保留并写「本节未强调」：',
        '### 一句话总结',
        '（不超过 40 字，直接说这门课解决什么问题）',
        '### 核心概念',
        '（不超过 8 条，定义与区别优先）',
        '### 机制与步骤',
        '（有先后顺序的写成编号步骤）',
        '### 易错与考点',
        '（老师强调过的、容易混淆的）',
        '### 自测',
        '（3 个问题，只问不答）',
        '只输出 Markdown 正文，不要代码围栏，不要开场白。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `课程：${args.meta.title}${args.meta.owner ? `（${args.meta.owner}）` : ''}`,
        `分P 数：${args.meta.partCount}`,
        '',
        '各分P要点：',
        evidence,
      ].join('\n'),
    },
  ];
}

/** 精华笔记：frontmatter + 标题 + 来源 + 一页复习卡 + 未收录说明 */
export function assembleEssenceNote(
  meta: CourseMeta,
  essence: string,
  skipped: readonly SkippedPart[] = [],
  clippedAt = new Date(),
): string {
  const bvid = (meta.bvid || '').trim();
  const body = bvid ? linkEssenceAnchors(stripCodeFence(essence), bvid) : stripCodeFence(essence);
  const head = buildCourseFrontmatter(meta, clippedAt);
  const material = normalizeMaterialUrl(meta.materialUrl);
  const source = bvid
    ? [
        `> 一页精华 · 来源：B 站 · ${meta.owner || '未知 UP 主'} · ${meta.partCount} 个分P · 总时长 ${formatTime(meta.duration)}`,
        `> 原视频：${courseUrl(bvid)}`,
        ...(material ? [`> 网盘资料：${material}`] : []),
        '> 只提炼可复习的结论；完整讲解按分P见「完整讲义」模式。没有字幕的分P不做音频转写。',
      ]
    : [
        `> 一页精华 · 来源：本地导入 · ${meta.partCount} 个文件`,
        ...(material ? [`> 网盘资料：${material}`] : []),
        '> 内容来自导入的字幕/文本，时间戳只作参考，没有可跳转的 B 站视频。',
      ];
  const tail = skipped.length
    ? ['## 未收录', ...skipped.map((s) => `- P${s.page}《${s.part}》：${s.reason}`)].join('\n')
    : '';
  return [head, '', `# ${safeTitle(meta.title)}`, '', ...source, '', body, ...(tail ? ['', tail] : []), ''].join('\n');
}

/** 人格卡提示词：只归纳表达方式，不猜生平。字数上限与 SOUL_PREFIX_LIMIT 对齐 */
export function buildPersonaMessages(args: {
  meta: CourseMeta;
  /** 已生成的讲义（截断后作为证据） */
  evidence: string;
  /** 原话样本：用来支撑「语言风格」层；没有就不写口头禅 */
  styleSample?: string;
}): WireMessage[] {
  const limit = Math.max(400, SOUL_PREFIX_LIMIT - 80);
  return [
    {
      role: 'system',
      content: [
        '你负责把一位讲师的讲课方式写成「人格卡」，供另一个 AI 在回答时保持同样口吻。',
        '只根据给出的讲义与原话样本归纳，不编造生平、学历、任职、性格。',
        '分两层写，缺一层都会退化（只有风格是模仿秀，只有判断是教科书）：',
        '第一层「判断与教学法」：先抓什么、怎么框定问题、什么情况用哪个方法及不适用条件、怎么纠错、明确划的边界、怎么判断考点。',
        '第二层「语言风格」：只保留有辨识度的——口头禅原句、自称与称呼、提问互动方式、类比取材、敲打方式。没有证据就写「原话样本不足」，不要编口头禅。',
        '减废话判据：删掉这条，读者对这位老师的认识会不会变少？不会就删。不要搬「这个这个」、语气词、无意义重复。',
        '溯源：每条若来自原话，可附一句极短的原话片段；属于你的归纳就标「（推断）」；没有依据的不要写。',
        '输出纯文本，不要 Markdown 围栏、不要「以下是人格卡」之类的话。',
        `总长度不超过 ${limit} 个字符，用三到五段短句。`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `讲师：${args.meta.owner || '未知'}`,
        `课程：${args.meta.title}`,
        '',
        '讲义证据：',
        args.evidence,
        ...(args.styleSample?.trim() ? ['', '原话样本（只用于归纳风格，不要整段复述）：', args.styleSample] : []),
      ].join('\n'),
    },
  ];
}

/** 人格卡文件：frontmatter 的 persona 决定它在 AI 面板里的显示名 */
export function buildPersonaCard(name: string, body: string, meta?: CourseMeta): string {
  const text = stripCodeFence(body).trim();
  const clipped = text.length > SOUL_PREFIX_LIMIT ? `${text.slice(0, SOUL_PREFIX_LIMIT - 1)}…` : text;
  return [
    '---',
    `persona: ${yamlString(safeTitle(name))}`,
    ...(meta?.bvid ? [`source: ${yamlString(courseUrl(meta.bvid))}`] : []),
    '---',
    '',
    clipped,
    '',
  ].join('\n');
}

/** 本地导入课程的默认目录：和 B 站课程分开，便于按来源找笔记 */
export const LOCAL_COURSE_DIR = '课程笔记';

export function courseNotePath(title: string, dir: string = COURSE_DIR): string {
  return `${dir}/${safeTitle(title)}.md`;
}

export function personaPath(name: string): string {
  return `${PERSONA_DIR}/${safeTitle(name)}-perspective.md`;
}


export interface EssenceAudit {
  ok: boolean;
  issues: string[];
}

/**
 * 生成后的确定性自检（借技能包阶段 7 的交付自检思路）。
 * 只检查能机械判定的事：结构齐不齐、有没有可回看的锚点、有没有超预算。
 * 内容对不对不在这里判——那要靠人回看原视频。
 */
export function auditEssence(
  text: string,
  opts: { anchors?: boolean } = {},
): EssenceAudit {
  const body = stripCodeFence(text);
  const issues: string[] = [];
  const sections = ['一句话总结', '核心概念', '机制与步骤', '易错与考点', '自测'];
  for (const name of sections) {
    if (!body.includes(`### ${name}`)) issues.push(`缺少「${name}」一节`);
  }
  // 本地导入没有可跳转的视频，不要求时间锚点
  if (opts.anchors !== false && !/(?:P\d+\s+)?\d+:\d{2}/.test(body)) {
    issues.push('没有可回看的时间锚点');
  }
  if (body.replace(/\s/g, '').length > ESSENCE_LIMIT) {
    issues.push(`超过 ${ESSENCE_LIMIT} 字预算`);
  }
  if (!/^[-*]\s+/m.test(body)) issues.push('没有任何要点列表');
  return { ok: issues.length === 0, issues };
}

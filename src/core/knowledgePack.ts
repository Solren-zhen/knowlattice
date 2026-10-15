/**
 * 知识包：把「一组现成的笔记」当成一个可导入/导出的 JSON 文件。
 *
 * 借鉴点：第三方备考工具随安装包带 7 个结构化数据集（症状→疾病 341/436、医学英语 721 组、
 * 方剂口诀 4 库、影像题 603…），新用户第一次打开就有内容可练；本项目是**空库**，
 * 自己建完才有东西——冷启动是最明显的体验缺口（有 core/demo.ts 演示数据，但那是"假数据"，
 * 不是可累积、可分享的真内容）。
 *
 * 为什么不直接随包发布医学内容，而只做**机制**：
 *   1. 版权。对标产品自己的手写笔记标着「售卖版」、题库靠「AI 严格对标大纲参数化现场命制，
 *      不侵犯第三方真题版权」来规避 —— 它自己都在防这件事。我不去生成或搬运受版权保护的
 *      题库/讲义，也不臆造医学结论（错的医学内容比没有内容有害得多）。
 *   2. 体积。7 个数据集 1.85 MB 起步，还要配远端图片（它们用 CDN URL，会破坏我们的离线可用）。
 * 所以这里交付格式 + 导入/导出机制 + 一个不含医学结论的自带示例包。
 * 真实内容由用户/老师自己打包分发（这也是知识包的正常用法）。
 *
 * 与既有导入的一致性：**重复路径跳过并报告，绝不静默覆盖**——
 * 导入别人的包不该改掉你自己的笔记，这与题库批量导入同一纪律。
 *
 * 刻意不 import core/vault.ts：那个模块会拉起整套存储适配器，
 * 而知识包只需要"校验 + 组装文本"，没必要为它把 vault 拖进来（也会形成循环依赖）。
 * 因此安全校验在这里独立完成，落盘交给调用方走 vault.createNote。
 */
import { parseFrontmatter, serializeFrontmatter, type NoteMeta } from './parser';

export const PACK_FORMAT = 'knowlattice-pack';
export const PACK_VERSION = 1;

/** 单个包最多多少篇（防手滑导入巨型文件把界面卡死） */
export const MAX_PACK_NOTES = 5000;
/** 单篇正文最大字符数 */
export const MAX_NOTE_CHARS = 1_000_000;

export interface PackNote {
  /** 笔记标题（也是文件名，不含 .md） */
  title: string;
  /** 正文（不含 frontmatter；frontmatter 由本模块按 chapter/tags 等字段生成） */
  body: string;
  /** vault 内相对目录，用 `/` 分隔（如「生理学/血液」）；空 = 根目录 */
  dir?: string;
  chapter?: string;
  tags?: string[];
  source?: string;
  exam?: string[];
}

export interface KnowledgePack {
  format: typeof PACK_FORMAT;
  version: number;
  name: string;
  description?: string;
  author?: string;
  license?: string;
  notes: PackNote[];
}

/** Windows 非法文件名字符 + 路径分隔符（这些会写到盘上失败，或造成路径穿越） */
const BAD_IN_NAME = /[\\/:*?"<>|]/;

/**
 * 是否含控制字符（C0 区 + DEL）。
 * 不用正则字符类：oxlint 的 no-control-regex 会为 `[\u0000-\u001f]` 报警告，
 * 而这里只是想挡住不该出现在文件名里的字符——逐字符判断更直白，也不平白增加告警噪声。
 */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** 单段路径是否安全可用：非空、无非法字符、不是 `.` / `..`、不以 `.` 开头（隐藏/系统目录） */
export function safeSegment(seg: string): boolean {
  const s = seg.trim();
  if (!s) return false;
  if (s === '.' || s === '..') return false;
  if (s.startsWith('.')) return false;
  return !BAD_IN_NAME.test(s) && !hasControlChar(s);
}

/** 相对目录是否安全（逐段校验；空串视为根目录） */
export function safeDir(dir: string): boolean {
  const d = dir.trim();
  if (!d) return true;
  return d.split('/').every(safeSegment);
}

/** 包内笔记 → vault 相对路径（不校验安全，校验见 planPackInstall） */
export function packNotePath(note: PackNote): string {
  const dir = (note.dir ?? '').trim().replace(/\/+$/, '');
  return dir ? `${dir}/${note.title.trim()}.md` : `${note.title.trim()}.md`;
}

/** 包内笔记 → 完整 Markdown 文本（frontmatter + H1 + 正文） */
export function packNoteContent(note: PackNote): string {
  const meta: NoteMeta = {
    aliases: [],
    tags: Array.isArray(note.tags) ? note.tags.filter((t) => typeof t === 'string' && t.trim()) : [],
    chapter: note.chapter ?? '',
    source: note.source ?? '',
    created: new Date().toISOString().slice(0, 10),
    exam: Array.isArray(note.exam) ? note.exam.filter((e) => typeof e === 'string' && e.trim()) : [],
  };
  const body = (note.body ?? '').replace(/^\s*\n/, '').replace(/\s+$/, '');
  return `${serializeFrontmatter(meta)}\n# ${note.title.trim()}\n\n${body}\n`;
}

/**
 * 解析知识包文本。任何结构问题都抛错并说明原因——
 * 导入失败必须让用户看到"为什么"，静默导入 0 篇是最糟的结果。
 */
export function parseKnowledgePack(text: string): KnowledgePack {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('不是有效的 JSON 文件');
  }
  const o = data as Partial<KnowledgePack> | null;
  if (!o || typeof o !== 'object') throw new Error('知识包内容为空');
  if (o.format !== PACK_FORMAT) throw new Error(`不是晶格知识包（缺少 format: "${PACK_FORMAT}"）`);
  if (typeof o.version === 'number' && o.version > PACK_VERSION) {
    throw new Error(`知识包版本 ${o.version} 高于当前支持的 ${PACK_VERSION}，请升级后再导入`);
  }
  if (!Array.isArray(o.notes)) throw new Error('知识包缺少 notes 列表');
  if (o.notes.length > MAX_PACK_NOTES) throw new Error(`知识包含 ${o.notes.length} 篇，超过上限 ${MAX_PACK_NOTES}`);
  const notes: PackNote[] = [];
  o.notes.forEach((raw, i) => {
    const n = raw as Partial<PackNote> | null;
    if (!n || typeof n !== 'object') throw new Error(`第 ${i + 1} 篇不是对象`);
    if (typeof n.title !== 'string' || !n.title.trim()) throw new Error(`第 ${i + 1} 篇缺少 title`);
    if (typeof n.body !== 'string') throw new Error(`第 ${i + 1} 篇（${n.title}）缺少 body 文本`);
    if (n.body.length > MAX_NOTE_CHARS) throw new Error(`第 ${i + 1} 篇（${n.title}）正文过长`);
    notes.push({
      title: n.title,
      body: n.body,
      dir: typeof n.dir === 'string' ? n.dir : '',
      chapter: typeof n.chapter === 'string' ? n.chapter : '',
      tags: Array.isArray(n.tags) ? n.tags.filter((t): t is string => typeof t === 'string') : [],
      source: typeof n.source === 'string' ? n.source : '',
      exam: Array.isArray(n.exam) ? n.exam.filter((e): e is string => typeof e === 'string') : [],
    });
  });
  return {
    format: PACK_FORMAT,
    version: typeof o.version === 'number' ? o.version : PACK_VERSION,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : '未命名知识包',
    description: typeof o.description === 'string' ? o.description : '',
    author: typeof o.author === 'string' ? o.author : '',
    license: typeof o.license === 'string' ? o.license : '',
    notes,
  };
}

export interface PackInstallEntry {
  dir: string;
  title: string;
  path: string;
  content: string;
}

export interface PackInstallPlan {
  toCreate: PackInstallEntry[];
  /** 被跳过的条目 + 原因（逐条报给用户，不静默丢弃） */
  skipped: Array<{ path: string; title: string; reason: string }>;
}

/**
 * 生成安装计划：只产出"该新建什么"，不写任何东西（纯函数，可单测）。
 *
 * 跳过规则（每条都会出现在结果里，由界面逐条显示）：
 *   - 标题/目录不安全 → 不写盘（避免路径穿越、避免 Windows 非法名）
 *   - 标题或正文为空 → 没有意义的空笔记
 *   - 目标路径已存在 → **跳过，不覆盖**（同名笔记可能是用户自己的心血）
 */
export function planPackInstall(pack: KnowledgePack, exists: (path: string) => boolean): PackInstallPlan {
  const toCreate: PackInstallEntry[] = [];
  const skipped: PackInstallPlan['skipped'] = [];
  // 同一包内重名也要去重，否则第二次会撞上第一次写出来的文件
  const seen = new Set<string>();

  for (const note of pack.notes) {
    const title = note.title.trim();
    const dir = (note.dir ?? '').trim().replace(/\/+$/, '');
    if (!safeSegment(title)) {
      skipped.push({ path: title || '(空标题)', title, reason: '标题含非法字符或为空' });
      continue;
    }
    if (!safeDir(dir)) {
      skipped.push({ path: `${dir}/${title}.md`, title, reason: '目录含非法字符' });
      continue;
    }
    if (!note.body.trim()) {
      skipped.push({ path: packNotePath(note), title, reason: '正文为空' });
      continue;
    }
    const path = packNotePath(note);
    if (seen.has(path)) {
      skipped.push({ path, title, reason: '包内重名' });
      continue;
    }
    if (exists(path)) {
      skipped.push({ path, title, reason: '同名笔记已存在（未覆盖）' });
      continue;
    }
    seen.add(path);
    toCreate.push({ dir, title, path, content: packNoteContent(note) });
  }
  return { toCreate, skipped };
}

/**
 * 把一批已有笔记打包（供用户/老师导出分享）。
 * 正文里的 frontmatter 会被解析出来转成包字段，导回去仍是同一篇笔记。
 */
export function packFromNotes(
  name: string,
  entries: Array<{ path: string; content: string }>,
  info: { description?: string; author?: string; license?: string } = {}
): KnowledgePack {
  const notes: PackNote[] = [];
  for (const { path, content } of entries) {
    const { meta, body, title } = parseFrontmatter(content);
    const base = path.replace(/\.md$/, '');
    const fileTitle = base.split('/').pop() || base;
    // 目录 = 去掉最后一段；它同时是包里的 dir
    const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
    notes.push({
      title: title || fileTitle,
      body: body.replace(/^\s*\n/, ''),
      dir,
      chapter: meta.chapter,
      tags: meta.tags,
      source: meta.source,
      exam: meta.exam,
    });
  }
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    name,
    description: info.description ?? '',
    author: info.author ?? '',
    license: info.license ?? '',
    notes,
  };
}

/**
 * 自带示例包：**刻意不含任何医学结论**，只演示格式与两件本项目独有能力
 * （`{{挖空}}` 行内制卡、frontmatter 的 chapter/exam 字段），
 * 因此可以放心随包发布——错的学习方法只是没用，错的医学知识是有害的。
 */
export function examplePack(): KnowledgePack {
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    name: '晶格用法示例',
    description:
      '两篇演示笔记：一篇讲行内挖空 {{ }} 怎么用，一篇讲 frontmatter 里 chapter/exam 怎么填。不含任何医学结论，可安全导入、可随意删改。',
    author: 'KnowLattice',
    license: '随项目许可（GPL-3.0-only）',
    notes: [
      {
        title: '怎么用挖空做起复习卡',
        dir: '示例知识包',
        chapter: '使用示例',
        tags: ['使用示例', '挖空'],
        body: `把答案用双层花括号括起来，复习时它会被遮住；翻面后自动还原。

- 一行可以挖多处: 心输出量 = {{每搏输出量}} × {{心率}}
- 表格里也能挖空，遮罩只作用于双层花括号内部
- 围栏代码块与行内代码里的花括号**不会**被遮住（笔记里抄的代码不会被改坏）

## 什么时候适合挖空

适合: 一个句子里只有一两个关键词要记，其余是上下文。
不适合: 整段都要背——那种情况应该把这一段单独放一个「##」小节，让切卡规则自己处理。

## 常见误用

- 写成单层花括号「{心率}」不会生效（只认双层）
- 空的花括号「{{}}」不是挖空，会被原文保留
`,
      },
      {
        title: 'frontmatter 里该填什么',
        dir: '示例知识包',
        chapter: '使用示例',
        tags: ['使用示例'],
        source: '晶格使用示例',
        body: `每篇笔记开头的一小段 YAML 是它的属性，界面上的筛选、图谱、复习卡正面都会读它。

- aliases: 别的叫法，搜索与「[[双链]]」都能命中
- tags: 分类标签（正文里的「#标签」也会被自动收集进来）
- chapter: 章节名，统计面板的薄弱章节热力图按它聚合
- exam: 历年真题编号（如「2023-生理-12」），复习卡正面会提示
- created: 建立日期

## 为什么值得填

不填也能用，但「薄弱章节」「真题分布」这些统计会全部落到一个空章节里，
等于把颗粒度最细的那层信息扔掉了。填一次、之后复制这篇的骨架即可。
`,
      },
    ],
  };
}

/** 导出为可下载的 JSON 文本 */
export function serializeKnowledgePack(pack: KnowledgePack): string {
  return JSON.stringify(pack, null, 2);
}

/**
 * 一句话摘要：导入/导出时告诉用户「这是哪个包、多少篇、多大、谁给的、什么许可」。
 *
 * 依据：对标的几款备考 App 都随包带一份**目录清单**——窦起心搏的 `manifest.json` 里
 * 每个卷都带 `total`/`got`/`chapters`，万川医考的 `manifest.json` 带 `count`/`size`/
 * `totalQuestions`，导入前就能看见"我要吃进去的是什么、多大"。我们此前只有一个
 * 「新增 N 篇」的计数，用户其实不知道自己导入的是谁整理的东西——
 * 导入他人分享的包时尤其该讲清楚（许可字段决定能不能再分发、能不能商用）。
 *
 * `bytes` 由调用方给：调用点手上已经有原始 JSON 文本，直接用 `text.length` 就好，
 * 不必为了报个体积把整包再 stringify 一遍（几千篇的包会为此多造一份几十 MB 的字符串）。
 */
export function packSummary(pack: KnowledgePack, bytes = serializeKnowledgePack(pack).length): string {
  const parts = [
    `《${pack.name}》`,
    `${pack.notes.length} 篇`,
    `约 ${Math.max(1, Math.round(bytes / 1024))} KB`,
  ];
  if (pack.author) parts.push(`作者 ${pack.author}`);
  if (pack.license) parts.push(`许可 ${pack.license}`);
  return parts.join(' · ');
}

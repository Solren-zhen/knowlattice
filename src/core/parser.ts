/**
 * frontmatter 解析 / 序列化 —— 数据格式规范。
 * 核心字段 aliases/tags/chapter/source/created；
 * M7 起增加 exam（历年真题标记，如 `2023-生理-12`）。
 * 支持多行 YAML 列表（aliases:\n - x）与正文 #标签 收集（Obsidian 习惯）。
 */

export interface NoteMeta {
  aliases: string[];
  tags: string[];
  chapter: string;
  source: string;
  created: string;
  /** M7 · 历年真题标记，如 ["2023-生理-12", "2022-生化-8"] */
  exam: string[];
}

export interface ParsedNote {
  meta: NoteMeta;
  body: string; // 去掉 frontmatter 后的正文
  title: string; // 一级标题或文件名
}

/** 正文 #标签：# 后紧跟中英文字符（# 后有空格的是标题，前有 \w 的如 C# 不算） */
const BODY_TAG_RE = /(^|[^\w#])#([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9_/-]{0,23})/g;
/** 单篇最多收集的正文标签数（防止极端笔记拖慢全库解析） */
const MAX_BODY_TAGS = 16;

/** frontmatter 解析缓存（模块级，与 React 渲染无关）：同一路径 + 同一内容引用即命中。
 *  全库索引（nameIndex/allLinkNames）与反链面板渲染共用，避免重复解析。
 *  缓存按 path 单键覆盖，不会随保存次数无限增长；内容引用比较保证旧解析不会串台。 */
const parseCache = new Map<string, { content: string; parsed: ParsedNote }>();

export function parseFrontmatterCached(path: string, raw: string): ParsedNote {
  const hit = parseCache.get(path);
  if (hit && hit.content === raw) return hit.parsed;
  const parsed = parseFrontmatter(raw);
  parseCache.set(path, { content: raw, parsed });
  return parsed;
}

/** 从正文收集 #标签（跳过代码块；`# 标题` 行因 # 后有空格天然不命中） */
function collectBodyTags(body: string): string[] {
  const tags = new Set<string>();
  let inCode = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    for (const m of line.matchAll(BODY_TAG_RE)) tags.add(m[2]);
    if (tags.size >= MAX_BODY_TAGS) break;
  }
  return [...tags].slice(0, MAX_BODY_TAGS);
}

/** 去掉列表项两侧的引号 */
const unquote = (s: string) => s.replace(/^["']|["']$/g, '').trim();

export function parseFrontmatter(raw: string): ParsedNote {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const meta: NoteMeta = { aliases: [], tags: [], chapter: '', source: '', created: '', exam: [] };
  let body = raw;

  if (m) {
    body = m[2];
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = /^(\w+):\s*(.*)$/.exec(lines[i].trim());
      if (!kv) continue;
      const [, key, value] = kv;
      if (key === 'aliases' || key === 'tags' || key === 'exam') {
        const v = value.trim();
        if (!v) {
          // 多行 YAML 列表：aliases:\n  - x\n  - y
          const items: string[] = [];
          let j = i + 1;
          while (j < lines.length) {
            const li = /^\s+-\s*(.+)$/.exec(lines[j]);
            if (!li) break;
            const item = unquote(li[1]);
            if (item) items.push(item);
            j++;
          }
          i = j - 1;
          meta[key] = items;
        } else {
          // 行内数组 [a, b] 或逗号分隔
          meta[key] = v
            .replace(/^\[/, '')
            .replace(/\]$/, '')
            .split(',')
            .map(unquote)
            .filter(Boolean);
        }
      } else if (key === 'chapter' || key === 'source' || key === 'created') {
        meta[key] = value.trim();
      }
    }
  }

  const h1 = /^#\s+(.+)$/m.exec(body);
  const title = h1 ? h1[1].trim() : '';
  // frontmatter tags 与正文 #标签 合并（去重），供图谱/统计使用
  const allTags = new Set(meta.tags);
  for (const t of collectBodyTags(body)) allTags.add(t);
  meta.tags = [...allTags];
  return { meta, body, title };
}

export function serializeFrontmatter(meta: NoteMeta): string {
  const lines = ['---'];
  lines.push(`aliases: [${meta.aliases.join(', ')}]`);
  lines.push(`tags: [${meta.tags.join(', ')}]`);
  lines.push(`chapter: ${meta.chapter}`);
  lines.push(`source: ${meta.source}`);
  lines.push(`exam: [${meta.exam.join(', ')}]`);
  lines.push(`created: ${meta.created}`);
  lines.push('---');
  return lines.join('\n') + '\n';
}

/** 笔记类型：新建向导按类型生成骨架（医学生填空即可，不必学语法） */
export type NoteType = 'concept' | 'disease' | 'mechanism' | 'exam' | 'mnemonic' | 'blank';

export const NOTE_TYPE_LABELS: Array<{ key: NoteType; label: string }> = [
  { key: 'concept', label: '概念' },
  { key: 'disease', label: '疾病' },
  { key: 'mechanism', label: '机制' },
  { key: 'exam', label: '检查' },
  { key: 'mnemonic', label: '口诀' },
  { key: 'blank', label: '空白' },
];

/** 各类型正文骨架：「属性: 」留空即填空题 */
const SKELETONS: Record<Exclude<NoteType, 'blank'>, string[]> = {
  concept: ['- 定义: ', '- 机制: ', '- 鉴别: ', '- 口诀: ', '- 我的理解: '],
  disease: ['- 定义: ', '- 病因: ', '- 病理: ', '- 临床表现: ', '- 辅助检查: ', '- 鉴别: ', '- 治疗: ', '- 口诀: ', '- 我的理解: '],
  mechanism: ['- 定义: ', '- 关键环节: ', '- 调节因素: ', '- 失代偿: ', '- 相关疾病: ', '- 口诀: ', '- 我的理解: '],
  exam: ['- 定义: ', '- 原理: ', '- 正常值: ', '- 临床意义: ', '- 升高见于: ', '- 降低见于: ', '- 我的理解: '],
  mnemonic: ['- 内容: ', '- 释义: ', '- 适用: ', '- 关联: '],
};

/** 新建笔记模板（M1 验收项：新建笔记走模板，自动填 chapter/frontmatter；M8 起按类型出骨架） */
export function noteTemplate(title: string, chapter: string, type: NoteType = 'concept'): string {
  const today = new Date().toISOString().slice(0, 10);
  const fm = serializeFrontmatter({
    aliases: [],
    tags: [],
    chapter,
    source: '',
    created: today,
    exam: [],
  });
  const body = type === 'blank' ? '' : SKELETONS[type].join('\n');
  return fm + `\n# ${title}\n\n` + body;
}

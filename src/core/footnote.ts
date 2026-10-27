/**
 * 脚注与表格行编辑。
 *
 * 脚注走「先摘出来再拼回去」而不是给 markdown-it 装插件：
 * 项目里 markdown-it 是懒加载的（`core/markdown.ts`），插件只能在异步工厂里挂；
 * 而脚注定义本来就集中在文末那几行，摘走再统一渲染成「注释」列表，
 * 结果与 Obsidian 读起来一致，却不用往渲染管线里塞依赖。
 *
 * 表格行编辑只做「在光标所在表格末尾加一行」：加列要改分隔行与每一行的竖线数量，
 * 稍微错一个竖线整张表就散了，收益远小于风险。
 */
import type { MdEdit } from './mdFormat';

export interface Footnote {
  label: string;
  body: string;
}

/** 脚注定义行：`[^1]: 正文` */
const DEF_RE = /^\[\^([^\]]+)\]:[ \t]*(.*)$/;
/** 正文里的脚注引用：`[^1]`（不能吃掉定义行，故先摘定义） */
const REF_RE = /\[\^([^\]]+)\]/g;

/** 引用占位符：渲染后换成上标（markdown-it 关掉了 html，只能走占位替换） */
export const FN_OPEN = '\uE020';
export const FN_CLOSE = '\uE021';

/**
 * 把文末的脚注定义摘出来，正文里换成可渲染的占位符。
 * 同一 label 重复定义时取第一条（第二次出现多半是复制粘贴留下的，静默覆盖只会让人以为改没生效）。
 */
export function splitFootnotes(text: string): { body: string; notes: Footnote[] } {
  const notes: Footnote[] = [];
  const seen = new Set<string>();
  const kept: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : DEF_RE.exec(line);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      notes.push({ label: m[1], body: m[2].trim() });
      continue;
    }
    if (m) continue; // 重复定义直接丢掉，别渲染成两行
    kept.push(line);
  }
  const body = kept.join('\n').replace(REF_RE, (_m, label: string) => `${FN_OPEN}${label}${FN_CLOSE}`);
  return { body, notes };
}

/** 脚注列表的 markdown（拼在正文尾部渲染）；没有脚注时不追加任何东西 */
export function notesMarkdown(notes: Footnote[]): string {
  if (!notes.length) return '';
  const items = notes.map((n) => `- **${n.label}**　${n.body}`).join('\n');
  return `\n\n---\n\n**注释**\n\n${items}\n`;
}

/** 插入脚注：选中文字就把它变成脚注正文，光标处插入引用标记 */
export function insertFootnote(doc: string, from: number, to: number): MdEdit {
  const { notes } = splitFootnotes(doc);
  // 编号取「已有数字里最大的 +1」：用 notes.length+1 时删过脚注就会撞号
  const maxNum = notes.reduce((max, n) => {
    const num = Number.parseInt(n.label, 10);
    return Number.isFinite(num) && num > max ? num : max;
  }, 0);
  let label = String(maxNum + 1);
  while (notes.some((n) => n.label === label)) label = `${label}x`; // 用户名里出现 1x 这种，别撞
  const selected = doc.slice(from, to).trim();
  const ref = `[^${label}]`;
  const changes: MdEdit['changes'] = [{ from, to, insert: ref }];
  // 定义追加在文末，前面补空行：否则会粘在最后一段后面，markdown 认不出它是独立行
  const tail = doc.endsWith('\n') ? '' : '\n';
  const def = `${tail}\n[^${label}]: ${selected}\n`;
  changes.push({ from: doc.length, to: doc.length, insert: def });
  return { changes, selection: { anchor: from + ref.length, head: from + ref.length } };
}

/**
 * 在光标所在表格的末尾加一行。
 * 不在表格里返回 null——静默插一行空行到正文里只会让人莫名其妙。
 */
export function appendTableRow(doc: string, pos: number): MdEdit | null {
  const lines = doc.split('\n');
  // 找到光标所在行号
  let line = 0;
  let acc = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const end = acc + lines[i].length;
    if (pos <= end) { line = i; break; }
    acc = end + 1;
    line = i;
  }
  const isTableRow = (i: number) => /^\s*\|.*\|\s*$/.test(lines[i] ?? '');
  if (!isTableRow(line)) return null;
  let last = line;
  while (isTableRow(last + 1)) last += 1;
  // 列数按表头（表格第一行）算，不用当前行：某行少写一个竖线时不该带着整张表一起走样
  let head = line;
  while (isTableRow(head - 1)) head -= 1;
  const cols = Math.max(1, (lines[head].match(/\|/g)?.length ?? 2) - 1);
  const row = `|${Array.from({ length: cols }, () => '  ').join('|')}|`;
  const at = lines.slice(0, last + 1).join('\n').length;
  return {
    changes: [{ from: at, to: at, insert: `\n${row}` }],
    selection: { anchor: at + row.length + 1, head: at + row.length + 1 },
  };
}

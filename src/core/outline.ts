/**
 * 笔记大纲（本页目录）：从 Markdown 原文提取 # ~ #### 标题，供关联面板的大纲区跳转。
 *
 * 与 livePreview 的渲染口径保持一致：
 * - ATX 标题必须顶格（livePreview 的 HEAD_RE 不认缩进标题），# 后须有空格；
 * - frontmatter 与围栏代码块（``` / ~~~）里长得像标题的行不算；
 * - 行内标记（**加粗** / ==高亮== / *斜体* / `代码` / [[双链]] / [链接](url)）从目录文案里剥掉，
 *   目录显示的是「这句话」，不是「这句话的写法」。
 */

export interface OutlineItem {
  /** 标题级别 1~4 */
  level: number;
  /** 剥离行内标记后的纯文本（已 trim；空标题不产出） */
  text: string;
  /** 1-based 行号（编辑器跳转用） */
  line: number;
}

const HEAD_RE = /^(#{1,4})\s+(.*)$/;
const FENCE_RE = /^\s*(```+|~~~+)/;

/** 剥掉一层行内标记：成对标记取内容，[[目标|别名]] 取别名，[文字](链接) 取文字；
 *  图片/嵌入（![alt](url) 与 ![[嵌入]]）不产出文字（以图代题的标题不进目录） */
function stripInline(s: string): string {
  let prev = '';
  let cur = s.trim();
  // 嵌套标记（如 **[[双链]]**）一层剥不完，剥到不再变化为止（上限防病态输入）
  for (let i = 0; i < 4 && cur !== prev; i++) {
    prev = cur;
    cur = cur
      .replace(/!\[\[[^\]]+\]\]/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/^(\s*)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/, (_m, sp, t, alias) => `${sp}${(alias ?? t).trim()}`)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|==|~~|`)([^*=`~]+?)\1/g, '$2')
      .replace(/\*([^*\n]+)\*/g, '$1');
  }
  return cur.trim();
}

export function parseOutline(content: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const lines = content.split(/\r?\n/);
  let inFrontmatter = false;
  let fence: string | null = null; // 围栏标记字符（` 或 ~），null = 不在代码块里

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // frontmatter：仅当文件以 --- 开头，到下一行 --- 结束
    if (i === 0 && raw.trim() === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter) {
      if (raw.trim() === '---') inFrontmatter = false;
      continue;
    }

    // 围栏代码块：进入/退出（```pathway 这类带语言标注的围栏同样算开围栏）
    const fm = FENCE_RE.exec(raw);
    if (fm) {
      const marker = fm[1][0];
      if (!fence) fence = marker;
      else if (fence === marker && new RegExp(`^\\s*${marker === '`' ? '`{3,}' : `~{3,}`}\\s*$`).test(raw)) fence = null;
      continue;
    }
    if (fence) continue;

    const m = HEAD_RE.exec(raw);
    if (!m) continue;
    const text = stripInline(m[2]);
    if (!text) continue; // 「## 」空标题不进目录
    out.push({ level: m[1].length, text, line: i + 1 });
  }
  return out;
}

/** 大纲项的行号数组（编辑器做「光标所在小节」判定用） */
export function outlineLines(items: OutlineItem[]): number[] {
  return items.map((o) => o.line);
}

/** 光标行所在的小节标题行号：最后一个 ≤ 光标行的标题；光标在首个标题之前返回 null */
export function activeHeadingLine(lines: number[], cursorLine: number): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] <= cursorLine) return lines[i];
  }
  return null;
}

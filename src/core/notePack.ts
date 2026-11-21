/**
 * 桌面 → 手机的只读笔记包（knowlattice.notes/1）。
 *
 * 笔记正文按 desktop parser 的规则去掉 frontmatter；标题/章节用同一份解析结果，
 * 避免手机端重新理解 YAML。附件图片暂不随包传输，正文里的相对图片会在手机端显示为缺图。
 */
import { parseFrontmatterCached } from './parser';

export interface NotePackNote {
  path: string;
  title: string;
  chapter: string;
  tags: string[];
  content: string;
}

export interface NotePack {
  schema: 'knowlattice.notes/1';
  packId: string;
  exportedAt: string;
  notes: NotePackNote[];
}

const fallbackTitle = (path: string): string => {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '') || '未命名笔记';
};

export function buildNotePack(
  docs: ReadonlyMap<string, string>,
  paths: readonly string[],
  now = Date.now(),
): string {
  const seen = new Set<string>();
  const notes: NotePackNote[] = [];
  for (const path of paths) {
    if (seen.has(path) || !path.endsWith('.md')) continue;
    seen.add(path);
    const raw = docs.get(path);
    if (raw === undefined) continue;
    const parsed = parseFrontmatterCached(path, raw);
    notes.push({
      path,
      title: parsed.title || fallbackTitle(path),
      chapter: parsed.meta.chapter.trim() || path.split('/').slice(0, -1).join('/'),
      tags: parsed.meta.tags,
      content: parsed.body.trim(),
    });
  }

  return JSON.stringify({
    schema: 'knowlattice.notes/1',
    packId: `notes-${now.toString(36)}`,
    exportedAt: new Date(now).toISOString(),
    notes,
  } satisfies NotePack);
}

/**
 * 题库 → 笔记的章节索引。修一个「功能写了、文档写了、但一次都没生效」的缺口。
 *
 * 起因：README 与题库面板说明都写着「答错且题目标注了关联笔记时，自动收录进错题本」，
 * 而 QuizView 的收录条件是 `if (!correct && q.note)`。但转换器
 * scripts/qbank-to-vault.mjs 写题库 JSON 时的字段白名单（payloadFor）里**没有 note**，
 * 于是 127 份题库、111,548 道题的 `q.note` 恒为 undefined——这个能力在真实数据上
 * 一直是空的，而且不报任何错（`if` 直接短路），谁都不会发现。
 *
 * 为什么不重新生成题库 JSON：源 markdown（绿皮书 / 医考帮）已不在仓库里，
 * 重新转换先得找回源；而且 127 份合计 74 MB，重生成后用户还得重导一遍。
 *
 * 改成运行时反查，靠的是转换器自己写下的两处约定：
 *   - 题库题目的 chapter = `${学科}·${章节}`   （qbank-to-vault.mjs:294）
 *   - 笔记路径           = `题库/<源>/<学科>/<章节>.md`（qbank-to-vault.mjs:264）
 * 两边是同一组 subject / chapter，所以是**精确匹配、不是模糊匹配**：
 * 对真实全量数据实测 111,548 / 111,548 命中（0 未命中、0 空 chapter）。
 *
 * 注意：不能改用 resolveLink(chapter)。nameIndex 里同名只留第一条
 * （`if (!map.has(...))`），而「第1章 绪论」这类标题跨学科重复，
 * 按名字解析会指到别的学科的笔记上去。带学科前缀的 chapter 键没有这个问题。
 */

/** 题库笔记的路径前缀 */
export const QBANK_NOTE_PREFIX = '题库/';

/**
 * `题库/绿皮书/生理学/第6章 消化和吸收.md` → `生理学·第6章 消化和吸收`
 * 不是「题库/<源>/<学科>/<章节>.md」这种四段结构就返回 null（附件、普通笔记、更深层级都不认）。
 */
export function chapterKeyOfNotePath(path: string): string | null {
  const parts = path.split('/');
  if (parts.length !== 4 || parts[0] !== '题库') return null;
  const file = parts[3];
  if (!file.endsWith('.md')) return null;
  return `${parts[2]}·${file.slice(0, -3)}`;
}

/** 从全库路径建「章节键 → 笔记路径」索引。同名键只留第一条（键含学科，实际不会撞）。 */
export function buildChapterIndex(paths: Iterable<string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of paths) {
    const key = chapterKeyOfNotePath(p);
    if (key && !m.has(key)) m.set(key, p);
  }
  return m;
}

/**
 * 解析一道题的关联笔记路径，任一步不成立就返回 null（调用方无需先校验）。
 *
 * ① 显式 `note` 字段优先：手写题库里它是笔记名，走 resolveLink 按名解析
 *    （文件名 / 一级标题 / alias 都能命中）；转换器未来产出的会是路径，
 *    所以再接受一次「直接就是路径」——由 hasPath 把关，不凭空相信字符串。
 * ② 否则按 `chapter` 精确反查题库笔记。
 */
export function resolveQuestionNote(
  q: { note?: string; chapter?: string },
  resolveLink: (name: string) => string | null,
  chapterIndex: Map<string, string>,
  hasPath?: (path: string) => boolean
): string | null {
  const named = q.note?.trim();
  if (named) {
    const byName = resolveLink(named);
    if (byName) return byName;
    if (hasPath && named.endsWith('.md') && hasPath(named)) return named;
  }
  const chapter = q.chapter?.trim();
  if (!chapter) return null;
  return chapterIndex.get(chapter) ?? null;
}

/**
 * 「打开笔记」按钮上显示什么。
 * 手写题库里 note 本身就是给人看的笔记名，直接用；转换器产出的是路径，
 * 拿末段（题库笔记的末段就是章节标题）比整条路径友好。
 */
export function questionNoteLabel(q: { note?: string }, resolvedPath: string): string {
  const named = q.note?.trim();
  if (named && !named.endsWith('.md') && !named.includes('/')) return named;
  return resolvedPath.replace(/\.md$/, '').split('/').pop() ?? resolvedPath;
}

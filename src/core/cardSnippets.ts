/**
 * 复习卡小节：把「别的知识载体」（解剖结构、题库题目…）一键写成一个笔记小节，
 * 直接进现有的复习队列。
 *
 * 借鉴点：第三方备考工具里「点一个解剖结构 → 直接生成复习卡」「导图节点 → 一键转闪卡」
 * 是它们的核心动线——知识在哪个界面被看到，就在那里能立刻变成一张卡。
 * 本项目此前卡只能由笔记小节派生（core/srsCards.ts），于是解剖结构想进复习队列
 * 只能靠自己手动去写一篇笔记。
 *
 * **为什么不新建一套「手工卡」存储**：core/srsCards.ts 的规则是
 * 「`##` 小节 = 一张卡」，卡键 = `<path>#<小节标题>`。只要写进小节，
 * FSRS 调度、卡片编辑/删除、统计面板的「今日到期」、备份、Markdown 导出
 * **一行都不用改**就自动生效。反过来另建卡源会引出四件事：
 * 新卡源的合并、备份字段与迁移、统计口径不一致（面板说 3 张到期、复习队列给了 4 张）、
 * 以及一个只有它自己认得的存储。写小节是显式的、用户看得见也改得动，
 * 也与本项目「笔记是唯一事实来源」的既有基调一致。
 *
 * 幂等性（关键）：同标题小节已存在时**替换该小节内容**，而不是再追加一个同名小节。
 * 否则连点两次「生成复习卡」会得到两个同名 `##`，core/srsCards.ts 会把重名的补成
 * `#2` / `#3`，复习队列里出现两张几乎一样的卡，各算一套 FSRS 调度。
 *
 * 纯函数，不碰 DOM，不 import vault（由调用方负责落盘），可单测。
 */

/** 小节标题前缀：固定 `##`，与切卡规则用最浅一级标题一致 */
const H = '## ';

/** 解剖复习卡固定落在这篇笔记里（连同目录，与 views/Workspace 的解剖笔记目录一致） */
export const ANATOMY_REVIEW_DIR = '08-解剖学';
export const ANATOMY_REVIEW_TITLE = '解剖复习卡';

/**
 * 找出 `## <title>` 小节的 [start, end) 行区间。
 * `end` 落在下一个「同级或更高级」标题的行号上——`###` 属于本小节内容，
 * 这与 core/srsCards.ts 把更深的标题留在卡里的行为一致。
 */
export function findSection(body: string, title: string): { start: number; end: number } | null {
  const t = title.trim();
  if (!t) return null;
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.trim() === `${H}${t}`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s+\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

export function hasSection(body: string, title: string): boolean {
  return findSection(body, title) !== null;
}

/**
 * 写入/替换一个小节（幂等）。返回新的笔记正文。
 * 标题为空时原样返回——宁可什么都不做，也不要写出一个没有标题的空小节
 * （切卡规则会把它当成「总览」的一部分，用户看不出发生了什么）。
 */
export function upsertSection(body: string, title: string, content: string): string {
  const t = title.trim();
  if (!t) return body;
  const block = `${H}${t}\n\n${content.trim()}`;
  const found = findSection(body, t);
  const lines = body.split('\n');

  if (!found) {
    const head = body.trim();
    return head ? `${head}\n\n${block}\n` : `${block}\n`;
  }

  const before = lines.slice(0, found.start).join('\n').trim();
  const after = lines.slice(found.end).join('\n').trim();
  return [`${before}\n\n${block}`, after].filter(Boolean).join('\n\n') + '\n';
}

/** 删除一个小节（幂等）。不存在时原样返回。 */
export function removeSection(body: string, title: string): string {
  const found = findSection(body, title);
  if (!found) return body;
  const lines = body.split('\n');
  const before = lines.slice(0, found.start).join('\n').trim();
  const after = lines.slice(found.end).join('\n').trim();
  const joined = [before, after].filter(Boolean).join('\n\n');
  return joined ? `${joined}\n` : '';
}

/**
 * 由「属性键 → 值」列表拼一个小节正文。
 * 用 `- 键: 值` 形式：core/srsCards.ts 的 cardHints 会把这些键抽出来当**正面提示**
 * （只给键、不给值），所以卡片正面会自动显示「英文名 / 所属系统 / 笔记」这些线索，
 * 不必为复习界面额外写一套渲染。
 */
export function buildSectionBody(fields: Array<[key: string, value: string]>): string {
  const lines = fields
    .filter(([k]) => k.trim())
    .map(([k, v]) => `- ${k.trim()}: ${(v ?? '').trim()}`);
  // 留一个「我的理解」空格：与新建向导的概念模板同口径，用户补一句就是自己的卡
  lines.push('- 我的理解: ');
  return lines.join('\n');
}

/**
 * 解剖结构 → 复习卡小节（标题 + 正文）。
 *
 * 只为「看得见的那部分」建卡：结构名做标题，英文名/所属系统/对应笔记做属性。
 * 不臆造解剖学结论——本项目已经有 3D 图谱与结构↔笔记双向关联，
 * 真正的知识应该由用户写在那篇笔记里，这里只负责把它拉进复习队列。
 */
export function anatomySection(
  input: { zhName: string; enName: string; system: string; noteTitle?: string }
): { title: string; body: string } {
  const title = (input.zhName || input.enName).trim();
  const note = (input.noteTitle ?? '').trim();
  return {
    title,
    body: buildSectionBody([
      ['英文名', input.enName],
      ['所属系统', input.system],
      ['笔记', note ? `[[${note}]]` : ''],
    ]),
  };
}

/**
 * 「哪些附件已经没有被任何笔记引用」的判定（纯函数，不碰存储）。
 *
 * 背景：附件外置在库根的 `_attachments/`（见 vault.saveAttachment），引用它们的地方有**两处**：
 *   ① 笔记正文里的库相对路径（`![](_attachments/x.png)`，也支持 `![[x.png]]`）；
 *   ② 应用侧存储里的挂载/引用——音频与字幕挂在 `core/noteMedia`（localStorage），题库的题干图与
 *      选项图挂在题库存储（`storage/qbank`）。**这两类在正文里没有任何字符串**。
 * 只扫正文就删，会把用户挂着的音频/字幕、题库里的题图当成「没人用」删掉——正文里的播放条当场断、
 * 题目图变成破图。所以本模块的入参除了正文，还要接收「正文之外的引用路径」（extraReferences）。
 *
 * 本模块只负责**判定**：给一批附件路径 + 全部笔记正文 + 正文外引用，算出「谁都没提」的那些。
 *
 * 判据只有一条：**在上面这些地方找得到这条路径**（找不到 = 孤儿）。方向刻意保守——宁可漏删（当成有人用），
 * 也绝不误删（正文留下破图）：
 *   - 正文里的路径用「附件路径本身」构造正则精确匹配，因此带空格、全角括号的文件名都没问题
 *     （`第一讲 呼吸（上）.mp3` 这种名字真实存在：挂音频/字幕用的是**原始文件名**）；
 *   - 正文写成 `%20` 这类百分号编码时，把正文整体解码后再扫一遍（两个方向都扫，只多认不漏认）；
 *   - `[[目标]]` / `![[目标|显示]]` 按应用的解析规则算引用：目标已是 `_attachments/…` 用它本身，
 *     否则按 `_attachments/<目标>`（与 core/livePreview 的嵌入解析一致）；
 *   - 只看路径、不看它出现在什么语法里：写在代码块/行内代码里的路径也算引用。
 * 少删一个孤儿只是没省下那点空间；误删一个被引用的文件却会让正文留下破图，代价不对称。
 */

/** `[[目标]]` 与 `![[目标|显示]]` 的目标（显示名不参与解析） */
const WIKI_TARGET = /\[\[([^\][|]+)(?:\|[^\]]*)?\]\]/g;

/** 把一段文本当成正则字面量（附件路径里 `.` `(` `)` 都是常见字符，必须转义） */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 待扫的文本：原样 + 百分号解码后的版本（有 `%` 才尝试解码，解不开就只扫原样） */
function textVariants(text: string): string[] {
  const out = [text];
  if (text.includes('%')) {
    try {
      const decoded = decodeURIComponent(text);
      if (decoded !== text) out.push(decoded);
    } catch {
      /* 文本里有非法的 % 序列：忽略解码这一路，原样仍然算 */
    }
  }
  return out;
}

/**
 * 被引用到的附件路径（结果一定是 `attachmentPaths` 的子集）。
 * `extraReferences` 是**正文之外**的引用路径（挂载表里的音频/字幕、题库里的题干图与选项图）——
 * 漏掉它们就会把这些附件当孤儿删掉，见文件头说明。
 */
export function referencedAttachments(
  noteTexts: Iterable<string>,
  attachmentPaths: Iterable<string>,
  extraReferences: Iterable<string> = [],
): Set<string> {
  const all = [...new Set(attachmentPaths)];
  const allSet = new Set(all);
  const used = new Set<string>();
  // 正文之外的引用先算：它们不依赖正文，直接按路径命中
  for (const p of extraReferences) if (allSet.has(p)) used.add(p);
  if (all.length === 0) return used;
  // 长路径排在前面：`_attachments/a.png.bak` 存在时，正文提到它不会被 `_attachments/a.png` 抢先匹配掉
  const pattern = new RegExp([...all].sort((a, b) => b.length - a.length).map(escapeRe).join('|'), 'g');
  for (const raw of noteTexts) {
    // 所有附件都已被引用：再往下扫也不可能产出新的孤儿（结果只会由「有」变「无」），提前收工。
    // 大库里这个早退很常见（绝大多数附件都有引用），一次清理从「扫完全库」降到「扫到最后一个孤儿」。
    if (used.size === all.length) break;
    if (typeof raw !== 'string' || !raw) continue;
    for (const text of textVariants(raw)) {
      for (const m of text.matchAll(pattern)) used.add(m[0]);
      for (const m of text.matchAll(WIKI_TARGET)) {
        const target = m[1].trim();
        const cands = target.startsWith('_attachments/') ? [target] : [`_attachments/${target}`];
        for (const cand of cands) if (allSet.has(cand)) used.add(cand);
      }
    }
  }
  return used;
}

/**
 * 没有任何笔记引用的附件（按路径升序，界面列表才稳定）。
 * 同时给出总数与仍被引用的数量，调用方可以直接说「共 N 个，其中 M 个还在用」。
 */
export function findOrphanAttachments(
  attachmentPaths: Iterable<string>,
  noteTexts: Iterable<string>,
  /** 正文之外的引用路径（音频/字幕挂载、题库题图），见文件头说明 */
  extraReferences: Iterable<string> = [],
): { orphans: string[]; referenced: number; total: number } {
  // 去重：调用方给了重复路径时，孤儿清单不该出现两条一样的（界面会看糊涂，删除也会算两次）
  const all = [...new Set(attachmentPaths)];
  const used = referencedAttachments(noteTexts, all, extraReferences);
  const orphans = all.filter((p) => !used.has(p)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { orphans, referenced: used.size, total: all.length };
}

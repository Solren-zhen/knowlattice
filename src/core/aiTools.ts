/**
 * AI 笔记助手里「算新正文」的那几段纯逻辑，从视图里搬出来单独放。
 *
 * 为什么搬：这些是写入路径上最容易错、也最难靠界面测覆盖的部分——锚文本宽容匹配、
 * 属性键骨架插入位置、唯一性校验。原先它们埋在 AiAgentPanel 的 executeTool 巨型 if 链里
 * （那个函数两百多行，混着路径校验、用户确认、快照推进），只能靠 DOM 测试间接断言，
 * 出错时也不知道是逻辑错还是接线错。抽成纯函数后可以直接对着字符串单测。
 *
 * 这一层**不做**任何 IO：不读笔记、不写盘、不问用户。调用方负责取 old、拿裁决、落盘。
 */
import { fuzzyFindAnchor } from './aiPatch';
import { cardHints } from './srsCards';

/** `- 键: ` 属性键行的判据；与 srsCards.cardHints 同口径（键 ≤12 字，无空格冒号） */
export const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*$/;

export type ToolOutcome = { next: string } | { error: string };

/** 与 srsCards.cardHints 同一判据的属性键行（键不含空白、≤12 字、半角冒号） */
function isCardKeyLine(line: string): boolean {
  const m = /^(\s*-\s*)([^:\n【[]{1,12})(\s*):/.exec(line);
  return !!m && !/\s/.test(m[2]);
}

/**
 * 属性键清洗：去空白、去尾部半角/全角冒号、去重，再校验。
 *
 * 为什么要去尾部冒号：中文输入法下「定义：」是极自然的写法，而 cardHints 只认半角冒号，
 * 带全角冒号的键写进笔记后不会变成回忆提示，等于白做一次提案。
 */
export function cleanCardKeys(raw: unknown): { keys: string[] } | { error: string } {
  const keys = [...new Set((Array.isArray(raw) ? raw : [])
    .map((k) => String(k).trim().replace(/[:：]+$/, '').trim())
    .filter(Boolean))];
  if (!keys.length) return { error: '错误：keys 为空。至少给一个属性键，如「定义」。' };
  const bad = keys.find((k) => /[:\s：]/.test(k) || k.length > 12);
  if (bad) {
    return {
      error: `错误：属性键「${bad}」不合法——不能含空格或冒号，且不超过 12 个字（参考：定义、首选检查、鉴别要点）。`,
    };
  }
  return { keys };
}

/**
 * 把属性键骨架插进指定小节标题之后；返回错误文案（string）或新正文的行数组。
 *
 * 找不到标题就报错而不是猜一个近似标题：插错小节会污染一篇完全无关的内容，
 * 而模型拿到明确报错后可以重新 read_note 再来一次。
 */
export function insertCardHints(old: string, heading: string, keys: string[]): string[] | string {
  const lines = old.split('\n');
  const target = lines.findIndex((l) => HEADING_LINE.exec(l)?.[2] === heading);
  if (target < 0) {
    return `错误：找不到小节标题「${heading}」。先 read_note，标题要与文中一字不差（不含 # 号）。`;
  }
  const level = HEADING_LINE.exec(lines[target])![1].length;
  let end = lines.length;
  for (let i = target + 1; i < lines.length; i++) {
    const m = HEADING_LINE.exec(lines[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  const existing = new Set(cardHints(lines.slice(target + 1, end).join('\n')));
  const add = keys.filter((k) => !existing.has(k));
  if (!add.length) {
    return `错误：这些提示键在小节里都已存在（${keys.join('、')}），不用重复添加。`;
  }
  // 插入点：标题之后；该小节已有属性键时落到最后一个键后面——
  // 从中间插会把键块劈成两段（中间还得塞空行），正文里看起来像两组属性。
  let at = target + 1;
  while (at < end && isCardKeyLine(lines[at])) at++;
  const insert = add.map((k) => `- ${k}: `);
  // 插入点之后不是空行时补一个空行，免得骨架粘在正文第一句上
  if (lines[at] !== undefined && lines[at].trim() !== '') insert.push('');
  lines.splice(at, 0, ...insert);
  return lines;
}

/** 定点替换：算新正文，或返回可行动的报错。 */
export function applyNotePatch(old: string, findText: string, replaceText: string): ToolOutcome {
  if (!findText) {
    return { error: '错误：find_text 为空。请先 read_note，再从返回结果里原样复制一段唯一文本。' };
  }
  const occurrences = old.split(findText).length - 1;
  if (occurrences > 1) {
    return {
      error: `错误：find_text 出现了 ${occurrences} 次，不唯一。请扩大上下文（多带几行）让它唯一。`,
    };
  }
  // 逐字唯一命中直接用；否则走宽容匹配（空白/全半角标点/引号/省略号/CRLF 差异），
  // 并且只在**恰好唯一**命中时放行——多命中仍然报错让模型扩上下文，绝不猜。
  const hit = occurrences === 1
    ? { start: old.indexOf(findText), end: old.indexOf(findText) + findText.length }
    : fuzzyFindAnchor(old, findText);
  if (!hit) {
    return {
      error: '错误：find_text 在笔记中没有找到（已尝试忽略空白与标点差异）。'
        + '请先 read_note，从返回结果里原样复制（含空格与标点）。',
    };
  }
  return { next: old.slice(0, hit.start) + replaceText + old.slice(hit.end) };
}

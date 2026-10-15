/**
 * 挖空复习（cloze）—— `{{答案}}` 行内制卡语法。
 *
 * 起因：对标第三方医学备考工具后发现「在正文里直接写标记，就自动变成复习卡」是它们
 * 最省事的一环（它们用 `==` 单向卡 / `<=>` 双向卡 / `{{}}` 挖空三种）。本项目**只取 `{{}}`**：
 *
 *   - `==高亮==` 已被 core/livePreview.ts 占用（InlineKind 'highlight'，DELIM_LEN.highlight = 2），
 *     同一段文字既是"高亮"又是"单向卡"会让编辑器和复习界面各说各话，冲突没有赢家，故不引入；
 *   - `<=>` 需要"双向卡"这个概念（一张卡两个方向），而本项目的卡键 = `<路径>#<小节标题>`，
 *     一个键对一张卡；双向卡要拆成两个键，会波及调度迁移，收益不抵风险，故不引入；
 *   - `{{ }}` 经全库确认空闲：只有 core/anki.ts 生成的 Anki 导出模板里出现过 `{{正面}}`，
 *     那是导出产物、不回流到笔记正文（且该处也不经过本模块）。
 *
 * **关键设计约束：挖空不改卡键。** 卡片仍由 core/srsCards.ts 按 `<path>#<小节标题>` 生成，
 * 既有 FSRS 调度一格不动；挖空只改变"同一张卡在复习界面怎么呈现"——正面把 `{{x}}` 遮成
 * 占位条，翻面还原原文。所以引入这个语法不会让任何人的复习进度清零。
 *
 * 为什么必须跳过代码：笔记里写 `{{正面}}` 这类 Anki 模板示例、或 JS 模板字符串里的花括号
 * 是很常见的内容；连带围栏代码块一起遮掉，等于复习顺手改坏了用户抄下来的代码。
 *
 * 纯函数，不碰 DOM，可单测。
 */

/** 行内挖空：`{{` 与 `}}` 之间至少一个非花括号字符（空 `{{}}`、嵌套 `{{{{` 都不算） */
const CLOZE_RE_SOURCE = String.raw`\{\{([^{}\n]+)\}\}`;

/** 挖空正则（每次新建：带 g 的正则复用会因 lastIndex 残留而漏配）。 */
export function clozeRe(): RegExp {
  return new RegExp(CLOZE_RE_SOURCE, 'g');
}

/**
 * 整串恰好是一处挖空。
 * 编辑器工具栏按钮与 wrapCloze 共用这一个判定——两处各写一套正则必然漂移，
 * 于是会出现"编辑器认出是挖空、复习界面不认"这类最难查的不一致。
 */
export function isWholeCloze(text: string): boolean {
  return new RegExp(`^${CLOZE_RE_SOURCE}$`).test(text);
}

/** 挖空占位：定宽全角下划线。与 Anki 的 `[...]` 同思路——不泄漏答案长度。 */
export const CLOZE_PLACEHOLDER = '＿＿＿';

/**
 * 逐行变换，但整体跳过围栏代码块（``` / ~~~ 成对出现的区间）。
 * 与 core/parser.ts 的 collectBodyTags 用同一套围栏判定，避免两处规则不一致。
 */
function mapLinesOutsideFence(text: string, fn: (line: string) => string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return fn(line);
    })
    .join('\n');
}

/**
 * 找出一行里真正的挖空区间，跳过行内代码（成对反引号包裹）内的假挖空。
 * 返回按出现顺序排列的 [start, end) 区间。
 */
function lineClozeSpans(line: string): Array<{ start: number; end: number }> {
  const codeSpans: Array<[number, number]> = [];
  for (const m of line.matchAll(/`+[^`]*`+/g)) {
    codeSpans.push([m.index, m.index + m[0].length]);
  }
  const inCode = (i: number) => codeSpans.some(([a, b]) => i >= a && i < b);

  const out: Array<{ start: number; end: number }> = [];
  // 每次新建正则（clozeRe）：复用带 g 的正则做 matchAll 会因 lastIndex 残留而漏配
  for (const m of line.matchAll(clozeRe())) {
    if (inCode(m.index)) continue;
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 挖空处数（同一行可以挖多次） */
export function countCloze(text: string): number {
  let n = 0;
  mapLinesOutsideFence(text, (line) => {
    n += lineClozeSpans(line).length;
    return line;
  });
  return n;
}

/** 这一段文本里是否有挖空（复习界面据此决定要不要出「挖空题面」） */
export function hasCloze(text: string): boolean {
  return countCloze(text) > 0;
}

/**
 * 遮住挖空内容 → 题面。`{{肾小球}}` → `＿＿＿`。
 * 未挖空的段落原样返回（调用方可以无条件调用，不必先判断）。
 */
export function maskCloze(text: string, placeholder: string = CLOZE_PLACEHOLDER): string {
  return mapLinesOutsideFence(text, (line) => {
    const spans = lineClozeSpans(line);
    if (!spans.length) return line;
    let out = '';
    let at = 0;
    for (const s of spans) {
      out += line.slice(at, s.start) + placeholder;
      at = s.end;
    }
    return out + line.slice(at);
  });
}

/**
 * 还原挖空 → 答案面：只去掉 `{{` `}}` 标记，保留内容。
 * 复习翻面后用它渲染，让用户看不到自己写的原始标记（笔记正文一个字节都不动）。
 */
export function revealCloze(text: string): string {
  return mapLinesOutsideFence(text, (line) => {
    const spans = lineClozeSpans(line);
    if (!spans.length) return line;
    let out = '';
    let at = 0;
    for (const s of spans) {
      // 去掉首尾各两个花括号
      out += line.slice(at, s.start) + line.slice(s.start + 2, s.end - 2);
      at = s.end;
    }
    return out + line.slice(at);
  });
}

/**
 * 把选区文本包成挖空（编辑器工具栏用）。已经在挖空里的内容不重复包一层，
 * 否则连点两次会变成 `{{{{x}}}}`，而上面的正则不认嵌套，用户会看到"点了没反应"。
 */
export function wrapCloze(selected: string): string {
  const s = selected;
  if (!s.trim()) return '{{}}';
  if (/^\{\{[^{}\n]+\}\}$/.test(s)) return s;
  return `{{${s}}}`;
}

/**
 * 复习卡 → Anki 挖空卡的标记转换：`{{答案}}` → `{{c1::答案}}`。
 *
 * 为什么全部编成 c1 而不用 c1/c2 分开：本项目的语义是「一个小节 = 一张卡，翻面才看答案」，
 * 所以同一段里的多个挖空应当**同时**遮住、同时揭开。Anki 里多个 c1 正好表示
 * 「同一张卡上遮住多处」；而 c1/c2 会被拆成两张卡，与本项目的复习节奏对不上。
 *
 * 与 maskCloze / revealCloze 一样跳过围栏代码块与行内代码：
 * 否则笔记里抄的模板代码会被改写成 Anki 标记，导出来的包更难用。
 */
export function toAnkiCloze(text: string, num = 1): string {
  return mapLinesOutsideFence(text, (line) => {
    const spans = lineClozeSpans(line);
    if (!spans.length) return line;
    let out = '';
    let at = 0;
    for (const s of spans) {
      out += line.slice(at, s.start) + `{{c${num}::` + line.slice(s.start + 2, s.end - 2) + '}}';
      at = s.end;
    }
    return out + line.slice(at);
  });
}

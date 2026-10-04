/**
 * AI 提案锚文本宽容匹配：
 * 模型给 propose_note_patch 的 find_text 是「凭 read_note 结果复制」的，但实际经常
 * 带入不可见差异（行尾空白、全角/半角标点、引号样式、省略号字符、CRLF 等），
 * 逐字比对 0 命中 → 报错 → 模型原样重试 → 撞 maxSteps 上限，表现为「说动手做但一直没改」。
 * 这里把 0 命中时做一次归一化重找：空白折叠 + 常见标点/引号映射，只在**恰好唯一**命中时放行
 * （多命中仍然报错让模型扩上下文，绝不猜）。返回真实命中区间，替换基于原文区间而非模型文本。
 */

/** 归一化单字符：折叠空白；映射常见全角/弯引号/省略号/破折号到半角 */
function normalizeChar(ch: string): string {
  if (/\s/.test(ch)) return ' ';
  switch (ch) {
    case '，': case '、': return ',';
    case '。': case '．': return '.';
    case '：': return ':';
    case '；': return ';';
    case '！': return '!';
    case '？': return '?';
    case '（': case '《': case '「': case '『': return '(';
    case '）': case '》': case '」': case '』': return ')';
    case '“': case '”': case '„': case '‟': case '«': case '»': return '"';
    case '‘': case '’': case '‚': return "'";
    case '…': case '⋯': case '‥': return '...';
    case '—': case '–': case '−': case 'ー': return '-';
    case '～': return '~';
    default: return ch;
  }
}

/** 把整段文本归一化：逐字符映射，连续空白折叠为单个空格，并去掉首尾空白 */
export function normalizeAnchor(text: string): string {
  let out = '';
  let prevSpace = false;
  for (const ch of text) {
    const n = normalizeChar(ch);
    if (n === ' ') {
      if (out.length === 0) continue; // 首部空白丢弃
      prevSpace = true;
      continue;
    }
    if (prevSpace) { out += ' '; prevSpace = false; }
    out += n;
  }
  return out;
}

export interface AnchorHit {
  /** 命中起点（原始文本中的字符偏移，按 UTF-16 code unit 计） */
  start: number;
  /** 命中终点（不含） */
  end: number;
}interface NormIndex {
  normText: string;
  normStarts: number[]; // normChars[i] 对应 text 中的起始 code-unit 偏移
  normEnds: number[]; // normChars[i] 所在原字符的结束偏移（多字符映射共享同一原字符）
}

/**
 * 构建归一化索引。
 * mode='collapse'：空白折叠为单个空格（处理 CRLF/缩进/换行差异）；
 * mode='strip'：空白全部丢弃（兜底处理模型多打/漏打空格的情况）。
 */
function buildNormIndex(text: string, mode: 'collapse' | 'strip'): NormIndex {
  const normChars: string[] = [];
  const normStarts: number[] = [];
  const normEnds: number[] = [];
  let ti = 0;
  let pendingSpace = false;
  let lastSpaceStart = 0;
  for (const ch of text) {
    const n = normalizeChar(ch);
    const width = ch.length;
    if (n === ' ') {
      if (mode === 'strip') { ti += width; continue; }
      if (normChars.length === 0) { ti += width; continue; }
      if (!pendingSpace) lastSpaceStart = ti;
      pendingSpace = true;
      ti += width;
      continue;
    }
    if (pendingSpace) {
      normChars.push(' ');
      normStarts.push(lastSpaceStart);
      normEnds.push(ti); // 空白串结束于当前字符的起点
      pendingSpace = false;
    }
    if (n.length === 1 && normalizeChar(ch) === ch) {
      normChars.push(ch);
      normStarts.push(ti);
      normEnds.push(ti + width);
    } else {
      // 映射产生多个字符（如 … → ...）：逐个 push，起止都记在原字符处
      for (const c of n) {
        normChars.push(c);
        normStarts.push(ti);
        normEnds.push(ti + width);
      }
    }
    ti += width;
  }
  return { normText: normChars.join(''), normStarts, normEnds };
}

/** 在归一化索引里找唯一命中，返回原文区间；非唯一/零命中返回 null */
function uniqueHitInIndex(idx: NormIndex, normAnchor: string): AnchorHit | null {
  if (!normAnchor) return null;
  const hits: number[] = [];
  let from = 0;
  while (true) {
    const at = idx.normText.indexOf(normAnchor, from);
    if (at < 0) break;
    hits.push(at);
    from = at + 1;
  }
  if (hits.length !== 1) return null;
  // 命中区间：起点 = 首个归一化字符的原文起点；终点 = 末个归一化字符的原文终点
  // （末端若是多字符映射如 …→...，取该原字符的终点，不会多吃）
  return {
    start: idx.normStarts[hits[0]],
    end: idx.normEnds[hits[0] + normAnchor.length - 1],
  };
}

/**
 * 在 text 中宽容地找 anchor：
 * ① 逐字精确匹配（唯一命中直接用）；
 * ② 归一化（空白折叠+标点映射）后唯一命中；
 * ③ 归一化再去掉全部空白后唯一命中（兜底模型多打/漏打空格）；
 * 其余情况返回 null（调用方维持原报错路径，绝不猜）。
 */
export function fuzzyFindAnchor(text: string, anchor: string): AnchorHit | null {
  if (!anchor) return null;
  const direct = exactOccurrences(text, anchor);
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return null; // 多命中交给调用方报「不唯一」

  const collapsed = uniqueHitInIndex(buildNormIndex(text, 'collapse'), normalizeAnchor(anchor));
  if (collapsed) return collapsed;
  // 去空白兜底：锚也去掉全部空格
  const strippedAnchor = normalizeAnchor(anchor).replaceAll(' ', '');
  return uniqueHitInIndex(buildNormIndex(text, 'strip'), strippedAnchor);
}

/** 逐字精确匹配的所有出现区间 */
function exactOccurrences(text: string, anchor: string): AnchorHit[] {
  const hits: AnchorHit[] = [];
  let from = 0;
  while (true) {
    const idx = text.indexOf(anchor, from);
    if (idx < 0) break;
    hits.push({ start: idx, end: idx + anchor.length });
    from = idx + 1;
  }
  return hits;
}

/**
 * 字幕（SRT / WebVTT）—— 解析、定位、挖空制卡。
 *
 * 起因：对标第三方医学备考工具后发现「知识点挂一段音频讲解 + 逐句字幕，点字幕回跳」是最省事的一环
 * （它们的 knowledge.json 节点里是 `{audio:{name,url}, timelong, srt:[{start,end,text}]}`），
 * 本项目此前完全没有字幕能力。这里只做**纯函数核心**（解析 → 查询 → 制卡），界面另接：
 * 播放器拿到 Cue[] 后按 start/end 高亮，点时间戳按钮用 start 回听。
 *
 * 三个关键决定（都是被真实场景逼出来的）：
 *
 * 1. **制卡必须复用 `{{…}}` 语法**（见 core/cloze.ts）。它已经是本项目唯一的挖空标记，
 *    复习界面（ReviewView）只认它。若这里自创一套（比如 `[[…]]`），字幕卡在复习时会变成
 *    一张"永远不遮答案"的普通卡——用户看不出哪里错了，却怎么点都不出题。所以宁可挖得保守，
 *    也绝不引入第二种标记。
 * 2. **cueAt 落在句间空隙返回 null，而不是"最近的一句"**。字幕的沉默段、片头片尾、切换空隙里，
 *    "离哪句最近"本身没有意义；界面上猜错一句会让用户以为播放器跳错了时间点。宁可不高亮。
 * 3. **end <= start 时把 end 兜成下一句的 start**。真实 SRT/VTT 里退化时间行（起止相同、甚至
 *    倒挂）非常常见（Anki 导入器、yt-dlp、各家 OCR 字幕都会产出）。若不兜，界面按区间高亮会
 *    出现"高亮一闪而过"或负区间导致整句永不命中；兜成下一句起点正是播放器/Anki 的通行做法。
 *    最后一句没有"下一句"，就兜成 start，绝不留 end < start。
 *
 * 纯函数：不碰 DOM、不读文件、不读 localStorage，可单测。
 */
import { clozeRe, isWholeCloze } from './cloze';

/** 一条字幕。start/end 为秒（浮点），text 为纯文本一句（多行正文用 '\n' 连接） */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

/**
 * 时间戳 → 秒。`00:00:01,200` / `00:00:01.200` / `00:01:01.2` / `61.2` 都接受；
 * 解析不出来（空串、含非法字符、段数超过 3）返回 null。
 *
 * 小数点后的位数按"右补零到毫秒"处理：`.2` = 200ms（= 0.2 秒），与 WebVTT 的 `.mmm` 一致，
 * 也与常见字幕工具导出的简写一致。
 */
export function parseTimestamp(s: string): number | null {
  const raw = s.trim();
  if (!raw) return null;
  const parts = raw.split(':');
  // HH:MM:SS 之外（`1:2:3:4`、IPv6 之类）一律判非法
  if (parts.length > 3) return null;

  const last = /^(\d+)(?:[.,](\d+))?$/.exec(parts[parts.length - 1]);
  if (!last) return null;

  let seconds = Number(last[1]);
  if (last[2]) seconds += Number(last[2]) / 10 ** last[2].length;

  const head = parts.slice(0, -1);
  for (const p of head) {
    if (!/^\d+$/.test(p)) return null;
  }
  if (head.length === 2) seconds += Number(head[0]) * 3600 + Number(head[1]) * 60;
  else if (head.length === 1) seconds += Number(head[0]) * 60;

  return Number.isFinite(seconds) ? seconds : null;
}

/** 块分隔用的时间箭头。SRT 与 WebVTT 都是它。 */
const ARROW = '-->';

/**
 * 去掉正文里的标记：
 *   - ASS/SSA 定位与样式（`{\an8}`、`{\pos(1,2)}`）—— 从 SRT 转出来的文件常带；
 *   - HTML / WebVTT 标签（`<i>` `<b>` `<c.yellow>` `<v 张三>` `</v>`、`<00:00:01.000>`）。
 * 标签整体删掉（不留空格），避免 `你好</v>` 变成 `你好 `。
 */
function stripMarks(s: string): string {
  return s.replace(/\{\\[^}]*\}/g, '').replace(/<[^>]*>/g, '');
}

/**
 * 解析字幕文本：SRT（序号 + 时间行 + 正文）与 WebVTT（可带 `WEBVTT` 头、`X-TIMESTAMP-MAP`、
 * `<v 说话人>` 标签、`HH:MM:SS.mmm`）都要吃。
 *
 * - 多行正文合并成一句，用 '\n' 连接（保留换行，界面按原文显示）；
 * - 丢弃时间非法、或正文去掉标签与空白后为空的块；
 * - 按 start 升序返回；`end <= start` 时兜成下一句的 start，最后一句兜成 start。
 */
export function parseSubtitle(text: string): Cue[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  // 以"时间行"为块起点：它前面的东西（WEBVTT 头、X-TIMESTAMP-MAP、SRT 序号、VTT 的 cue 标识行）
  // 全部不属于正文，直接丢掉；块内后续行都是正文。
  const blocks: string[][] = [];
  let cur: string[] | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.includes(ARROW)) {
      if (cur) blocks.push(cur);
      cur = [line];
      continue;
    }
    if (!cur) continue;
    if (!line) {
      blocks.push(cur);
      cur = null;
      continue;
    }
    cur.push(line);
  }
  if (cur) blocks.push(cur);

  const cues: Cue[] = [];
  for (const block of blocks) {
    const timing = block[0];
    const at = timing.indexOf(ARROW);
    const start = parseTimestamp(timing.slice(0, at));
    // 时间行右侧可能跟 VTT 设置（`align:start position:10%`），取第一个空白分隔的片段
    const end = parseTimestamp(timing.slice(at + ARROW.length).trim().split(/\s+/)[0]);
    if (start === null || end === null) continue;

    // 空行只是排版，不参与正文；保留换行但去掉行首尾空白
    const body = block
      .slice(1)
      .map((l) => stripMarks(l).trim())
      .filter((l) => l !== '')
      .join('\n');
    if (!body) continue;

    cues.push({ start, end, text: body });
  }

  cues.sort((a, b) => a.start - b.start);

  // 退化区间兜底：end <= start 时用下一句的 start 收尾（同 Anki / 播放器做法），
  // 最后一句没有下一句则收成 start —— 任何情况下都不产出负区间。
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (cue.end > cue.start) continue;
    const nextStart = i + 1 < cues.length ? cues[i + 1].start : cue.start;
    cue.end = nextStart > cue.start ? nextStart : cue.start;
  }
  return cues;
}

/**
 * 当前秒数在数组里的下标；没有命中返回 -1（界面据此高亮当前行）。
 * 区间取闭区间 [start, end]：正好等于 start 或 end 都算命中。
 * 落在句间空隙（含数组为空、seconds 非有限数）返回 -1 —— 宁可不高亮，也不要高亮错的那句。
 * 假定 cues 已按 start 升序且不重叠（parseSubtitle 的输出即如此）；重叠时取靠前的一条。
 */
export function cueIndexAt(cues: Cue[], seconds: number): number {
  if (!Number.isFinite(seconds)) return -1;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (seconds >= cue.start && seconds <= cue.end) return i;
  }
  return -1;
}

/**
 * 给定秒数，落在哪一句里；落在句间空隙返回 null（宁可没有，也不要给错的那句）。
 * 与 cueIndexAt 共用同一套判定，避免"高亮在第 3 行、点开却是第 4 句"这类不一致。
 */
export function cueAt(cues: Cue[], seconds: number): Cue | null {
  const i = cueIndexAt(cues, seconds);
  return i < 0 ? null : cues[i];
}

/**
 * 秒 → `m:ss` / `h:mm:ss`（界面当时间戳按钮用）。
 * 不足 1 小时不显示小时位（字幕通常几十分钟，多一位反而占地方）；
 * 负数与非有限数一律按 0 处理，避免界面上出现 `-1:-5`。
 */
export function formatTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 候选关键词：区间 + 文本 + 优先级（越小越优先）。 */
interface Candidate {
  start: number;
  end: number;
  text: string;
  rank: number;
}

/** 括号内（中英括号）—— 开括号是 1 个码元，捕获组 1 的起点 = m.index + 1 */
const BRACKET_SRC = String.raw`[(（]([^()（）\n]{2,})[)）]`;

/** 数字+单位的单位表，长的排前面，否则 `mg` 会被 `g` 抢先吃掉。 */
const UNIT_ALT =
  '次/分|L/min|mL/min|ml/min|mmol/L|μmol/L|umol/L|mmHg|kPa|kg/m2|mg/dL|mmol|μmol|umol|mcg|μg|ug|mg|kg' +
  '|mL|ml|cm|mm|nm|μm|um|Hz|IU|U|g|L|d|h|min|s|％|%|℃|°C|小时|分钟|秒|分|次|天|周|月|年|岁';

/** 数字+单位，如 `60次/分`、`28天`、`5mg`。单位后面不能紧跟字母，免得 `min` 吃掉 `minute`。 */
const NUMBER_UNIT_SRC = String.raw`\d+(?:[.,]\d+)?\s*(?:${UNIT_ALT})(?![A-Za-z])`;

/** 英文术语：连续 2+ 字母（允许尾随数字，好把 `PaO2`、`SpO2` 整块挖走）。 */
const ENGLISH_SRC = String.raw`[A-Za-z]{2,}[A-Za-z0-9]*`;

/**
 * 收集候选。正则每次新建（同 core/cloze.ts 的 clozeRe：复用带 g 的正则容易踩 lastIndex 残留）。
 * `group` 指定用哪个捕获组当关键词（只有括号候选用 1）。
 * 已经是整处挖空的文本（`{{x}}`）直接跳过 —— 与 core/cloze.ts 的 wrapCloze 同一判定，
 * 否则连点两次会变成 `{{{{x}}}}`，而 cloze 的正则不认嵌套。
 */
function pushCandidates(
  out: Candidate[],
  line: string,
  src: string,
  rank: number,
  group: number
): void {
  for (const m of line.matchAll(new RegExp(src, 'g'))) {
    const text = m[group];
    if (text.length < 2 || isWholeCloze(text)) continue;
    const start = m.index + (group === 0 ? 0 : 1);
    out.push({ start, end: start + text.length, text, rank });
  }
}

/**
 * 给一句字幕里的「疑似关键词」加 `{{}}`。
 *
 * 判据是纯启发式（可测、宁少勿多）：优先括号内的词，其次数字+单位，再次英文术语；
 * 同级里取更长的（长词更可能是术语，短词更容易是虚词）；一处都不命中就不挖 ——
 * 乱挖会把整句变成无用的填空，比不挖更糟。
 * 已经带 `{{}}` 的句子原样保留，既不在其内部再挖一层，也不跨过它。
 */
function markKeyTerms(line: string, maxPerCue: number): string {
  if (maxPerCue <= 0) return line;

  const existing: Array<[number, number]> = [];
  for (const m of line.matchAll(clozeRe())) existing.push([m.index, m.index + m[0].length]);
  const overlapExisting = (s: number, e: number) => existing.some(([a, b]) => s < b && e > a);

  const cands: Candidate[] = [];
  pushCandidates(cands, line, BRACKET_SRC, 0, 1);
  pushCandidates(cands, line, NUMBER_UNIT_SRC, 1, 0);
  pushCandidates(cands, line, ENGLISH_SRC, 2, 0);
  if (!cands.length) return line;

  cands.sort((a, b) => a.rank - b.rank || b.text.length - a.text.length || a.start - b.start);

  const picked: Candidate[] = [];
  for (const c of cands) {
    if (picked.length >= maxPerCue) break;
    if (overlapExisting(c.start, c.end)) continue;
    if (picked.some((p) => c.start < p.end && c.end > p.start)) continue;
    picked.push(c);
  }
  if (!picked.length) return line;

  picked.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const c of picked) {
    out += line.slice(at, c.start) + `{{${c.text}}}`;
    at = c.end;
  }
  return out + line.slice(at);
}

/**
 * 字幕 → 挖空复习卡的正文。
 *
 * 输出形如 `- 0:12 第一句带{{关键词}}\n- 0:20 第二句`：每句一行、行首是时间戳，
 * 复习时看到题面就知道回听哪里。用的时间戳格式即 formatTime（`m:ss` / `h:mm:ss`），
 * 与界面按钮一致，避免同一段字幕出现两套时间写法。
 *
 * - 每句最多挖 `maxPerCue` 处（默认 1；给 0 或非有限数则不挖），说明见 markKeyTerms；
 * - 一句内部的换行折成空格，保证"一句一行"，界面与卡片都不会被换行撑破；
 * - 空句子直接跳过，不产出只有一个时间戳的空行。
 */
export function subtitleToCardText(cues: Cue[], maxPerCue = 1): string {
  const limit = Number.isFinite(maxPerCue) ? Math.max(0, Math.floor(maxPerCue)) : 0;
  const out: string[] = [];
  for (const cue of cues) {
    const text = cue.text.replace(/\s*\n\s*/g, ' ').trim();
    if (!text) continue;
    out.push(`- ${formatTime(cue.start)} ${markKeyTerms(text, limit)}`);
  }
  return out.join('\n');
}

/**
 * 把一道题写成一篇笔记。
 *
 * 为什么值得单独做：做题时想通了某个点，那个「想通了」现在只以选项批注的形式
 * 挂在这道题上——做题界面之外看不到，也搜不到、进不了图谱、不能复习。
 * 反过来（笔记里能看到题目批注）已经做了；这里补的是正向：把题连同解析、我的选择、
 * 我的批注、知识点一起落成一篇真正的笔记，从此它是一条可以反复读的内容。
 *
 * 刻意不抄解析以外的东西：题干、选项、答案都来自题库本身，笔记只是它的一份快照；
 * 题库更新后重新生成即可，不做双向同步（双向同步的冲突处理成本远大于收益）。
 */
import type { QuizQuestion } from './qbank';

export interface QuestionNoteInput {
  question: QuizQuestion;
  /** 所属题库名 */
  bank: string;
  /** 我的选择（0 基下标）；没作答时留空 */
  picked?: number[];
  /** 是否正确；未判定时留空 */
  correct?: boolean;
  /** 取题那一刻的时间，默认现在 */
  at?: number;
}

/** 路径里不能出现的东西：/ \ : * ? " < > | 以及首尾空白 */
function slug(s: string, max: number): string {
  const cleaned = s
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = cleaned.slice(0, max).trim();
  return cut || '未命名';
}

/** 笔记路径：题库笔记/<题库>/<题干前 24 字>.md —— 按题库分目录，便于整库清理 */
export function questionNotePath(bank: string, question: QuizQuestion): string {
  return `题库笔记/${slug(bank, 40)}/${slug(question.stem.split('\n')[0] ?? '', 24)}.md`;
}

/** 选项字母：0 → A */
export function letter(i: number): string {
  return String.fromCharCode(65 + i);
}

/** 正确选项的下标集合（多选题的答案在 answers 里，单选在 answer 里） */
function correctSet(q: QuizQuestion): Set<number> {
  if (Array.isArray(q.answers) && q.answers.length) return new Set(q.answers);
  if (typeof q.answer === 'number' && q.answer >= 0) return new Set([q.answer]);
  return new Set();
}

export function questionToMarkdown(input: QuestionNoteInput): string {
  const { question: q, bank, picked = [], correct } = input;
  const at = input.at ?? Date.now();
  const right = correctSet(q);
  const lines: string[] = [];

  const title = slug(q.stem.split('\n')[0] ?? '', 60);
  // frontmatter 的 tags 会被标签浏览与图谱直接吃进去：从题库名就能聚成一片
  lines.push('---');
  lines.push(`tags: [题, ${bank.replace(/[,\]]/g, ' ')}]`);
  lines.push(`来源: ${bank}${q.chapter ? ` · ${q.chapter}` : ''}`);
  lines.push(`日期: ${new Date(at).toISOString().slice(0, 10)}`);
  lines.push('---', '');
  lines.push(`# ${title}`, '');
  lines.push(q.stem.trim(), '');

  if (q.options.length) {
    q.options.forEach((opt, i) => {
      const mark = right.has(i) ? ' ✅' : '';
      lines.push(`- ${letter(i)}．${opt.replace(/\n+/g, ' ').trim()}${mark}`);
    });
    lines.push('');
  }

  const answerText =
    right.size > 0
      ? [...right].sort((a, b) => a - b).map(letter).join('、')
      : (q.answerText ?? '').trim();
  lines.push(`**答案**：${answerText || '（题库未给答案）'}`);
  if (picked.length) {
    const mine = [...picked].sort((a, b) => a - b).map(letter).join('、');
    const verdict = correct === undefined ? '' : correct ? '　✅ 答对' : '　❌ 答错';
    lines.push(`**我的选择**：${mine}${verdict}`);
  }
  lines.push('');

  const explanations = (q.explanations?.length ? q.explanations : q.explanation ? [{ source: '', text: q.explanation }] : [])
    .filter((e) => e.text.trim());
  if (explanations.length) {
    lines.push('## 解析', '');
    for (const e of explanations) {
      if (e.source) lines.push(`**${e.source}**`, '');
      lines.push(e.text.trim(), '');
    }
  }

  const notes = (q.optionNotes ?? [])
    .map((n, i) => ({ n: n?.trim(), i }))
    .filter((x): x is { n: string; i: number } => Boolean(x.n));
  if (notes.length) {
    lines.push('## 我的批注', '');
    for (const { n, i } of notes) lines.push(`- ${letter(i)}：${n.replace(/\n+/g, ' ')}`);
    lines.push('');
  }

  const points = (q.chapters ?? (q.chapter ? [q.chapter] : [])).filter(Boolean);
  if (points.length) {
    lines.push('## 知识点', '');
    for (const p of points) lines.push(`- [[${p}]]`);
    lines.push('');
  }

  // 出处留一行，方便日后回题库核对原文
  lines.push('---', `> 由题库「${bank}」生成。题库更新后重新生成即可。`);
  return lines.join('\n');
}

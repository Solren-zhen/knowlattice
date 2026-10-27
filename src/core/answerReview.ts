import { correctIndices, isMultiSelect, type QuizQuestion } from './qbank';

/** 选项下标 → 字母（0 → A）。本仓题目用下标存答案，展示层才需要字母。 */
export function letterOf(index: number): string {
  return String.fromCharCode(65 + index);
}

export type PickVerdict = 'correct' | 'blank' | 'partial' | 'extra' | 'wrong';

export interface PickAnalysis {
  verdict: PickVerdict;
  /** 直接可显示的短标签（全对 / 未作答 / 少选 / 多选 / 少选 + 多选 / 错选） */
  label: string;
  tone: 'success' | 'danger' | 'neutral';
  /** 是否多选题（X 型）：决定措辞用「漏选/多选」还是「应选/你选了」 */
  multi: boolean;
  /** 对了但没选的项 */
  missing: number[];
  /** 选了但不对的项 */
  extra: number[];
}

/**
 * 作答复盘：把「错了」拆成漏选 / 多选 / 错选三档。
 * 全对才算对（与 isCorrectPick 同口径，不给部分分），但复盘要说清错在哪一类——
 * 「少选」和「多选」的补救动作完全不同，只回一个「错」学不到东西。
 */
export function analyzePick(q: QuizQuestion, picked: readonly number[]): PickAnalysis {
  const right = correctIndices(q);
  const mine = [...new Set(picked)].filter((i) => i >= 0).sort((a, b) => a - b);
  const multi = isMultiSelect(q);
  const missing = right.filter((i) => !mine.includes(i));
  const extra = mine.filter((i) => !right.includes(i));

  if (!mine.length) return { verdict: 'blank', label: '未作答', tone: 'neutral', multi, missing: right, extra: [] };
  if (!missing.length && !extra.length) return { verdict: 'correct', label: '全对', tone: 'success', multi, missing, extra };
  if (missing.length && extra.length) {
    return { verdict: 'wrong', label: multi ? '少选 + 多选' : '错选', tone: 'danger', multi, missing, extra };
  }
  if (missing.length) {
    return { verdict: multi ? 'partial' : 'wrong', label: multi ? '少选' : '错选', tone: 'danger', multi, missing, extra };
  }
  return { verdict: 'extra', label: multi ? '多选' : '错选', tone: 'danger', multi, missing, extra };
}

/** 复盘行：把漏选/多选落到具体字母上，答完题直接能看懂错在哪一项 */
export function pickHint(a: PickAnalysis): string {
  // 单选题说「多选」会被读成多选题：这里换成「应选 X，你选了 Y」
  if (!a.multi && a.tone === 'danger') {
    const right = [...a.missing, ...a.extra].filter((i) => !a.extra.includes(i)).map(letterOf).join('');
    const mine = a.extra.map(letterOf).join('');
    return '错选：应选 ' + (right || '—') + (mine ? '，你选了 ' + mine : '');
  }
  const parts: string[] = [];
  if (a.missing.length) parts.push('漏选 ' + a.missing.map(letterOf).join(''));
  if (a.extra.length) parts.push('多选 ' + a.extra.map(letterOf).join(''));
  return parts.length ? a.label + '：' + parts.join('，') : a.label;
}

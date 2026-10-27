/**
 * 题目批注的汇总：把「题库里写的选项批注」按章节笔记的路径聚起来。
 *
 * 起因：批注存在题库里（QuizQuestion.optionNotes，随题库进 IndexedDB 和整包备份），
 * 而看笔记的时候完全看不到——用户在题库里写的「为什么选错」只活在那个面板里，
 * 复习笔记时不会提醒他这道题当初错在哪。这里只做一层索引，不改存储：
 * 题库题的 chapter 与题库笔记的路径是同一组 `${学科}·${章节}`（详见 core/qbankNotes.ts），
 * 所以批注能精确落到「题库/<源>/<学科>/<章节>.md」这篇笔记上。
 */
import type { QuizBank } from './qbank';
import { chapterKeyOfNotePath } from './qbankNotes';

export interface QuestionAnnotation {
  /** 题库名（同名题库唯一，作为回查依据） */
  bank: string;
  qid: string;
  /** `${学科}·${章节}`，用于跟笔记路径对齐 */
  chapter: string;
  /** 题干（列表里要能认出是哪道题） */
  stem: string;
  /** 选项字母 A/B/C… */
  letter: string;
  /** 批注正文 */
  note: string;
}

/** 题干截断：批注列表是索引，不是阅读器，一屏能扫更多题比显示全文有用 */
const STEM_MAX = 80;

function stemOf(q: { stem?: string }): string {
  const s = (q.stem ?? '').replace(/\s+/g, ' ').trim();
  return s.length > STEM_MAX ? `${s.slice(0, STEM_MAX)}…` : s;
}

/** 收集全部批注。没有批注的题、空批注的选项都不产生条目（列表里不放空行）。 */
export function collectAnnotations(banks: QuizBank[]): QuestionAnnotation[] {
  const out: QuestionAnnotation[] = [];
  for (const bank of banks) {
    for (const q of bank.questions) {
      const notes = q.optionNotes;
      if (!notes?.length) continue;
      const chapter = q.chapter ?? q.chapters?.[0] ?? '';
      if (!chapter) continue; // 没有章节就落不到任何笔记上，留着也看不见
      notes.forEach((note, i) => {
        const text = (note ?? '').trim();
        if (!text) return;
        out.push({
          bank: bank.name,
          qid: q.id,
          chapter,
          stem: stemOf(q),
          letter: String.fromCharCode(65 + i),
          note: text,
        });
      });
    }
  }
  return out;
}

/**
 * 取某篇笔记（题库章节笔记）上的批注。
 * 不是「题库/<源>/<学科>/<章节>.md」结构的路径一律返回空数组——附件、
 * 普通笔记、更深层目录都不该冒出别人的批注。
 */
export function annotationsForPath(all: QuestionAnnotation[], path: string): QuestionAnnotation[] {
  const key = chapterKeyOfNotePath(path);
  if (!key) return [];
  return all.filter((a) => a.chapter === key);
}

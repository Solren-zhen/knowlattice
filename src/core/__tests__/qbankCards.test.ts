import { describe, expect, it } from 'vitest';
import type { QuizQuestion } from '../qbank';
import type { QStat, StatsMap } from '../qbankStats';
import {
  extractQuestionId,
  generateCardFromMistake,
  generateCardsFromMistakes,
  getGeneratableCount,
  isMistakeCard,
  shouldGenerateCard,
} from '../qbankCards';

/** 造一条逐题记录：只写关心的字段，其余按「还没复习过」的默认值 */
function qstat(patch: Partial<QStat> = {}): QStat {
  return {
    due: 0,
    stability: 0,
    difficulty: 0,
    elapsed: 0,
    scheduled: 0,
    steps: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    lastReview: 0,
    wrong: 0,
    ...patch,
  };
}

/** 造一份逐题记录表：默认都放在同一个题库下 */
function statsOf(entries: Record<string, QStat>, bank = '测试库'): StatsMap {
  return { [bank]: entries };
}

describe('qbankCards', () => {
  const mockQuestion: QuizQuestion = {
    id: 'q001',
    type: 'choice',
    stem: '急性心肌梗死最常见的并发症是？',
    options: ['心律失常', '心源性休克', '心脏破裂', '室壁瘤'],
    answer: 0,
    answerText: '心律失常',
    explanation: '急性心梗后心肌电生理不稳定，最常见并发症是心律失常（75-95%）',
    chapter: '心血管系统',
    note: '急性心肌梗死',
  };

  const mockStat = qstat({ wrong: 3, lastReview: 1697650800000 });

  describe('shouldGenerateCard', () => {
    it('错误次数 >= 3 且无对应卡片 → 应该生成', () => {
      const existingKeys = new Set<string>();
      expect(shouldGenerateCard('q001', mockStat, existingKeys)).toBe(true);
    });

    it('错误次数 < 3 → 不生成', () => {
      const lowStat = qstat({ wrong: 2 });
      const existingKeys = new Set<string>();
      expect(shouldGenerateCard('q001', lowStat, existingKeys)).toBe(false);
    });

    it('已有对应卡片 → 不重复生成', () => {
      const existingKeys = new Set(['qbank:q001']);
      expect(shouldGenerateCard('q001', mockStat, existingKeys)).toBe(false);
    });
  });

  describe('generateCardFromMistake', () => {
    it('生成基本卡片', () => {
      const card = generateCardFromMistake(mockQuestion, mockStat);

      expect(card.key).toBe('qbank:q001');
      expect(card.heading).toBe('急性心肌梗死最常见的并发症是？');
      expect(card.body).toContain('**正确答案**：心律失常');
      expect(card.body).toContain('**解析**：急性心梗后心肌电生理不稳定');
      expect(card.body).toContain('**关联笔记**：[[急性心肌梗死]]');
      expect(card.body).toContain('来自错题本（错 3 次）');
      expect(card.noteTitle).toBe('心血管系统');
      expect(card.questionId).toBe('q001');
      expect(card.mistakeCount).toBe(3);
      // 口径：QStat 只记「上次复习时间」，不区分对错，所以字段叫 lastReviewedAt
      expect(card.lastReviewedAt).toBe(1697650800000);
    });

    it('处理多套解析', () => {
      const questionWithMultipleExplanations: QuizQuestion = {
        ...mockQuestion,
        explanations: [
          { source: '人卫教材', text: '教材版解析' },
          { source: '小亮老师', text: '老师版解析' },
        ],
      };

      const card = generateCardFromMistake(questionWithMultipleExplanations, mockStat);

      expect(card.body).toContain('**详细解析**：');
      expect(card.body).toContain('- **人卫教材**：教材版解析');
      expect(card.body).toContain('- **小亮老师**：老师版解析');
    });

    it('处理无章节无笔记的题目', () => {
      const minimalQuestion: QuizQuestion = {
        id: 'q002',
        type: 'choice',
        stem: '简单题干',
        options: ['A', 'B'],
        answer: 0,
        answerText: 'A',
      };

      const card = generateCardFromMistake(minimalQuestion, mockStat);

      expect(card.noteTitle).toBe('题库练习');
      expect(card.hints).toEqual([]);
      expect(card.body).not.toContain('关联笔记');
    });

    it('携带题干图片路径', () => {
      const questionWithImage: QuizQuestion = {
        ...mockQuestion,
        image: '_attachments/ecg-stemi.png',
      };

      const card = generateCardFromMistake(questionWithImage, mockStat);

      expect(card.image).toBe('_attachments/ecg-stemi.png');
    });
  });

  describe('generateCardsFromMistakes', () => {
    it('批量生成卡片', () => {
      const stats = statsOf({
        q001: qstat({ wrong: 3 }),
        q002: qstat({ wrong: 5 }),
        q003: qstat({ wrong: 2 }), // < 3，不生成
      });

      const questions = new Map<string, QuizQuestion>([
        ['q001', mockQuestion],
        ['q002', { ...mockQuestion, id: 'q002', stem: '另一道题' }],
        ['q003', { ...mockQuestion, id: 'q003' }],
      ]);

      const existingKeys = new Set<string>();
      const cards = generateCardsFromMistakes(stats, questions, existingKeys);

      expect(cards).toHaveLength(2);
      expect(cards[0].questionId).toBe('q001');
      expect(cards[1].questionId).toBe('q002');
    });

    it('跳过已有卡片的题目', () => {
      const stats = statsOf({
        q001: qstat({ wrong: 3 }),
        q002: qstat({ wrong: 5 }),
      });

      const questions = new Map<string, QuizQuestion>([
        ['q001', mockQuestion],
        ['q002', { ...mockQuestion, id: 'q002' }],
      ]);

      const existingKeys = new Set(['qbank:q001']); // q001 已有卡片
      const cards = generateCardsFromMistakes(stats, questions, existingKeys);

      expect(cards).toHaveLength(1);
      expect(cards[0].questionId).toBe('q002');
    });

    it('处理题目已删除的情况', () => {
      const stats = statsOf({
        q001: qstat({ wrong: 3 }),
        q999: qstat({ wrong: 5 }), // 题目不存在
      });

      const questions = new Map<string, QuizQuestion>([
        ['q001', mockQuestion],
      ]);

      const existingKeys = new Set<string>();
      const cards = generateCardsFromMistakes(stats, questions, existingKeys);

      expect(cards).toHaveLength(1);
      expect(cards[0].questionId).toBe('q001');
    });

    it('跨题库合并统计', () => {
      const stats: StatsMap = {
        内科库: { q001: qstat({ wrong: 3 }) },
        外科库: { q002: qstat({ wrong: 4 }) },
      };
      const questions = new Map<string, QuizQuestion>([
        ['q001', mockQuestion],
        ['q002', { ...mockQuestion, id: 'q002' }],
      ]);

      const cards = generateCardsFromMistakes(stats, questions, new Set());

      expect(cards).toHaveLength(2);
      expect(cards.map((c) => c.questionId).sort()).toEqual(['q001', 'q002']);
    });
  });

  describe('isMistakeCard', () => {
    it('识别错题卡片', () => {
      expect(isMistakeCard('qbank:q001')).toBe(true);
      expect(isMistakeCard('qbank:abc123')).toBe(true);
    });

    it('识别非错题卡片', () => {
      expect(isMistakeCard('notes/心衰.md')).toBe(false);
      expect(isMistakeCard('notes/心衰.md#定义')).toBe(false);
      expect(isMistakeCard('')).toBe(false);
    });
  });

  describe('extractQuestionId', () => {
    it('从卡片键提取题目 ID', () => {
      expect(extractQuestionId('qbank:q001')).toBe('q001');
      expect(extractQuestionId('qbank:abc-123')).toBe('abc-123');
    });

    it('非错题卡返回 null', () => {
      expect(extractQuestionId('notes/心衰.md')).toBeNull();
      expect(extractQuestionId('')).toBeNull();
    });
  });

  describe('getGeneratableCount', () => {
    it('统计可生成卡片的数量', () => {
      const stats = statsOf({
        q001: qstat({ wrong: 3 }),
        q002: qstat({ wrong: 5 }),
        q003: qstat({ wrong: 2 }), // < 3
        q004: qstat({ wrong: 4 }),
      });

      const existingKeys = new Set(['qbank:q002']); // q002 已有
      const count = getGeneratableCount(stats, existingKeys);

      expect(count).toBe(2); // q001 和 q004
    });
  });
});

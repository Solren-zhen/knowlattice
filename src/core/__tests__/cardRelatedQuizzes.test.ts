import { describe, expect, it } from 'vitest';
import type { ReviewCard } from '../srsCards';
import type { QuizQuestion } from '../qbank';
import {
  findRelatedQuizzes,
  batchFindRelatedQuizzes,
  quickFindRelatedQuizzes,
} from '../cardRelatedQuizzes';

describe('cardRelatedQuizzes', () => {
  const mockCards = new Map<string, ReviewCard>([
    [
      'card1',
      {
        key: 'card1',
        path: 'notes/心力衰竭.md',
        noteTitle: '心力衰竭',
        heading: '诱因',
        body: '慢性心衰急性加重的诱因：感染（最常见）、心律失常、过度劳累、输液过快',
        hints: ['感染', '心律失常'],
      },
    ],
    [
      'card2',
      {
        key: 'card2',
        path: 'notes/心肌梗死.md',
        noteTitle: '急性心肌梗死',
        heading: '心电图演变',
        body: '超急性期：T 波高尖；急性期：ST 段抬高；亚急性期：病理性 Q 波',
        hints: ['T 波高尖', 'ST 段抬高'],
      },
    ],
    [
      'card3',
      {
        key: 'card3',
        path: 'notes/肺炎.md',
        noteTitle: '肺炎',
        heading: '肺炎球菌肺炎症状',
        body: '寒战、高热、咳嗽、咳铁锈色痰',
        hints: ['寒战', '高热'],
      },
    ],
  ]);

  const mockQuestions = new Map<string, QuizQuestion>([
    [
      'q1',
      {
        id: 'q1',
        type: 'choice',
        stem: '慢性心力衰竭最常见的诱因是',
        options: ['感染', '心律失常', '过度劳累', '输液过快'],
        answer: 0,
        answerText: '感染',
        chapter: '心血管系统',
        explanation: '感染是慢性心衰急性加重最常见诱因。',
      },
    ],
    [
      'q2',
      {
        id: 'q2',
        type: 'choice',
        stem: '急性心肌梗死最早出现的心电图改变是',
        options: ['T 波高尖', 'ST 段抬高', '病理性 Q 波', 'T 波倒置'],
        answer: 0,
        answerText: 'T 波高尖',
        chapter: '心血管系统',
      },
    ],
    [
      'q3',
      {
        id: 'q3',
        type: 'choice',
        stem: '肺炎球菌肺炎的典型症状是',
        options: ['寒战高热', '刺激性干咳', '咯血', '胸痛'],
        answer: 0,
        answerText: '寒战高热',
        chapter: '呼吸系统',
      },
    ],
    [
      'q4',
      {
        id: 'q4',
        type: 'choice',
        stem: '完全无关的题目',
        options: ['A', 'B'],
        answer: 0,
        answerText: 'A',
        chapter: '消化系统',
      },
    ],
  ]);

  describe('findRelatedQuizzes', () => {
    it('根据章节推荐题目', () => {
      const card = mockCards.get('card1')!; // 心力衰竭

      const related = findRelatedQuizzes(card, mockQuestions);

      expect(related.length).toBeGreaterThan(0);
      expect(related[0].qid).toBe('q1'); // 心衰诱因题
      expect(related[0].relevance).toBeGreaterThan(0);
    });

    it('根据关键词推荐题目', () => {
      const card = mockCards.get('card2')!; // 心电图

      const related = findRelatedQuizzes(card, mockQuestions);

      expect(related.length).toBeGreaterThan(0);
      const ecgQuiz = related.find((r) => r.qid === 'q2');
      expect(ecgQuiz).toBeDefined();
    });

    it('根据 hints 推荐题目', () => {
      const card = mockCards.get('card1')!; // 心力衰竭，hints: 感染、心律失常

      const related = findRelatedQuizzes(card, mockQuestions);

      const q1 = related.find((r) => r.qid === 'q1');
      expect(q1).toBeDefined();
      expect(q1?.reason).toContain('感染');
    });

    it('提供题目预览', () => {
      const card = mockCards.get('card1')!;

      const related = findRelatedQuizzes(card, mockQuestions);

      for (const quiz of related) {
        expect(quiz.preview).toBeTruthy();
        expect(quiz.preview.length).toBeLessThanOrEqual(53); // 50 + '...'
      }
    });

    it('按相关度排序', () => {
      const card = mockCards.get('card1')!;

      const related = findRelatedQuizzes(card, mockQuestions);

      // 相关度递减
      for (let i = 1; i < related.length; i++) {
        expect(related[i - 1].relevance).toBeGreaterThanOrEqual(related[i].relevance);
      }
    });

    it('限制推荐数量', () => {
      const card = mockCards.get('card1')!;

      const related = findRelatedQuizzes(card, mockQuestions, 2);

      expect(related.length).toBeLessThanOrEqual(2);
    });

    it('不推荐无关题目', () => {
      const card = mockCards.get('card3')!; // 肺炎

      const related = findRelatedQuizzes(card, mockQuestions);

      const hasUnrelated = related.some((r) => r.qid === 'q4');
      expect(hasUnrelated).toBe(false);
    });

    it('无匹配题目时返回空数组', () => {
      const unrelatedCard: ReviewCard = {
        key: 'unrelated',
        path: 'notes/test.md',
        noteTitle: '完全无关主题',
        heading: '无关内容',
        body: '与医学无关的内容',
        hints: [],
      };

      const related = findRelatedQuizzes(unrelatedCard, mockQuestions);

      expect(related.length).toBe(0);
    });
  });

  describe('batchFindRelatedQuizzes', () => {
    it('批量查找关联题目', () => {
      const cards = Array.from(mockCards.values());

      const results = batchFindRelatedQuizzes(cards, mockQuestions);

      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.relatedQuizzes.length > 0)).toBe(true);
    });

    it('跳过无关联题目的卡片', () => {
      const cards: ReviewCard[] = [
        mockCards.get('card1')!, // 有关联
        {
          key: 'unrelated',
          path: 'notes/test.md',
          noteTitle: '编程语言',
          heading: 'JavaScript 语法',
          body: 'const x = 1; let y = 2;',
          hints: [],
        }, // 完全无关联
      ];

      const results = batchFindRelatedQuizzes(cards, mockQuestions);

      // card1 肯定有结果
      const card1Result = results.find((r) => r.card.key === 'card1');
      expect(card1Result).toBeDefined();
      expect(card1Result!.relatedQuizzes.length).toBeGreaterThan(0);

      // 无关卡片应该没有结果
      const unrelatedResult = results.find((r) => r.card.key === 'unrelated');
      expect(unrelatedResult).toBeUndefined();
    });
  });

  describe('quickFindRelatedQuizzes', () => {
    it('快速查找单张卡片的关联题目', () => {
      const related = quickFindRelatedQuizzes(
        'card1',
        mockCards,
        mockQuestions
      );

      expect(related.length).toBeGreaterThan(0);
      expect(related[0].qid).toBe('q1');
    });

    it('卡片不存在时返回空数组', () => {
      const related = quickFindRelatedQuizzes(
        'nonexistent',
        mockCards,
        mockQuestions
      );

      expect(related).toEqual([]);
    });
  });

  describe('关键词提取', () => {
    it('从卡片标题提取医学术语', () => {
      const card = mockCards.get('card1')!; // 诱因

      const related = findRelatedQuizzes(card, mockQuestions);

      expect(related.length).toBeGreaterThan(0);
    });

    it('从卡片内容提取关键词', () => {
      const card = mockCards.get('card2')!; // 心电图演变

      const related = findRelatedQuizzes(card, mockQuestions);

      const ecgQuiz = related.find((r) => r.qid === 'q2');
      expect(ecgQuiz).toBeDefined();
    });

    it('匹配题干关键词', () => {
      const card = mockCards.get('card3')!; // 肺炎症状

      const related = findRelatedQuizzes(card, mockQuestions);

      const pneumoniaQuiz = related.find((r) => r.qid === 'q3');
      expect(pneumoniaQuiz).toBeDefined();
    });
  });

  describe('边缘情况', () => {
    it('处理空题库', () => {
      const card = mockCards.get('card1')!;

      const related = findRelatedQuizzes(card, new Map());

      expect(related).toEqual([]);
    });

    it('处理无 hints 的卡片', () => {
      const cardWithoutHints: ReviewCard = {
        key: 'test',
        path: 'notes/test.md',
        noteTitle: '心力衰竭',
        heading: '诱因',
        body: '感染是最常见诱因',
        // ReviewCard.hints 是必填的 string[]；「无提示」用空数组表达
        hints: [],
      };

      const related = findRelatedQuizzes(cardWithoutHints, mockQuestions);

      expect(related.length).toBeGreaterThan(0);
    });

    it('处理无 chapter 的题目', () => {
      const questionsWithoutChapter = new Map<string, QuizQuestion>([
        [
          'q999',
          {
            id: 'q999',
            type: 'choice',
            stem: '慢性心力衰竭的诱因',
            options: ['A', 'B'],
            answer: 0,
            answerText: 'A',
            // 无 chapter
          },
        ],
      ]);

      const card = mockCards.get('card1')!;

      const related = findRelatedQuizzes(card, questionsWithoutChapter);

      // 仍能通过关键词匹配
      expect(related.length).toBeGreaterThan(0);
    });

    it('处理超长题干预览', () => {
      const longStemQuestion = new Map<string, QuizQuestion>([
        [
          'qlong',
          {
            id: 'qlong',
            type: 'choice',
            stem: '这是一道题干非常长的题目'.repeat(10),
            options: ['A', 'B'],
            answer: 0,
            answerText: 'A',
            chapter: '心血管系统',
          },
        ],
      ]);

      const card = mockCards.get('card1')!;

      const related = findRelatedQuizzes(card, longStemQuestion);

      if (related.length > 0) {
        expect(related[0].preview.length).toBeLessThanOrEqual(53);
        expect(related[0].preview).toContain('...');
      }
    });
  });
});

import { describe, expect, it } from 'vitest';
import type { QuizQuestion } from '../qbank';
import type { NoteMetadata } from '../mistakeNoteRecommendation';
import {
  recommendNotesForMistake,
  batchRecommendNotes,
  recommendNotesForQuiz,
} from '../mistakeNoteRecommendation';

describe('mistakeNoteRecommendation', () => {
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
        explanation: '感染是慢性心衰急性加重最常见诱因，尤其是呼吸道感染。',
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
        explanation: '超急性期 T 波高尖是最早出现的心电图变化。',
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
  ]);

  const mockNotes: NoteMetadata[] = [
    {
      path: 'notes/心力衰竭.md',
      title: '心力衰竭',
      content: `# 心力衰竭

## 诱因

慢性心衰急性加重的诱因：
1. **感染**（最常见，尤其呼吸道感染）
2. 心律失常
3. 过度劳累
4. 输液过快

## 治疗

...
`,
      tags: ['心血管系统', '心衰'],
      updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 天前
    },
    {
      path: 'notes/急性心肌梗死.md',
      title: '急性心肌梗死',
      content: `# 急性心肌梗死

## 心电图演变

超急性期：T 波高尖（最早出现）
急性期：ST 段抬高
亚急性期：病理性 Q 波
慢性期：T 波倒置
`,
      tags: ['心血管系统', '心梗'],
      updatedAt: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 天前
    },
    {
      path: 'notes/肺炎.md',
      title: '肺炎',
      content: `# 肺炎

## 肺炎球菌肺炎

典型症状：寒战、高热、咳嗽、咳铁锈色痰。
`,
      tags: ['呼吸系统'],
      updatedAt: Date.now(),
    },
    {
      path: 'notes/不相关笔记.md',
      title: '消化系统疾病',
      content: '与心血管无关的内容...',
      tags: ['消化系统'],
      updatedAt: Date.now(),
    },
  ];

  describe('recommendNotesForMistake', () => {
    it('根据章节推荐笔记', () => {
      const question = mockQuestions.get('q1')!;

      const recommendations = recommendNotesForMistake(question, mockNotes);

      expect(recommendations.length).toBeGreaterThan(0);
      expect(recommendations[0].noteTitle).toContain('心力衰竭');
      expect(recommendations[0].relevance).toBeGreaterThan(0);
    });

    it('根据关键词推荐笔记', () => {
      const question = mockQuestions.get('q2')!;

      const recommendations = recommendNotesForMistake(question, mockNotes);

      expect(recommendations.length).toBeGreaterThan(0);
      const hasECGNote = recommendations.some((r) => r.noteTitle.includes('心肌梗死'));
      expect(hasECGNote).toBe(true);
    });

    it('提供推荐原因', () => {
      const question = mockQuestions.get('q1')!;

      const recommendations = recommendNotesForMistake(question, mockNotes);

      expect(recommendations[0].reason).toBeTruthy();
      expect(recommendations[0].reason.length).toBeGreaterThan(0);
    });

    it('按相关度排序', () => {
      const question = mockQuestions.get('q1')!;

      const recommendations = recommendNotesForMistake(question, mockNotes);

      // 第一个应该是最相关的（心力衰竭笔记）
      expect(recommendations[0].noteTitle).toBe('心力衰竭');

      // 相关度递减
      for (let i = 1; i < recommendations.length; i++) {
        expect(recommendations[i - 1].relevance).toBeGreaterThanOrEqual(
          recommendations[i].relevance
        );
      }
    });

    it('限制推荐数量', () => {
      const question = mockQuestions.get('q1')!;

      const recommendations = recommendNotesForMistake(question, mockNotes, 2);

      expect(recommendations.length).toBeLessThanOrEqual(2);
    });

    it('不推荐无关笔记', () => {
      const question = mockQuestions.get('q3')!; // 呼吸系统

      const recommendations = recommendNotesForMistake(question, mockNotes);

      const hasUnrelatedNote = recommendations.some((r) =>
        r.noteTitle.includes('消化系统')
      );
      expect(hasUnrelatedNote).toBe(false);
    });

    it('考虑笔记新鲜度', () => {
      const question = mockQuestions.get('q3')!; // 肺炎

      const recommendations = recommendNotesForMistake(question, mockNotes);

      // 肺炎笔记是最新的，应该排在前面
      const pneumoniaNote = recommendations.find((r) => r.noteTitle === '肺炎');
      expect(pneumoniaNote).toBeDefined();
      expect(pneumoniaNote?.relevance).toBeGreaterThan(0.5);
    });

    it('无匹配笔记时返回空数组', () => {
      const question: QuizQuestion = {
        id: 'q999',
        type: 'choice',
        stem: '完全无关的题目',
        options: ['A', 'B'],
        answer: 0,
        answerText: 'A',
        chapter: '不存在的章节',
      };

      const recommendations = recommendNotesForMistake(question, mockNotes);

      expect(recommendations).toEqual([]);
    });
  });

  describe('batchRecommendNotes', () => {
    it('批量推荐笔记', () => {
      const mistakes = [
        { qid: 'q1', wrong: 5 },
        { qid: 'q2', wrong: 3 },
        { qid: 'q3', wrong: 2 },
      ];

      const results = batchRecommendNotes(mistakes, mockQuestions, mockNotes);

      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.recommendations.length > 0)).toBe(true);
    });

    it('跳过无匹配题目', () => {
      const mistakes = [
        { qid: 'q1', wrong: 5 },
        { qid: 'q999', wrong: 3 }, // 不存在的题目
      ];

      const results = batchRecommendNotes(mistakes, mockQuestions, mockNotes);

      expect(results.length).toBe(1); // 只有 q1 有结果
      expect(results[0].qid).toBe('q1');
    });

    it('跳过无推荐笔记的题目', () => {
      const unrelatedQuestion = new Map([
        [
          'q999',
          {
            id: 'q999',
            type: 'choice' as const,
            stem: '完全无关',
            options: ['A', 'B'],
            answer: 0,
            answerText: 'A',
          },
        ],
      ]);

      const mistakes = [{ qid: 'q999', wrong: 5 }];

      const results = batchRecommendNotes(mistakes, unrelatedQuestion, mockNotes);

      expect(results.length).toBe(0);
    });
  });

  describe('recommendNotesForQuiz', () => {
    it('为单次答题推荐笔记', () => {
      const recommendations = recommendNotesForQuiz('q1', mockQuestions, mockNotes);

      expect(recommendations.length).toBeGreaterThan(0);
      expect(recommendations[0].noteTitle).toBe('心力衰竭');
    });

    it('题目不存在时返回空数组', () => {
      const recommendations = recommendNotesForQuiz('q999', mockQuestions, mockNotes);

      expect(recommendations).toEqual([]);
    });
  });

  describe('关键词提取', () => {
    it('从题干提取医学术语', () => {
      const question = mockQuestions.get('q1')!;

      const recommendations = recommendNotesForMistake(question, mockNotes);

      // 应该匹配到"心力衰竭"关键词
      expect(recommendations.length).toBeGreaterThan(0);
      expect(recommendations[0].noteTitle).toContain('心力衰竭');
    });

    it('从答案提取关键词', () => {
      const question = mockQuestions.get('q1')!;

      const recommendations = recommendNotesForMistake(question, mockNotes);

      // 答案是"感染"，心力衰竭笔记中有"感染"内容
      const heartFailureNote = recommendations.find((r) =>
        r.noteTitle.includes('心力衰竭')
      );
      expect(heartFailureNote).toBeDefined();
    });

    it('从解析提取关键词', () => {
      const question = mockQuestions.get('q1')!;

      const recommendations = recommendNotesForMistake(question, mockNotes);

      // 解析中提到"呼吸道感染"
      const heartFailureNote = recommendations.find((r) =>
        r.noteTitle.includes('心力衰竭')
      );
      expect(heartFailureNote).toBeDefined();
      expect(heartFailureNote!.relevance).toBeGreaterThan(0.5);
    });
  });

  describe('边缘情况', () => {
    it('处理空笔记列表', () => {
      const question = mockQuestions.get('q1')!;

      const recommendations = recommendNotesForMistake(question, []);

      expect(recommendations).toEqual([]);
    });

    it('处理无 chapter 的题目', () => {
      const question: QuizQuestion = {
        id: 'q999',
        type: 'choice',
        stem: '某个医学问题',
        options: ['A', 'B'],
        answer: 0,
        answerText: 'A',
        // 无 chapter
      };

      const recommendations = recommendNotesForMistake(question, mockNotes);

      // 仍能通过关键词匹配
      expect(recommendations).toBeDefined();
    });

    it('处理无 tags 的笔记', () => {
      const notesWithoutTags: NoteMetadata[] = [
        {
          path: 'notes/test.md',
          title: '心力衰竭相关',
          content: `心力衰竭的诱因包括感染、心律失常等。

慢性心力衰竭患者应避免感染，因为感染是最常见的急性加重诱因。`,
          // 无 tags
        },
      ];

      const question = mockQuestions.get('q1')!;

      const recommendations = recommendNotesForMistake(question, notesWithoutTags);

      expect(recommendations.length).toBeGreaterThan(0);
      expect(recommendations[0].noteTitle).toContain('心力衰竭');
    });
  });
});

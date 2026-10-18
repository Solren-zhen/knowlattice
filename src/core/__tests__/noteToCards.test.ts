import { describe, expect, it } from 'vitest';
import {
  extractKeyPoints,
  keyPointsToCards,
  analyzeNoteAndGenerateCards,
  batchAnalyzeNotes,
} from '../noteToCards';

describe('noteToCards', () => {
  const sampleNote = `# 心力衰竭

## 定义

心力衰竭（Heart Failure, HF）是指心脏收缩和/或舒张功能障碍，导致**心排血量**不能满足机体代谢需要的一种复杂临床综合征。

**关键点**：泵功能障碍是核心。

## 临床表现

主要症状包括：
1. 呼吸困难（最常见）
2. 乏力
3. 水肿

体征：颈静脉怒张、肺部啰音、下肢水肿。

## 诊断标准

Framingham 诊断标准：
- **主要标准**：阵发性夜间呼吸困难、颈静脉怒张、肺部啰音
- **次要标准**：下肢水肿、夜间咳嗽、肝肿大

## 治疗

参考指南...（篇幅较短，跳过）

## 预后

5 年生存率约 50%。
`;

  describe('extractKeyPoints', () => {
    it('提取二级标题作为关键点', () => {
      const keyPoints = extractKeyPoints('notes/心衰.md', '心力衰竭', sampleNote);

      expect(keyPoints.length).toBeGreaterThan(0);
      expect(keyPoints.some((kp) => kp.heading === '定义')).toBe(true);
      expect(keyPoints.some((kp) => kp.heading === '临床表现')).toBe(true);
    });

    it('判断关键点重要程度', () => {
      const keyPoints = extractKeyPoints('notes/心衰.md', '心力衰竭', sampleNote);

      const definition = keyPoints.find((kp) => kp.heading === '定义');
      expect(definition?.importance).toBe(3); // 定义是高优先级

      const symptoms = keyPoints.find((kp) => kp.heading === '临床表现');
      expect(symptoms?.importance).toBe(2); // 症状是中优先级
    });

    it('提取 hints', () => {
      const keyPoints = extractKeyPoints('notes/心衰.md', '心力衰竭', sampleNote);

      const definition = keyPoints.find((kp) => kp.heading === '定义');
      expect(definition?.hints.length).toBeGreaterThan(0);
      expect(definition?.hints).toContain('心排血量');
    });

    it('跳过太短的段落', () => {
      const shortNote = `# 标题\n\n## 空段落\n\n`;
      const keyPoints = extractKeyPoints('notes/test.md', '测试', shortNote);

      expect(keyPoints.length).toBe(0);
    });

    it('提取列表项作为关键点', () => {
      const listNote = `# 心梗并发症

主要并发症：
1. 心律失常
2. 心源性休克
3. 心脏破裂
4. 室壁瘤
5. 心包炎
`;

      const keyPoints = extractKeyPoints('notes/心梗.md', '心梗并发症', listNote);

      const listPoint = keyPoints.find((kp) => kp.heading.includes('要点'));
      expect(listPoint).toBeDefined();
      expect(listPoint?.hints.length).toBeGreaterThan(0);
    });
  });

  describe('keyPointsToCards', () => {
    it('将关键点转换为卡片', () => {
      const keyPoints = extractKeyPoints('notes/心衰.md', '心力衰竭', sampleNote);

      const cards = keyPointsToCards('notes/心衰.md', '心力衰竭', keyPoints);

      expect(cards.length).toBeGreaterThan(0);
      expect(cards[0].key).toContain('notes/心衰.md#');
      expect(cards[0].noteTitle).toBe('心力衰竭');
      expect(cards[0].path).toBe('notes/心衰.md');
    });

    it('只为中高重要度生成卡片', () => {
      const keyPoints = [
        {
          heading: '低优先级',
          content: 'test',
          importance: 1 as const,
          hints: [],
        },
        {
          heading: '中优先级',
          content: 'test',
          importance: 2 as const,
          hints: [],
        },
        {
          heading: '高优先级',
          content: 'test',
          importance: 3 as const,
          hints: [],
        },
      ];

      const cards = keyPointsToCards('notes/test.md', '测试', keyPoints, 2);

      expect(cards.length).toBe(2); // 只有 importance >= 2 的
      expect(cards.every((c) => !c.heading.includes('低优先级'))).toBe(true);
    });

    it('支持自定义最低重要度', () => {
      const keyPoints = [
        {
          heading: '低优先级',
          content: 'test',
          importance: 1 as const,
          hints: [],
        },
        {
          heading: '中优先级',
          content: 'test',
          importance: 2 as const,
          hints: [],
        },
      ];

      const allCards = keyPointsToCards('notes/test.md', '测试', keyPoints, 1);
      expect(allCards.length).toBe(2); // 包含所有

      const highOnlyCards = keyPointsToCards('notes/test.md', '测试', keyPoints, 3);
      expect(highOnlyCards.length).toBe(0); // 无 importance >= 3 的
    });
  });

  describe('analyzeNoteAndGenerateCards', () => {
    it('完整流程：分析 + 生成卡片', () => {
      const result = analyzeNoteAndGenerateCards(
        'notes/心衰.md',
        '心力衰竭',
        sampleNote
      );

      expect(result.notePath).toBe('notes/心衰.md');
      expect(result.noteTitle).toBe('心力衰竭');
      expect(result.keyPoints.length).toBeGreaterThan(0);
      expect(result.generatedCards.length).toBeGreaterThan(0);
    });

    it('支持配置最低重要度', () => {
      const highOnlyResult = analyzeNoteAndGenerateCards(
        'notes/心衰.md',
        '心力衰竭',
        sampleNote,
        { minImportance: 3 }
      );

      const allResult = analyzeNoteAndGenerateCards(
        'notes/心衰.md',
        '心力衰竭',
        sampleNote,
        { minImportance: 1 }
      );

      expect(highOnlyResult.generatedCards.length).toBeLessThan(
        allResult.generatedCards.length
      );
    });
  });

  describe('batchAnalyzeNotes', () => {
    it('批量处理多篇笔记', () => {
      const notes = [
        { path: 'notes/心衰.md', title: '心力衰竭', content: sampleNote },
        {
          path: 'notes/心梗.md',
          title: '心肌梗死',
          content: '## 定义\n\n心肌梗死是...',
        },
        {
          path: 'notes/空笔记.md',
          title: '空笔记',
          content: '# 空笔记\n\n无内容',
        },
      ];

      const results = batchAnalyzeNotes(notes);

      expect(results.length).toBe(3);
      expect(results[0].generatedCards.length).toBeGreaterThan(0);
      expect(results[2].generatedCards.length).toBe(0); // 空笔记无卡片
    });

    it('批量处理支持配置', () => {
      const notes = [
        { path: 'notes/心衰.md', title: '心力衰竭', content: sampleNote },
      ];

      const highOnly = batchAnalyzeNotes(notes, { minImportance: 3 });
      const all = batchAnalyzeNotes(notes, { minImportance: 1 });

      expect(highOnly[0].generatedCards.length).toBeLessThan(
        all[0].generatedCards.length
      );
    });
  });

  describe('边缘情况', () => {
    it('处理无标题笔记', () => {
      const noHeadingNote = '这是一篇没有任何标题的笔记。\n\n只有纯文本。';

      const keyPoints = extractKeyPoints('notes/test.md', '测试', noHeadingNote);

      expect(keyPoints.length).toBe(0); // 无标题，无关键点
    });

    it('处理超长段落', () => {
      const longContent = '这是一段超长内容。'.repeat(200);
      const longNote = `## 长段落\n\n${longContent}`;

      const keyPoints = extractKeyPoints('notes/test.md', '测试', longNote);

      expect(keyPoints[0].content.length).toBeLessThanOrEqual(500); // 限制长度
    });

    it('处理特殊字符', () => {
      const specialNote = `## 定义（含括号）

**重点**：这是\`代码\`块和 [链接](url)。
`;

      const keyPoints = extractKeyPoints('notes/test.md', '测试', specialNote);

      expect(keyPoints.length).toBeGreaterThan(0);
      expect(keyPoints[0].heading).toBe('定义（含括号）');
    });
  });
});

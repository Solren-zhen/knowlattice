import { describe, expect, it } from 'vitest';
import {
  containsQuestions,
  convertToQuizQuestions,
  importAiQuestions,
  parseAiQuestions,
} from '../aiQuestionImport';

describe('aiQuestionImport', () => {
  describe('parseAiQuestions', () => {
    it('解析标准格式（带【题N】）', () => {
      const text = `
【题1】急性心肌梗死最常见的并发症是？
A. 心律失常
B. 心源性休克
C. 心脏破裂
D. 室壁瘤
答案：A
解析：急性心梗后心肌电生理不稳定，最常见并发症是心律失常（75-95%）

【题2】以下哪项不是心力衰竭的诱因？
A. 感染
B. 心律失常
C. 低血压
D. 过度劳累
答案：C
解析：低血压是心衰的表现，不是诱因
      `.trim();

      const questions = parseAiQuestions(text);

      expect(questions).toHaveLength(2);
      expect(questions[0].stem).toBe('急性心肌梗死最常见的并发症是？');
      expect(questions[0].options).toEqual(['心律失常', '心源性休克', '心脏破裂', '室壁瘤']);
      expect(questions[0].answer).toBe(0);
      expect(questions[0].answerText).toBe('心律失常');
      expect(questions[0].explanation).toContain('急性心梗后心肌电生理不稳定');

      expect(questions[1].stem).toBe('以下哪项不是心力衰竭的诱因？');
      expect(questions[1].answer).toBe(2); // C
    });

    it('解析 Markdown 列表格式', () => {
      const text = `
1. 氧解离曲线右移的意义是？
- A. 容易放氧
- B. 容易结合氧
- 答案：A
- 解析：右移表示氧亲和力下降，容易释放氧气

2. 呼吸衰竭的血气标准是？
- A. PaO2 < 60mmHg
- B. PaO2 < 80mmHg
- 答案：A
      `.trim();

      const questions = parseAiQuestions(text);

      expect(questions).toHaveLength(2);
      expect(questions[0].stem).toBe('氧解离曲线右移的意义是？');
      expect(questions[0].options).toEqual(['容易放氧', '容易结合氧']);
      expect(questions[0].answer).toBe(0);
    });

    it('解析简答题（无选项）', () => {
      const text = `
【题1】什么是心力衰竭？
答案：心力衰竭是指心脏泵血功能障碍，不能满足机体代谢需要
      `.trim();

      const questions = parseAiQuestions(text);

      expect(questions).toHaveLength(1);
      expect(questions[0].stem).toBe('什么是心力衰竭？');
      expect(questions[0].options).toEqual([]);
      expect(questions[0].answerText).toBe('心力衰竭是指心脏泵血功能障碍，不能满足机体代谢需要');
    });

    it('解析中文逗号选项', () => {
      const text = `
【题1】题干
A、选项1
B、选项2
答案：B
      `.trim();

      const questions = parseAiQuestions(text);

      expect(questions[0].options).toEqual(['选项1', '选项2']);
      expect(questions[0].answer).toBe(1);
    });

    it('处理多行解析', () => {
      const text = `
【题1】题干
A. 选项1
B. 选项2
答案：A
解析：这是第一行解析
这是第二行解析
这是第三行解析
      `.trim();

      const questions = parseAiQuestions(text);

      expect(questions[0].explanation).toContain('这是第一行解析');
      expect(questions[0].explanation).toContain('这是第二行解析');
      expect(questions[0].explanation).toContain('这是第三行解析');
    });

    it('答案文本匹配选项原文', () => {
      const text = `
【题1】题干
A. 选项1
B. 选项2很长的文字
答案：选项2很长的文字
      `.trim();

      const questions = parseAiQuestions(text);

      expect(questions[0].answer).toBe(1);
      expect(questions[0].answerText).toBe('选项2很长的文字');
    });

    it('处理无明确标记的单题', () => {
      const text = `
题干文本
A. 选项1
B. 选项2
答案：B
      `.trim();

      const questions = parseAiQuestions(text);

      expect(questions).toHaveLength(1);
      expect(questions[0].stem).toBe('题干文本');
      expect(questions[0].answer).toBe(1);
    });

    it('忽略空白段落', () => {
      const text = `
【题1】题干1
A. 选项
答案：A

【题2】
      `.trim();

      const questions = parseAiQuestions(text);

      expect(questions).toHaveLength(1); // 第二题无内容，被过滤
    });
  });

  describe('convertToQuizQuestions', () => {
    it('转换为 QuizQuestion 格式', () => {
      const parsed = [
        {
          stem: '题干',
          options: ['选项1', '选项2'],
          answer: 0,
          answerText: '选项1',
          explanation: '解析文本',
        },
      ];

      const questions = convertToQuizQuestions(parsed, {
        chapter: '心血管系统',
        notePath: 'notes/心肌梗死.md',
      });

      expect(questions).toHaveLength(1);
      expect(questions[0].id).toBeTruthy(); // nanoid 生成
      expect(questions[0].type).toBe('choice');
      expect(questions[0].stem).toBe('题干');
      expect(questions[0].chapter).toBe('心血管系统');
      expect(questions[0].note).toBe('心肌梗死');
    });

    it('区分选择题与简答题', () => {
      const parsed = [
        {
          stem: '选择题',
          options: ['A', 'B'],
          answer: 0,
          answerText: 'A',
        },
        {
          stem: '简答题',
          options: [],
          answer: 0,
          answerText: '答案文本',
        },
      ];

      const questions = convertToQuizQuestions(parsed);

      expect(questions[0].type).toBe('choice');
      expect(questions[1].type).toBe('recall');
    });

    it('处理无笔记路径的情况', () => {
      const parsed = [
        {
          stem: '题干',
          options: ['A'],
          answer: 0,
          answerText: 'A',
        },
      ];

      const questions = convertToQuizQuestions(parsed);

      expect(questions[0].note).toBeUndefined();
    });
  });

  describe('importAiQuestions', () => {
    it('一键导入', () => {
      const text = `
【题1】题干1
A. 选项
答案：A

【题2】题干2
B. 选项
答案：B
      `.trim();

      const result = importAiQuestions(text, {
        chapter: '生理学',
        notePath: 'notes/呼吸系统.md',
      });

      expect(result.count).toBe(2);
      expect(result.questions).toHaveLength(2);
      expect(result.questions[0].chapter).toBe('生理学');
      expect(result.questions[0].note).toBe('呼吸系统');
    });
  });

  describe('containsQuestions', () => {
    it('识别包含题目的文本', () => {
      const text1 = '【题1】题干\nA. 选项\n答案：A';
      expect(containsQuestions(text1)).toBe(true);

      const text2 = '1. 题干\nA. 选项\n答案：A';
      expect(containsQuestions(text2)).toBe(true);
    });

    it('识别不包含题目的文本', () => {
      const text1 = '这是普通对话';
      expect(containsQuestions(text1)).toBe(false);

      const text2 = 'A. 孤立的选项（没有答案）';
      expect(containsQuestions(text2)).toBe(false);
    });

    it('识别有选项但无答案的文本', () => {
      const text = '题干\nA. 选项1\nB. 选项2';
      expect(containsQuestions(text)).toBe(false);
    });
  });
});

/**
 * 题目讲解音频：内容包 → 题目模型 → 界面。
 *
 * 为什么单独测：音频是「只在有素材时才出现」的可选字段，最容易被字段改名
 * 或转换脚本漏掉而静默消失——用户看不出区别（题还是那道题），只是永远听不到讲解。
 */
import { describe, expect, it } from 'vitest';
import { normalizeQuestions } from '../qbank';
import { packUnitToQuestions } from '../contentPack';

describe('normalizeQuestions 的讲解音频', () => {
  it('audio / audioDur 原样留下', () => {
    const [q] = normalizeQuestions([
      { stem: '题干', options: ['甲', '乙'], answer: 'A', audio: ' https://cdn.example/a.mp3 ', audioDur: 95 },
    ]);
    expect(q.audio).toBe('https://cdn.example/a.mp3');
    expect(q.audioDur).toBe(95);
  });

  it('中文键与非法值都被处理掉', () => {
    const [a] = normalizeQuestions([{ stem: 'x', options: ['甲', '乙'], answer: 'A', 音频: 'https://e/b.mp3' }]);
    expect(a.audio).toBe('https://e/b.mp3');
    const [b] = normalizeQuestions([{ stem: 'y', options: ['甲', '乙'], answer: 'A', audio: '', audioDur: -3 }]);
    expect(b.audio).toBeUndefined();
    expect(b.audioDur).toBeUndefined();
  });
});

describe('内容包里的音视频条目', () => {
  const unit = {
    unitId: 'u1',
    pack: 'wanchuan',
    title: '测试单元',
    items: [
      {
        qid: 'q1',
        type: 'radio',
        stem: [{ t: 'text', v: '题干' }],
        choices: [
          { k: 'A', body: [{ t: 'text', v: '甲' }] },
          { k: 'B', body: [{ t: 'text', v: '乙' }] },
        ],
        answers: ['A'],
        // 字符串是图片 ref，对象才是音视频：两种混在同一个 media 数组里
        media: ['m000abc', { kind: 'audio', url: 'https://cdn.example/jj.mp3', dur: 95 }],
      },
    ],
  };

  it('对象条目变成 audio，不被当成图片路径', () => {
    const { questions } = packUnitToQuestions(unit, () => undefined);
    expect(questions).toHaveLength(1);
    expect(questions[0].audio).toBe('https://cdn.example/jj.mp3');
    expect(questions[0].audioDur).toBe(95);
    expect(questions[0].image).toBeUndefined();
  });
});

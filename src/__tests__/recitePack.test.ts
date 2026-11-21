import { describe, expect, it } from 'vitest';
import { buildRecitePack } from '../core/recitePack';
import type { StoryArchiveEntry } from '../core/wordStory';

const entry = {
  id: 'story-1',
  createdAt: 1700000000000,
  bankName: 'CET-6',
  words: [
    {
      word: { en: 'abandon', zh: '放弃' },
      record: {
        en: 'abandon',
        right: 1,
        wrong: 2,
        reps: 3,
        due: 0,
        mastered: false,
        stability: 1,
        difficulty: 6,
        lastReview: 0,
        lapses: 1,
      },
      score: 3.2,
    },
  ],
  story: {
    title: 'The Storm Plan',
    titleZh: '风暴计划',
    sentences: [{ en: 'They abandoned the plan.', zh: '他们放弃了计划。' }],
    used: [{ word: 'abandon', form: 'abandoned' }],
  },
  analysis: null,
  pinned: false,
} as StoryArchiveEntry;

describe('桌面手机背诵包', () => {
  it('输出手机端可识别的扁平短文与目标词', () => {
    const pack = JSON.parse(buildRecitePack([entry], 1700000000000));
    expect(pack.schema).toBe('knowlattice.recite/1');
    expect(pack.stories).toHaveLength(1);
    expect(pack.stories[0]).toMatchObject({
      id: 'story-1',
      title: 'The Storm Plan',
      targets: [{ en: 'abandon', zh: '放弃' }],
      used: [{ word: 'abandon', form: 'abandoned' }],
    });
    expect(pack.baseline.records).toEqual({});
    expect(pack.events).toEqual([]);
  });
});

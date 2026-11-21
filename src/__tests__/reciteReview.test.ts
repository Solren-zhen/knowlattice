import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyReviewDelta, parseReviewDelta } from '../core/reciteReview';
import { loadRecords, saveRecords, type WordRecord } from '../core/wordDrill';

const event = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'e-1',
  word: 'abandon',
  correct: true,
  at: 1_700_000_000_000,
  device: 'phone-1',
  ...overrides,
});

const delta = (events: unknown[]) => ({
  schema: 'knowlattice.review/1',
  device: 'phone-1',
  events,
});

beforeEach(() => {
  localStorage.clear();
});

describe('手机回传复习记录', () => {
  it('拒绝不认识的包版本，并丢弃字段不完整的事件', () => {
    expect(() => parseReviewDelta({ schema: 'other', events: [] })).toThrow('不支持的复习记录版本');
    const parsed = parseReviewDelta(
      delta([event(), { id: '', word: 'x' }, { id: 'e-2', word: 'x', correct: true, at: 'nope' }]),
    );
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].id).toBe('e-1');
  });

  it('手机时钟跑快时把未来时间截到 5 分钟漂移内', () => {
    const parsed = parseReviewDelta(delta([event({ at: Date.now() + 86_400_000 })]));
    expect(parsed.events[0].at).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  });

  it('把事件合并进单词工坊记录，重复回传不重复计数', () => {
    const first = applyReviewDelta(delta([event()]));
    expect(first).toMatchObject({ added: 1, skipped: 0, words: ['abandon'] });
    expect(loadRecords().abandon).toMatchObject({ right: 1, wrong: 0, reps: 1 });

    const second = applyReviewDelta(delta([event()]));
    expect(second).toMatchObject({ added: 0, skipped: 0 });
    expect(loadRecords().abandon.right).toBe(1);
  });

  it('按事件时间顺序套用，避免乱序回传改变 FSRS 结果', () => {
    applyReviewDelta(
      delta([
        event({ id: 'e-2', at: 1_700_000_100_000, correct: true }),
        event({ id: 'e-1', at: 1_700_000_000_000, correct: false }),
      ]),
    );
    const record = loadRecords().abandon;
    expect(record.right).toBe(1);
    expect(record.wrong).toBe(1);
    expect(record.lastReview).toBe(1_700_000_100_000);
  });

  it('早于本机 lastReview 的旧事件只标记已处理，不回退调度', () => {
    const current: WordRecord = {
      en: 'abandon',
      right: 5,
      wrong: 0,
      reps: 5,
      due: 1_800_000_000_000,
      mastered: true,
      stability: 30,
      difficulty: 3,
      lastReview: 1_750_000_000_000,
      lapses: 0,
    };
    saveRecords({ abandon: current });
    const result = applyReviewDelta(delta([event({ at: 1_700_000_000_000, correct: false })]));
    expect(result).toMatchObject({ added: 0, skipped: 1 });
    expect(loadRecords().abandon).toEqual(current);
  });

  it('有新记录时广播刷新事件，让已打开的单词工坊同步', () => {
    const dispatch = vi.fn();
    vi.stubGlobal('window', { dispatchEvent: dispatch });
    try {
      applyReviewDelta(delta([event({ id: 'e-broadcast' })]));
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

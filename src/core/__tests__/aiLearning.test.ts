import { afterEach, describe, expect, it } from 'vitest';
import { quizProgressReport, reviewDueReport, studySummaryReport, weakChaptersReport } from '../aiLearning';
import { clearMistake, importMistakes, loadMistakes } from '../mistakes';
import { recordCalibration } from '../qbankCalib';
import type { QuizBank } from '../qbank';
import type { QStat, StatsMap } from '../qbankStats';

const DOCS = new Map([
  ['解剖/心脏.md', '# 心脏\n## 泵血\n心肌收缩泵血。\n\n## 电生理\n窦房结起搏。\n'],
  ['药理/洋地黄.md', '# 洋地黄\n正性肌力。\n'],
]);
const PATHS = [...DOCS.keys()];

/** 一张过期的 ts-fsrs 调度卡（loadCards 的校验字段齐全） */
function dueCard(dueIso: string) {
  return {
    due: dueIso, stability: 2.5, difficulty: 5, elapsed_days: 0,
    scheduled_days: 1, reps: 1, lapses: 0, state: 2, last_review: dueIso,
  };
}

afterEach(() => {
  localStorage.clear();
});

/** 清空错题本：模块缓存不随 localStorage.clear() 复位，所以显式逐条清（顺序无关） */
function wipeMistakes() {
  for (const p of Object.keys(loadMistakes())) clearMistake(p);
}

describe('reviewDueReport', () => {
  it('空库返回无笔记提示', () => {
    expect(reviewDueReport([], new Map())).toContain('还没有笔记');
  });

  it('没有调度数据时全部算新卡', () => {
    const out = reviewDueReport(PATHS, DOCS);
    expect(out).toContain('今天没有到期的复习卡');
    expect(out).toContain('新卡');
    expect(out).toContain('共 3 张');
  });

  it('列出到期卡与小节，逾期计数正确', () => {
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
    localStorage.setItem('knowlattice-srs', JSON.stringify({
      '解剖/心脏.md#泵血': dueCard(past),
      '药理/洋地黄.md': dueCard(new Date(Date.now() - 3600_000).toISOString()),
    }));
    const out = reviewDueReport(PATHS, DOCS);
    expect(out).toContain('今日到期 2 张');
    expect(out).toContain('逾期 1 张');
    expect(out).toContain('解剖/心脏.md「泵血」');
    expect(out).toContain('药理/洋地黄.md「整篇」');
  });

  it('未来到期的卡不算到期', () => {
    localStorage.setItem('knowlattice-srs', JSON.stringify({
      '解剖/心脏.md#泵血': dueCard(new Date(Date.now() + 86_400_000).toISOString()),
    }));
    expect(reviewDueReport(PATHS, DOCS)).toContain('今天没有到期');
  });
});

describe('studySummaryReport', () => {
  it('包含打卡与复习卡总览', () => {
    const out = studySummaryReport(PATHS, DOCS);
    expect(out).toContain('连续打卡');
    expect(out).toContain('近 7 天');
    expect(out).toContain('共 3 张');
    expect(out).toContain('今日到期 0 张');
  });

  it('到期的卡反映在概况里', () => {
    localStorage.setItem('knowlattice-srs', JSON.stringify({
      '解剖/心脏.md#泵血': dueCard(new Date(Date.now() - 1000).toISOString()),
    }));
    expect(studySummaryReport(PATHS, DOCS)).toContain('今日到期 1 张');
  });

  it('把握度校准：没样本时如实说没有，不编造自评水平', () => {
    expect(studySummaryReport(PATHS, DOCS)).toContain('把握度校准：还没有样本');
  });

  it('把握度校准：并排给出平均自信与实际正确率', () => {
    recordCalibration(4, true);
    recordCalibration(4, false);
    recordCalibration(5, true);
    const out = studySummaryReport(PATHS, DOCS);
    expect(out).toContain('3 次作答报了把握度');
    expect(out).toContain('平均自信 87%、实际答对 67%');
    expect(out).toContain('高估 20 个百分点');
  });

  it('把握度校准：自信与实际相符时给正面结论', () => {
    for (const ok of [true, true, true, false, false]) recordCalibration(3, ok);
    expect(studySummaryReport(PATHS, DOCS)).toContain('校准得不错');
  });
});

describe('weakChaptersReport', () => {
  it('空错题本给出引导', () => {
    expect(weakChaptersReport()).toContain('错题本是空的');
  });

  it('按次数聚合薄弱章节与最需要回看的笔记', () => {
    importMistakes({
      '药理/洋地黄.md': { path: '药理/洋地黄.md', chapter: '药理学', title: '洋地黄', count: 3, lastFailedAt: Date.now() - 86_400_000 },
      '解剖/心脏.md': { path: '解剖/心脏.md', chapter: '生理学', title: '心脏', count: 1, lastFailedAt: Date.now() },
    });
    const out = weakChaptersReport();
    expect(out).toContain('错题共 2 处（累计 4 次）');
    expect(out).toContain('药理学：3 次');
    expect(out).toContain('药理/洋地黄.md「洋地黄」3 次');
    expect(out).toContain('1 天前');
  });

  it('错因分布：按条数统计各档，未标注单独说明', () => {
    wipeMistakes(); // 模块缓存不随 afterEach 的 localStorage.clear() 复位，这里显式清空
    const now = Date.now();
    importMistakes({
      'a.md': { path: 'a.md', chapter: '生理学', title: 'A', count: 1, lastFailedAt: now, reason: 'knowledge' },
      'b.md': { path: 'b.md', chapter: '生理学', title: 'B', count: 2, lastFailedAt: now, reason: 'knowledge' },
      'c.md': { path: 'c.md', chapter: '药理学', title: 'C', count: 1, lastFailedAt: now, reason: 'confusion' },
      'd.md': { path: 'd.md', chapter: '药理学', title: 'D', count: 1, lastFailedAt: now },
    });
    const out = weakChaptersReport();
    // 计数单位是错题条数（不是失败次数）：b.md 失败 2 次但只算 1 条
    expect(out).toContain('错因分布（已标注 3 条）：知识没记住 2、概念混淆 1、审题偏差 0、临床推理跳步 0；未标注 1 条。');
    expect(out).toContain('a.md「A」1 次（最近 今天）（知识没记住）');
  });

  it('错因都没标注时明说，不假装有分布', () => {
    wipeMistakes();
    importMistakes({
      'a.md': { path: 'a.md', chapter: '生理学', title: 'A', count: 1, lastFailedAt: Date.now() },
    });
    expect(weakChaptersReport()).toContain('1 条错题都还没标注错因');
  });
});

/** 逐题记录：只有 due / wrong 参与题库进度计算，其余字段填合法值 */
function qstat(due: number, wrong: number): QStat {
  return {
    due, stability: 1, difficulty: 5, elapsed: 0, scheduled: 1,
    steps: 0, reps: 1, lapses: 0, state: 2, lastReview: 0, wrong,
  };
}

function bank(name: string, n: number): QuizBank {
  return {
    name,
    importedAt: 0,
    questions: Array.from({ length: n }, (_, i) => ({
      id: `${name}-${i}`, type: 'recall', stem: `题 ${i}`, options: [], answer: -1, answerText: '答案',
    })),
  };
}

describe('quizProgressReport', () => {
  it('没有题库时给出引导', () => {
    expect(quizProgressReport([], {})).toContain('还没有导入题库');
  });

  it('有题库但没有作答记录时提示先练一轮', () => {
    const out = quizProgressReport([bank('生理学', 10)], {});
    expect(out).toContain('共 1 个题库、10 道题');
    expect(out).toContain('还没有作答记录');
  });

  it('按错题数指出最薄弱题库并统计待复习', () => {
    const stats: StatsMap = {
      生理学: {
        '生理学-0': qstat(Date.now() - 1000, 2),
        '生理学-1': qstat(Date.now() + 86_400_000, 0),
      },
      药理学: { '药理学-0': qstat(Date.now() - 1000, 0) },
    };
    const out = quizProgressReport([bank('生理学', 3), bank('药理学', 1)], stats);
    expect(out).toContain('已作答 3 题，有错题 1 题，今日待复习 2 题');
    expect(out).toContain('- 生理学：做过 2/3 题，有错题 1 题，今日待复习 1 题');
    expect(out).toContain('- 药理学：做过 1/1 题，有错题 0 题，今日待复习 1 题');
    expect(out).toContain('今日待复习最多的题库：');
  });
});

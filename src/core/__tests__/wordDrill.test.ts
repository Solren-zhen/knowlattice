// @vitest-environment node
/**
 * 单词工坊的领域规则：判定、排期、挑词、词库解析。
 *
 * 这些是面板里唯一会影响「学得对不对」的部分，钉住它们就够了；
 * 视图只做渲染，不重复断言 CSS。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DAY,
  DEFAULT_SETTINGS,
  MASTER_REPS,
  SETTINGS_VERSION,
  WORD_BANKS,
  bankSummary,
  dailyPlan,
  dailySeries,
  dayKey,
  diffChars,
  drillSummary,
  hintOf,
  judge,
  nextRecord,
  normalizeSettings,
  normWord,
  parseWordList,
  parseWordBankFile,
  pickDailyQueue,
  pickQueue,
  recordDaily,
  searchWords,
  wordState,
  shuffle,
  wrongBook,
  type DrillDaily,
  type Word,
  type WordRecord,
} from '../wordDrill';

const NOW = Date.UTC(2026, 0, 15, 9, 0, 0);

describe('词库清单与词表文件', () => {
  it('登记了 CET-6 与考研两个词库', () => {
    expect(WORD_BANKS.map((b) => b.id)).toEqual(['cet6', 'kaoyan']);
    for (const bank of WORD_BANKS) {
      expect(bank.count).toBeGreaterThan(2000);
      expect(bank.file).toMatch(/^wordbanks\/[a-z0-9]+\.json$/);
    }
  });

  it('词表文件真实存在、条数与清单一致、字段可用', () => {
    for (const bank of WORD_BANKS) {
      const file = path.join(process.cwd(), 'public', bank.file);
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        count: number;
        source: string;
        words: Array<{ en: string; zh: string; ipa?: string; example?: string }>;
      };
      expect(data.words.length).toBe(data.count);
      expect(data.count).toBe(bank.count);
      expect(data.source).toContain('TypeWords');

      // 抽查 300 条：词形是英文、释义非空且被截断在可读长度内
      for (const word of data.words.slice(0, 300)) {
        expect(normWord(word.en)).toMatch(/^[a-z][a-z'\- ]*$/);
        expect(word.zh.trim().length).toBeGreaterThan(0);
        expect(word.zh.length).toBeLessThanOrEqual(60);
        if (word.example) expect(word.example.length).toBeLessThanOrEqual(110);
      }
      expect(data.words[0].ipa?.startsWith('/')).toBe(true);
    }
  });

  it('词表内没有重复词条', () => {
    for (const bank of WORD_BANKS) {
      const file = path.join(process.cwd(), 'public', bank.file);
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { words: Array<{ en: string }> };
      const keys = data.words.map((w) => normWord(w.en));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('normWord · 归一化', () => {
  it('大小写、首尾与连续空格、连字符/撇号变体都不影响比较', () => {
    expect(normWord('  MetaStasis ')).toBe('metastasis');
    expect(normWord('blood   pressure')).toBe('blood pressure');
    expect(normWord('placebo\u2013controlled')).toBe('placebo-controlled');
    expect(normWord('don\u2019t')).toBe("don't");
  });
});

describe('judge · 判定', () => {
  it('完全一致（忽略大小写与空格）算对', () => {
    expect(judge('Metastasis', 'metastasis')).toBe('right');
    expect(judge('  blood pressure ', 'blood pressure')).toBe('right');
  });

  it('差一个字母算「接近」，差得远算错', () => {
    expect(judge('metastatis', 'metastasis')).toBe('near');
    expect(judge('metasta', 'metastasis')).toBe('wrong');
  });

  it('长词的容差放宽到两个字母', () => {
    // 14 个字母，容差 2
    expect(judge('atherosclerosi', 'atherosclerosis')).toBe('near');
    expect(judge('atherosclero', 'atherosclerosis')).toBe('wrong');
  });

  it('空输入直接算错，不会因为「都是空」而判对', () => {
    expect(judge('', 'anatomy')).toBe('wrong');
    expect(judge('   ', 'anatomy')).toBe('wrong');
  });
});

describe('nextRecord · FSRS 排期', () => {
  it('新词答对：建立稳定性与难度，间隔落在几天量级', () => {
    const rec = nextRecord(undefined, 'alpha', true, NOW);
    expect(rec.reps).toBe(1);
    expect(rec.right).toBe(1);
    expect(rec.stability).toBeGreaterThan(2);
    expect(rec.stability).toBeLessThan(6);
    expect(rec.difficulty).toBeGreaterThan(4);
    expect(rec.difficulty).toBeLessThan(7);
    expect(rec.due - NOW).toBeGreaterThanOrEqual(DAY);
    expect(rec.mastered).toBe(false);
  });

  it('连续答对：间隔单调变长，第 5 次算掌握', () => {
    let rec: WordRecord | undefined;
    let at = NOW;
    let prev = 0;
    const gaps: number[] = [];
    for (let i = 0; i < MASTER_REPS; i++) {
      rec = nextRecord(rec, 'alpha', true, at);
      const gap = rec.due - at;
      expect(gap).toBeGreaterThanOrEqual(prev);
      prev = gap;
      gaps.push(gap);
      at = rec.due; // 下一次在第 4/5 次复习真正到期时才作答
    }
    expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0]);
    expect(rec?.mastered).toBe(true);
  });

  it('答错：连对清零、遗忘次数 +1、难度上调、稳定性回落', () => {
    let rec: WordRecord | undefined;
    for (let i = 0; i < 4; i++) rec = nextRecord(rec, 'alpha', true, NOW);
    const before = rec!;
    const after = nextRecord(before, 'alpha', false, NOW);

    expect(after.reps).toBe(0);
    expect(after.lapses).toBe(before.lapses + 1);
    expect(after.mastered).toBe(false);
    expect(after.difficulty).toBeGreaterThan(before.difficulty);
    expect(after.stability).toBeLessThan(before.stability);
    expect(after.due - NOW).toBeLessThan(before.due - NOW);
  });

  it('间隔有上限，不会超过 365 天', () => {
    let rec: WordRecord | undefined;
    for (let i = 0; i < 40; i++) rec = nextRecord(rec, 'alpha', true, NOW);
    expect(rec!.due - NOW).toBeLessThanOrEqual(365 * DAY);
  });
});

const WORDS: Word[] = [
  { en: 'alpha', zh: '甲' },
  { en: 'beta', zh: '乙' },
  { en: 'gamma', zh: '丙' },
  { en: 'delta', zh: '丁' },
];

const rec = (en: string, patch: Partial<WordRecord> = {}): WordRecord => ({
  en,
  right: 0,
  wrong: 0,
  reps: 0,
  due: 0,
  mastered: false,
  stability: 1,
  difficulty: 5,
  lastReview: 0,
  lapses: 0,
  ...patch,
});

describe('pickQueue · 挑这一轮练什么', () => {
  it('生词排在到期词之前，其余不排', () => {
    const records = {
      alpha: rec('alpha', { due: NOW - DAY }),
      beta: rec('beta', { due: NOW + DAY }),
    };
    const picked = pickQueue(WORDS, records, { limit: 10, now: NOW });
    // gamma / delta 是生词（tier 0），alpha 到期（tier 1）；beta 未到期被过滤
    expect(picked.map((w) => w.en).slice(0, 2).sort()).toEqual(['delta', 'gamma']);
    expect(picked.map((w) => w.en)).toContain('alpha');
    expect(picked.map((w) => w.en)).not.toContain('beta');
  });

  it('已掌握且未到期的词不再出现', () => {
    const records = {
      alpha: rec('alpha', { mastered: true, due: NOW + DAY, right: 6, reps: 6 }),
    };
    const picked = pickQueue(WORDS, records, { limit: 10, now: NOW });
    expect(picked.map((w) => w.en)).not.toContain('alpha');
  });

  it('filter=wrong 只收「错过且未掌握」，错得多的在前', () => {
    const records = {
      alpha: rec('alpha', { wrong: 1, due: NOW + DAY }),
      beta: rec('beta', { wrong: 3, due: NOW + DAY }),
      gamma: rec('gamma', { wrong: 2, mastered: true, due: NOW + DAY }),
    };
    const picked = pickQueue(WORDS, records, { limit: 10, now: NOW, filter: 'wrong' });
    expect(picked.map((w) => w.en)).toEqual(['beta', 'alpha']);
  });

  it('filter=all 收全部（含已掌握），limit 生效', () => {
    const records = { alpha: rec('alpha', { mastered: true, due: NOW + DAY }) };
    const picked = pickQueue(WORDS, records, { limit: 2, now: NOW, filter: 'all' });
    expect(picked).toHaveLength(2);
  });

  it('词库里的重复词只出现一次', () => {
    const dup = [...WORDS, { en: 'Alpha', zh: '甲（重复）' }];
    const picked = pickQueue(dup, {}, { limit: 10, now: NOW });
    expect(picked.map((w) => normWord(w.en))).toEqual(['alpha', 'beta', 'gamma', 'delta']);
  });
});

describe('shuffle', () => {
  it('不改原数组、元素不丢不重', () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffle(input, () => 0);
    expect(input).toEqual([1, 2, 3, 4, 5]);
    expect(out.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('parseWordList · 词库解析', () => {
  it('空格 / 制表符 / 逗号 / 等号 / 中文标点都认', () => {
    const { words, skipped } = parseWordList(
      ['homeostasis 内环境稳态', 'aneurysm\t动脉瘤', 'edema,水肿', 'lesion = 病灶', 'fever，发热'].join('\n'),
    );
    expect(skipped).toBe(0);
    expect(words).toEqual([
      { en: 'homeostasis', zh: '内环境稳态' },
      { en: 'aneurysm', zh: '动脉瘤' },
      { en: 'edema', zh: '水肿' },
      { en: 'lesion', zh: '病灶' },
      { en: 'fever', zh: '发热' },
    ]);
  });

  it('跳过注释、空行、缺释义、纯中文和无英文的行，但继续解析后面的行', () => {
    const { words, skipped } = parseWordList(
      ['# 注释', '', '只是中文没有英文', 'noZh', '12345', 'good 好的'].join('\n'),
    );
    expect(words).toEqual([{ en: 'good', zh: '好的' }]);
    // 注释与空行直接跳过、不算「脏行」：只有三行是真的解析不出来
    expect(skipped).toBe(3);
  });

  it('重复词（大小写不同）只保留第一条', () => {
    const { words, skipped } = parseWordList('Liver 肝\nliver 肝脏');
    expect(words).toEqual([{ en: 'Liver', zh: '肝' }]);
    expect(skipped).toBe(1);
  });

  it('多词术语与连字符保留', () => {
    const { words } = parseWordList('blood pressure 血压\nplacebo-controlled 安慰剂对照');
    expect(words.map((w) => w.en)).toEqual(['blood pressure', 'placebo-controlled']);
  });
});

describe('drillSummary / wrongBook', () => {
  it('汇总：总数 / 已掌握 / 待复习 / 薄弱', () => {
    const records = {
      alpha: rec('alpha', { mastered: true, due: NOW + DAY, right: 6, reps: 6 }),
      beta: rec('beta', { wrong: 2, due: NOW - DAY }),
      gamma: rec('gamma', { wrong: 0, due: NOW + DAY }),
    };
    expect(drillSummary(records, NOW)).toEqual({ tracked: 3, mastered: 1, weak: 1, dueNow: 1 });
  });

  it('bankSummary 只算当前词库：别的词库的记录不混进来', () => {
    const records = {
      alpha: rec('alpha', { mastered: true, due: NOW + DAY, right: 6, reps: 6 }),
      beta: rec('beta', { wrong: 2, due: NOW - DAY }),
      // 不在 WORDS 里的记录（比如切到另一个词库后留下的）
      zeta: rec('zeta', { wrong: 9, due: NOW - DAY }),
    };
    expect(bankSummary(WORDS, records, NOW)).toEqual({ tracked: 2, mastered: 1, weak: 1, dueNow: 1 });
  });

  it('错词本只列词库里认得的、错过且未掌握的词', () => {
    const records = {
      alpha: rec('alpha', { wrong: 1 }),
      beta: rec('beta', { wrong: 2 }),
      gamma: rec('gamma', { wrong: 1, mastered: true }),
      unknown: rec('unknown', { wrong: 9 }),
    };
    expect(wrongBook(WORDS, records).map((w) => w.en)).toEqual(['beta', 'alpha']);
  });
});

describe('hintOf', () => {
  it('只给首字母与字母数，不泄露完整拼写', () => {
    expect(hintOf('anatomy')).toBe('a······（7 个字母）');
    expect(hintOf('blood pressure')).toMatch(/^b·+（13 个字母）$/);
  });
});

describe('diffChars · 逐字符对照', () => {
  const bad = (cells: Array<{ state: string }>) => cells.filter((c) => c.state === 'bad').length;

  it('完全正确时两边都没有错字', () => {
    const d = diffChars('Anatomy', 'anatomy');
    expect(bad(d.input)).toBe(0);
    expect(bad(d.target)).toBe(0);
    expect(d.extra).toBe(0);
    expect(d.missing).toBe(0);
  });

  it('少打一个字母：只标那一个位置，不把后面全染红', () => {
    const d = diffChars('anatmy', 'anatomy');
    expect(d.missing).toBe(1);
    expect(d.extra).toBe(0);
    // 漏掉的是 o，且只有它被标红
    expect(bad(d.target)).toBe(1);
    expect(d.target.filter((c) => c.state === 'bad').map((c) => c.ch)).toEqual(['o']);
    expect(bad(d.input)).toBe(0);
  });

  it('多打一个字母：多出来的那个在输入行标红，正确写法仍然全绿', () => {
    const d = diffChars('anattomy', 'anatomy');
    expect(d.extra).toBe(1);
    expect(d.missing).toBe(0);
    expect(bad(d.target)).toBe(0);
    expect(bad(d.input)).toBe(1);
  });

  it('打错字母：输入与正确写法各标一处', () => {
    const d = diffChars('anotomy', 'anatomy');
    expect(d.extra).toBe(1);
    expect(d.missing).toBe(1);
    expect(bad(d.input)).toBe(1);
    expect(bad(d.target)).toBe(1);
  });

  it('完全没打：输入为空，正确写法整行标红', () => {
    const d = diffChars('', 'abc');
    expect(d.input).toEqual([]);
    expect(d.target.map((c) => c.state)).toEqual(['bad', 'bad', 'bad']);
  });

  it('判定口径一致：大小写与空格不影响对照结果', () => {
    const d = diffChars('  Blood  Pressure ', 'blood pressure');
    expect(d.extra).toBe(0);
    expect(d.missing).toBe(0);
  });
});

describe('每日统计与配额', () => {
  it('dayKey 用本地日期而不是 UTC', () => {
    const at = new Date(2026, 0, 5, 23, 30).getTime();
    expect(dayKey(at)).toBe('2026-01-05');
  });

  it('recordDaily 区分新词与复习，并按天归档', () => {
    let d: DrillDaily = {};
    d = recordDaily(d, { isNew: true, ok: true, now: NOW });
    d = recordDaily(d, { isNew: true, ok: false, now: NOW });
    d = recordDaily(d, { isNew: false, ok: true, now: NOW });
    expect(d[dayKey(NOW)]).toEqual({ newWords: 2, reviews: 1, correct: 2, total: 3 });

    const tomorrow = recordDaily(d, { isNew: true, ok: true, now: NOW + DAY });
    expect(tomorrow[dayKey(NOW)]).toEqual({ newWords: 2, reviews: 1, correct: 2, total: 3 });
    expect(tomorrow[dayKey(NOW + DAY)]).toEqual({ newWords: 1, reviews: 0, correct: 1, total: 1 });
  });

  it('dailyPlan 扣减今日剩余额度', () => {
    const daily: DrillDaily = { [dayKey(NOW)]: { newWords: 4, reviews: 5, correct: 7, total: 9 } };
    expect(dailyPlan(daily, 10, 20, NOW)).toMatchObject({
      remainingNew: 6,
      remainingReview: 15,
      done: { newWords: 4, reviews: 5 },
    });
  });

  it('dailySeries 返回 14 天、缺数据的天正确率为 0', () => {
    const daily: DrillDaily = { [dayKey(NOW)]: { newWords: 2, reviews: 0, correct: 1, total: 2 } };
    const series = dailySeries(daily, 14, NOW);
    expect(series).toHaveLength(14);
    expect(series[13].key).toBe(dayKey(NOW));
    expect(series[13].rate).toBe(0.5);
    expect(series[0].total).toBe(0);
    expect(series[0].rate).toBe(0);
  });

  it('pickDailyQueue 先补新词额度，再补到期复习', () => {
    const records = {
      alpha: rec('alpha', { due: NOW - DAY, stability: 2, difficulty: 5, lastReview: NOW - 2 * DAY }),
    };
    const picked = pickDailyQueue(WORDS, records, { newLimit: 2, reviewLimit: 1, now: NOW });
    expect(picked).toHaveLength(3);
    expect(picked.map((w) => w.en)).toContain('alpha');
    // 两个新词额度 + 一个到期复习
    expect(picked.filter((w) => w.en !== 'alpha')).toHaveLength(2);
  });

  it('配额已经用完时退回普通队列，不会返回空', () => {
    const daily: DrillDaily = { [dayKey(NOW)]: { newWords: 10, reviews: 20, correct: 9, total: 30 } };
    const picked = pickDailyQueue(WORDS, {}, { newLimit: 10, reviewLimit: 20, now: NOW, daily });
    expect(picked.length).toBeGreaterThan(0);
  });

  it('已掌握且未到期的词不会进每日队列', () => {
    const records = {
      alpha: rec('alpha', { mastered: true, due: NOW + 10 * DAY, reps: 6, stability: 30, difficulty: 4 }),
    };
    const picked = pickDailyQueue(WORDS, records, { newLimit: 10, reviewLimit: 10, now: NOW });
    expect(picked.map((w) => w.en)).not.toContain('alpha');
  });
});

describe('searchWords · 词库内查词', () => {
  const BANK: Word[] = [
    { en: 'cat', zh: '猫' },
    { en: 'scatter', zh: '散布' },
    { en: 'concatenate', zh: '连接' },
    { en: 'dog', zh: '狗' },
  ];

  it('英文前缀 → 英文包含 → 中文包含三段排序', () => {
    expect(searchWords(BANK, 'cat').map((w) => w.en)).toEqual(['cat', 'scatter', 'concatenate']);
    expect(searchWords(BANK, '连接').map((w) => w.en)).toEqual(['concatenate']);
  });

  it('大小写不敏感，空查询返回空数组', () => {
    expect(searchWords(BANK, 'CAT').map((w) => w.en)).toEqual(['cat', 'scatter', 'concatenate']);
    expect(searchWords(BANK, '   ')).toEqual([]);
  });

  it('遵守条数上限，且没有命中时返回空数组', () => {
    expect(searchWords(BANK, 'c', 2)).toHaveLength(2);
    expect(searchWords(BANK, 'zzz')).toEqual([]);
  });
});

describe('wordState · 词条状态', () => {
  it('没记录是未学，到期与未到期分开，掌握优先', () => {
    expect(wordState(undefined, NOW)).toBe('new');
    expect(wordState(rec('alpha', { due: NOW - 1 }), NOW)).toBe('due');
    expect(wordState(rec('alpha', { due: NOW + DAY }), NOW)).toBe('later');
    expect(wordState(rec('alpha', { due: NOW - 1, mastered: true }), NOW)).toBe('mastered');
  });
});

describe('normalizeSettings · 记住上次设置', () => {
  it('合法设置原样保留', () => {
    expect(
      normalizeSettings({
        version: SETTINGS_VERSION,
        bankId: 'kaoyan',
        mode: 'dictation',
        size: 20,
        newLimit: 7,
        reviewLimit: 33,
      }),
    ).toEqual({
      version: SETTINGS_VERSION,
      bankId: 'kaoyan',
      mode: 'dictation',
      size: 20,
      newLimit: 7,
      reviewLimit: 33,
    });
  });

  it('未知词库 / 模式 / 题量回退默认值', () => {
    expect(
      normalizeSettings({
        version: SETTINGS_VERSION,
        bankId: 'nope',
        mode: 'typing',
        size: 7,
        newLimit: 0,
        reviewLimit: 999,
      }),
    ).toEqual({
      version: SETTINGS_VERSION,
      bankId: DEFAULT_SETTINGS.bankId,
      mode: DEFAULT_SETTINGS.mode,
      size: DEFAULT_SETTINGS.size,
      // 配额夹到可用范围内，不变成 0（0 会让「开始练习」立刻无词可练）
      newLimit: 1,
      reviewLimit: 200,
    });
  });

  it('没有版本号的旧临时数据整份回退（默认听写）', () => {
    // 首次落地时默认还是「跟打」，那份数据不能继续沿用，否则用户看到的还是题面带答案
    expect(normalizeSettings({ bankId: 'cet6', mode: 'copy', size: 10 })).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.mode).toBe('dictation');
  });

  it('坏数据与自定义词库', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ version: SETTINGS_VERSION, bankId: 'custom' }).bankId).toBe('custom');
  });
});

describe('parseWordBankFile · 文件导入', () => {
  it('JSON 数组与 {words} 都认，保留 ipa/example，重复与坏条目计数', () => {
    const array = parseWordBankFile('bank.json', JSON.stringify([
      { en: 'abandon', zh: '放弃', ipa: '/əˈbændən/', example: 'They abandoned the plan.' },
      { en: 'Abandon', zh: '重复' },
      { en: 'nozh' },
      { zh: '缺英文' },
    ]));
    expect(array.error).toBeUndefined();
    expect(array.words).toEqual([
      { en: 'abandon', zh: '放弃', ipa: '/əˈbændən/', example: 'They abandoned the plan.' },
    ]);
    expect(array.skipped).toBe(3);

    const wrapped = parseWordBankFile('bank.json', JSON.stringify({ words: [{ en: 'fragile', zh: '脆弱的' }] }));
    expect(wrapped.words).toEqual([{ en: 'fragile', zh: '脆弱的' }]);
  });

  it('JSON 坏格式/没有 words 时返回可读错误，不回退成逐行解析', () => {
    expect(parseWordBankFile('bank.json', '{"words":').error).toContain('JSON 解析失败');
    expect(parseWordBankFile('bank.json', '{"foo":1}').error).toContain('没有 words');
  });

  it('文本文件走逐行解析，JSON 内容按扩展名/首字符识别', () => {
    const txt = parseWordBankFile('bank.txt', 'alpha 甲\nbeta 乙');
    expect(txt.words.map((w) => w.en)).toEqual(['alpha', 'beta']);
    const noExt = parseWordBankFile('bank', '[{"en":"gamma","zh":"丙"}]');
    expect(noExt.words).toEqual([{ en: 'gamma', zh: '丙' }]);
    expect(parseWordBankFile('bank.txt', '\uFEFFalpha 甲').words).toEqual([{ en: 'alpha', zh: '甲' }]);
  });
});

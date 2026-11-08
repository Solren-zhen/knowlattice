import { beforeEach, describe, expect, it } from 'vitest';
import {
  STORY_ARCHIVE_LIMIT,
  WEAK_MAX,
  analysisBatches,
  buildAnalysisMessages,
  buildStoryMessages,
  clearStoryArchive,
  decodeStoryArchive,
  importStoryArchiveBackup,
  loadStoryArchive,
  makeStoryArchiveEntry,
  mergeStoryArchives,
  parseAnalysis,
  parseJsonObject,
  parseStory,
  removeStoryArchive,
  saveStoryArchive,
  sortStoryArchive,
  storyCoverage,
  storyPlainText,
  storySurfaceForms,
  maskStoryText,
  storyToMarkdown,
  storyToMarkdownDocument,
  storyFileName,
  storyArchiveToMarkdown,
  archiveFileName,
  upsertStoryArchive,
  weakestWords,
  weaknessScore,
  wordAppears,
  wordForms,
  type WeakWord,
} from '../wordStory';
import { DAY, type Word, type WordRecord } from '../wordDrill';

const rec = (en: string, patch: Partial<WordRecord> = {}): WordRecord => ({
  en,
  right: 0,
  wrong: 0,
  reps: 0,
  due: 0,
  mastered: false,
  stability: 1,
  difficulty: 5,
  lastReview: Date.now(),
  lapses: 0,
  ...patch,
});

const word = (en: string): Word => ({ en, zh: `${en} 的释义` });

describe('薄弱词取词', () => {
  it('答错多、难度高、久未复习的词分数更高', () => {
    const now = Date.now();
    const weak = rec('weak', {
      right: 1,
      wrong: 4,
      reps: 0,
      lapses: 3,
      difficulty: 9,
      stability: 1,
      lastReview: now - 20 * DAY,
    });
    const strong = rec('strong', {
      right: 20,
      wrong: 1,
      reps: 8,
      mastered: true,
      difficulty: 2,
      stability: 60,
      lastReview: now,
    });
    expect(weaknessScore(weak, now)).toBeGreaterThan(weaknessScore(strong, now));
  });

  it('只统计练过的词，按最弱优先，并控制在 20% 与上下限内', () => {
    const words: Word[] = Array.from({ length: 50 }, (_, i) => word(`w${String(i).padStart(2, '0')}`));
    const records: Record<string, WordRecord> = {};
    for (const [i, w] of words.entries()) {
      // 序号越大越熟练
      records[w.en] = rec(w.en, {
        right: i,
        wrong: 50 - i,
        reps: i > 40 ? 6 : 1,
        mastered: i > 40,
        difficulty: Math.max(1, 10 - i / 6),
        lapses: i < 10 ? 4 : 0,
        stability: 1 + i / 5,
        lastReview: Date.now() - 30 * DAY,
      });
    }
    words.push(word('never-practiced'));

    const picked = weakestWords(words, records);
    expect(picked).toHaveLength(10); // 50 × 20%
    expect(picked[0].word.en).toBe('w00');
    expect(picked.map((p) => p.word.en)).not.toContain('never-practiced');
    // 逐项单调不增
    for (let i = 1; i < picked.length; i += 1) {
      expect(picked[i - 1].score).toBeGreaterThanOrEqual(picked[i].score);
    }
  });

  it('词少时取全部，词多时不超过上限', () => {
    const five = Array.from({ length: 5 }, (_, i) => word(`s${i}`));
    const fiveRecords = Object.fromEntries(five.map((w) => [w.en, rec(w.en, { wrong: 1 })]));
    expect(weakestWords(five, fiveRecords)).toHaveLength(5);

    const many = Array.from({ length: 200 }, (_, i) => word(`m${i}`));
    const manyRecords = Object.fromEntries(many.map((w) => [w.en, rec(w.en, { wrong: 2, lapses: 1 })]));
    expect(weakestWords(many, manyRecords)).toHaveLength(WEAK_MAX);
  });

  it('没有练习记录时返回空数组', () => {
    expect(weakestWords([word('alpha')], {})).toEqual([]);
  });
});

describe('提示词', () => {
  it('短文提示词带全部目标词，并要求打乱顺序与只输出 JSON', () => {
    const words = [word('abandon'), word('resilient'), word('on the verge of')];
    const messages = buildStoryMessages(words, 'CET-6');
    const system = messages[0].content;
    const user = messages[1].content;
    expect(system).toContain('只输出一个 JSON 对象');
    expect(system).toContain('不要按给定顺序排列');
    for (const w of words) expect(user).toContain(`- ${w.en} — ${w.zh}`);
    expect(user).toContain('CET-6');
  });

  it('词条释义只带第一个义项，避免多义项把提示词撑长', () => {
    const user = buildStoryMessages([{ en: 'abandon', zh: 'v. 抛弃，遗弃；放弃；陷入' }])[1].content;
    expect(user).toContain('- abandon — v. 抛弃，遗弃');
    expect(user).not.toContain('陷入');
  });

  it('精读提示词逐句编号，并要求 phrase 逐字出自原句', () => {
    const story = {
      title: 'The Long Way Home',
      titleZh: '回家的长路',
      sentences: [
        { en: 'She was on the verge of giving up.', zh: '她快要放弃了。' },
        { en: 'The rain had stopped by dawn.', zh: '天亮时雨已经停了。' },
      ],
    };
    const messages = buildAnalysisMessages(story);
    expect(messages[0].content).toContain('必须在该句中逐字出现');
    expect(messages[1].content).toContain('1. She was on the verge of giving up.');
    expect(messages[1].content).toContain('2. The rain had stopped by dawn.');
  });

  it('长文按 6 句分批，批次保持原编号且只带本批原文', () => {
    const story = {
      title: 'Long',
      titleZh: '',
      sentences: Array.from({ length: 14 }, (_, i) => ({ en: `Sentence ${i + 1}.`, zh: '' })),
    };
    expect(analysisBatches(story)).toEqual([
      { start: 1, end: 6 },
      { start: 7, end: 12 },
      { start: 13, end: 14 },
    ]);
    const messages = buildAnalysisMessages(story, { start: 7, end: 12 });
    expect(messages[1].content).toContain('7. Sentence 7.');
    expect(messages[1].content).toContain('12. Sentence 12.');
    expect(messages[1].content).not.toContain('Sentence 6.');
    expect(messages[1].content).toContain('第 7–12 句');
  });
});

describe('解析模型输出', () => {
  it('容忍围栏、前后解释与尾逗号', () => {
    const raw = [
      '好的，下面是短文：',
      '```json',
      '{"title":"Small Steps","titleZh":"小小一步","sentences":[{"en":"A.","zh":"甲"},{"en":"B.","zh":"乙"},],}',
      '```',
      '希望有帮助。',
    ].join('\n');
    const obj = parseJsonObject(raw);
    expect(obj?.title).toBe('Small Steps');
    const story = parseStory(raw);
    expect(story?.sentences.map((s) => s.en)).toEqual(['A.', 'B.']);
  });

  it('纯字符串句子与 story 包装也能解析', () => {
    const story = parseStory('{"story":{"title":"T","sentences":["One.","Two."]}}');
    expect(story).toEqual({
      title: 'T',
      titleZh: '',
      sentences: [
        { en: 'One.', zh: '' },
        { en: 'Two.', zh: '' },
      ],
    });
  });

  it('没有句子时判为失败，不返回空壳', () => {
    expect(parseStory('{"title":"T","sentences":[]}')).toBeNull();
    expect(parseStory('不是 JSON')).toBeNull();
  });

  it('精读按 index 排序，丢掉空壳句，兼容字符串搭配', () => {
    const analysis = parseAnalysis(
      JSON.stringify({
        sentences: [
          { index: 2, grammar: '过去完成时', points: [{ phrase: 'by dawn', zh: '到天亮时' }] },
          { index: 1, points: ['on the verge of', { phrase: 'give up', kind: '动词短语', zh: '放弃', tip: '后接动名词' }] },
          { index: 3 },
        ],
      }),
    );
    expect(analysis?.lines.map((l) => l.index)).toEqual([1, 2]);
    expect(analysis?.lines[0].points[0]).toEqual({
      phrase: 'on the verge of',
      kind: '固定搭配',
      zh: '',
      tip: '',
    });
    expect(analysis?.lines[0].points[1].phrase).toBe('give up');
    expect(analysis?.lines[1].grammar).toBe('过去完成时');
  });
});

describe('词形识别与导出', () => {
  it('识别常见屈折与双写', () => {
    expect(wordAppears('She studied all night.', 'study')).toBe(true);
    expect(wordAppears('They are stopping here.', 'stop')).toBe(true);
    expect(wordAppears('He abandoned the plan.', 'abandon')).toBe(true);
    expect(wordAppears('The article is long.', 'art')).toBe(false);
    expect(wordForms('study')).toContain('studied');
  });

  it('导出文本包含短文、译文与逐句搭配', () => {
    const story = {
      title: 'Small Steps',
      titleZh: '小小一步',
      sentences: [{ en: 'She was on the verge of giving up.', zh: '她快要放弃了。' }],
    };
    const md = storyToMarkdown(story, {
      lines: [
        {
          index: 1,
          grammar: '过去进行时',
          points: [{ phrase: 'on the verge of', kind: '固定搭配', zh: '濒临', tip: '后接名词或动名词' }],
        },
      ],
    });
    expect(md).toContain('# Small Steps（小小一步）');
    expect(md).toContain('她快要放弃了。');
    expect(md).toContain('on the verge of｜固定搭配｜濒临');
    expect(md).toContain('句型：过去进行时');
  });
});

describe('历史短文', () => {
  const story = {
    title: 'Small Steps',
    titleZh: '小小一步',
    sentences: [{ en: 'She kept walking.', zh: '她继续走着。' }],
  };
  const weak = (en: string): WeakWord => ({
    word: word(en),
    record: rec(en, { wrong: 2, lapses: 1, lastReview: Date.now() }),
    score: 3,
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it('新条目置顶，同 id 覆盖，最多保留 20 篇', () => {
    let list = upsertStoryArchive([], makeStoryArchiveEntry({ id: 'a', createdAt: 1, words: [weak('alpha')], story, analysis: null }));
    list = upsertStoryArchive(list, makeStoryArchiveEntry({ id: 'b', createdAt: 2, words: [weak('beta')], story, analysis: null }));
    expect(list.map((e) => e.id)).toEqual(['b', 'a']);

    const updated = makeStoryArchiveEntry({
      id: 'a',
      createdAt: 1,
      words: [weak('alpha')],
      story,
      analysis: { lines: [{ index: 1, grammar: '', points: [{ phrase: 'kept walking', kind: '动词短语', zh: '继续走', tip: '' }] }] },
    });
    list = upsertStoryArchive(list, updated);
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.id === 'a')?.analysis?.lines[0].points[0].phrase).toBe('kept walking');

    for (let i = 0; i < 25; i += 1) {
      list = upsertStoryArchive(
        list,
        makeStoryArchiveEntry({ id: `e${i}`, createdAt: 100 + i, words: [weak('w')], story, analysis: null }),
      );
    }
    expect(list).toHaveLength(STORY_ARCHIVE_LIMIT);
    expect(list[0].createdAt).toBe(124);
    expect(list.at(-1)?.createdAt).toBe(105);
  });

  it('解析时丢掉坏条目；精读损坏只保留短文', () => {
    const decoded = decodeStoryArchive([
      {
        id: 'ok',
        createdAt: 1,
        bankName: ' CET-6 ',
        words: [weak('alpha')],
        story,
        analysis: { sentences: [{ index: 1, points: [{ phrase: 'kept walking' }] }] },
      },
      { id: 'bad-story', createdAt: 3, story: { sentences: [] } },
      { id: 'bad-analysis', createdAt: 2, story, analysis: { sentences: [] } },
      'nope',
    ]);
    expect(decoded.map((e) => e.id)).toEqual(['bad-analysis', 'ok']);
    expect(decoded[0].analysis).toBeNull();
    expect(decoded[1].bankName).toBe('CET-6');
    expect(decoded[1].analysis?.lines[0].points[0].phrase).toBe('kept walking');
    expect(decoded[1].words[0].word.en).toBe('alpha');
  });

  it('本机存储可读写、可删除、可清空', () => {
    const entry = makeStoryArchiveEntry({ createdAt: 100, bankName: 'CET-6', words: [weak('alpha')], story, analysis: null });
    saveStoryArchive([entry]);
    const loaded = loadStoryArchive();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].story.title).toBe('Small Steps');
    expect(removeStoryArchive(loaded, entry.id)).toEqual([]);
    clearStoryArchive();
    expect(loadStoryArchive()).toEqual([]);
  });

  it('生成的 id 非空且同毫秒也不重复', () => {
    const a = makeStoryArchiveEntry({ createdAt: 1, words: [], story, analysis: null });
    const b = makeStoryArchiveEntry({ createdAt: 1, words: [], story, analysis: null });
    expect(a.id).not.toBe('');
    expect(a.id).not.toBe(b.id);
  });
});

describe('导出为文件', () => {
  const story = {
    title: 'Small Steps',
    titleZh: '小小一步',
    sentences: [{ en: 'She was on the verge of giving up.', zh: '她快要放弃了。' }],
  };
  const analysis = {
    lines: [
      {
        index: 1,
        grammar: '过去进行时',
        points: [{ phrase: 'on the verge of', kind: '固定搭配', zh: '濒临', tip: '后接名词或动名词' }],
      },
    ],
  };
  const created = new Date(2026, 10, 8, 20, 30).getTime();

  it('单篇导出带 frontmatter，文件名清理非法字符并保留中文', () => {
    const doc = storyToMarkdownDocument(story, analysis, {
      createdAt: created,
      bankName: 'CET-6',
      words: [word('alpha'), word('beta')],
    });
    expect(doc.startsWith('---\n')).toBe(true);
    expect(doc).toContain('title: "Small Steps（小小一步）"');
    expect(doc).toContain('created: 2026-11-08');
    expect(doc).toContain('source: 单词工坊');
    expect(doc).toContain('bank: "CET-6"');
    expect(doc).toContain('words: ["alpha","beta"]');
    expect(doc).toContain('# Small Steps（小小一步）');
    expect(doc).toContain('on the verge of｜固定搭配｜濒临');

    expect(storyFileName({ ...story, title: 'A/B: C*' }, created)).toBe('A-B-C-20261108.md');
    expect(storyFileName({ ...story, title: '  ' }, created)).toBe('word-story-20261108.md');
    expect(storyFileName({ ...story, title: '回家 的路' }, created)).toBe('回家-的路-20261108.md');
  });

  it('全部历史导出：每篇一个二级标题，正文不重复大标题', () => {
    const mk = (title: string, ts: number) =>
      makeStoryArchiveEntry({
        createdAt: ts,
        bankName: 'CET-6',
        words: [{ word: word('alpha'), record: rec('alpha'), score: 1 }],
        story: { ...story, title, titleZh: '' },
        analysis: null,
      });
    const md = storyArchiveToMarkdown([mk('First Story', created), mk('Second Story', created + 1000)]);
    expect(md).toContain('# 单词工坊 · 历史短文');
    expect(md).toContain('## 1. First Story');
    expect(md).toContain('## 2. Second Story');
    expect(md).not.toContain('# First Story');
    expect(md).toContain('She was on the verge of giving up.');
    expect(md.split('\n\n---\n\n')).toHaveLength(3);
    expect(archiveFileName(created)).toBe('单词工坊-历史短文-20261108.md');
  });
});

describe('收藏与备份', () => {
  const story = {
    title: 'Pinned',
    titleZh: '',
    sentences: [{ en: 'Keep going.', zh: '继续。' }],
  };
  const mk = (id: string, createdAt: number, pinned = false) =>
    makeStoryArchiveEntry({
      id,
      createdAt,
      words: [{ word: word(id), record: rec(id), score: 1 }],
      story,
      analysis: null,
      pinned,
    });

  beforeEach(() => {
    localStorage.clear();
  });

  it('收藏条目排在前面，并在截断时优先保留', () => {
    const list = sortStoryArchive([mk('new', 100), mk('old', 1, true), mk('mid', 50)]);
    expect(list.map((e) => e.id)).toEqual(['old', 'new', 'mid']);

    const many = Array.from({ length: 25 }, (_, i) => mk(`e${i}`, i, i === 0));
    expect(sortStoryArchive(many)).toHaveLength(STORY_ARCHIVE_LIMIT);
    expect(sortStoryArchive(many)[0].id).toBe('e0');
  });

  it('合并备份只补不覆盖，按 id 去重并保持上限', () => {
    const current = [mk('a', 10)];
    const incoming = [mk('a', 10), mk('b', 20), mk('c', 30)];
    const merged = mergeStoryArchives(current, incoming);
    expect(merged.map((e) => e.id)).toEqual(['c', 'b', 'a']);
    expect(merged).toHaveLength(3);
  });

  it('导入短文备份后写入本机，重复条目不重复计数', () => {
    saveStoryArchive([mk('a', 10)]);
    const result = importStoryArchiveBackup([mk('a', 10), mk('b', 20)]);
    expect(result).toEqual({ added: 1, kept: 1 });
    expect(loadStoryArchive().map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('目标词覆盖与挖空', () => {
  const story = {
    title: 'Irregular',
    titleZh: '',
    sentences: [
      { en: 'He went home after the children fell asleep.', zh: '孩子们睡着后他回了家。' },
      { en: 'She studied the map and stopped at the art gallery.', zh: '她研究了地图，在美术馆前停下。' },
    ],
    used: [
      { word: 'go', form: 'went' },
      { word: 'child', form: 'children' },
      { word: 'study', form: 'studied' },
    ],
  };

  it('用 used.form 校验不规则变化，漏词能被识别', () => {
    const coverage = storyCoverage(story, [word('go'), word('child'), word('study'), word('borrow'), word('abandon')]);
    expect(coverage.used.map((w) => w.en)).toEqual(['go', 'child', 'study']);
    expect(coverage.missing.map((w) => w.en)).toEqual(['borrow', 'abandon']);
  });

  it('实际形态优先于词形规则，挖空不误伤子串', () => {
    const forms = storySurfaceForms(story, [word('go'), word('child'), word('study')]);
    expect(forms).toContain('went');
    expect(forms).toContain('children');
    expect(maskStoryText('He went home with the children.', forms)).toBe('He ＿＿＿ home with the ＿＿＿.');
    expect(maskStoryText('They started the car.', ['art'])).toBe('They started the car.');
    expect(maskStoryText('The art show.', ['art'])).toBe('The ＿＿＿ show.');
  });

  it('没有 used 时退回规则词形', () => {
    const plain = { title: 'T', titleZh: '', sentences: [{ en: 'They studied all night.', zh: '' }] };
    expect(storySurfaceForms(plain, [word('study')])).toContain('studied');
    expect(storyPlainText(plain)).toBe('They studied all night.');
    expect(storyCoverage(plain, [word('study')]).missing).toEqual([]);
  });
});

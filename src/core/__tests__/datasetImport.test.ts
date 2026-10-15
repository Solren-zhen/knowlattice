/**
 * datasetImport 的单测。
 *
 * 样例**全部自造**：字段名按三类数据集常见的几种写法拼出来，内容用「甲/乙/丙」占位，
 * 不粘贴任何真实医学内容或第三方数据集原文——本模块只搬运格式，测试也不该引入第三方资料。
 */
import { describe, expect, it } from 'vitest';
import {
  datasetSummary,
  datasetToNotes,
  datasetToVaultFiles,
  detectDataset,
} from '../datasetImport';

const SYMPTOM_DATASET = {
  entries: [
    { symptom: '症状甲', diseases: ['疾病甲', '疾病乙'], category: '系统甲' },
    { symptom: '症状乙', diseases: '疾病丙、疾病丁', category: '系统甲' },
  ],
};

const MNEMONIC_DATASET = {
  specialty: '专科甲',
  source_note: '来源说明甲',
  entries: [
    { keyword: '口诀甲', detail: '内容甲', mnemonic: '口诀文本甲' },
    { keyword: '口诀乙', category: '分类乙', mnemonic: '口诀文本乙' },
  ],
};

const TERM_DATASET = {
  terms: [
    { en: 'term-alpha', zh: '术语甲', note: '备注甲' },
    { en: 'term-beta', zh: '术语乙' },
  ],
};

const UNKNOWN_DATASET = { records: [{ foo: '甲', bar: '乙' }] };

describe('detectDataset · 三类各一例', () => {
  it('认出症状→疾病对照，count 与实际条数一致', () => {
    const d = detectDataset(SYMPTOM_DATASET);
    expect(d.kind).toBe('symptom-disease');
    expect(d.count).toBe(2);
    expect(d.count).toBe(datasetToNotes(SYMPTOM_DATASET, 'symptom-disease').length);
    expect(d.confidence).toBeGreaterThan(0.6);
    const evidence = d.evidence.join(' ');
    expect(evidence).toContain('symptom/症状');
    expect(evidence).toContain('diseases/diseasesRaw/疾病');
  });

  it('认出口诀数据集（外层 specialty/source_note + entries）', () => {
    const d = detectDataset(MNEMONIC_DATASET);
    expect(d.kind).toBe('mnemonic');
    expect(d.count).toBe(2);
    const evidence = d.evidence.join(' ');
    expect(evidence).toContain('keyword/关键词/名称');
    expect(evidence).toContain('source_note/来源');
  });

  it('认出术语表（terms 列表）', () => {
    const d = detectDataset(TERM_DATASET);
    expect(d.kind).toBe('term-list');
    expect(d.count).toBe(2);
    expect(d.evidence.join(' ')).toContain('terms/术语');
  });

  it('JSON 文本与数组直接给都能识别', () => {
    expect(detectDataset(JSON.stringify(SYMPTOM_DATASET)).kind).toBe('symptom-disease');
    expect(detectDataset([{ en: 'term-gamma', zh: '术语丙' }]).kind).toBe('term-list');
  });
});

describe('detectDataset · 未知形状', () => {
  it('返回 unknown，并在 evidence 里说明缺什么', () => {
    const d = detectDataset(UNKNOWN_DATASET);
    expect(d.kind).toBe('unknown');
    expect(d.confidence).toBe(0);
    expect(d.count).toBe(0);
    const evidence = d.evidence.join(' ');
    expect(evidence).toContain('没有命中任何一类数据集');
    // 缺什么要写清楚，界面才能提示用户
    expect(evidence).toContain('symptom/症状');
    expect(evidence).toContain('keyword/关键词/名称');
    expect(evidence).toContain('en/英文');
  });

  it('非 JSON 文本 / 空列表 / 纯值 / null 也算未知', () => {
    expect(detectDataset('这不是 JSON').kind).toBe('unknown');
    expect(detectDataset('').kind).toBe('unknown');
    expect(detectDataset({ entries: [] }).kind).toBe('unknown');
    expect(detectDataset(42).kind).toBe('unknown');
    expect(detectDataset(null).kind).toBe('unknown');
  });

  it('unknown 不产出任何笔记', () => {
    expect(datasetToNotes(UNKNOWN_DATASET, 'unknown')).toEqual([]);
    expect(datasetToNotes(UNKNOWN_DATASET, 'symptom-disease')).toEqual([]);
    expect(datasetToNotes('{坏 JSON', 'mnemonic')).toEqual([]);
    expect(datasetToNotes({ entries: [] }, 'term-list')).toEqual([]);
  });
});

describe('datasetToNotes · 症状→疾病', () => {
  it('一条症状一篇笔记，疾病名写成 [[双链]]，chapter 取 category', () => {
    const notes = datasetToNotes(SYMPTOM_DATASET, 'symptom-disease');
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({
      title: '症状甲',
      chapter: '系统甲',
      body: '- 相关疾病: [[疾病甲]]、[[疾病乙]]',
    });
    // 纯字符串疾病列表（顿号分隔）也要能拆
    expect(notes[1].body).toBe('- 相关疾病: [[疾病丙]]、[[疾病丁]]');
    expect(notes[1].title).toBe('症状乙');
  });

  it('中文键名同样吃，逗号分隔也能拆', () => {
    const notes = datasetToNotes(
      [{ 症状: '症状丙', 疾病: '疾病戊,疾病己', 分类: '系统乙' }],
      'symptom-disease'
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      title: '症状丙',
      chapter: '系统乙',
      body: '- 相关疾病: [[疾病戊]]、[[疾病己]]',
    });
  });

  it('没有症状名的条目直接丢掉，不产出空标题', () => {
    expect(datasetToNotes([{ diseases: '疾病甲' }], 'symptom-disease')).toEqual([]);
  });
});

describe('datasetToNotes · 口诀', () => {
  it('按 出处/组成/功用/主治/口诀 逐行产出；缺失的键不留空行', () => {
    const notes = datasetToNotes(
      {
        specialty: '专科甲',
        source_note: '来源说明甲',
        entries: [
          {
            keyword: '口诀甲',
            mnemonic: '口诀文本甲',
            composition: '组成甲',
            function: '功用甲',
            indication: '主治甲',
          },
        ],
      },
      'mnemonic'
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('口诀甲');
    // 条目自己没给分类 → 退到外层 specialty
    expect(notes[0].chapter).toBe('专科甲');
    expect(notes[0].body).toBe(
      [
        '- 出处: 来源说明甲',
        '- 组成: 组成甲',
        '- 功用: 功用甲',
        '- 主治: 主治甲',
        '- 口诀: 口诀文本甲',
      ].join('\n')
    );
  });

  it('只有 keyword + detail 时只写口诀一行（detail 是通用内容的兜底）', () => {
    const notes = datasetToNotes([{ keyword: '口诀乙', detail: '内容乙' }], 'mnemonic');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: '口诀乙', chapter: '' });
    expect(notes[0].body).toBe('- 口诀: 内容乙');
    expect(notes[0].body).not.toContain('\n');
  });

  it('一条内容都没有的口诀条目正文为空，交给写盘层按「正文为空」报告', () => {
    const notes = datasetToNotes([{ keyword: '口诀丙' }], 'mnemonic');
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe('');
  });

  it('没有 keyword 的条目丢掉', () => {
    expect(datasetToNotes([{ detail: '内容丙' }], 'mnemonic')).toEqual([]);
  });
});

describe('datasetToNotes · 术语表', () => {
  it('扁平数组 [{en, zh}] 也能吃：标题取中文，正文写 英文/中文', () => {
    const notes = datasetToNotes([{ en: 'term-gamma', zh: '术语丙' }], 'term-list');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      title: '术语丙',
      chapter: '',
      body: '- 英文: term-gamma\n- 中文: 术语丙',
    });
  });

  it('容器形态（terms 在顶层外层）产出全部词条', () => {
    const notes = datasetToNotes(TERM_DATASET, 'term-list');
    expect(notes.map((n) => n.title)).toEqual(['术语甲', '术语乙']);
    expect(notes[0].body).toBe('- 英文: term-alpha\n- 中文: 术语甲\n- 备注: 备注甲');
    // 没有备注就不写备注行
    expect(notes[1].body).toBe('- 英文: term-beta\n- 中文: 术语乙');
  });

  it('文档形态（docId/title/category + terms）按词条展开，没中文就用英文当标题', () => {
    const notes = datasetToNotes(
      [
        {
          docId: 'd1',
          title: '章节甲',
          category: '分类甲',
          terms: [
            { en: 'term-alpha', zh: '术语甲', note: '备注甲' },
            { en: 'term-beta' },
          ],
        },
      ],
      'term-list'
    );
    expect(notes.map((n) => n.title)).toEqual(['术语甲', 'term-beta']);
    expect(notes[0].chapter).toBe('分类甲');
    expect(notes[1].body).toBe('- 英文: term-beta');
  });

  it('文档没有 category 时用文档标题当章节，中英都没有的词条丢掉', () => {
    const notes = datasetToNotes(
      [
        { title: '章节乙', terms: [{ en: 'term-delta', zh: '术语丁' }] },
        { title: '章节丙', terms: [{ note: '备注乙' }] },
      ],
      'term-list'
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].chapter).toBe('章节乙');
  });
});

describe('datasetToNotes · 任何形态都不留空行/空值行', () => {
  it('body 里没有「- 标签: 」这种空值行，也没有多余空行', () => {
    const all = [
      ...datasetToNotes(SYMPTOM_DATASET, 'symptom-disease'),
      ...datasetToNotes(MNEMONIC_DATASET, 'mnemonic'),
      ...datasetToNotes(TERM_DATASET, 'term-list'),
    ];
    for (const note of all) {
      for (const line of note.body.split('\n')) {
        expect(line).not.toMatch(/^-\s*[^:：]*[:：]\s*$/);
      }
      expect(note.body).not.toMatch(/\n\n/);
      expect(note.body).not.toMatch(/\n$/);
      expect(note.title).not.toBe('');
    }
  });
});

describe('datasetToVaultFiles', () => {
  it('产出的文件带 frontmatter source、dir 生效、detection 透传', () => {
    const res = datasetToVaultFiles(SYMPTOM_DATASET, {
      dir: '导入测试',
      sourceNote: '来源甲·自造样例',
    });
    expect(res.detection.kind).toBe('symptom-disease');
    expect(res.detection.count).toBe(2);
    expect(res.files).toHaveLength(2);
    expect(res.files[0].path).toBe('导入测试/症状甲.md');
    // 来源标注是版权预防措施：每篇都必须写进 frontmatter
    expect(res.files[0].content).toContain('source: 来源甲·自造样例');
    expect(res.files[0].content).toContain('chapter: 系统甲');
    expect(res.files[0].content).toContain('[[疾病甲]]');
    expect(res.skipped).toEqual([]);
  });

  it('JSON 文本可直接导入，kind 可被调用方覆盖', () => {
    const res = datasetToVaultFiles(JSON.stringify(TERM_DATASET), { sourceNote: '来源乙' });
    expect(res.detection.kind).toBe('term-list');
    expect(res.files.map((f) => f.path)).toEqual(['术语甲.md', '术语乙.md']);
    expect(res.files[0].content).toContain('source: 来源乙');

    const forced = datasetToVaultFiles(TERM_DATASET, {
      kind: 'symptom-disease',
      sourceNote: '来源乙',
    });
    expect(forced.detection.kind).toBe('symptom-disease');
    expect(forced.detection.evidence[0]).toContain('调用方指定');
    expect(forced.files).toEqual([]);
  });

  it('跳过项带中文原因（同一批重名 / 正文为空）', () => {
    const dup = datasetToVaultFiles(
      [
        { symptom: '症状甲', diseases: '疾病甲' },
        { symptom: '症状甲', diseases: '疾病乙' },
      ],
      { sourceNote: '来源丙' }
    );
    expect(dup.files).toHaveLength(1);
    expect(dup.skipped).toHaveLength(1);
    expect(dup.skipped[0].reason).toContain('重名');

    const empty = datasetToVaultFiles(
      [{ symptom: '症状乙' }, { symptom: '症状丙', diseases: '疾病丙' }],
      { sourceNote: '来源丙' }
    );
    expect(empty.skipped).toHaveLength(1);
    expect(empty.skipped[0].title).toBe('症状乙');
    expect(empty.skipped[0].reason).toContain('正文为空');
  });

  it('目录名不安全时整批不写（路径安全复用 importToVault）', () => {
    const res = datasetToVaultFiles(SYMPTOM_DATASET, { dir: '../越权', sourceNote: '来源甲' });
    expect(res.files).toEqual([]);
    expect(res.skipped.map((s) => s.reason)).toEqual(['目录名不安全', '目录名不安全']);
  });

  it('没识别出来时不写任何文件，也不抛错', () => {
    const res = datasetToVaultFiles(UNKNOWN_DATASET, { sourceNote: '来源丁' });
    expect(res.detection.kind).toBe('unknown');
    expect(res.detection.count).toBe(0);
    expect(res.files).toEqual([]);
    expect(res.skipped).toEqual([]);
  });
});

describe('datasetSummary', () => {
  it('一句话说清类别、可导入数、跳过数与来源', () => {
    const res = datasetToVaultFiles(
      [
        { symptom: '症状甲', diseases: '疾病甲' },
        { symptom: '症状甲', diseases: '疾病乙' },
      ],
      { sourceNote: '来源甲·自造样例' }
    );
    const text = datasetSummary(res, '来源甲·自造样例');
    expect(text).toContain('症状→疾病');
    expect(text).toContain('可导入 1 篇');
    expect(text).toContain('跳过 1 篇');
    expect(text).toContain('来源甲·自造样例');
  });

  it('未识别时直说识别不出，而不是假装成功', () => {
    const res = datasetToVaultFiles(UNKNOWN_DATASET, { sourceNote: '来源丁' });
    const text = datasetSummary(res, '来源丁');
    expect(text).toContain('未能识别');
    expect(text).toContain('可导入 0 篇');
    expect(text).toContain('来源丁');
  });
});

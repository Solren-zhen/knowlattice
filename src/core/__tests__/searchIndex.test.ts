import { describe, expect, it } from 'vitest';
import { bigramTokenize, VaultSearch } from '../searchIndex';

describe('bigramTokenize', () => {
  it('CJK 二元切分，ASCII 作为整词小写', () => {
    expect(bigramTokenize('氧解离曲线')).toEqual(['氧解', '解离', '离曲', '曲线']);
    expect(bigramTokenize('GFR')).toEqual(['gfr']);
  });

  it('混合内容切分正确且去掉空白', () => {
    const tokens = bigramTokenize('ECG 触发 氧解');
    expect(tokens).toContain('ecg');
    expect(tokens).toContain('触发');
    expect(tokens).toContain('氧解');
    // 单字 CJK 不产生二元组，相邻英文不受影响
    expect(bigramTokenize('氧 GFR 曲线')).toEqual(['gfr', '曲线']);
  });
});

describe('VaultSearch', () => {
  function docs() {
    return new Map<string, string>([
      ['生理/氧解离曲线.md', '# 氧解离曲线\n\n右移说明容易放氧。'],
      ['生理/通气.md', '# 通气\n\n通气量。'],
    ]);
  }

  it('未 warm 时搜索返回空，warm 后可搜到', async () => {
    const vs = new VaultSearch();
    vs.sync(docs());
    expect(vs.isReady()).toBe(false);
    expect(vs.search('氧解离')).toEqual([]);
    await vs.warm();
    expect(vs.isReady()).toBe(true);
    const hits = vs.search('氧解离');
    expect(hits.map((h) => h.id)).toContain('生理/氧解离曲线.md');
  });

  it('同步新增/修改/删除文档后增量生效', async () => {
    const vs = new VaultSearch();
    vs.sync(docs());
    await vs.warm();

    vs.sync(new Map([...docs(), ['新.md', '# 新篇\n\n提到主动脉弓。']]));
    expect(vs.search('主动脉弓').map((h) => h.id)).toContain('新.md');
    // 标题取文件名（不解析 H1）
    expect(vs.getDoc('新.md')?.title).toBe('新');

    vs.sync(new Map([
      ['生理/氧解离曲线.md', '# 氧解离曲线 修改后内容'],
    ]));
    expect(vs.search('容易放氧')).toEqual([]);

    vs.sync(new Map([['生理/通气.md', '# 通气']]));
    expect(vs.getDoc('生理/通气.md')?.title).toBe('通气');
  });

  it('标题字段参与检索（prefix 搜文件名/标题', async () => {
    const vs = new VaultSearch();
    vs.sync(new Map([['01/肺通气.md', '# 肺通气\n\n内容']]));
    await vs.warm();
    expect(vs.search('肺通').map((h) => h.id)).toContain('01/肺通气.md');
  });

  it('listSome 限制数量并排除指定路径', () => {
    const vs = new VaultSearch();
    vs.sync(docs());
    const out = vs.listSome(new Set(['生理/氧解离曲线.md']), 1);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('生理/通气.md');
    expect(vs.listSome(new Set(), 0)).toEqual([]);
  });

  it('只索引 .md，附件不进入', async () => {
    const vs = new VaultSearch();
    vs.sync(new Map([
      ['笔记.md', '# n'],
      ['_attachments/a.png', 'not-md'],
    ]));
    await vs.warm();
    expect(vs.list()).toHaveLength(1);
  });
});

/**
 * 「模糊查询」：此前 MiniSearch 的 fuzzy 从没打开过，查询也没有任何展开，
 * 于是搜「心衰」找不到标题是「心力衰竭」的笔记——而那篇笔记的 aliases
 * 里很可能就写着「心衰」。这一组就是守这几条召回路径。
 */
describe('VaultSearch 语义近似 / 别名 / 错字', () => {
  const bank = {
    '生理/氧解离曲线.md': '氧解离曲线右移表示血红蛋白对氧的亲和力降低，有利于放氧。',
    '内科/心肌梗死.md': '急性心肌梗死的典型表现是持续性胸痛，心电图见 ST 段抬高。',
    '内科/心力衰竭.md': '心力衰竭时心排血量下降，出现肺淤血。',
    '其他/无关笔记.md': '这篇笔记讲的是别的内容，和上面几个词都不沾边。',
  };

  async function build(docs: Record<string, string>): Promise<VaultSearch> {
    const vs = new VaultSearch();
    vs.sync(new Map(Object.entries(docs)));
    await vs.warm();
    return vs;
  }
  const ids = (vs: VaultSearch, q: string) => vs.search(q).map((h) => h.id);

  it('语义近似：搜俗称「心衰」能找到「心力衰竭」', async () => {
    const vs = await build(bank);
    expect(ids(vs, '心衰')).toContain('内科/心力衰竭.md');
  });

  it('语义近似：搜缩写「AMI」能找到「心肌梗死」', async () => {
    const vs = await build(bank);
    expect(ids(vs, 'AMI')).toContain('内科/心肌梗死.md');
  });

  it('aliases 真的进了索引（用词表覆盖不到的别名验）', async () => {
    const vs = await build({
      '内科/心肌梗死.md': '---\naliases: [心梗后综合征, Dressler]\n---\n急性心肌梗死表现为持续性胸痛。',
      '其他/无关笔记.md': '别的内容。',
    });
    expect(ids(vs, 'Dressler')).toContain('内科/心肌梗死.md');
    expect(ids(vs, '心梗后综合征')).toContain('内科/心肌梗死.md');
  });

  it('错字容忍（fuzzy）：英文拼错一个字母仍能命中', async () => {
    const vs = await build({
      '内科/心律失常.md': 'Atrial fibrillation is the most common sustained arrhythmia.',
    });
    expect(ids(vs, 'fibrilation')).toContain('内科/心律失常.md');
  });

  it('近似不等于乱召回：完全无关的查询仍然零结果', async () => {
    const vs = await build(bank);
    expect(ids(vs, '量子色动力学')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  examplePack,
  PACK_FORMAT,
  PACK_VERSION,
  packFromNotes,
  packNoteContent,
  packNotePath,
  packSummary,
  parseKnowledgePack,
  planPackInstall,
  safeDir,
  safeSegment,
  serializeKnowledgePack,
} from '../knowledgePack';

const pack = (notes: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: PACK_FORMAT, version: PACK_VERSION, name: '测试包', notes, ...extra });

describe('knowledgePack · 路径安全', () => {
  it('拒绝路径穿越与 Windows 非法名', () => {
    expect(safeSegment('..')).toBe(false);
    expect(safeSegment('.')).toBe(false);
    expect(safeSegment('.hidden')).toBe(false);
    expect(safeSegment('a/b')).toBe(false);
    expect(safeSegment('a\\b')).toBe(false);
    expect(safeSegment('a:b')).toBe(false);
    expect(safeSegment('a*b')).toBe(false);
    expect(safeSegment('')).toBe(false);
    expect(safeSegment('正常标题')).toBe(true);
    expect(safeSegment('2023-生理-12')).toBe(true);
  });

  it('目录逐段校验，空串视为根目录', () => {
    expect(safeDir('')).toBe(true);
    expect(safeDir('生理学/血液')).toBe(true);
    expect(safeDir('生理学/../秘密')).toBe(false);
    expect(safeDir('/绝对路径')).toBe(false);
  });
});

describe('knowledgePack · 解析', () => {
  it('往返一致（用自带示例包）', () => {
    const p = examplePack();
    const back = parseKnowledgePack(serializeKnowledgePack(p));
    expect(back.name).toBe(p.name);
    expect(back.notes).toHaveLength(p.notes.length);
    expect(back.notes[0].title).toBe(p.notes[0].title);
    expect(back.notes[0].body).toBe(p.notes[0].body);
  });

  it('非 JSON 报错', () => {
    expect(() => parseKnowledgePack('{坏')).toThrow('不是有效的 JSON 文件');
  });

  it('缺 format 报错（防止误把别的 json 导进来）', () => {
    expect(() => parseKnowledgePack(JSON.stringify({ notes: [] }))).toThrow(/不是晶格知识包/);
  });

  it('缺 notes / 版本过高 都报错', () => {
    expect(() => parseKnowledgePack(JSON.stringify({ format: PACK_FORMAT }))).toThrow(/notes/);
    expect(() => parseKnowledgePack(pack([], { version: PACK_VERSION + 1 }))).toThrow(/版本/);
  });

  it('单篇缺字段时报错并指出第几篇', () => {
    expect(() => parseKnowledgePack(pack([{ body: 'x' }]))).toThrow(/第 1 篇/);
    expect(() => parseKnowledgePack(pack([{ title: 'a', body: 'x' }, { title: 'b' }]))).toThrow(/第 2 篇/);
  });

  it('缺 name 时给默认名，不报错', () => {
    const p = parseKnowledgePack(JSON.stringify({ format: PACK_FORMAT, version: 1, notes: [] }));
    expect(p.name).toBe('未命名知识包');
  });
});

describe('knowledgePack · 正文组装', () => {
  it('路径按目录 + 标题拼（空目录不加前缀）', () => {
    expect(packNotePath({ title: '血压', body: 'x', dir: '生理学' })).toBe('生理学/血压.md');
    expect(packNotePath({ title: '血压', body: 'x', dir: '生理学/' })).toBe('生理学/血压.md');
    expect(packNotePath({ title: '血压', body: 'x', dir: '' })).toBe('血压.md');
  });

  it('生成 frontmatter + H1 + 正文', () => {
    const text = packNoteContent({
      title: '血压',
      body: '正文一\n正文二',
      chapter: '循环',
      tags: ['生理'],
      exam: ['2023-生理-12'],
      source: '某教材',
    });
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('chapter: 循环');
    expect(text).toContain('tags: [生理]');
    expect(text).toContain('exam: [2023-生理-12]');
    expect(text).toContain('source: 某教材');
    expect(text).toContain('# 血压');
    expect(text).toContain('正文一\n正文二');
  });
});

describe('knowledgePack · 安装计划', () => {
  const exists = (list: string[]) => (p: string) => list.includes(p);

  it('逐条给出跳过原因，绝不静默丢弃', () => {
    const p = parseKnowledgePack(
      pack([
        { title: '好的', body: '内容', dir: 'A' },
        { title: '../坏', body: '内容' },
        { title: '空的', body: '   ' },
        { title: '好的', body: '另一份', dir: 'A' },
      ])
    );
    const plan = planPackInstall(p, () => false);
    expect(plan.toCreate.map((e) => e.path)).toEqual(['A/好的.md']);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      '标题含非法字符或为空',
      '正文为空',
      '包内重名',
    ]);
  });

  it('同名笔记已存在时跳过，不覆盖用户自己的笔记', () => {
    const p = parseKnowledgePack(pack([{ title: '已有', body: '内容', dir: 'A' }]));
    const plan = planPackInstall(p, exists(['A/已有.md']));
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('同名笔记已存在（未覆盖）');
  });

  it('返回的 content 是可直接写盘的完整文本', () => {
    const p = parseKnowledgePack(pack([{ title: 'x', body: 'y', dir: 'D' }]));
    const plan = planPackInstall(p, () => false);
    expect(plan.toCreate[0].content).toContain('# x');
    expect(plan.toCreate[0].dir).toBe('D');
    expect(plan.toCreate[0].title).toBe('x');
  });
});

describe('knowledgePack · 打包已有笔记', () => {
  it('frontmatter 与目录被转成包字段，再导回去还是同一篇', () => {
    const content = '---\ntags: [生理]\nchapter: 循环\nsource: 教材\ncreated: 2026-01-01\nexam: [2023-生理-12]\n---\n\n# 血压\n\n正文\n';
    const p = packFromNotes('我的包', [{ path: '生理学/血压.md', content }]);
    expect(p.notes).toHaveLength(1);
    expect(p.notes[0].dir).toBe('生理学');
    expect(p.notes[0].title).toBe('血压');
    expect(p.notes[0].chapter).toBe('循环');
    expect(p.notes[0].tags).toEqual(['生理']);
    expect(p.notes[0].exam).toEqual(['2023-生理-12']);

    // 重新组装出的文本里 frontmatter 字段仍然在
    const rebuilt = packNoteContent({ ...p.notes[0], dir: '', title: '血压' });
    expect(rebuilt).toContain('chapter: 循环');
    expect(rebuilt).toContain('# 血压');
    expect(rebuilt).toContain('正文');
  });
});

describe('knowledgePack · 自带示例包不含医学结论', () => {
  it('示例包可以通过解析与安装计划，且标题里没有医学断言', () => {
    const p = examplePack();
    expect(p.notes.length).toBeGreaterThan(0);
    const plan = planPackInstall(parseKnowledgePack(serializeKnowledgePack(p)), () => false);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.toCreate).toHaveLength(p.notes.length);
    // 示例包只讲用法，不应包含"某某病首选某某药"这类结论性断言
    const all = p.notes.map((n) => n.body).join('\n');
    expect(all).not.toMatch(/首选|禁忌|诊断标准|治疗/);
  });
});

describe('knowledgePack · 摘要（导入前说清吃进去的是什么）', () => {
  it('带上包名、篇数、体积与作者/许可', () => {
    const s = packSummary({
      format: PACK_FORMAT,
      version: PACK_VERSION,
      name: '生理提纲',
      description: '',
      author: '张三',
      license: 'CC BY-NC 4.0',
      notes: [{ title: 'a', body: 'x' }],
    });
    expect(s).toContain('《生理提纲》');
    expect(s).toContain('1 篇');
    expect(s).toContain('KB');
    expect(s).toContain('作者 张三');
    expect(s).toContain('许可 CC BY-NC 4.0');
  });

  it('没写作者/许可时不留空字段', () => {
    const s = packSummary({ format: PACK_FORMAT, version: PACK_VERSION, name: 'x', notes: [] });
    expect(s).not.toContain('作者');
    expect(s).not.toContain('许可');
  });

  it('自带示例包的摘要能被直接显示', () => {
    expect(packSummary(examplePack())).toContain('《晶格用法示例》');
  });
});

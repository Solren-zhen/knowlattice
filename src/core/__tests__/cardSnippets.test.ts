import { describe, expect, it } from 'vitest';
import {
  anatomySection,
  buildSectionBody,
  findSection,
  hasSection,
  removeSection,
  upsertSection,
} from '../cardSnippets';

const BODY = '---\nchapter: 循环\n---\n\n# 心脏\n\n总览正文\n\n## 左心室\n\n- 英文名: left ventricle\n\n## 右心室\n\n- 英文名: right ventricle\n';

describe('cardSnippets · 定位小节', () => {
  it('找到小节的行区间，结束在下一个同级标题', () => {
    const f = findSection(BODY, '左心室')!;
    const lines = BODY.split('\n');
    expect(lines[f.start]).toBe('## 左心室');
    expect(lines[f.end]).toBe('## 右心室');
  });

  it('末尾小节一直延伸到文末', () => {
    const f = findSection(BODY, '右心室')!;
    expect(f.end).toBe(BODY.split('\n').length);
  });

  it('更深的 ### 属于本小节内容，不截断', () => {
    const b = '## A\n\n### 细节\n\nx\n\n## B\n\ny\n';
    const f = findSection(b, 'A')!;
    expect(b.split('\n')[f.end]).toBe('## B');
  });

  it('不存在 / 空标题 返回 null', () => {
    expect(findSection(BODY, '不存在')).toBeNull();
    expect(findSection(BODY, '   ')).toBeNull();
    expect(hasSection(BODY, '左心室')).toBe(true);
  });

  it('只认整行相同的 ## 标题（不会被 ### 或正文里的字串骗到）', () => {
    expect(hasSection('### 左心室\n', '左心室')).toBe(false);
    expect(hasSection('这里提到左心室但不是标题\n', '左心室')).toBe(false);
  });
});

describe('cardSnippets · 写入小节', () => {
  it('不存在时追加到末尾', () => {
    const out = upsertSection('# 心脏\n\n正文\n', '左心房', '- 英文名: left atrium');
    expect(out).toContain('## 左心房');
    expect(out).toContain('- 英文名: left atrium');
    expect(out.indexOf('正文')).toBeLessThan(out.indexOf('## 左心房'));
  });

  it('幂等：连做两次不会出现两个同名小节', () => {
    let out = upsertSection('# 心脏\n\n正文\n', '左心房', '第一次');
    out = upsertSection(out, '左心房', '第二次');
    expect(out.match(/## 左心房/g)).toHaveLength(1);
    expect(out).not.toContain('第一次');
    expect(out).toContain('第二次');
  });

  it('替换已有小节时保留前后小节', () => {
    const out = upsertSection(BODY, '左心室', '- 英文名: LV\n- 我的理解: ');
    expect(out.match(/## 左心室/g)).toHaveLength(1);
    expect(out).toContain('- 英文名: LV');
    expect(out).toContain('## 右心室');
    expect(out).toContain('# 心脏');
    // 顺序不变
    expect(out.indexOf('## 左心室')).toBeLessThan(out.indexOf('## 右心室'));
  });

  it('空正文笔记也能写入', () => {
    expect(upsertSection('', '标题', '内容')).toBe('## 标题\n\n内容\n');
  });

  it('标题为空时原样返回（不制造无标题小节）', () => {
    expect(upsertSection(BODY, '   ', 'x')).toBe(BODY);
  });
});

describe('cardSnippets · 删除小节', () => {
  it('删掉目标小节、保留其余', () => {
    const out = removeSection(BODY, '左心室');
    expect(out).not.toContain('## 左心室');
    expect(out).toContain('## 右心室');
    expect(out).toContain('# 心脏');
  });

  it('幂等：不存在时原样返回', () => {
    expect(removeSection(BODY, '不存在')).toBe(BODY);
  });
});

describe('cardSnippets · 正文组装', () => {
  it('用 `- 键: 值` 形式，并留一个「我的理解」空格', () => {
    const body = buildSectionBody([['英文名', 'left ventricle'], ['所属系统', '心血管']]);
    expect(body).toBe('- 英文名: left ventricle\n- 所属系统: 心血管\n- 我的理解: ');
  });

  it('空键被丢弃，空值保留成待填空', () => {
    const body = buildSectionBody([['', 'x'], ['笔记', '']]);
    expect(body).toBe('- 笔记: \n- 我的理解: ');
  });

  it('属性键不含空格——否则卡片正面的提示键会被 core/srsCards 的规则漏掉', () => {
    const body = buildSectionBody([['英文名', 'a'], ['所属系统', 'b']]);
    for (const line of body.split('\n')) {
      const m = /^-\s*([^:\n【[]{1,12})\s*:/.exec(line);
      if (!m) continue;
      expect(m[1]).not.toMatch(/\s/);
    }
  });
});

describe('cardSnippets · 解剖结构 → 小节', () => {
  it('中文名做标题，属性含英文名/所属系统/笔记双链', () => {
    const s = anatomySection({ zhName: '左心室', enName: 'left ventricle', system: '心血管系统', noteTitle: '心脏' });
    expect(s.title).toBe('左心室');
    expect(s.body).toContain('- 英文名: left ventricle');
    expect(s.body).toContain('- 所属系统: 心血管系统');
    expect(s.body).toContain('- 笔记: [[心脏]]');
  });

  it('没有对应笔记时不写空双链', () => {
    const s = anatomySection({ zhName: '左心室', enName: 'left ventricle', system: '心血管系统' });
    expect(s.body).not.toContain('[[]]');
    expect(s.body).toContain('- 笔记: ');
  });

  it('中文名缺失时退回英文名做标题', () => {
    const s = anatomySection({ zhName: '', enName: 'left ventricle', system: '心血管系统' });
    expect(s.title).toBe('left ventricle');
  });

  it('产出的小节能直接写进笔记并再被找到（与切卡规则对齐）', () => {
    const s = anatomySection({ zhName: '左心室', enName: 'left ventricle', system: '心血管系统' });
    const out = upsertSection('---\nchapter: 解剖\n---\n\n# 解剖复习卡\n', s.title, s.body);
    expect(hasSection(out, '左心室')).toBe(true);
    expect(out).toContain('## 左心室\n\n- 英文名: left ventricle');
  });
});

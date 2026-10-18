import { describe, expect, it } from 'vitest';
import { fuzzyFindAnchor, normalizeAnchor, structureLossWarnings } from '../aiPatch';

describe('normalizeAnchor', () => {
  it('空白折叠 + 全角标点映射', () => {
    expect(normalizeAnchor('  a　 b \n c ')).toBe('a b c');
    expect(normalizeAnchor('，。：；（）！？')).toBe(',.:;()!?');
    expect(normalizeAnchor('“弯引号”‘单引号’')).toBe('"弯引号"\'单引号\'');
    expect(normalizeAnchor('省略号…破折号—')).toBe('省略号...破折号-');
  });

  it('中文与字母数字原样保留', () => {
    expect(normalizeAnchor('心肌收缩泵血 P182')).toBe('心肌收缩泵血 P182');
  });
});

describe('structureLossWarnings（整篇重写的结构丢失检查）', () => {
  const oldNote = '---\ntags: [心脏]\nchapter: 循环\n---\n\n# 心脏\n- 定义: 泵血器官\n- 鉴别: [[肺]]\n';

  it('丢掉 frontmatter 键、双链与大段正文时逐条报出', () => {
    const w = structureLossWarnings(oldNote, '# 心脏\n泵血。\n');
    const kinds = w.map((x) => x.kind);
    expect(kinds).toContain('frontmatter');
    expect(kinds).toContain('links');
    expect(w.find((x) => x.kind === 'frontmatter')?.detail).toContain('tags、chapter');
    expect(w.find((x) => x.kind === 'links')?.detail).toContain('从 1 条减到 0 条');
  });

  it('结构原样保留（只做增补）时没有提醒', () => {
    const next = `${oldNote}\n- 口诀: 心房心室\n`;
    expect(structureLossWarnings(oldNote, next)).toEqual([]);
  });

  it('新建笔记（旧正文为空）没有基线，不报结构丢失', () => {
    expect(structureLossWarnings('', '# 新笔记\n')).toEqual([]);
  });

  it('短笔记缩水不算结构丢失（避免小改动被当成丢内容）', () => {
    expect(structureLossWarnings('# 心脏\n泵血。\n', '# 心脏\n泵。\n').some((w) => w.kind === 'shrink')).toBe(false);
  });
});

describe('fuzzyFindAnchor', () => {
  const doc = '# 心脏\n心肌收缩泵血，维持循环。\n\n## 泵血\n心肌收缩泵血，维持循环。\n';

  it('精确唯一命中直接返回区间', () => {
    const hit = fuzzyFindAnchor(doc, '# 心脏');
    expect(hit).toEqual({ start: 0, end: 4 });
  });

  it('精确多命中返回 null（不猜）', () => {
    expect(fuzzyFindAnchor(doc, '心肌收缩泵血')).toBeNull();
  });

  it('零命中且归一化也不命中返回 null', () => {
    expect(fuzzyFindAnchor(doc, '心室')).toBeNull();
  });

  it('空白差异：0 命中后归一化唯一命中，区间落在原文', () => {
    const text = '# 心脏\n心肌收缩泵血，维持循环。\n';
    // 模型给的锚文本多了空格/换行差异
    const hit = fuzzyFindAnchor(text, '心肌收缩泵血，  维持循环。\n');
    expect(hit).not.toBeNull();
    const hit2 = fuzzyFindAnchor(text, '心肌收缩泵血，\n维持循环。');
    expect(hit2).not.toBeNull();
    expect(text.slice(hit!.start, hit!.end)).toBe('心肌收缩泵血，维持循环。');
  });

  it('全角/半角标点差异：模型给半角逗号，原文全角', () => {
    const text = '第一段，这里有全角逗号。\n';
    const hit = fuzzyFindAnchor(text, '第一段,这里有全角逗号');
    expect(hit).not.toBeNull();
    expect(text.slice(hit!.start, hit!.end)).toBe('第一段，这里有全角逗号');
  });

  it('弯引号差异命中', () => {
    const text = '他说：“心律不齐。”然后就走了。\n';
    const hit = fuzzyFindAnchor(text, '他说:"心律不齐。"然后就走了。');
    expect(hit).not.toBeNull();
    expect(text.slice(hit!.start, hit!.end)).toBe('他说：“心律不齐。”然后就走了。');
  });

  it('省略号差异命中', () => {
    const text = '表现为胸痛、气短…等等。\n';
    const hit = fuzzyFindAnchor(text, '表现为胸痛、气短...等等。');
    expect(hit).not.toBeNull();
    expect(text.slice(hit!.start, hit!.end)).toBe('表现为胸痛、气短…等等。');
  });

  it('换行差异：归一化折叠后唯一命中，区间落在原文两行', () => {
    const text = 'a b\nc d\n';
    const hit = fuzzyFindAnchor(text, 'a b c d');
    expect(hit).not.toBeNull();
    expect(text.slice(hit!.start, hit!.end)).toBe('a b\nc d');
  });

  it('多命中（含归一化后仍多命中）返回 null', () => {
    const text = 'x y\nx y\n';
    expect(fuzzyFindAnchor(text, 'x y')).toBeNull();
    // 归一化把两行折成一个序列后仍出现两次
    const text2 = 'a b\na b\n';
    expect(fuzzyFindAnchor(text2, 'a b')).toBeNull();
  });

  it('空锚文本返回 null', () => {
    expect(fuzzyFindAnchor(doc, '')).toBeNull();
  });

  it('行尾空白差异：模型锚带尾随空格', () => {
    const text = '# 心脏\n第一行内容\n第二行内容\n';
    const hit = fuzzyFindAnchor(text, '第一行内容 \n第二行内容');
    expect(hit).not.toBeNull();
    expect(text.slice(hit!.start, hit!.end)).toBe('第一行内容\n第二行内容');
  });

  it('CRLF 差异命中', () => {
    const text = '第一行\r\n第二行\r\n';
    const hit = fuzzyFindAnchor(text, '第一行\n第二行');
    expect(hit).not.toBeNull();
    expect(text.slice(hit!.start, hit!.end)).toBe('第一行\r\n第二行');
  });
});

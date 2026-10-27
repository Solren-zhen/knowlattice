/**
 * 写入路径纯逻辑的单元测试：属性键清洗、骨架插入位置、定点替换的唯一性判定。
 *
 * 这三块原先埋在 AiAgentPanel 的 executeTool 巨型 if 链里，只能靠 DOM 测试间接断言
 * （错也不知道是逻辑错还是接线错）。抽到 core/aiTools 后可以对着字符串直接钉边界：
 * 插错小节、键被全角冒号废掉、锚文本多命中却放行——每一条都会静默写坏一篇笔记。
 */
import { describe, expect, it } from 'vitest';
import { applyNotePatch, cleanCardKeys, insertCardHints } from '../aiTools';

describe('cleanCardKeys', () => {
  it('去掉尾部的半角/全角冒号（中文输入法几乎必然打全角）', () => {
    expect(cleanCardKeys(['定义：', '首选检查:', '鉴别要点'])).toEqual({
      keys: ['定义', '首选检查', '鉴别要点'],
    });
  });

  it('去重并丢掉空白项', () => {
    expect(cleanCardKeys([' 定义 ', '定义', '   ', ''])).toEqual({ keys: ['定义'] });
  });

  it('空清单与非数组都报可行动的错', () => {
    expect(cleanCardKeys([])).toEqual({ error: expect.stringContaining('keys 为空') });
    expect(cleanCardKeys(undefined)).toEqual({ error: expect.stringContaining('keys 为空') });
  });

  it('键中间含空格/冒号或超过 12 字时报错（键名本身不被改写）', () => {
    expect(cleanCardKeys(['首选 检查'])).toEqual({ error: expect.stringContaining('首选 检查') });
    expect(cleanCardKeys(['十三个字的属性键名一定超长'])).toEqual({
      error: expect.stringContaining('不超过 12 个字'),
    });
  });
});

describe('insertCardHints', () => {
  it('插在小节标题之后，并用空行与正文隔开', () => {
    const out = insertCardHints('# 心脏\n## 泵血\n心肌收缩泵血。\n', '泵血', ['定义', '鉴别要点']);
    expect(out).toEqual([
      '# 心脏',
      '## 泵血',
      '- 定义: ',
      '- 鉴别要点: ',
      '',
      '心肌收缩泵血。',
      '',
    ]);
  });

  it('只认目标小节：其他小节里同名键不算已存在', () => {
    const doc = '# 总\n## A\n- 定义: 甲\n## B\n乙的内容\n';
    const out = insertCardHints(doc, 'B', ['定义']);
    expect(Array.isArray(out)).toBe(true);
    expect((out as string[]).join('\n')).toBe('# 总\n## A\n- 定义: 甲\n## B\n- 定义: \n\n乙的内容\n');
  });

  it('小节里已有的键跳过；全都存在时不出提案', () => {
    const doc = '# 总\n## A\n- 定义: 甲\n';
    // 定义已存在、鉴别要点缺失：只补缺的那个
    expect(insertCardHints(doc, 'A', ['定义', '鉴别要点'])).toEqual([
      '# 总',
      '## A',
      '- 定义: 甲',
      '- 鉴别要点: ',
      '',
    ]);
    expect(insertCardHints(doc, 'A', ['定义'])).toBe(
      '错误：这些提示键在小节里都已存在（定义），不用重复添加。',
    );
  });

  it('标题不存在时报错并指路（不猜近似标题）', () => {
    const out = insertCardHints('# 心脏\n## 泵血\n内容\n', '泵 血', ['定义']);
    expect(typeof out).toBe('string');
    expect(out as string).toContain('找不到小节标题');
    expect(out as string).toContain('一字不差');
  });
});

describe('applyNotePatch', () => {
  const doc = '# 心脏\n心肌收缩泵血。\n瓣膜防止倒流。\n';

  it('逐字唯一命中直接替换', () => {
    expect(applyNotePatch(doc, '心肌收缩泵血。', '心肌收缩泵血，维持循环。')).toEqual({
      next: '# 心脏\n心肌收缩泵血，维持循环。\n瓣膜防止倒流。\n',
    });
  });

  it('空 find_text 报错', () => {
    expect(applyNotePatch(doc, '', 'x')).toEqual({
      error: expect.stringContaining('find_text 为空'),
    });
  });

  it('多命中报「不唯一」而不是替模型挑一处', () => {
    const out = applyNotePatch(doc, '。', '！');
    expect(out).toEqual({ error: expect.stringContaining('不唯一') });
  });

  it('0 命中时走宽容匹配（半角逗号 vs 全角逗号）', () => {
    const full = '# 心脏\n心肌收缩泵血，维持循环。\n';
    // 原文是全角逗号，模型给了半角
    expect(applyNotePatch(full, '心肌收缩泵血,维持循环', '心肌舒张充盈，维持循环')).toEqual({
      next: '# 心脏\n心肌舒张充盈，维持循环。\n',
    });
  });

  it('宽容匹配也找不到时报错（不许猜）', () => {
    expect(applyNotePatch(doc, '心室里不存在的原文', 'x')).toEqual({
      error: expect.stringContaining('没有找到'),
    });
  });
});

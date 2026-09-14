import { describe, expect, it } from 'vitest';
import {
  joinLineItems,
  itemsToLines,
  analyzeGlobals,
  classifyLine,
  stripHeadersFooters,
  linesToMarkdown,
  tidyMarkdown,
  type PdfTextItem,
} from '../convert';

const item = (str: string, x: number, y: number, w = str.length * 5, h = 10, fontName = 'F1'): PdfTextItem =>
  ({ str, x, y, w, h, fontName });

describe('joinLineItems', () => {
  it('拉丁文间隙补空格，中文不补', () => {
    expect(joinLineItems([item('Hello', 0, 10, 25), item('World', 40, 10, 25)])).toBe('Hello World');
    expect(joinLineItems([item('甲状腺', 0, 10, 15), item('结节', 20, 10, 10)])).toBe('甲状腺结节');
  });

  it('紧邻的字符合并为一个词', () => {
    expect(joinLineItems([item('Hel', 0, 10, 15), item('lo', 15, 10, 10)])).toBe('Hello');
  });

  it('按 x 排序（PDF 文本项顺序不可靠）', () => {
    // 宽度按真实字形比例：单字符 ≈ 0.6 × 字高，间隙 < 阈值不补空格
    expect(joinLineItems([item('B', 6, 10, 6), item('A', 0, 10, 6)])).toBe('AB');
    expect(joinLineItems([item('B', 30, 10, 6), item('A', 0, 10, 6)])).toBe('A B');
  });

  it('移除软连字符与 nbsp', () => {
    expect(joinLineItems([item('hyper\u00ad', 0, 10, 20), item('thyroidism', 18, 10, 40)])).toBe('hyperthyroidism');
  });
});

describe('itemsToLines', () => {
  it('按 y 聚合成行并自上而下排序', () => {
    const lines = itemsToLines([
      item('第二行', 0, 100, 30),
      item('第一行', 0, 120, 30),
      item('续', 35, 119, 10),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe('第一行续');
    expect(lines[1].text).toBe('第二行');
  });
});

describe('analyzeGlobals / classifyLine', () => {
  const body = (text: string, y: number) => ({ y, h: 10, items: [item(text, 0, y)], text });
  const big = (text: string, y: number) => ({ y, h: 22, items: [item(text, 0, y, text.length * 12, 22, 'Arial-Bold')], text });

  it('最常用字高识别为正文，更大字高成为标题级别', () => {
    const g = analyzeGlobals([[big('第一章 绪论', 700), body('甲状腺激素由甲状腺滤泡上皮细胞分泌。', 680), body('它对代谢具有显著的调节作用。', 665), body('正常成人每日分泌量相对恒定。', 650)]]);
    expect(g.bodyHeight).toBe(10);
    expect(classifyLine(big('第一章 绪论', 700), g, [22])).toEqual({ type: 'heading', level: 1 });
    expect(classifyLine(body('甲状腺激素由甲状腺滤泡上皮细胞分泌。', 680), g, [22])).toEqual({ type: 'para', text: '甲状腺激素由甲状腺滤泡上皮细胞分泌。' });
  });

  it('识别无序列表、有序列表与中文序号', () => {
    const mk = (t: string) => ({ y: 0, h: 10, items: [item(t, 0, 10)], text: t });
    const g = analyzeGlobals([[mk('• 要点')]]);
    expect(classifyLine(mk('• 要点'), g, [])).toEqual({ type: 'bullet', text: '要点' });
    expect(classifyLine(mk('1. 第一条'), g, [])).toEqual({ type: 'ordered', num: 1, text: '第一条' });
    expect(classifyLine(mk('一、定义'), g, [])).toEqual({ type: 'bullet', text: '一、定义' });
    expect(classifyLine(mk('① 起病急'), g, [])).toEqual({ type: 'bullet', text: '① 起病急' });
  });
});

describe('stripHeadersFooters', () => {
  it('剔除多数页面重复的页眉页脚（页码数字归一化）', () => {
    const page = (n: number) => [
      item('第 ' + n + ' 页', 0, 750, 30, 10),
      item('生理学讲义', 0, 730, 50, 10),
      item(`${['滤泡上皮', '滤泡旁细胞', '腺垂体', '下丘脑'][n - 1]}分泌的激素各有特点，互不相同。`, 0, 500, 200, 10),
    ].map((it) => ({ y: it.y, h: it.h, items: [it], text: it.str }));
    const pages = [1, 2, 3, 4].map(page);
    const out = stripHeadersFooters(pages);
    for (const lines of out) {
      expect(lines).toHaveLength(1);
      expect(lines[0].text).toContain('分泌的激素');
    }
  });

  it('页数不足 3 时不剔除', () => {
    const page = () => [{ y: 750, h: 10, items: [item('固定页眉', 0, 750)], text: '固定页眉' }];
    const pages = [page(), page()];
    expect(stripHeadersFooters(pages)).toHaveLength(2);
    expect(stripHeadersFooters(pages)[0]).toHaveLength(1);
  });
});

describe('linesToMarkdown', () => {
  it('标题 + 段落合并 + 加粗 + 列表', () => {
    const body = (str: string, y: number) => ({ y, h: 10, items: [item(str, 0, y)], text: str });
    const bold = (str: string, y: number) => ({ y, h: 10, items: [item(str, 0, y, str.length * 5, 10, 'BoldFont')], text: str });
    const head = (str: string, y: number) => ({ y, h: 22, items: [item(str, 0, y, str.length * 12, 22)], text: str });
    const pages = [[
      head('第二章 呼吸生理', 700),
      body('氧解离曲线是指血红蛋白氧饱和度与血氧分压', 680),
      body('的关系曲线，呈 S 形。', 663),
      bold('重要结论：', 640),
      body('• 上段平坦反映氧储备', 620),
      body('• 下段陡峭提示组织供氧', 600),
    ]];
    const g = analyzeGlobals(pages);
    const md = linesToMarkdown(pages, g);
    expect(md).toContain('# 第二章 呼吸生理');
    // 中文续行合并为一段（不插空格）
    expect(md).toContain('氧解离曲线是指血红蛋白氧饱和度与血氧分压的关系曲线，呈 S 形。');
    // 粗体字体包裹
    expect(md).toContain('**重要结论：**');
    expect(md).toContain('- 上段平坦反映氧储备');
    expect(md).toContain('- 下段陡峭提示组织供氧');
  });

  it('拉丁文续行合并时补空格', () => {
    const a = { y: 700, h: 10, items: [item('The oxyhemoglobin', 0, 700)], text: 'The oxyhemoglobin' };
    const b = { y: 683, h: 10, items: [item('dissociation curve', 0, 683)], text: 'dissociation curve' };
    const filler = { y: 660, h: 10, items: [item('填充句。', 0, 660)], text: '填充句。' };
    const filler2 = { y: 640, h: 10, items: [item('再一句。', 0, 640)], text: '再一句。' };
    const filler3 = { y: 620, h: 10, items: [item('第三句。', 0, 620)], text: '第三句。' };
    const g = analyzeGlobals([[a, b, filler, filler2, filler3]]);
    const md = linesToMarkdown([[a, b, filler, filler2, filler3]], g);
    expect(md).toContain('The oxyhemoglobin dissociation curve');
  });
});

describe('tidyMarkdown', () => {
  it('收敛连续空行并保留结尾换行', () => {
    expect(tidyMarkdown('a\n\n\n\n\nb')).toBe('a\n\nb\n');
    expect(tidyMarkdown('  x  ')).toBe('x\n');
  });
});

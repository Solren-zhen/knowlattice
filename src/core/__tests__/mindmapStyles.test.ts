/**
 * core/mindmapStyles 单测：直角折线的几何 + 编号方案的 CSS 值。
 *
 * 为什么值得单独测：这两样都是「算错了不会报错、只会画歪/不显示」的类型——
 * 连线拐点算错顶多是线穿过节点，编号计数器写错则是一片空白，用户根本不知道哪里坏了。
 * 纯函数在这里逐字钉住输出，比在 jsdom 里看 DOM 靠谱（jsdom 没有布局引擎，量不了几何）。
 */
import { describe, expect, it } from 'vitest';
import { LINE_STYLES, NUMBERINGS, numberingVars, orthoMainBranch, orthoSubBranch, orthoPath } from '../mindmapStyles';
import { NUMBERING_IDS } from '../mindmapPrefs';

/** 一份可读的几何：父节点 (100,50) 大小 80×30，子节点 (300,120) 大小 60×24 */
const geom = { pT: 50, pL: 100, pW: 80, pH: 30, cT: 120, cL: 300, cW: 60, cH: 24 };

describe('mindmapStyles · 直角折线', () => {
  it('向右布局：父节点右缘 → 竖直中线 → 子节点左缘，先横后竖再横', () => {
    // 主分支从竖直中点出发：y1 = 50 + 15 = 65；拐点 x = 180 + (300-180)/2 = 240；y2 = 120 + 12 = 132
    expect(orthoPath({ ...geom, direction: 'rhs' }, false)).toBe('M 180 65 H 240 V 132 H 300');
  });

  it('向左布局：镜像到左侧（从父节点左缘出发，收在子节点右缘）', () => {
    // x1 = 100；x2 = 300 + 60 = 360；拐点 x = 100 + (360-100)/2 = 230
    expect(orthoPath({ ...geom, direction: 'lhs' }, false)).toBe('M 100 65 H 230 V 132 H 360');
  });

  it('子分支从父节点**下缘**出发（逻辑图里「挂下来」的那一路）', () => {
    expect(orthoPath({ ...geom, direction: 'rhs' }, true)).toBe('M 180 80 H 240 V 132 H 300');
  });

  it('纵向布局：竖 → 横 → 竖（从父节点下缘到子节点上缘，横段落在两者中点）', () => {
    // y1 = 50 + 30 = 80；y2 = 120；中点 100；x1 = 140；x2 = 330
    expect(orthoPath({ ...geom, direction: 'down' }, false)).toBe('M 140 80 V 100 H 330 V 120');
  });

  it('两个生成器分别对应主分支（中点）与子分支（下缘）', () => {
    expect(orthoMainBranch({ ...geom, direction: 'rhs' } as never)).toBe('M 180 65 H 240 V 132 H 300');
    expect(orthoSubBranch({ ...geom, direction: 'rhs' } as never)).toBe('M 180 80 H 240 V 132 H 300');
  });

  it('连线样式清单只有两项，默认那一项是曲线（与偏好默认值对齐）', () => {
    expect(LINE_STYLES.map((l) => l.id)).toEqual(['curve', 'ortho']);
  });
});

describe('mindmapStyles · 标题编号', () => {
  it('方案清单与偏好的白名单一一对应（顺序也一致，界面下拉直接照它渲染）', () => {
    expect(NUMBERINGS.map((n) => n.id)).toEqual([...NUMBERING_IDS]);
    expect(NUMBERINGS).toHaveLength(8);
  });

  it('只有「不编号」没有内容值；其余每一项都三层齐全、都是用计数器拼的', () => {
    for (const n of NUMBERINGS) {
      if (n.id === 'none') {
        expect(n.vars).toBeNull();
        continue;
      }
      expect(n.vars).toHaveLength(3);
      for (const v of n.vars!) expect(v).toContain('counter(');
    }
  });

  it('numberingVars：不编号给空对象；选中方案给三个带尾随空格的 CSS 变量', () => {
    expect(numberingVars('none')).toEqual({});
    const vars = numberingVars('dot');
    expect(Object.keys(vars)).toEqual(['--mm-num1', '--mm-num2', '--mm-num3']);
    // 值就是 CSS 的 content 语法：计数器 + 字符串，末尾补空格把编号与文字分开
    expect(vars['--mm-num1']).toBe('counter(mml1) "." " "');
    expect(vars['--mm-num3']).toContain('counter(mml3)');
    expect(vars['--mm-num3'].endsWith('" "')).toBe(true);
  });

  it('中文数字与圈码用的是 CSS 的计数器样式（cjk-ideographic / circled-decimal）', () => {
    expect(numberingVars('cn-dot')['--mm-num1']).toContain('cjk-ideographic');
    expect(numberingVars('circled')['--mm-num1']).toBe('counter(mml1, circled-decimal) " "');
    expect(numberingVars('alpha')['--mm-num1']).toContain('upper-alpha');
  });
});

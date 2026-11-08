import { describe, expect, it } from 'vitest';
import { colorToRgb } from '../knowledgeField';

describe('知识星图：主题色解析', () => {
  it('#rrggbb 与 #rgb 都能解析', () => {
    expect(colorToRgb('#4f46e5')).toEqual([79, 70, 229]);
    expect(colorToRgb('#818cf8')).toEqual([129, 140, 248]);
    expect(colorToRgb('#fff')).toEqual([255, 255, 255]);
  });

  it('rgb()/rgba() 与前后空白也能解析', () => {
    expect(colorToRgb('  rgb(34, 211, 238) ')).toEqual([34, 211, 238]);
    expect(colorToRgb('rgba(129, 140, 248, 0.5)')).toEqual([129, 140, 248]);
  });

  it('不认识的值回落到主题靛蓝，不抛错（画布渐变不能因配色缺失中断）', () => {
    expect(colorToRgb('var(--accent)')).toEqual([79, 70, 229]);
    expect(colorToRgb('')).toEqual([79, 70, 229]);
  });
});

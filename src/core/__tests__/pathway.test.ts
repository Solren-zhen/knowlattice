import { describe, it, expect } from 'vitest';
import { parsePathway, renderPathwaySvg, isPathwayLang } from '../pathway';

const SRC = `# 糖代谢总览
## EMP 糖酵解 | #d64545 | 无氧条件 · 细胞质基质
葡萄糖 -> 6-磷酸葡萄糖 : 己糖激酶
6-磷酸葡萄糖 <-> 6-磷酸果糖 : 磷酸己糖异构酶
> 关键酶：己糖激酶、PFK-1、丙酮酸激酶

## TCA 三羧酸循环 | #1c7ed6
[[丙酮酸]] -> 乙酰CoA : 丙酮酸脱氢酶系
`;

describe('parsePathway', () => {
  it('解析标题 / 分组 / 可逆箭头 / 酶名 / 旁注', () => {
    const { spec, errors } = parsePathway(SRC);
    expect(errors).toEqual([]);
    expect(spec.title).toBe('糖代谢总览');
    expect(spec.groups.map((g) => g.name)).toEqual(['EMP 糖酵解', 'TCA 三羧酸循环']);
    expect(spec.groups[0].color).toBe('#d64545');
    expect(spec.groups[0].note).toBe('无氧条件 · 细胞质基质');
    expect(spec.edges).toHaveLength(3);
    expect(spec.edges[0]).toMatchObject({
      from: '葡萄糖',
      to: '6-磷酸葡萄糖',
      label: '己糖激酶',
      reversible: false,
    });
    expect(spec.edges[1].reversible).toBe(true);
    expect(spec.notes[0].text).toContain('PFK-1');
  });

  it('[[目标]] 节点记为可点击链接', () => {
    const { spec } = parsePathway(SRC);
    const node = spec.nodes.find((n) => n.key === '丙酮酸')!;
    expect(node.link).toEqual({ target: '丙酮酸', label: '丙酮酸' });
  });

  it('[[目标|别名]] 用别名显示、目标跳转', () => {
    const { spec } = parsePathway('[[糖酵解|EMP]] -> 丙酮酸');
    expect(spec.nodes[0]).toMatchObject({ label: 'EMP', link: { target: '糖酵解', label: 'EMP' } });
  });

  it('同一节点在别的分组被引用时保留首次所属分组（跨泳道连线）', () => {
    const { spec } = parsePathway('## A\nX -> Y\n## B\nY -> Z');
    expect(spec.nodes.find((n) => n.key === 'Y')!.group).toBe('g0');
    expect(spec.edges[1]).toMatchObject({ from: 'Y', to: 'Z', group: 'g1' });
  });

  it('缺省颜色按调色板补齐', () => {
    const { spec } = parsePathway('## 通路\nA -> B');
    expect(spec.groups[0].color).toMatch(/^#/);
  });

  it('坏行收集为错误但不中断其余通路', () => {
    const { spec, errors } = parsePathway('A -> B\n这不是一行通路');
    expect(errors).toHaveLength(1);
    expect(spec.edges).toHaveLength(1);
  });
});

describe('renderPathwaySvg', () => {
  it('输出 SVG 且含分组名、节点、酶名、色值与箭头', () => {
    const svg = renderPathwaySvg(SRC);
    expect(svg).toContain('<svg');
    expect(svg).toContain('EMP 糖酵解');
    expect(svg).toContain('6-磷酸葡萄糖');
    expect(svg).toContain('己糖激酶');
    expect(svg).toContain('#d64545');
    expect(svg).toContain('marker-start');
  });

  it('wikilink 节点同时带 data-lp-target（编辑器）与 data-mv-target（预览）', () => {
    const svg = renderPathwaySvg(SRC);
    expect(svg).toContain('data-lp-target="丙酮酸"');
    expect(svg).toContain('data-mv-target="丙酮酸"');
  });

  it('转义用户文本，不产生原始 HTML', () => {
    const svg = renderPathwaySvg('## <script>\nA <x> -> B : e<b>');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('e&lt;b&gt;');
  });

  it('空内容或没有通路时给出错误块', () => {
    expect(renderPathwaySvg('')).toContain('pw-error');
    expect(renderPathwaySvg('## 只有分组')).toContain('pw-error');
  });

  it('同泳道跨行连线绕开中间节点（用曲线而非穿过节点的直线）', () => {
    const svg = renderPathwaySvg('A -> B\nB -> C\nA -> C : 跨行');
    const paths = svg.match(/<path d="[^"]*"/g) ?? [];
    expect(paths.some((d) => d.includes(' C'))).toBe(true);
    expect(svg).toContain('跨行');
  });

  it('一个节点的多个产物并排成子分支，母节点留在上方中央', () => {
    const svg = renderPathwaySvg('丙酮酸 -> 乳酸\n丙酮酸 -> 乙酰CoA');
    const at = (key: string) => {
      const m = new RegExp(`data-pw-key="${key}" data-pw-x="([^"]+)" data-pw-y="([^"]+)"`).exec(svg);
      return { x: Number(m?.[1]), y: Number(m?.[2]) };
    };
    const parent = at('丙酮酸');
    const left = at('乳酸');
    const right = at('乙酰CoA');
    expect(parent.y).toBeLessThan(left.y);
    expect(left.y).toBe(right.y);
    expect(left.x).toBeLessThan(parent.x);
    expect(right.x).toBeGreaterThan(parent.x);
  });

  it('默认按流向分层：产物排在来源下方', () => {
    const svg = renderPathwaySvg('起点 -> 中间\n中间 -> 产物');
    const read = (key: string) => Number(new RegExp(`data-pw-key="${key}" data-pw-x="[^"]+" data-pw-y="([^"]+)"`).exec(svg)?.[1]);
    expect(read('起点')).toBeLessThan(read('中间'));
    expect(read('中间')).toBeLessThan(read('产物'));
  });

  it('同一对节点的两条边分列两侧，标签不再叠在同一点', () => {
    const svg = renderPathwaySvg('A -> B : 己糖激酶\nB -> A : 反馈抑制');
    const labels = [...svg.matchAll(/class="pw-enzyme pw-edge-label" x="([^"]+)" y="([^"]+)"/g)]
      .map((m) => `${m[1]},${m[2]}`);
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
  });

  it('箭头线使用可见样式，且同一节点的多条边分别生成', () => {
    const svg = renderPathwaySvg('A -> B : 第一条\nA -> C : 第二条\nB -> D');
    expect(svg).toContain('class="pw-edge"');
    expect(svg).toContain('marker-end=');
    expect((svg.match(/class="pw-edge"/g) ?? []).length).toBe(3);
  });

  it('长旁注在泳道宽度内折行，不越界', () => {
    const long = '这是一条很长的旁注说明文字应当在泳道内自动折行显示而不是溢出到相邻泳道里';
    const svg = renderPathwaySvg(`A -> B\n> ${long}`);
    const noteLines = svg.match(/<text class="pw-note"[^>]*>([^<]*)</g) ?? [];
    expect(noteLines.length).toBeGreaterThan(1);
    for (const line of noteLines) expect(line.length).toBeLessThan(long.length + 40);
  });

  it('filter id 由源码派生：同源码稳定（可缓存），异源码互不冲突', () => {
    const a1 = renderPathwaySvg('A -> B');
    const a2 = renderPathwaySvg('A -> B');
    const b = renderPathwaySvg('A -> C');
    const id = (s: string) => /filter id="([^"]+)"/.exec(s)![1];
    expect(a1).toBe(a2);
    expect(id(a1)).toBe(id(a2));
    expect(id(b)).not.toBe(id(a1));
  });

  it('泳道标题带 --pw-gc（供 CSS 按主题混合到可读对比度）', () => {
    expect(renderPathwaySvg(SRC)).toContain('--pw-gc:#d64545');
  });

  // ---------- 手动定位（@ 节点 | x | y，通路工作区拖拽/微调的落点） ----------

  it('手动定位的节点钉在指定坐标，其余节点照常按流向分层', () => {
    const svg = renderPathwaySvg('A -> B\n@ C | 300 | 200');
    const at = (key: string) => {
      const m = new RegExp(`data-pw-key="${key}" data-pw-x="([^"]+)" data-pw-y="([^"]+)"`).exec(svg);
      return { x: Number(m?.[1]), y: Number(m?.[2]) };
    };
    expect(at('C')).toEqual({ x: 300, y: 200 });
    expect(at('A').y).toBeLessThan(at('B').y);
  });

  it('手动与自动节点混排时连线照常生成（两端各自取位置）', () => {
    const svg = renderPathwaySvg('A -> C\n@ C | 260 | 180');
    expect((svg.match(/class="pw-edge"/g) ?? []).length).toBe(1);
    expect(svg).toContain('data-pw-key="C" data-pw-x="260"');
  });

  it('负坐标/越界坐标夹到可见区，viewBox 不会把节点裁掉', () => {
    const svg = renderPathwaySvg('A -> B\n@ C | -50 | -50');
    const y = Number(new RegExp('data-pw-key="C" data-pw-x="[^"]+" data-pw-y="([^"]+)"').exec(svg)?.[1]);
    expect(y).toBeGreaterThanOrEqual(60);
  });

  it('去掉 @ 坐标后回到自动分层位置（撤销拖拽的渲染侧表现）', () => {
    const pinned = renderPathwaySvg('A -> B\nC -> B\n@ C | 300 | 300');
    const unpinned = renderPathwaySvg('A -> B\nC -> B');
    const y = (s: string, key: string) => Number(new RegExp(`data-pw-key="${key}" data-pw-x="[^"]+" data-pw-y="([^"]+)"`).exec(s)?.[1]);
    expect(y(pinned, 'C')).toBe(300);
    expect(y(unpinned, 'C')).toBeLessThan(300); // 回到来源层
  });
});

describe('isPathwayLang', () => {
  it('识别 pathway / biochem，不放行普通语言', () => {
    expect(isPathwayLang('pathway')).toBe(true);
    expect(isPathwayLang('biochem')).toBe(true);
    expect(isPathwayLang('js')).toBe(false);
  });
});

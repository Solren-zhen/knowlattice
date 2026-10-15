/**
 * core/mindmapMarks 单测：关系线/概要的校验、存储、以及「文本路径 ↔ 库节点 id」的来回换算。
 *
 * 这些必须逐条钉住的原因：标记是「下次打开还要画回正确位置」的东西。
 * 换算错一点，线就画到别的节点上；校验松一点，脏值会写进 localStorage 并在每次打开时重放。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MARK_KEY,
  clearNoteMarks,
  exportMarks,
  getNoteMarks,
  importMarks,
  indexByKey,
  keyIndex,
  keyOfId,
  loadMarks,
  renameNodeMark,
  resolveMarks,
  sanitizeArrow,
  sanitizeNoteMarks,
  sanitizeSummary,
  serializeMarks,
  setNoteMarks,
  type MarkNode,
} from '../mindmapMarks';
import { nodePathKey } from '../mindmapNodeStyles';

const NOTE = '01-生理学/呼吸/波尔效应.md';
const A = nodePathKey(['波尔效应'], '机制');
const B = nodePathKey(['波尔效应'], '表现');

const raw = () => JSON.parse(localStorage.getItem(MARK_KEY) ?? '{}') as Record<string, unknown>;

beforeEach(() => {
  localStorage.clear();
  loadMarks(); // 清空后强制重读一次，用例之间不串缓存
});

describe('mindmapMarks · 校验', () => {
  it('关系线：两端必填且不能是同一个节点；标签限长；样式只留白名单', () => {
    expect(sanitizeArrow({ from: A, to: B })).toEqual({ from: A, to: B });
    expect(sanitizeArrow({ from: A, to: A })).toBeNull();
    expect(sanitizeArrow({ from: A })).toBeNull();
    expect(sanitizeArrow({ from: A, to: B, label: 'x'.repeat(200) })).toEqual({ from: A, to: B }); // 超长标签被丢，端点留着

    const withStyle = sanitizeArrow({
      from: A, to: B, bidirectional: true,
      style: { stroke: '#dc2626', strokeDasharray: '4 2', strokeWidth: 2, opacity: 0.5, labelColor: '#2563eb', 乱入: 'x' },
    });
    expect(withStyle).toEqual({
      from: A, to: B, bidirectional: true,
      style: { stroke: '#dc2626', strokeDasharray: '4 2', strokeWidth: 2, opacity: 0.5, labelColor: '#2563eb' },
    });
    // 非法的样式值一律丢，但端点仍保留
    expect(sanitizeArrow({ from: A, to: B, style: { stroke: 'red; }', opacity: 5 } })).toEqual({ from: A, to: B });
  });

  it('概要：父节点必填，start/end 必须是整数且 end ≥ start', () => {
    expect(sanitizeSummary({ parent: A, start: 0, end: 2 })).toEqual({ parent: A, start: 0, end: 2 });
    expect(sanitizeSummary({ parent: A, start: 2, end: 1 })).toBeNull();
    expect(sanitizeSummary({ parent: A, start: -1, end: 1 })).toBeNull();
    expect(sanitizeSummary({ parent: A, start: 0.5, end: 1 })).toBeNull();
    expect(sanitizeSummary({ start: 0, end: 1 })).toBeNull();
  });

  it('整篇：逐条过滤；一条都不剩 → null（不留空壳）', () => {
    expect(sanitizeNoteMarks({ arrows: [{ from: A, to: B }, { from: A, to: A }], summaries: [{ parent: A, start: 0, end: 1 }] }))
      .toEqual({ arrows: [{ from: A, to: B }], summaries: [{ parent: A, start: 0, end: 1 }] });
    expect(sanitizeNoteMarks({ arrows: [], summaries: [] })).toBeNull();
    expect(sanitizeNoteMarks('nope')).toBeNull();
  });
});

describe('mindmapMarks · 存取', () => {
  it('写入 → 读出（副本语义）；清空 → 键一起删', () => {
    setNoteMarks(NOTE, { arrows: [{ from: A, to: B, label: '因为' }] });
    const got = getNoteMarks(NOTE);
    expect(got).toEqual({ arrows: [{ from: A, to: B, label: '因为' }] });
    got.arrows![0].label = '改了';
    expect(getNoteMarks(NOTE).arrows![0].label).toBe('因为'); // 缓存没被污染
    expect(raw()[NOTE]).toEqual({ arrows: [{ from: A, to: B, label: '因为' }] });

    clearNoteMarks(NOTE);
    expect(getNoteMarks(NOTE)).toEqual({});
    expect(raw()[NOTE]).toBeUndefined();
  });

  it('导出→导入（同笔记整份覆盖，没提到的原样留着）；脏值/空值不导入', () => {
    setNoteMarks(NOTE, { arrows: [{ from: A, to: B }] });
    expect(exportMarks()[NOTE]).toEqual({ arrows: [{ from: A, to: B }] });

    const n = importMarks({
      [NOTE]: { arrows: [{ from: A, to: B, label: '新' }] },
      '另一篇.md': { summaries: [{ parent: A, start: 0, end: 1 }] },
      '脏的.md': { arrows: [{ from: A, to: A }] },
      '空的.md': {},
    });
    expect(n).toBe(2);
    expect(getNoteMarks(NOTE)).toEqual({ arrows: [{ from: A, to: B, label: '新' }] });
    expect(getNoteMarks('另一篇.md').summaries).toHaveLength(1);
    expect(getNoteMarks('脏的.md')).toEqual({});
    expect(getNoteMarks('空的.md')).toEqual({});
  });

  it('存储被写脏（坏 JSON）时当空表，不抛错', () => {
    localStorage.setItem(MARK_KEY, '{ 坏掉的 JSON');
    expect(loadMarks()).toEqual({});
  });
});

describe('mindmapMarks · 文本路径 ↔ 库节点 id', () => {
  const tree: MarkNode = {
    id: 'root',
    topic: '波尔效应',
    children: [
      { id: 'n1', topic: '机制', children: [{ id: 'n11', topic: '二氧化碳升高' }] },
      { id: 'n2', topic: '表现' },
    ],
  };

  it('indexByKey / keyOfId 互为反函数', () => {
    const byKey = indexByKey(tree);
    expect(byKey.get(A)).toBe('n1');
    expect(byKey.get(nodePathKey(['波尔效应', '机制'], '二氧化碳升高'))).toBe('n11');
    expect(keyOfId(tree, 'n11')).toBe(nodePathKey(['波尔效应', '机制'], '二氧化碳升高'));
    expect(keyOfId(tree, '不存在')).toBeNull();
    expect(keyOfId(null, 'n1')).toBeNull();
  });

  it('keyIndex：整表反查与逐个 keyOfId 完全一致，且不漏掉任何有 id 的节点', () => {
    // 多层 + 多分支：深到第 4 层，兄弟分支与「无 id 的中间层」都要能正确累积祖先路径
    const deep: MarkNode = {
      id: 'r',
      topic: '呼吸',
      children: [
        { topic: '无 id 的中间层', children: [{ id: 'g1', topic: '气体运输', children: [{ id: 'g11', topic: '氧解离曲线' }] }] },
        { id: 'n2', topic: '调节', children: [{ id: 'n21', topic: '化学感受器' }] },
        { id: 'n3', topic: '表现' },
      ],
    };
    const byId = keyIndex(deep);
    const ids: string[] = [];
    const collect = (n: MarkNode) => {
      if (n.id) ids.push(n.id);
      for (const c of n.children ?? []) collect(c);
    };
    collect(deep);
    // 覆盖：有 id 的节点一个不少、没有 id 的不进表
    expect([...byId.keys()].sort()).toEqual([...ids].sort());
    // 反表：每个键值都必须与逐个 keyOfId 算出来的完全相同（这就是「能直接替换」的验收）
    for (const [id, key] of byId) expect(key).toBe(keyOfId(deep, id));
    expect(byId.get('不存在')).toBeUndefined();
    // 深层的值必须是完整祖先链（与 indexByKey 正好反着对得上）
    expect(byId.get('g11')).toBe(nodePathKey(['呼吸', '无 id 的中间层', '气体运输'], '氧解离曲线'));
    expect(indexByKey(deep).get(byId.get('g11')!)).toBe('g11');
  });

  it('serializeMarks：把库的 id 换成文本路径；解析不出路径的条目直接丢', () => {
    const marks = serializeMarks(
      { arrows: [{ from: 'n1', to: 'n2', label: '因为' }, { from: 'n1', to: '幽灵' }], summaries: [{ parent: 'root', start: 0, end: 1 }] },
      (id) => keyOfId(tree, id),
    );
    expect(marks).toEqual({ arrows: [{ from: A, to: B, label: '因为' }], summaries: [{ parent: '波尔效应', start: 0, end: 1 }] });
  });

  it('resolveMarks：把文本路径换回 id；端点/父节点找不到就跳过（绝不猜别的节点）', () => {
    const out = resolveMarks(tree, {
      arrows: [{ from: A, to: B }, { from: A, to: nodePathKey([], '不存在的节点') }],
      summaries: [{ parent: '波尔效应', start: 0, end: 1 }, { parent: '幽灵父节点', start: 0, end: 1 }],
    });
    expect(out.arrows).toEqual([{ from: 'n1', to: 'n2' }]);
    expect(out.summaries).toEqual([{ parent: 'root', start: 0, end: 1 }]);
  });
});

describe('mindmapMarks · 节点改名后的迁移（renameNodeMark）', () => {
  /** 改名前的「机制 → 二氧化碳升高」这条路：祖先改名后整条前缀都要变 */
  const GRAND = nodePathKey(['波尔效应', '机制'], '二氧化碳升高');

  it('端点自己改名：键跟着搬，标签与样式一起留着', () => {
    setNoteMarks(NOTE, {
      arrows: [{ from: A, to: B, label: '因为', bidirectional: true, style: { stroke: '#dc2626' } }],
    });
    const renamed = nodePathKey(['波尔效应'], '机制（通气）');
    renameNodeMark(NOTE, A, renamed);
    expect(getNoteMarks(NOTE).arrows).toEqual([
      { from: renamed, to: B, label: '因为', bidirectional: true, style: { stroke: '#dc2626' } },
    ]);
  });

  it('祖先改名：整棵子树的键一起重写前缀；与这次改名无关的键一个都不动', () => {
    setNoteMarks(NOTE, {
      // 第 1 条两端都在被改名的那棵子树下（祖先一改，两个端点都要跟着走）；
      // 第 2 条在别的分支上：用它证明不是「整表重写」，而是按前缀挑着改。
      arrows: [
        { from: GRAND, to: B },
        { from: '别的根\u0000节点', to: '抓住' },
      ],
      summaries: [{ parent: A, start: 0, end: 1 }],
    });
    renameNodeMark(NOTE, '波尔效应', '呼吸调节');
    expect(getNoteMarks(NOTE)).toEqual({
      arrows: [
        { from: nodePathKey(['呼吸调节', '机制'], '二氧化碳升高'), to: nodePathKey(['呼吸调节'], '表现') },
        { from: '别的根\u0000节点', to: '抓住' },
      ],
      summaries: [{ parent: nodePathKey(['呼吸调节'], '机制'), start: 0, end: 1 }],
    });
  });

  it('改成和另一个已有节点同名（两端搬到同一个键）：那条线丢掉；线全丢时连笔记的键一起删', () => {
    setNoteMarks(NOTE, { arrows: [{ from: A, to: B }] });
    renameNodeMark(NOTE, A, B);
    expect(getNoteMarks(NOTE)).toEqual({});
    expect(raw()[NOTE]).toBeUndefined();
  });

  it('没标记 / 名字没变 / 路径为空：原样返回且一个字都不写', () => {
    const before = localStorage.getItem(MARK_KEY);
    expect(renameNodeMark(NOTE, A, A)).toEqual({});
    expect(renameNodeMark('没标记的.md', A, nodePathKey([], '新名字'))).toEqual({});
    expect(renameNodeMark('', A, nodePathKey([], '新名字'))).toEqual({});
    expect(localStorage.getItem(MARK_KEY)).toBe(before);
  });

  it('只动这一篇：别的笔记的标记原样留着', () => {
    const OTHER = '02-药理学/某药.md';
    setNoteMarks(NOTE, { arrows: [{ from: A, to: B }] });
    setNoteMarks(OTHER, { arrows: [{ from: A, to: B }] });
    renameNodeMark(NOTE, A, nodePathKey([], '机制（通气）'));
    expect(getNoteMarks(OTHER).arrows).toEqual([{ from: A, to: B }]);
  });
});


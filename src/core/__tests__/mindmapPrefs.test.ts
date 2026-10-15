/**
 * 思维导图呈现偏好（core/mindmapPrefs.ts）：默认值、按字段合并、空值删键、副本语义、
 * 脏值兜底、导出/导入、按笔记隔离。
 *
 * 存法对齐 core/noteMedia（单键 localStorage + 按原始字符串比对的模块级缓存），
 * 所以这里专门守两条最容易坏的行为：
 *   ① 外部直接写存储后，缓存要自己失效；
 *   ② **脏值不能把导图弄坏**——读到的值不在白名单里就回默认值，而不是原样带出去。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DIRECTION_IDS,
  LINE_IDS,
  MINDMAP_DEFAULTS,
  NUMBERING_IDS,
  THEME_IDS,
  VIEW_IDS,
  clearMindMapPref,
  exportMindMapPrefs,
  getMindMapPref,
  importMindMapPrefs,
  loadMindMapPrefs,
  resolveMindMapPref,
  saveMindMapPref,
} from '../mindmapPrefs';

const KEY = 'knowlattice-mindmap-prefs';
const A = '07-生理学/呼吸/氧解离曲线.md';
const B = '07-生理学/呼吸/波尔效应.md';

beforeEach(() => {
  localStorage.clear();
  loadMindMapPrefs(); // 清空存储后强制模块缓存重读一次，用例之间不串
});

const raw = (): Record<string, unknown> =>
  JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;

describe('mindmapPrefs · 默认值', () => {
  it('没存过 = 改动前的观感：双向展开 + 跟随应用 + 导图视图 + 曲线连线 + 不编号', () => {
    expect(MINDMAP_DEFAULTS).toEqual({
      direction: 'side', theme: 'follow', view: 'map', line: 'curve', numbering: 'none',
    });
    expect(getMindMapPref(A)).toBeNull();
    expect(loadMindMapPrefs()).toEqual({});
    expect(resolveMindMapPref(A)).toEqual(MINDMAP_DEFAULTS);
  });

  it('只存了一项时，其余字段补默认值', () => {
    saveMindMapPref(A, { theme: 'eye' });
    expect(getMindMapPref(A)).toEqual({ theme: 'eye' });
    expect(resolveMindMapPref(A)).toEqual({
      ...MINDMAP_DEFAULTS, theme: 'eye',
    });
  });

  it('白名单就是界面上的那几项（数量对不上说明清单被改过）', () => {
    expect(DIRECTION_IDS).toEqual(['side', 'right', 'down', 'left']);
    expect(THEME_IDS).toEqual(['follow', 'warm', 'eye', 'plain']);
    expect(VIEW_IDS).toEqual(['map', 'outline']);
    expect(LINE_IDS).toEqual(['curve', 'ortho']);
    expect(NUMBERING_IDS).toEqual(['none', 'dot', 'comma', 'paren', 'cn-dot', 'cn-paren', 'alpha', 'circled']);
  });

  it('已删除的「经典圆弧」（classic）映射到「暖阳纸页」（warm）：老笔记的选择不被静默重置', () => {
    localStorage.setItem(KEY, JSON.stringify({ [A]: { theme: 'classic' } }));
    expect(getMindMapPref(A)).toEqual({ theme: 'warm' });
    expect(resolveMindMapPref(A)).toEqual({ ...MINDMAP_DEFAULTS, theme: 'warm' });
    // 别名表只认被删掉的那一个，不是「什么脏值都收」
    localStorage.setItem(KEY, JSON.stringify({ [A]: { theme: 'rainbow' } }));
    expect(resolveMindMapPref(A).theme).toBe('follow');
  });

  it('新增的两轴（连线 / 编号）也走白名单与 patch 合并：脏值不写入，只改一项不重置另一项', () => {
    saveMindMapPref(A, { line: 'ortho', numbering: 'cn-dot' });
    expect(getMindMapPref(A)).toEqual({ line: 'ortho', numbering: 'cn-dot' });
    // 只改连线：编号原样留着
    saveMindMapPref(A, { line: 'curve' });
    expect(getMindMapPref(A)).toEqual({ line: 'curve', numbering: 'cn-dot' });
    // 认不得的值一律当没给：这一项写不进去，其余项留着（与既有 theme / direction 同一套规则）
    saveMindMapPref(A, { numbering: 'rainbow' as never });
    expect(getMindMapPref(A)).toEqual({ line: 'curve' });
    // '' 清掉单项 → 回默认；两项都清空 → 整条记录删掉（不留空壳）
    saveMindMapPref(A, { numbering: '', line: '' });
    expect(getMindMapPref(A)).toBeNull();
  });
});

describe('mindmapPrefs · 存取与合并', () => {
  it('存取往返：save → get / load / export / 存储原文一致', () => {
    saveMindMapPref(A, { direction: 'right', theme: 'eye', view: 'outline' });
    const want = { direction: 'right', theme: 'eye', view: 'outline' };
    expect(getMindMapPref(A)).toEqual(want);
    expect(loadMindMapPrefs()).toEqual({ [A]: want });
    expect(exportMindMapPrefs()).toEqual({ [A]: want });
    expect(raw()[A]).toEqual(want);
  });

  it('patch 逐字段合并：只改主题不会把布局/视图重置', () => {
    saveMindMapPref(A, { direction: 'down', view: 'outline' });
    saveMindMapPref(A, { theme: 'plain' });
    expect(getMindMapPref(A)).toEqual({ direction: 'down', theme: 'plain', view: 'outline' });
    saveMindMapPref(A, { direction: 'left' });
    expect(getMindMapPref(A)).toEqual({ direction: 'left', theme: 'plain', view: 'outline' });
  });

  it('save 每次返回新对象（视图放进 state 才会重渲染）', () => {
    const a = saveMindMapPref(A, { direction: 'right' });
    const b = saveMindMapPref(A, { direction: 'right' });
    expect(a).not.toBe(b);
  });

  it('路径首尾空白裁掉：存取用的是同一个键', () => {
    saveMindMapPref(`  ${A}  `, { theme: 'eye' });
    expect(getMindMapPref(A)).toEqual({ theme: 'eye' });
    expect(raw()[`  ${A}  `]).toBeUndefined();
  });

  it('路径为空就不写存储（不攒 "" 这种野键）', () => {
    expect(saveMindMapPref('   ', { theme: 'eye' })).toEqual({});
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('mindmapPrefs · 空值与删键', () => {
  it("'' 清掉单项 → 回默认，其余字段留着", () => {
    saveMindMapPref(A, { direction: 'right', theme: 'plain' });
    saveMindMapPref(A, { theme: '' });
    expect(getMindMapPref(A)).toEqual({ direction: 'right' });
    expect(resolveMindMapPref(A)).toEqual({ ...MINDMAP_DEFAULTS, direction: 'right' });
  });

  it('三项都清空 → 整条记录删掉（不留空壳）', () => {
    saveMindMapPref(A, { direction: 'right', theme: 'plain', view: 'outline' });
    const map = saveMindMapPref(A, { direction: '', theme: '', view: '' });
    expect(map[A]).toBeUndefined();
    expect(getMindMapPref(A)).toBeNull();
    expect(localStorage.getItem(KEY)).toBe('{}');
  });

  it('clearMindMapPref 只摘这一篇，别的笔记留着；清不存在的键不报错', () => {
    saveMindMapPref(A, { direction: 'right' });
    saveMindMapPref(B, { theme: 'eye' });
    expect(clearMindMapPref(A)).toEqual({ [B]: { theme: 'eye' } });
    expect(localStorage.getItem(KEY)).not.toContain('right');
    expect(clearMindMapPref('从没打开过.md')).toEqual({ [B]: { theme: 'eye' } });
  });
});

describe('mindmapPrefs · 副本语义', () => {
  it('getMindMapPref 返回副本：改它不会污染缓存', () => {
    saveMindMapPref(A, { theme: 'eye' });
    const p = getMindMapPref(A)!;
    p.theme = 'plain';
    expect(getMindMapPref(A)).toEqual({ theme: 'eye' });
  });

  it('exportMindMapPrefs 返回快照：改它不影响存储', () => {
    saveMindMapPref(A, { theme: 'eye' });
    const snap = exportMindMapPrefs();
    snap[A].theme = 'plain';
    snap[B] = { view: 'outline' };
    expect(getMindMapPref(A)).toEqual({ theme: 'eye' });
    expect(getMindMapPref(B)).toBeNull();
  });

  it('loadMindMapPrefs 返回缓存本身（内部使用），但存进去的值是冻结语义的普通对象', () => {
    // 这里只钉「两次读同一份存储拿到同一个引用」——视图每次渲染都会读，
    // 每次 new 一份对象会让下游 useMemo 永远失效。
    saveMindMapPref(A, { theme: 'eye' });
    expect(loadMindMapPrefs()).toBe(loadMindMapPrefs());
  });
});

describe('mindmapPrefs · 脏值兜底', () => {
  it('存储里的脏值被丢掉：认不得的方向/主题/视图一律回默认', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        [A]: { direction: 'diagonal', theme: 'rainbow', view: 'map' },
        [B]: { direction: 3, theme: null, view: 'fullscreen' },
      })
    );
    // 一项都不认得的记录整条不留（[B] 三项都脏）
    expect(loadMindMapPrefs()).toEqual({ [A]: { view: 'map' } });
    expect(resolveMindMapPref(A)).toEqual(MINDMAP_DEFAULTS);
    expect(resolveMindMapPref(B)).toEqual(MINDMAP_DEFAULTS);
  });

  it('脏 patch 当没给：不会把脏值写进存储，原值也不动', () => {
    saveMindMapPref(A, { direction: 'right' });
    // 走 any 模拟「旧版本/手改的存储」传进来的非法值
    saveMindMapPref(A, { theme: 'rainbow' } as never);
    expect(getMindMapPref(A)).toEqual({ direction: 'right' });
    // 未知键也不落盘
    saveMindMapPref(A, { zoom: 3 } as never);
    expect(getMindMapPref(A)).toEqual({ direction: 'right' });
  });

  it('坏 JSON / 存储被清空：当空表，不抛错', () => {
    saveMindMapPref(A, { theme: 'eye' });
    localStorage.clear();
    expect(loadMindMapPrefs()).toEqual({});
    localStorage.setItem(KEY, '{oops');
    expect(loadMindMapPrefs()).toEqual({});
    expect(getMindMapPref(A)).toBeNull();
    expect(resolveMindMapPref(A)).toEqual(MINDMAP_DEFAULTS);
  });

  it('外部直接写存储后，下一次读自动失效重解析（另一个标签页/备份导入）', () => {
    saveMindMapPref(A, { theme: 'eye' });
    expect(getMindMapPref(A)).toEqual({ theme: 'eye' });
    // 外部写入的必须是**另一个**合法值：若前后同值，这条用例在缓存没失效时也会绿（判定力为零）
    localStorage.setItem(KEY, JSON.stringify({ [A]: { theme: 'plain' } }));
    expect(getMindMapPref(A)).toEqual({ theme: 'plain' });
  });

  it('按笔记隔离：两篇笔记各存各的', () => {
    saveMindMapPref(A, { direction: 'down' });
    saveMindMapPref(B, { direction: 'left', view: 'outline' });
    expect(getMindMapPref(A)).toEqual({ direction: 'down' });
    expect(getMindMapPref(B)).toEqual({ direction: 'left', view: 'outline' });
    expect(resolveMindMapPref(A)).toEqual({ ...MINDMAP_DEFAULTS, direction: 'down' });
  });
});

describe('mindmapPrefs · importMindMapPrefs', () => {
  it('合并导入：同键覆盖、没提到的键留着，返回导入条数', () => {
    saveMindMapPref(A, { direction: 'right' });
    const n = importMindMapPrefs({
      [A]: { theme: 'plain' },
      [B]: { direction: 'down', view: 'outline' },
      'c.md': { theme: 'rainbow' }, // 脏值，不导入
      'd.md': { direction: '', theme: '' }, // 空壳，不导入
    });
    expect(n).toBe(2);
    expect(loadMindMapPrefs()).toEqual({
      [A]: { theme: 'plain' },
      [B]: { direction: 'down', view: 'outline' },
    });
  });

  it('非法输入一条都不导入，也不动已存数据', () => {
    saveMindMapPref(A, { theme: 'eye' });
    expect(importMindMapPrefs(null)).toBe(0);
    expect(importMindMapPrefs(undefined)).toBe(0);
    expect(importMindMapPrefs('{}')).toBe(0); // 备份里字段缺失/类型不对
    expect(importMindMapPrefs({ 'x.md': 3, 'y.md': { theme: 7 }, 'z.md': null })).toBe(0);
    expect(loadMindMapPrefs()).toEqual({ [A]: { theme: 'eye' } });
  });

  it('导出→导入往返：换一份存储后能原样恢复', () => {
    saveMindMapPref(A, { direction: 'left', theme: 'eye', view: 'outline' });
    const snap = exportMindMapPrefs();
    localStorage.clear();
    loadMindMapPrefs();
    expect(loadMindMapPrefs()).toEqual({});
    expect(importMindMapPrefs(snap)).toBe(1);
    expect(resolveMindMapPref(A)).toEqual({ ...MINDMAP_DEFAULTS, direction: 'left', theme: 'eye', view: 'outline' });
  });
});

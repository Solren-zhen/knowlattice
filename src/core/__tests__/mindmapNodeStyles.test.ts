/**
 * core/mindmapNodeStyles 单测：节点样式的白名单、存储语义、树上的贴回。
 *
 * 为什么这些必须逐条钉住：样式是「存下来下次还要贴回正确节点」的东西，
 * 白名单松一点会把脏值写进存储（下次渲染出一个诡异的节点），
 * 键的规则错一点会把样式贴到**别的节点**上——比丢样式严重得多。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  NODE_STYLE_KEY,
  applyStoredStyles,
  clearNoteStyles,
  collectNodeKeys,
  exportNoteStyles,
  getNoteStyles,
  importNoteStyles,
  keyParts,
  loadNoteStyles,
  mergeStyle,
  nodePathKey,
  pruneNoteStyles,
  renameNodeStyle,
  sanitizeStyle,
  setNodeStyle,
  type StylableNode,
} from '../mindmapNodeStyles';

const NOTE = '01-生理学/呼吸/波尔效应.md';

const raw = () => JSON.parse(localStorage.getItem(NODE_STYLE_KEY) ?? '{}') as Record<string, unknown>;

beforeEach(() => {
  localStorage.clear();
  loadNoteStyles(); // 清空后强制重读，用例之间不串缓存
});

describe('mindmapNodeStyles · 白名单', () => {
  it('只留认得的键与合法的值，认不得的一律丢', () => {
    expect(sanitizeStyle({ fontSize: '16px', fontWeight: 'bold', fontStyle: 'italic', textAlign: 'center', borderRadius: '12px' }))
      .toEqual({ fontSize: '16px', fontWeight: 'bold', fontStyle: 'italic', textAlign: 'center', borderRadius: '12px' });
    // 非法值 / 未知键 / 非字符串
    expect(sanitizeStyle({ fontSize: 'big', fontWeight: '9000', color: 'red; }', textAlign: 'justify', nope: 'x', color2: 12 })).toBeNull();
    // 一个都不剩 = 没设过
    expect(sanitizeStyle({})).toBeNull();
    expect(sanitizeStyle(null)).toBeNull();
  });

  it('颜色允许 hex / rgb / var(--token)；边框同理', () => {
    expect(sanitizeStyle({ color: '#c026d3', background: 'rgb(12, 34, 56)', border: '1px solid var(--border)' }))
      .toEqual({ color: '#c026d3', background: 'rgb(12, 34, 56)', border: '1px solid var(--border)' });
  });

  it('mergeStyle：给值＝覆盖，给 null＝清掉这一项，其余留着；清空后返回 null', () => {
    const base = { fontSize: '16px', color: '#c026d3' };
    expect(mergeStyle(base, { color: null })).toEqual({ fontSize: '16px' });
    expect(mergeStyle(base, { fontSize: '20px' })).toEqual({ fontSize: '20px', color: '#c026d3' });
    expect(mergeStyle(base, { fontSize: 'nope' })).toEqual(base); // 脏值当没给
    expect(mergeStyle(base, { fontSize: null, color: null })).toBeNull();
  });
});

describe('mindmapNodeStyles · 节点键（文本路径）', () => {
  it('祖先主题依次相接 + 自己；分隔符用控制字符，主题里不会出现', () => {
    const key = nodePathKey(['波尔效应', '机制'], '二氧化碳升高');
    expect(key).toBe('波尔效应\u0000机制\u0000二氧化碳升高');
    expect(keyParts(key)).toEqual(['波尔效应', '机制', '二氧化碳升高']);
    // 不同层级结构 → 不同键（正常文本下不会撞）
    expect(nodePathKey(['波尔效应'], '机制')).not.toBe(nodePathKey(['波尔效应', '机制'], '体温升高'));
    // 前提假设（与 vault.ts 的路径签名同一条）：主题文字里不含 U+0000——
    // 这个控制字符在 Markdown 文本里敲不出来，所以不做转义。
  });

  it('collectNodeKeys 走全树（含根），键与 applyStoredStyles 用的完全一致', () => {
    const tree: StylableNode = {
      topic: '根',
      children: [{ topic: '甲', children: [{ topic: '甲一' }] }, { topic: '乙' }],
    };
    expect(collectNodeKeys(tree)).toEqual([
      nodePathKey([], '根'),
      nodePathKey(['根'], '甲'),
      nodePathKey(['根', '甲'], '甲一'),
      nodePathKey(['根'], '乙'),
    ]);
  });

  it('applyStoredStyles 只给存过的节点贴样式（其余保持 undefined = 主题默认）', () => {
    const tree: StylableNode = { topic: '根', children: [{ topic: '甲' }, { topic: '乙' }] };
    const styles = { [nodePathKey(['根'], '乙')]: { fontWeight: 'bold' } };
    expect(applyStoredStyles(tree, styles)).toBe(1);
    expect(tree.children![0].style).toBeUndefined();
    expect(tree.children![1].style).toEqual({ fontWeight: 'bold' });
  });
});

describe('mindmapNodeStyles · 存取', () => {
  it('写入 → 读出（副本语义：改读到的对象不污染缓存）', () => {
    setNodeStyle(NOTE, '甲', { fontSize: '18px' });
    const got = getNoteStyles(NOTE);
    expect(got).toEqual({ 甲: { fontSize: '18px' } });
    got.甲.fontSize = '99px';
    expect(getNoteStyles(NOTE)).toEqual({ 甲: { fontSize: '18px' } });
    expect(raw()[NOTE]).toEqual({ 甲: { fontSize: '18px' } });
  });

  it('样式清空 / 笔记下一项都不剩 → 键一起删（不留空壳）', () => {
    setNodeStyle(NOTE, '甲', { color: '#c026d3' });
    setNodeStyle(NOTE, '甲', null);
    expect(getNoteStyles(NOTE)).toEqual({});
    expect(raw()[NOTE]).toBeUndefined();
  });

  it('renameNodeStyle 把条目搬到新键；旧键不存在时什么都不做', () => {
    setNodeStyle(NOTE, '旧名', { fontWeight: 'bold' });
    renameNodeStyle(NOTE, '旧名', '新名');
    expect(getNoteStyles(NOTE)).toEqual({ 新名: { fontWeight: 'bold' } });
    renameNodeStyle(NOTE, '没这个键', '随便');
    expect(getNoteStyles(NOTE)).toEqual({ 新名: { fontWeight: 'bold' } });
  });

  it('改名按**前缀**搬：改名的节点与它整棵子树的键一起走，与这次改名无关的键一个不动', () => {
    const SEP = '\u0000';
    setNodeStyle(NOTE, '波尔效应', { fontSize: '20px' });
    setNodeStyle(NOTE, `波尔效应${SEP}机制`, { fontWeight: 'bold' });
    setNodeStyle(NOTE, `波尔效应${SEP}机制${SEP}二氧化碳升高`, { color: '#dc2626' });
    setNodeStyle(NOTE, `别的根${SEP}节点`, { fontStyle: 'italic' });

    renameNodeStyle(NOTE, '波尔效应', '呼吸调节');

    expect(getNoteStyles(NOTE)).toEqual({
      呼吸调节: { fontSize: '20px' },
      [`呼吸调节${SEP}机制`]: { fontWeight: 'bold' },
      [`呼吸调节${SEP}机制${SEP}二氧化碳升高`]: { color: '#dc2626' },
      [`别的根${SEP}节点`]: { fontStyle: 'italic' },
    });
  });

  it('这篇里没有要改的键 / 名字没变：一个字都不写（幂等）', () => {
    setNodeStyle(NOTE, '甲', { fontWeight: 'bold' });
    const before = localStorage.getItem(NODE_STYLE_KEY);
    renameNodeStyle(NOTE, '波尔效应', '呼吸调节'); // 这篇里没设过这个节点
    renameNodeStyle(NOTE, '甲', '甲'); // 名字没变
    expect(getNoteStyles(NOTE)).toEqual({ 甲: { fontWeight: 'bold' } });
    expect(localStorage.getItem(NODE_STYLE_KEY)).toBe(before);
  });

  it('pruneNoteStyles 丢掉树里已不存在的键', () => {
    setNodeStyle(NOTE, '甲', { fontWeight: 'bold' });
    setNodeStyle(NOTE, '已经删掉的节点', { color: '#c026d3' });
    const { dropped } = pruneNoteStyles(NOTE, ['甲']);
    expect(dropped).toBe(1);
    expect(getNoteStyles(NOTE)).toEqual({ 甲: { fontWeight: 'bold' } });
  });

  it('clearNoteStyles：传 keys 只清这几个，不传清整篇', () => {
    setNodeStyle(NOTE, '甲', { fontWeight: 'bold' });
    setNodeStyle(NOTE, '乙', { fontStyle: 'italic' });
    clearNoteStyles(NOTE, ['甲']);
    expect(getNoteStyles(NOTE)).toEqual({ 乙: { fontStyle: 'italic' } });
    clearNoteStyles(NOTE);
    expect(getNoteStyles(NOTE)).toEqual({});
  });

  it('导出→导入（合并）：备份里的条目覆盖同键，没提到的原样留着；脏值不导入', () => {
    setNodeStyle(NOTE, '甲', { fontWeight: 'bold' });
    const snapshot = exportNoteStyles();
    expect(snapshot[NOTE]).toEqual({ 甲: { fontWeight: 'bold' } });

    const n = importNoteStyles({
      [NOTE]: { 甲: { color: '#c026d3' }, 丙: { fontSize: '20px' }, 脏: { fontSize: 'huge' } },
      '新笔记.md': { 一: { fontStyle: 'italic' } },
    });
    expect(n).toBe(3); // 脏的那条不算
    expect(getNoteStyles(NOTE)).toEqual({ 甲: { color: '#c026d3' }, 丙: { fontSize: '20px' } });
    expect(getNoteStyles('新笔记.md')).toEqual({ 一: { fontStyle: 'italic' } });
  });

  it('存储被外部写脏（坏 JSON / 非法条目）时当作空表，不抛错', () => {
    localStorage.setItem(NODE_STYLE_KEY, '{ 这不是 JSON');
    expect(loadNoteStyles()).toEqual({});
    localStorage.setItem(NODE_STYLE_KEY, JSON.stringify({ [NOTE]: { 甲: { fontSize: 'huge' }, 乙: 'not-an-object' } }));
    expect(getNoteStyles(NOTE)).toEqual({});
  });
});

/**
 * 视频笔记的核心逻辑测试：锚点编解码、片段去重与筛选、A-B 循环判定。
 *
 * 这些都不是「一眼看得出对错」的代码：锚点写错一位就会跳到别的画面上，
 * 循环判定错一次就会让正常播放一直回弹——所以每条边界都钉住。
 */
import { describe, expect, it } from 'vitest';
import {
  addClip,
  anchorHref,
  anchorMarkdown,
  clipRange,
  clipsFor,
  clipMarkdown,
  exportClips,
  findAnchors,
  formatClipRange,
  importClips,
  loadClips,
  loopNext,
  parseAnchorHref,
  removeClip,
  type VideoClip,
} from '../videoNotes';

describe('锚点', () => {
  it('秒数原样往返', () => {
    expect(anchorHref(0)).toBe('#vn=0');
    expect(parseAnchorHref('#vn=754')).toBe(754);
  });

  it('小数向下取整（舍入会跳到后一帧）', () => {
    expect(anchorHref(12.9)).toBe('#vn=12');
  });

  it('非法值不产生锚点', () => {
    expect(anchorHref(NaN)).toBe('#vn=0');
    expect(anchorHref(-5)).toBe('#vn=0');
    expect(parseAnchorHref('#vi=754')).toBeNull();
    expect(parseAnchorHref('#vn=abc')).toBeNull();
    expect(parseAnchorHref('')).toBeNull();
  });

  it('markdown 文本带时间文字与可选备注', () => {
    expect(anchorMarkdown(754)).toBe('[▶ 12:34](#vn=754)');
    expect(anchorMarkdown(754, ' 胃的运动形式 ')).toBe('[▶ 12:34](#vn=754) 胃的运动形式');
  });

  it('从笔记正文里挖出所有锚点', () => {
    const text = '第一处 [▶ 00:05](#vn=5)，第二处 [▶ 12:34](#vn=754)\n普通链接 [x](https://a.b)';
    expect(findAnchors(text).map((a) => a.seconds)).toEqual([5, 754]);
  });
});

function seed(clip: Omit<VideoClip, 'id' | 'at'>): VideoClip {
  const r = addClip(clip, 1_700_000_000_000);
  return r.clips[0];
}

describe('片段', () => {
  it('写入后可读回，同一秒重复收藏只更新备注不堆条目', () => {
    localStorage.clear();
    const first = seed({ media: 'a.mp4', start: 30, end: null, label: '', tags: [] });
    expect(loadClips()).toHaveLength(1);

    const again = addClip({ media: 'a.mp4', start: 30, end: null, label: '重点', tags: ['胃'] });
    expect(again.clips).toHaveLength(1);
    expect(again.clips[0].label).toBe('重点');
    expect(again.clips[0].id).toBe(first.id);
  });

  it('区间不同的同秒片段算两条（点收藏与选中区间是两件事）', () => {
    localStorage.clear();
    seed({ media: 'a.mp4', start: 30, end: null, label: '', tags: [] });
    seed({ media: 'a.mp4', start: 30, end: 40, label: '', tags: [] });
    expect(loadClips()).toHaveLength(2);
  });

  it('只列当前视频，按时间升序，可疑数据被过滤', () => {
    localStorage.clear();
    seed({ media: 'a.mp4', start: 90, end: null, label: '', tags: [] });
    seed({ media: 'a.mp4', start: 10, end: null, label: '开场', tags: [] });
    seed({ media: 'b.mp4', start: 5, end: null, label: '', tags: [] });
    localStorage.setItem('knowlattice-video-clips', JSON.stringify([{ id: 1 }, ...loadClips()]));
    const list = clipsFor(loadClips(), 'a.mp4');
    expect(list.map((c) => c.start)).toEqual([10, 90]);
  });

  it('筛选命中备注与标签', () => {
    localStorage.clear();
    seed({ media: 'a.mp4', start: 10, end: null, label: '胃的运动形式', tags: [] });
    seed({ media: 'a.mp4', start: 20, end: null, label: '', tags: ['迷走'] });
    expect(clipsFor(loadClips(), 'a.mp4', '胃')).toHaveLength(1);
    expect(clipsFor(loadClips(), 'a.mp4', '迷走')).toHaveLength(1);
    expect(clipsFor(loadClips(), 'a.mp4', '不存在')).toHaveLength(0);
  });

  it('删除只影响目标那一条', () => {
    localStorage.clear();
    const a = seed({ media: 'a.mp4', start: 10, end: null, label: '', tags: [] });
    seed({ media: 'a.mp4', start: 20, end: null, label: '', tags: [] });
    expect(removeClip(a.id).clips).toHaveLength(1);
    expect(loadClips()).toHaveLength(1);
  });

  it('区间文字', () => {
    // 时间文字沿用 core/subtitle 的 formatTime：分不补零（0:05），跨越小时才出 1:00:05
    expect(formatClipRange({ media: 'a', start: 5, end: null, label: '', tags: [], id: 'x', at: 0 })).toBe('0:05');
    expect(formatClipRange({ media: 'a', start: 5, end: 65, label: '', tags: [], id: 'x', at: 0 })).toBe('0:05–1:05');
  });

  it('片段能整理成可粘回笔记的锚点清单', () => {
    expect(clipMarkdown({
      media: 'a.mp4',
      start: 65,
      end: 90,
      label: '胃的运动形式',
      tags: ['生理', '#重点'],
      id: 'x',
      at: 0,
    })).toBe('- [▶ 1:05](#vn=65) 胃的运动形式（1:05–1:30） #生理 #重点');
  });
});

describe('A-B 循环', () => {
  it('未设满 A/B 时不动播放位置', () => {
    expect(loopNext(100, null, null)).toBeNull();
    expect(loopNext(100, 10, null)).toBeNull();
  });

  it('越过 B 回到 A，区间内正常播放', () => {
    expect(loopNext(9, 10, 20)).toBeNull();
    expect(loopNext(15, 10, 20)).toBeNull();
    expect(loopNext(20, 10, 20)).toBe(10);
  });

  it('A 在 B 之后也按区间处理（用户先设 B 再设 A）', () => {
    // 25 已经在 [20,30] 区间内 → 不动；33 越过上界 → 回到 20
    expect(loopNext(25, 30, 20)).toBeNull();
    expect(loopNext(33, 30, 20)).toBe(20);
  });
});

describe('区间收藏', () => {
  it('设了 A/B 就收藏那一段，与当前播放位置无关', () => {
    // 之前的写法把 start 取当前播放位置、end 取 max(a,b)：在 60 秒处点收藏
    // 会存成 start=60 / end=30 的倒序区间，清单显示「1:00–0:30」，点进去跳错地方
    expect(clipRange(30, 20, 60)).toEqual({ start: 20, end: 30 });
    expect(clipRange(20, 30, 60)).toEqual({ start: 20, end: 30 });
  });

  it('没设满 A/B 才退化成当前秒的单点收藏（向下取整）', () => {
    expect(clipRange(null, null, 12.9)).toEqual({ start: 12, end: null });
    expect(clipRange(30, null, 12)).toEqual({ start: 12, end: null });
    expect(clipRange(null, 30, 12)).toEqual({ start: 12, end: null });
  });

  it('addClip 把倒序区间归一成 start ≤ end（历史坏数据不再扩散到清单）', () => {
    localStorage.clear();
    const r = addClip({ media: 'a.mp4', start: 60, end: 30, label: '', tags: [] });
    expect(r.clips[0]).toMatchObject({ start: 30, end: 60 });
    expect(formatClipRange(r.clips[0])).toBe('0:30–1:00');
  });
});

describe('备份', () => {
  it('exportClips 返回副本：改它不会污染本机存储', () => {
    localStorage.clear();
    seed({ media: 'a.mp4', start: 5, end: null, label: '原备注', tags: ['胃'] });
    const out = exportClips();
    out[0].label = '改的是副本';
    out[0].tags.push('迷走');
    expect(loadClips()[0].label).toBe('原备注');
    expect(loadClips()[0].tags).toEqual(['胃']);
  });

  it('importClips 只补不覆盖：同 id 保留本地那份（旧备份不该冲掉新写的备注）', () => {
    localStorage.clear();
    const local = seed({ media: 'a.mp4', start: 10, end: null, label: '本地较新', tags: ['胃'] });
    const added = importClips([
      { ...local, label: '备份里的旧备注' },
      { id: 'v-new', media: 'a.mp4', start: 20, end: null, label: '新来的', tags: [], at: 1 },
    ]);
    expect(added).toBe(1);
    expect(loadClips()).toHaveLength(2);
    expect(loadClips().find((c) => c.id === local.id)?.label).toBe('本地较新');
  });

  it('importClips 丢弃形状不合规的条目，非数组返回 0', () => {
    localStorage.clear();
    expect(importClips(null)).toBe(0);
    expect(importClips({ id: 'x' })).toBe(0);
    const added = importClips([
      { id: 3, media: 'bad' },
      { id: 'ok', media: 'a.mp4', start: 1, end: null, label: '', tags: [], at: 2 },
    ]);
    expect(added).toBe(1);
    expect(loadClips().map((c) => c.id)).toEqual(['ok']);
  });
});

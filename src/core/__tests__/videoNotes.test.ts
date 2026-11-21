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
  bindNoteVideo,
  clearVideoHistory,
  clipRange,
  clipsFor,
  clipMarkdown,
  exportClips,
  exportNoteVideos,
  exportVideoHistory,
  findAnchors,
  formatClipRange,
  getVideoForNote,
  getVideoHistoryItem,
  importClips,
  importNoteVideos,
  importVideoHistory,
  isLocalMediaKey,
  loadClips,
  loadVideoHistory,
  loadVideoRate,
  loopNext,
  markClipsInserted,
  MAX_VIDEO_HISTORY,
  parseAnchorHref,
  recordVideoHistory,
  removeClip,
  removeVideoHistory,
  renameVideoHistory,
  resumeSeconds,
  saveVideoRate,
  togglePinVideoHistory,
  updateClip,
  updateVideoHistoryProgress,
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

describe('视频观看历史', () => {
  it('按 media 去重并置顶，保留已有进度与有效标题', () => {
    localStorage.clear();
    recordVideoHistory({
      media: 'bili:BV1xx411c7mD:p1',
      url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=1',
      title: '生理学第1讲',
      kind: 'bilibili',
    }, 100);
    updateVideoHistoryProgress('bili:BV1xx411c7mD:p1', { lastTime: 95, duration: 600 });

    recordVideoHistory({
      media: 'https://a.com/v.mp4',
      url: 'https://a.com/v.mp4',
      title: 'v.mp4',
      kind: 'direct',
    }, 200);

    // 再次打开第一个视频：即使未传 lastTime 和 title 为空，也应保留进度并置顶
    const list = recordVideoHistory({
      media: 'bili:BV1xx411c7mD:p1',
      url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=1',
      title: '',
      kind: 'bilibili',
    }, 300);

    expect(list.map((x) => x.media)).toEqual([
      'bili:BV1xx411c7mD:p1',
      'https://a.com/v.mp4',
    ]);
    expect(list[0].title).toBe('生理学第1讲');
    expect(list[0].lastTime).toBe(95);
    expect(list[0].duration).toBe(600);
  });

  it('最多保留 MAX_VIDEO_HISTORY 条并按时间倒序', () => {
    localStorage.clear();
    for (let i = 0; i < MAX_VIDEO_HISTORY + 5; i++) {
      recordVideoHistory({
        media: `v-${i}`,
        url: `https://example.com/${i}.mp4`,
        title: `视频 ${i}`,
        kind: 'direct',
      }, 1000 + i);
    }
    const list = loadVideoHistory();
    expect(list).toHaveLength(MAX_VIDEO_HISTORY);
    expect(list[0].media).toBe(`v-${MAX_VIDEO_HISTORY + 4}`);
    expect(list[list.length - 1].media).toBe('v-5');
  });

  it('更新进度、删除单条与清空历史互不干扰', () => {
    localStorage.clear();
    recordVideoHistory({ media: 'm1', url: 'https://a.com/1.mp4', title: '1.mp4', kind: 'direct' }, 10);
    recordVideoHistory({ media: 'm2', url: 'https://a.com/2.mp4', title: '2.mp4', kind: 'direct' }, 20);
    updateVideoHistoryProgress('m1', { lastTime: 42.9, duration: 120.4, title: '第一讲' });
    expect(getVideoHistoryItem('m1')).toMatchObject({ lastTime: 42, duration: 120, title: '第一讲' });

    expect(removeVideoHistory('m2').map((x) => x.media)).toEqual(['m1']);
    expect(clearVideoHistory()).toEqual([]);
    expect(loadVideoHistory()).toEqual([]);
  });

  it('备份导入只补不覆盖并丢弃异常条目', () => {
    localStorage.clear();
    recordVideoHistory({
      media: 'm1',
      url: 'https://a.com/1.mp4',
      title: '本地标题',
      kind: 'direct',
      lastTime: 88,
    }, 500);
    const added = importVideoHistory([
      { media: 'm1', url: 'https://a.com/1.mp4', title: '旧标题', kind: 'direct', at: 100, lastTime: 10 },
      { media: 'm2', url: 'https://a.com/2.mp4', title: '新来的', kind: 'direct', at: 200 },
      { media: '', url: 'bad', title: 'bad', kind: 'direct', at: 1 },
      { media: 'bad-kind', url: 'x', title: 'x', kind: 'invalid', at: 1 },
    ]);
    expect(added).toBe(1);
    expect(exportVideoHistory()).toHaveLength(2);
    expect(getVideoHistoryItem('m1')?.title).toBe('本地标题');
    expect(getVideoHistoryItem('m1')?.lastTime).toBe(88);
  });

  it('本地复合键识别与续播秒数边界', () => {
    expect(isLocalMediaKey('生理学.mp4|1024|1700000000')).toBe(true);
    expect(isLocalMediaKey('生理学.mp4')).toBe(false);
    expect(resumeSeconds({ lastTime: 0, duration: 100 })).toBeNull();
    expect(resumeSeconds({ lastTime: 99, duration: 100 })).toBeNull();
    expect(resumeSeconds({ lastTime: 45, duration: 100 })).toBe(45);
  });

  it('置顶条目排在前面且不被 MAX_VIDEO_HISTORY 滚动淘汰', () => {
    localStorage.clear();
    recordVideoHistory({ media: 'pinned-course', url: 'https://a.com/p.mp4', title: '置顶课程', kind: 'direct' }, 1);
    togglePinVideoHistory('pinned-course');
    for (let i = 0; i < MAX_VIDEO_HISTORY + 5; i++) {
      recordVideoHistory({ media: `v-${i}`, url: `https://a.com/${i}.mp4`, title: `视频${i}`, kind: 'direct' }, 100 + i);
    }
    const list = loadVideoHistory();
    expect(list).toHaveLength(MAX_VIDEO_HISTORY);
    expect(list[0].media).toBe('pinned-course');
    expect(list[0].pinned).toBe(true);
  });

  it('重命名历史标题，空白串不生效', () => {
    localStorage.clear();
    recordVideoHistory({ media: 'm1', url: 'https://a.com/1.mp4', title: '1.mp4', kind: 'direct' }, 10);
    renameVideoHistory('m1', '   ');
    expect(getVideoHistoryItem('m1')?.title).toBe('1.mp4');
    renameVideoHistory('m1', '循环系统总论');
    expect(getVideoHistoryItem('m1')?.title).toBe('循环系统总论');
  });

  it('片段支持编辑备注/标签与标记已入笔记', () => {
    localStorage.clear();
    const c = seed({ media: 'a.mp4', start: 20, end: null, label: '旧备注', tags: ['旧'] });
    const edited = updateClip(c.id, { label: '新备注', tags: ['新标签', '重点'] });
    expect(edited.clips[0]).toMatchObject({ label: '新备注', tags: ['新标签', '重点'] });
    const marked = markClipsInserted([c.id]);
    expect(marked.clips[0].inserted).toBe(true);
  });

  it('笔记↔视频映射与倍速偏好支持持久化和只补不覆盖导入', () => {
    localStorage.clear();
    bindNoteVideo('生理学/第1章.md', 'bili:BV1xx411c7mD:p1');
    expect(getVideoForNote('生理学/第1章.md')).toBe('bili:BV1xx411c7mD:p1');
    const added = importNoteVideos({
      '生理学/第1章.md': 'other',
      '生理学/第2章.md': 'bili:BV1xx411c7mD:p2',
    });
    expect(added).toBe(1);
    expect(exportNoteVideos()).toEqual({
      '生理学/第1章.md': 'bili:BV1xx411c7mD:p1',
      '生理学/第2章.md': 'bili:BV1xx411c7mD:p2',
    });
    expect(loadVideoRate()).toBe(1);
    saveVideoRate(1.5);
    expect(loadVideoRate()).toBe(1.5);
  });
});

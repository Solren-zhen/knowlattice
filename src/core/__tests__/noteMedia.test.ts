/**
 * 笔记媒体挂载表（core/noteMedia.ts）：存取往返、删键、导入合并、附件分类、扩展名边界。
 *
 * 存法对齐 core/cardEdits（单键 localStorage + 按原始字符串比对的模块级缓存），
 * 所以这里专门守一条最容易坏的行为：**外部直接写存储后，缓存要自己失效**。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIO_EXT,
  SUBTITLE_EXT,
  clearNoteMedia,
  exportNoteMedia,
  getNoteMedia,
  importNoteMedia,
  loadNoteMedia,
  pickMediaAttachments,
  saveNoteMedia,
} from '../noteMedia';

const KEY = 'knowlattice-note-media';
const NOTE = '07-生理学/呼吸/氧解离曲线.md';

beforeEach(() => {
  localStorage.clear();
  loadNoteMedia(); // 清空存储后强制模块缓存重读一次，用例之间不串
});

describe('noteMedia · 存取', () => {
  it('存取往返：save → get / load / export 看到同一份', () => {
    expect(getNoteMedia(NOTE)).toBeNull();
    expect(loadNoteMedia()).toEqual({});

    const saved = saveNoteMedia(NOTE, {
      audio: '_attachments/呼吸音.mp3',
      subtitle: '_attachments/呼吸音.srt',
    });
    const want = { audio: '_attachments/呼吸音.mp3', subtitle: '_attachments/呼吸音.srt' };

    expect(saved).toEqual({ [NOTE]: want });
    expect(getNoteMedia(NOTE)).toEqual(want);
    expect(loadNoteMedia()).toEqual({ [NOTE]: want });
    expect(exportNoteMedia()).toEqual({ [NOTE]: want });

    // 真的落到了存储里（另一个标签页/下次启动读得到）
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    expect(raw[NOTE]).toEqual(want);
  });

  it('返回新对象：视图放进 state 才会重渲染', () => {
    const a = saveNoteMedia(NOTE, { audio: 'a.mp3' });
    const b = saveNoteMedia(NOTE, { subtitle: 'b.srt' });
    expect(a).not.toBe(b);
    expect(getNoteMedia(NOTE)).toEqual({ audio: 'a.mp3', subtitle: 'b.srt' });
  });

  it('patch 是逐字段合并：只传一面不会把另一面弄丢', () => {
    saveNoteMedia(NOTE, { audio: 'a.mp3', subtitle: 'b.srt' });
    saveNoteMedia(NOTE, { audio: 'a2.m4a' });
    expect(getNoteMedia(NOTE)).toEqual({ audio: 'a2.m4a', subtitle: 'b.srt' });
    saveNoteMedia(NOTE, { subtitle: 'b2.vtt' });
    expect(getNoteMedia(NOTE)).toEqual({ audio: 'a2.m4a', subtitle: 'b2.vtt' });
  });

  it('路径首尾空白裁掉，存取用的是同一个键', () => {
    saveNoteMedia(`  ${NOTE}  `, { audio: '  _attachments/a.mp3  ' });
    expect(getNoteMedia(NOTE)).toEqual({ audio: '_attachments/a.mp3' });
    expect(loadNoteMedia()[`  ${NOTE}  `]).toBeUndefined();
  });

  it('getNoteMedia 返回副本：改它不会污染缓存', () => {
    saveNoteMedia(NOTE, { audio: 'a.mp3' });
    const m = getNoteMedia(NOTE)!;
    m.audio = '被人改过.mp3';
    expect(getNoteMedia(NOTE)).toEqual({ audio: 'a.mp3' });
  });

  it('两面都清空就删键（界面上「卸载附件」就是这一步）', () => {
    saveNoteMedia(NOTE, { audio: 'a.mp3', subtitle: 'b.srt' });
    const map = saveNoteMedia(NOTE, { audio: '', subtitle: '   ' });
    expect(map[NOTE]).toBeUndefined();
    expect(getNoteMedia(NOTE)).toBeNull();
    expect(localStorage.getItem(KEY)).toBe('{}');
  });

  it('clearNoteMedia 只摘这一篇，别的笔记留着；清不存在的键不报错', () => {
    saveNoteMedia('a.md', { audio: 'x.mp3' });
    saveNoteMedia('b.md', { subtitle: 'y.srt' });
    expect(clearNoteMedia('a.md')).toEqual({ 'b.md': { subtitle: 'y.srt' } });
    expect(localStorage.getItem(KEY)).not.toContain('x.mp3');
    expect(clearNoteMedia('从没挂过.md')).toEqual({ 'b.md': { subtitle: 'y.srt' } });
    expect(clearNoteMedia('b.md')).toEqual({});
  });
});

describe('noteMedia · 缓存', () => {
  it('外部直接写存储（另一个标签页 / 备份导入）后，下一次读自动失效重解析', () => {
    saveNoteMedia('a.md', { audio: 'x.mp3' });
    expect(getNoteMedia('a.md')).toEqual({ audio: 'x.mp3' });

    localStorage.setItem(KEY, JSON.stringify({ 'a.md': { subtitle: 'z.srt' } }));
    expect(loadNoteMedia()).toEqual({ 'a.md': { subtitle: 'z.srt' } });
  });

  it('存储被清空 / JSON 坏掉：当空表，不抛错', () => {
    saveNoteMedia('a.md', { audio: 'x.mp3' });
    localStorage.clear();
    expect(loadNoteMedia()).toEqual({});
    localStorage.setItem(KEY, '{oops');
    expect(loadNoteMedia()).toEqual({});
    expect(getNoteMedia('a.md')).toBeNull();
  });

  it('非法条目丢掉，只留能用的（空壳、非对象、两个字段都不是字符串）', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        'a.md': { audio: '', subtitle: '   ' }, // 空壳
        'b.md': 42,
        'c.md': null,
        'd.md': { audio: '_attachments/d.mp3', subtitle: 7 },
      })
    );
    expect(loadNoteMedia()).toEqual({ 'd.md': { audio: '_attachments/d.mp3' } });
  });
});

describe('noteMedia · importNoteMedia', () => {
  it('合并导入：同键覆盖、没提到的键留着，返回导入条数', () => {
    saveNoteMedia('a.md', { audio: 'a.mp3' });
    const n = importNoteMedia({
      'a.md': { subtitle: 'a.srt' },
      'b.md': { audio: 'b.m4a', subtitle: 'b.srt' },
      'c.md': { audio: '' }, // 空壳不导入
    });
    expect(n).toBe(2);
    expect(loadNoteMedia()).toEqual({
      'a.md': { subtitle: 'a.srt' },
      'b.md': { audio: 'b.m4a', subtitle: 'b.srt' },
    });
  });

  it('非法输入一条都不导入，也不动已存的数据', () => {
    saveNoteMedia('a.md', { audio: 'a.mp3' });
    expect(importNoteMedia(null)).toBe(0);
    expect(importNoteMedia(undefined)).toBe(0);
    expect(importNoteMedia('{}')).toBe(0); // 备份里字段缺失/类型不对
    expect(importNoteMedia({ 'x.md': 3, 'y.md': { audio: 7 }, 'z.md': null })).toBe(0);
    expect(loadNoteMedia()).toEqual({ 'a.md': { audio: 'a.mp3' } });
  });
});

describe('noteMedia · pickMediaAttachments', () => {
  it('按扩展名分到音频/字幕，各自按路径升序', () => {
    const r = pickMediaAttachments([
      '_attachments/b.srt',
      '_attachments/z.mp3',
      '_attachments/note.md',
      '_attachments/a.M4A',
      '_attachments/a.wav',
      'assets/c.vtt',
      '_attachments/cover.png',
    ]);
    expect(r.audio).toEqual(['_attachments/a.M4A', '_attachments/a.wav', '_attachments/z.mp3']);
    expect(r.subtitle).toEqual(['_attachments/b.srt', 'assets/c.vtt']);
  });

  it('中文文件名照常分类（只看文件名末尾的扩展名）', () => {
    const r = pickMediaAttachments([
      '_attachments/第一讲 呼吸（上）.mp3',
      '_attachments/第一讲 呼吸（上）.srt',
      '_attachments/第一讲 呼吸（上）.md',
    ]);
    expect(r.audio).toEqual(['_attachments/第一讲 呼吸（上）.mp3']);
    expect(r.subtitle).toEqual(['_attachments/第一讲 呼吸（上）.srt']);
  });

  it('目录名里的扩展名不算，空列表给出两个空桶，带查询串的路径不算附件', () => {
    expect(pickMediaAttachments(['media/mp3/笔记.md', '_attachments/x.mp3?raw=1'])).toEqual({
      audio: [],
      subtitle: [],
    });
    expect(pickMediaAttachments([])).toEqual({ audio: [], subtitle: [] });
  });
});

describe('noteMedia · 扩展名判定', () => {
  it('大小写都认（附件名来自用户，大小写不可控）', () => {
    for (const p of ['a.mp3', 'a.MP3', 'a.FlAc', 'a.m4a', 'a.webm', 'a.aac', 'a.ogg', 'a.oga', 'a.wav']) {
      expect(AUDIO_EXT.test(p)).toBe(true);
    }
    expect(SUBTITLE_EXT.test('a.SRT')).toBe(true);
    expect(SUBTITLE_EXT.test('a.Vtt')).toBe(true);
  });

  it('按结尾匹配：查询串/多一层后缀/少点号都不算', () => {
    expect(AUDIO_EXT.test('a.mp3?raw=1')).toBe(false);
    expect(SUBTITLE_EXT.test('a.srt?x=1')).toBe(false);
    expect(AUDIO_EXT.test('a.mp3.bak')).toBe(false);
    expect(AUDIO_EXT.test('amp3')).toBe(false); // 少了点号
    expect(AUDIO_EXT.test('a.mp4')).toBe(false); // 视频不算音频
    expect(SUBTITLE_EXT.test('a.ass')).toBe(false); // 不在表里的就是不认，不猜
    expect(SUBTITLE_EXT.test('ass')).toBe(false);
  });

  it('两个正则互不吃对方的扩展名', () => {
    for (const p of ['a.srt', 'a.vtt']) expect(AUDIO_EXT.test(p)).toBe(false);
    for (const p of ['a.mp3', 'a.wav']) expect(SUBTITLE_EXT.test(p)).toBe(false);
  });
});

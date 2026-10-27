/**
 * 视频来源识别的测试。
 *
 * 这块最容易错在两处，所以都钉住：
 * 1) B 站链接形态多（BV/av/分P/t 参数/页内锚点），取错 id 就播成别的视频；
 * 2) 网盘分享页里也可能带 .mp4 字样，但它不是媒体流——判错就会给一个永远转圈的播放器。
 */
import { describe, expect, it } from 'vitest';
import { bilibiliEmbed, mediaKeyOf, parseBilibili, parseVideoSource, withStart } from '../videoSource';

describe('B 站', () => {
  it('BV 号 + 分P + t 参数', () => {
    const ref = parseBilibili('https://www.bilibili.com/video/BV1xx411c7mD?p=3&t=754');
    expect(ref).toMatchObject({ bvid: 'BV1xx411c7mD', page: 3, start: 754 });
  });

  it('av 号与页内锚点写法 (#t=)', () => {
    const ref = parseBilibili('https://www.bilibili.com/video/av170001#t=90');
    expect(ref).toMatchObject({ aid: 'av170001', page: 1, start: 90 });
  });

  it('手机端 b23 短链认不出视频（要用户先打开短链）', () => {
    const s = parseVideoSource('https://b23.tv/abcd123');
    expect(s.kind).toBe('page');
    expect(s.embedUrl).toBeNull();
    expect(s.note).toContain('b23.tv');
  });

  it('iframe 地址带 t 与分P，且不带 autoplay 时保持安静', () => {
    const ref = parseBilibili('https://www.bilibili.com/video/BV1xx411c7mD?p=2')!;
    const url = bilibiliEmbed({ ...ref, at: 125 }, false);
    expect(url.startsWith('https://player.bilibili.com/player.html?')).toBe(true);
    expect(url).toContain('bvid=BV1xx411c7mD');
    expect(url).toContain('page=2');
    expect(url).toContain('t=125');
    expect(url).not.toContain('autoplay=1');
    expect(bilibiliEmbed({ ...ref, at: 5 }, true)).toContain('autoplay=1');
  });

  it('识别为 bilibili 且明确说了读不到进度', () => {
    const s = parseVideoSource('https://www.bilibili.com/video/BV1xx411c7mD');
    expect(s.kind).toBe('bilibili');
    expect(s.seekable).toBe(false);
    expect(s.embedUrl).toContain('player.bilibili.com');
    expect(s.note).toContain('手填');
  });
});

describe('抖音 / 网盘 / 直链', () => {
  it('抖音只记锚点，不假装能播', () => {
    const s = parseVideoSource('https://www.douyin.com/video/7412345678901234567');
    expect(s.kind).toBe('douyin');
    expect(s.playUrl).toBeNull();
    expect(s.embedUrl).toBeNull();
    expect(s.pageUrl).toBeTruthy();
    expect(s.note).toContain('浏览器');
  });

  it('网盘分享页即使带 .mp4 字样也不算媒体流', () => {
    const s = parseVideoSource('https://pan.baidu.com/s/1abcdEFG?pwd=1234&f=lecture.mp4');
    expect(s.kind).toBe('netdisk');
    expect(s.playUrl).toBeNull();
  });

  it('阿里云盘/夸克/115 都认', () => {
    for (const host of ['www.aliyundrive.com', 'www.alipan.com', 'pan.quark.cn', '115.com']) {
      expect(parseVideoSource(`https://${host}/s/xyz`).kind).toBe('netdisk');
    }
  });

  it('mp4 直链可播且能读进度', () => {
    const s = parseVideoSource('https://cdn.example.com/a/b/lecture-01.mp4?sign=1');
    expect(s.kind).toBe('direct');
    expect(s.seekable).toBe(true);
    expect(s.playUrl).toBe('https://cdn.example.com/a/b/lecture-01.mp4?sign=1');
  });

  it('m3u8 不当成普通直链（桌面 Chrome 不原生支持 HLS）', () => {
    const s = parseVideoSource('https://cdn.example.com/x/index.m3u8');
    expect(s.kind).toBe('direct');
    expect(s.playUrl).toBeNull();
    expect(s.note).toContain('m3u8');
  });

  it('本地与 blob 地址按本地处理', () => {
    expect(parseVideoSource('blob:http://localhost:5173/abc').kind).toBe('local');
    expect(parseVideoSource('D:\\课件\\生理学.mp4').kind).toBe('local');
    expect(parseVideoSource('生理学-01.mp4').kind).toBe('local');
  });

  it('空串与普通网页不报错', () => {
    expect(parseVideoSource('').title).toBe('');
    expect(parseVideoSource('https://example.com/article').kind).toBe('page');
  });
});

describe('辅助', () => {
  it('withStart 给原页加 t 参数（浏览器定位到该秒）', () => {
    expect(withStart('https://www.douyin.com/video/123', 754)).toContain('t=754');
    const u = new URL(withStart('https://www.douyin.com/video/123?x=1', 30));
    expect(u.searchParams.get('x')).toBe('1');
    expect(u.searchParams.get('t')).toBe('30');
  });

  it('片段归属键：B 站按 BV+分P，其余用原值', () => {
    const raw = 'https://www.bilibili.com/video/BV1xx411c7mD?p=2&spm_id_from=333';
    expect(mediaKeyOf(parseVideoSource(raw), raw)).toBe('bili:BV1xx411c7mD:p2');
    const net = 'https://pan.baidu.com/s/1abc';
    expect(mediaKeyOf(parseVideoSource(net), net)).toBe(net);
  });
});

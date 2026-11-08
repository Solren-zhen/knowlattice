/**
 * B 站课程字幕的纯函数契约测试。
 *
 * 这里钉的是「AI 讲义能不能拿到正确的时间锚点」：
 * 1) 字幕 JSON 的时间单位是秒、字段可能给成字符串，解析错会让所有锚点整体偏移；
 * 2) 语言挑选必须先人工后 AI —— 挑错会把机翻字幕当成讲义底稿；
 * 3) 合并行必须保留行首时间，否则生成的笔记无法回看。
 */
import { describe, expect, it, vi } from 'vitest';
import { setBiliProxyBase } from '../biliPlay';
import {
  cuesToTranscript,
  fetchSubtitleTracks,
  normalizeSubtitleUrl,
  parseBiliSubtitleJson,
  pickSubtitleTrack,
  subtitleOutOfRange,
  subtitleIncomplete,
  type BiliSubtitleTrack,
} from '../biliSubtitles';

const track = (lan: string, ai: boolean): BiliSubtitleTrack => ({
  lan,
  lanDoc: lan,
  url: `https://i0.hdslb.com/${lan}.json`,
  ai,
});

describe('normalizeSubtitleUrl', () => {
  it('协议相对地址补成 https', () => {
    expect(normalizeSubtitleUrl('//i0.hdslb.com/a.json')).toBe('https://i0.hdslb.com/a.json');
  });

  it('已是绝对地址与空串都原样处理', () => {
    expect(normalizeSubtitleUrl('https://i0.hdslb.com/a.json')).toBe('https://i0.hdslb.com/a.json');
    expect(normalizeSubtitleUrl('  ')).toBe('');
  });
});

describe('pickSubtitleTrack', () => {
  it('人工中文优先于 AI 中文', () => {
    const picked = pickSubtitleTrack([track('en-US', false), track('zh-CN', true), track('zh-CN', false)]);
    expect(picked?.ai).toBe(false);
    expect(picked?.lan).toBe('zh-CN');
  });

  it('没有人工字幕时才退回 AI 字幕', () => {
    expect(pickSubtitleTrack([track('en-US', true), track('zh-CN', true)])?.lan).toBe('zh-CN');
  });

  it('没有中文时取第一条可用字幕，空清单返回 null', () => {
    expect(pickSubtitleTrack([track('ja', false)])?.lan).toBe('ja');
    expect(pickSubtitleTrack([])).toBeNull();
    expect(pickSubtitleTrack([{ ...track('zh-CN', false), url: '' }])).toBeNull();
  });
});

describe('parseBiliSubtitleJson', () => {
  it('按 from/to 解析成 cue，字符串数字也能读', () => {
    const cues = parseBiliSubtitleJson(
      JSON.stringify({
        body: [
          { from: 3.2, to: 5.5, content: '第二句' },
          { from: '0', to: '2', content: '第一句' },
        ],
      }),
    );
    expect(cues).toEqual([
      { start: 0, end: 2, text: '第一句' },
      { start: 3.2, end: 5.5, text: '第二句' },
    ]);
  });

  it('压平正文换行并跳过空句', () => {
    const cues = parseBiliSubtitleJson(
      JSON.stringify({ body: [{ from: 0, to: 1, content: '上句\n下句' }, { from: 1, to: 2, content: '  ' }] }),
    );
    expect(cues).toEqual([{ start: 0, end: 1, text: '上句 下句' }]);
  });

  it('end 不晚于 start 时收成 start，非法输入返回空数组', () => {
    expect(parseBiliSubtitleJson(JSON.stringify({ body: [{ from: 4, to: 4, content: 'x' }] }))).toEqual([
      { start: 4, end: 4, text: 'x' },
    ]);
    expect(parseBiliSubtitleJson('not json')).toEqual([]);
    expect(parseBiliSubtitleJson('{}')).toEqual([]);
  });
});

describe('cuesToTranscript', () => {
  it('合并短句并保留行首时间锚点', () => {
    const text = cuesToTranscript(
      [
        { start: 0, end: 2, text: '第一句。' },
        { start: 2, end: 4, text: '第二句。' },
      ],
      { maxChars: 100 },
    );
    expect(text).toBe('[0:00] 第一句。第二句。');
  });

  it('超过字数上限就换行，换行处的时间取自该行第一句', () => {
    const text = cuesToTranscript(
      [
        { start: 0, end: 2, text: 'a'.repeat(60) },
        { start: 65, end: 70, text: 'b'.repeat(60) },
      ],
      { maxChars: 60 },
    );
    expect(text.split('\n')).toEqual([`[0:00] ${'a'.repeat(60)}`, `[1:05] ${'b'.repeat(60)}`]);
  });
});

describe('subtitleOutOfRange', () => {
  const cue = (end: number) => ({ start: 0, end, text: 'x' });

  it('字幕正常结束在视频时长内时不报警', () => {
    expect(subtitleOutOfRange([cue(180), cue(210)], 211)).toBe(false);
  });

  it('字幕跨度明显超过视频时长时判为抓错', () => {
    expect(subtitleOutOfRange([cue(300), cue(778)], 211)).toBe(true);
  });

  it('只覆盖到很短一段时判为不完整', () => {
    expect(subtitleIncomplete([cue(30)], 211)).toBe(true);
    expect(subtitleIncomplete([cue(200)], 211)).toBe(false);
  });

  it('空字幕或未知时长不报警', () => {
    expect(subtitleOutOfRange([], 211)).toBe(false);
    expect(subtitleOutOfRange([cue(900)], 0)).toBe(false);
  });
});

describe('fetchSubtitleTracks', () => {
  it('wbi 接口只给空 url 时回落老接口拿真实地址', async () => {
    setBiliProxyBase('http://proxy.test/bili-proxy');
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url));
      const body = String(url).includes('/player/wbi/v2')
        ? { code: 0, data: { subtitle: { subtitles: [{ lan: 'ai-zh', subtitle_url: '' }] } } }
        : {
            code: 0,
            data: {
              subtitle: {
                subtitles: [{ lan: 'ai-zh', subtitle_url: 'https://i0.hdslb.com/a.json', ai_type: 1 }],
              },
            },
          };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const list = await fetchSubtitleTracks('BV1xx411c7mD', 1, { sessdata: 'x'.repeat(30) });
    expect(list).toHaveLength(1);
    expect(list[0].lan).toBe('ai-zh');
    expect(urls[0]).toContain('/x/player/wbi/v2');
    expect(urls[1]).toContain('/x/player/v2');
    vi.unstubAllGlobals();
  });

  it('两个接口都失败时抛出错误，不静默变成「没有字幕」', async () => {
    setBiliProxyBase('http://proxy.test/bili-proxy');
    vi.stubGlobal('fetch', async () => new Response('blocked', { status: 412 }));
    await expect(fetchSubtitleTracks('BV1xx411c7mD', 1, null)).rejects.toThrow('字幕清单接口 412');
    vi.unstubAllGlobals();
  });
});

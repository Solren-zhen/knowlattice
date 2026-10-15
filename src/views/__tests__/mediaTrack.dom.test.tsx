// @vitest-environment jsdom
/**
 * 音频条 + 字幕轨（views/MediaTrack.tsx）的 DOM 测试。
 *
 * 纯逻辑（解析、定位、挖空）已经在 core/__tests__/subtitle.test.ts 里单测过，
 * 这里只守「接线」：渲染出 audio 与字幕列表、点字幕回跳、timeupdate 高亮当前句、
 * 没字幕不渲染空列表、「转成复习卡」真的走挖空后交给调用方。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import MediaTrack from '../MediaTrack';

/**
 * jsdom 的 HTMLMediaElement.currentTime 打桩。
 *
 * jsdom 把 currentTime 实现在 HTMLMediaElement.prototype 上（本机 jsdom 30 的这个访问器
 * 其实能写、不抛错；早期版本才是只读），但值的落点是引擎内部实现对象，我们无法断言
 * "组件确实把 currentTime 设成了 5"。所以按任务要求用 Object.defineProperty 把原型上的
 * 访问器换成自己的：
 *   - get/set 定义在 HTMLMediaElement.prototype 上，组件里的 `audio.currentTime = x`
 *     与随后的 `audio.currentTime`（cueIndexAt 读它）走的就是同一份存储，闭环成立；
 *   - 时间按**元素实例**存在 WeakMap 里，多个 audio 元素互不串，
 *     测试之间也不用重置（元素随 cleanup 被回收）。
 */
const times = new WeakMap<HTMLMediaElement, number>();

Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
  configurable: true,
  get(this: HTMLMediaElement) {
    return times.get(this) ?? 0;
  },
  set(this: HTMLMediaElement, v: number) {
    times.set(this, v);
  },
});

// jsdom 不实现 Element.prototype.scrollIntoView（本机 jsdom 30 里它是 undefined）。
// 组件里做了 typeof 守卫，这里补一个空实现，保证「高亮时把当前行滚进视野」这条路径真的被走到。
Element.prototype.scrollIntoView = () => {};

afterEach(() => cleanup());

/** 三条字幕：第 1、2、3 条分别含括号词 / 数字单位，能真的被 core/subtitle 挖空 */
const SRT = [
  '1',
  '00:00:00,000 --> 00:00:04,000',
  '心率（60次/分）为正常',
  '',
  '2',
  '00:00:05,000 --> 00:00:09,000',
  '每分钟输出量约 5L',
  '',
  '3',
  '00:00:10,000 --> 00:00:14,000',
  '收缩压 120mmHg',
].join('\n');

function renderTrack(overrides: Partial<Parameters<typeof MediaTrack>[0]> = {}) {
  const props = {
    audioSrc: 'blob:media/呼吸音.mp3',
    subtitleText: SRT,
    onMakeCards: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<MediaTrack {...props} />), props };
}

const cuesOf = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>('.media-cue')].map((b) => b.className);

describe('MediaTrack', () => {
  it('渲染出 audio 与字幕列表，条数 = 字幕条数（时间戳 + 原句）', () => {
    const { container } = renderTrack();

    const audio = container.querySelector<HTMLAudioElement>('audio.media-audio');
    expect(audio).toBeTruthy();
    expect(audio!.getAttribute('src')).toBe('blob:media/呼吸音.mp3');

    expect(container.querySelectorAll('.media-cues > li').length).toBe(3);
    const items = container.querySelectorAll<HTMLButtonElement>('.media-cue');
    expect(items.length).toBe(3);
    expect(items[1].textContent).toContain('0:05');
    expect(items[1].textContent).toContain('每分钟输出量约 5L');
    // 还没出声，谁都不高亮（core/subtitle 的约定：拿不准就不亮）
    expect(cuesOf(container)).toEqual(['media-cue', 'media-cue', 'media-cue']);
  });

  it('点第 2 条字幕把 audio.currentTime 设成该条的 start', () => {
    const { container } = renderTrack();
    const audio = container.querySelector<HTMLAudioElement>('audio.media-audio')!;
    const items = container.querySelectorAll<HTMLButtonElement>('.media-cue');

    expect(audio.currentTime).toBe(0);
    fireEvent.click(items[1]);
    expect(audio.currentTime).toBe(5);
    fireEvent.click(items[2]);
    expect(audio.currentTime).toBe(10);

    // 点击同时把高亮对到这一句（设 currentTime 不保证立刻抛 timeupdate）
    expect(cuesOf(container)).toEqual(['media-cue', 'media-cue', 'media-cue on']);
  });

  it('timeupdate 后当前句带 ` on`，落在句间空隙时谁都不亮', () => {
    const { container } = renderTrack();
    const audio = container.querySelector<HTMLAudioElement>('audio.media-audio')!;

    audio.currentTime = 6; // 第 2 条 [5, 9]
    fireEvent.timeUpdate(audio);
    expect(cuesOf(container)).toEqual(['media-cue', 'media-cue on', 'media-cue']);

    audio.currentTime = 12; // 第 3 条 [10, 14]
    fireEvent.timeUpdate(audio);
    expect(cuesOf(container)).toEqual(['media-cue', 'media-cue', 'media-cue on']);

    audio.currentTime = 9.5; // 句间空隙 —— 宁可不高亮，也不要亮错那句
    fireEvent.timeUpdate(audio);
    expect(cuesOf(container)).toEqual(['media-cue', 'media-cue', 'media-cue']);
  });

  it('没有字幕：只渲染音频条，不渲染空列表，也没有「转成复习卡」', () => {
    const { container } = renderTrack({ subtitleText: '' });
    expect(container.querySelector('audio.media-audio')).toBeTruthy();
    expect(container.querySelector('.media-cues')).toBeNull();
    expect(screen.queryByText('转成复习卡')).toBeNull();

    // 完全不传 subtitleText 也一样
    const second = renderTrack({ subtitleText: undefined });
    expect(second.container.querySelector('.media-cues')).toBeNull();
    expect(second.container.querySelector('audio.media-audio')).toBeTruthy();
  });

  it('「转成复习卡」把挖空后的字幕文本交给调用方（不是原样返回）', () => {
    const { props } = renderTrack();
    const btn = screen.getByText('转成复习卡');
    expect(btn.getAttribute('title')).toContain('复习队列');

    fireEvent.click(btn);
    expect(props.onMakeCards).toHaveBeenCalledTimes(1);

    const cardText = (props.onMakeCards as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(cardText).toContain('{{'); // 走了 core/subtitle.subtitleToCardText 的挖空
    expect(cardText.startsWith('- 0:00 ')).toBe(true); // 每句一行、行首时间戳
    expect(cardText.split('\n').length).toBe(3);
  });

  it('关闭按钮回传 onClose', () => {
    const { props } = renderTrack();
    fireEvent.click(screen.getByLabelText('关闭音频条'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
  it('卸载时摘掉 timeupdate 监听', () => {
    // React 自己也会给 media 元素挂一份 timeupdate（它属于非委托事件，直接挂在元素上，
    // 见 react-dom 的 nonDelegatedEvents），所以**不能数总次数**。只认最后挂上的那个：
    // 元素在 commit 时插入（React 那份挂在前），useEffect 在 commit 之后才跑（我们这份挂在后）。
    const add = vi.spyOn(HTMLMediaElement.prototype, 'addEventListener');
    const remove = vi.spyOn(HTMLMediaElement.prototype, 'removeEventListener');
    const { unmount } = renderTrack();

    const added = add.mock.calls.filter(([t]) => t === 'timeupdate').map(([, h]) => h);
    expect(added.length).toBeGreaterThan(0);
    const ours = added[added.length - 1];

    unmount();
    const removed = remove.mock.calls.filter(([t]) => t === 'timeupdate').map(([, h]) => h);
    expect(removed).toContain(ours);

    add.mockRestore();
    remove.mockRestore();
  });
});

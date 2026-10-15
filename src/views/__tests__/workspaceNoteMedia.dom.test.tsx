// @vitest-environment jsdom
/**
 * Workspace 的「笔记级音频 + 字幕」（I1 接线）DOM 测试。
 *
 * 守住的是**接线**而不是解析逻辑（解析/挖空已在 core/__tests__/subtitle.test.ts 与
 * views/__tests__/mediaTrack.dom.test.tsx 里测过）：
 *   1. 没挂媒体时不渲染音频条，但工具栏入口在；
 *   2. 挂了媒体而附件读不到（文件被删）时走兜底：不渲染 <audio>、给出说明、不崩，× 能摘挂载；
 *   3. 从入口真实挂上音频 + 字幕：写 localStorage（**不写笔记正文**）→ 播放器 + 字幕行出现 →
 *      「转成复习卡」把挖空正文写进当前笔记的 `## 字幕复习卡` 小节，且**再点一次不会多一份**。
 *
 * 环境缺口（两处垫片，都不改被测代码）：
 *   - jsdom 的 Blob 与 Node 的 fetch 不互通，blob: URL 取不到内容，所以自造一张 URL → Blob 表，
 *     fetch 直接读它（被测代码仍然走 fetch(vault.readFile(...)) 这条真实路径）；
 *   - jsdom 没有 ResizeObserver（ChapterTree 虚拟滚动要用）。
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { openDB } from 'idb';
import Workspace from '../Workspace';

class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ROStub;

const NOTE_PATH = '01-生理学/呼吸/波尔效应.md';
const NOTE_CONTENT =
  '---\ntitle: 波尔效应\ntype: concept\n---\n\n# 波尔效应\n\npH 降低时氧解离曲线右移。\n';

/** 三条字幕：能真的被 core/subtitle 挖空（括号词 / 数字+单位） */
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

const CARD_TOAST = '已生成复习卡，可在复习页看到';
const blobs = new Map<string, Blob>();
let urlSeq = 0;

beforeEach(async () => {
  localStorage.clear();
  blobs.clear();
  urlSeq = 0;

  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (b: Blob) => {
      const url = `blob:test/${++urlSeq}`;
      blobs.set(url, b);
      return url;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: () => {} });
  vi.stubGlobal('fetch', async (url: string) => {
    const blob = blobs.get(String(url));
    if (!blob) throw new Error(`拿不到这个 blob：${url}`);
    return { text: async () => blob.text() };
  });
  // 只清 toast 条目，不删 .mv-toast-host 容器本身：core/feedback 的 host 是模块级单例，
  // 把容器从 DOM 里摘掉之后，后续所有 toast 都落进那个已脱离文档的节点里（测试永远看不见）
  document.querySelectorAll('.mv-toast').forEach((el) => el.remove());

  const db = await openDB('knowlattice', 2, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'path' });
      if (!d.objectStoreNames.contains('attachments')) d.createObjectStore('attachments', { keyPath: 'path' });
    },
  });
  await db.put('files', { path: NOTE_PATH, content: NOTE_CONTENT, mtime: Date.now(), size: 10 });
  db.close();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 从目录树打开笔记（与 workspace.smoke 同一个入口），并等到笔记区渲染出来 */
async function openNote(container: HTMLElement) {
  const row = await waitFor(
    () => {
      const found = [...container.querySelectorAll('.tree-row.file')].find((c) =>
        c.textContent?.includes('波尔效应')
      );
      if (!found) throw new Error('目录还没列出「波尔效应」');
      return found as HTMLElement;
    },
    { timeout: 8000 }
  );
  fireEvent.click(row);
  await waitFor(() => expect(screen.getByLabelText('给当前笔记挂音频或字幕')).toBeTruthy(), { timeout: 8000 });
}

/** 直接读存储里的笔记正文：写盘是异步的，界面上的编辑器不是判定依据 */
async function noteBody(): Promise<string> {
  const db = await openDB('knowlattice', 2);
  const rec = (await db.get('files', NOTE_PATH)) as { content?: string } | undefined;
  db.close();
  return rec?.content ?? '';
}

const sectionCount = (body: string) => body.split('## 字幕复习卡').length - 1;
const toastTexts = () => [...document.querySelectorAll('.mv-toast')].map((e) => e.textContent ?? '');
const cardToasts = () => toastTexts().filter((t) => t === CARD_TOAST).length;

const mediaMap = (): Record<string, unknown> =>
  JSON.parse(localStorage.getItem('knowlattice-note-media') ?? '{}') as Record<string, unknown>;

/** 轮询等待一个同步读数满足条件（写盘/读字幕都是异步的，没有别的可靠观察点） */
async function until<T>(read: () => T, ok: (v: T) => boolean, timeout = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = read();
    if (ok(v) || Date.now() - start > timeout) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe('Workspace 笔记级音频 / 字幕', () => {
  it('没挂媒体：工具栏有入口，但不渲染音频条', async () => {
    const { container } = render(<Workspace />);
    await openNote(container);

    expect(screen.getByLabelText('给当前笔记挂音频或字幕')).toBeTruthy();
    expect(container.querySelector('.media-track-wrap')).toBeNull();
    expect(container.querySelector('audio.media-audio')).toBeNull();
    // 工具栏里的那个（章节目录卡片里也有隐藏的 file input，querySelector 会先命中它）
    expect(container.querySelector('.editor-toolbar input[type="file"]')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('knowlattice-note-media') ?? '{}')).toEqual({});
  }, 30000);

  it('挂了媒体但附件读不到：兜底提示、不渲染 <audio>、× 能摘掉挂载', async () => {
    localStorage.setItem(
      'knowlattice-note-media',
      JSON.stringify({ [NOTE_PATH]: { audio: '_attachments/讲解.mp3', subtitle: '_attachments/讲解.srt' } })
    );
    const { container } = render(<Workspace />);
    await openNote(container);

    await waitFor(() => expect(container.querySelector('.media-hint')).toBeTruthy());
    expect(container.querySelector('.media-hint')!.textContent).toContain('音频附件读不到');
    // 音频读不到就不渲染播放器：<audio src=""> 会去加载「当前文档地址」，报错且永远播不了
    expect(container.querySelector('audio.media-audio')).toBeNull();
    // 字幕读不到：异步读失败会报一条 toast，界面不显示「转成复习卡」（没有字幕文本可挖空）
    await new Promise((r) => setTimeout(r, 200));
    expect(toastTexts().some((t) => t.includes('字幕读取失败'))).toBe(true);
    expect(cardToasts()).toBe(0);
    expect(screen.queryByText('转成复习卡')).toBeNull();

    fireEvent.click(screen.getByLabelText('卸载当前笔记的音频/字幕'));
    await waitFor(() => expect(container.querySelector('.media-hint')).toBeNull());
    expect(mediaMap()).toEqual({});
  }, 30000);

  it('从入口挂音频 + 字幕：播放器与字幕行出现，转成复习卡写进小节且只一份', async () => {
    const { container } = render(<Workspace />);
    await openNote(container);

    // 必须限定在工具栏里：章节目录卡片里也有隐藏的 file input，container.querySelector 先命中它
    const input = container.querySelector<HTMLInputElement>('.editor-toolbar input[type="file"]');
    expect(input).toBeTruthy();
    const audio = new File([new Uint8Array([1, 2, 3])], '讲解.mp3', { type: 'audio/mpeg' });
    const srt = new File([SRT], '讲解.srt', { type: 'text/plain' });
    fireEvent.change(input!, { target: { files: [audio, srt] } });

    // 挂载落进本地映射（附件在 _attachments/ 下），笔记正文一个字不动
    await waitFor(() =>
      expect(mediaMap()[NOTE_PATH]).toEqual({ audio: '_attachments/讲解.mp3', subtitle: '_attachments/讲解.srt' })
    );
    expect(await noteBody()).toBe(NOTE_CONTENT);

    // 播放器 + 逐句字幕（字幕是异步读的，读到才有列表）
    await waitFor(() => expect(container.querySelector('audio.media-audio')).toBeTruthy());
    expect(container.querySelector('audio.media-audio')!.getAttribute('src')).toMatch(/^blob:test\//);
    await waitFor(() => expect(container.querySelectorAll('.media-cue').length).toBe(3));

    // 转成复习卡 → 写进当前笔记的 `## 字幕复习卡` 小节
    fireEvent.click(screen.getByText('转成复习卡'));
    await until(cardToasts, (n) => n >= 1);
    expect(cardToasts()).toBe(1);
    const body = await noteBody();
    expect(body).toContain('## 字幕复习卡');
    expect(body).toContain('- 0:00 心率（{{60次/分}}）为正常'); // 走 core/subtitle 的挖空，不另起一套
    expect(body).toContain('pH 降低时氧解离曲线右移。'); // 原正文留着
    expect(sectionCount(body)).toBe(1);

    // 再点一次：覆盖同名小节，而不是追加第二份（否则复习队列里会多一张同内容的卡）
    fireEvent.click(screen.getByText('转成复习卡'));
    await until(cardToasts, (n) => n >= 2);
    expect(cardToasts()).toBe(2);
    expect(sectionCount(await noteBody())).toBe(1);
  }, 30000);
});

/**
 * @vitest-environment jsdom
 *
 * 视频笔记面板的可交互部分：没视频时的空状态、记时间点写出的 markdown、
 * 收藏片段落到列表、以及「没有画面时截帧不许假装成功」。
 *
 * jsdom 不会真的解码视频，所以这里不测播放；测的是面板自己的行为——
 * 这几条正是「点了没反应」和「插错内容」最容易发生的接缝。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import VideoNoteView from '../VideoNoteView';
import { addClip } from '../../core/videoNotes';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function setup(over: Partial<React.ComponentProps<typeof VideoNoteView>> = {}) {
  const onInsert = vi.fn(() => true);
  const onUrl = vi.fn();
  const onAttach = vi.fn(async () => '_attachments/帧.png');
  const props = {
    media: '生理学-01.mp4',
    src: null,
    title: '生理学-01.mp4',
    onPick: vi.fn(),
    onUrl,
    onInsert,
    onAttach,
    onClose: vi.fn(),
    ...over,
  } as React.ComponentProps<typeof VideoNoteView>;
  render(<VideoNoteView {...props} />);
  return { onInsert, onAttach, onUrl };
}

describe('视频笔记面板', () => {
  it('没有视频时给出可读的空状态，按钮仍在（先叫面板再选文件）', () => {
    setup({ media: '' });
    expect(screen.getByText(/还没有视频/)).toBeTruthy();
    expect(screen.getByText('本地文件')).toBeTruthy();
    expect(screen.getByText('记时间点')).toBeTruthy();
  });

  it('记时间点把锚点 markdown 交给编辑器', () => {
    const { onInsert } = setup();
    fireEvent.click(screen.getByText('记时间点'));
    expect(onInsert).toHaveBeenCalledWith('[▶ 0:00](#vn=0)');
  });

  it('记时间点时带上当场写的备注与标签', () => {
    const { onInsert } = setup();
    fireEvent.change(screen.getByPlaceholderText(/这一段是什么/), { target: { value: '胃的运动形式' } });
    fireEvent.change(screen.getByPlaceholderText(/标签，用空格分开/), { target: { value: '生理 重点' } });
    fireEvent.click(screen.getByText('记时间点'));
    expect(onInsert).toHaveBeenCalledWith('[▶ 0:00](#vn=0) 胃的运动形式 #生理 #重点');
  });

  it('编辑器没接（没打开笔记）时提示，而不是静默失败', () => {
    setup({ onInsert: () => false });
    fireEvent.click(screen.getByText('记时间点'));
    // 提示走 core/feedback 的 toast（挂在 document.body 上），面板不因此抛错
    expect(screen.getByText(/先打开一篇笔记/)).toBeTruthy();
    expect(screen.getByText('记时间点')).toBeTruthy();
  });

  it('收藏片段后立刻出现在清单里', () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText(/这一段是什么/), { target: { value: '胃的运动形式' } });
    fireEvent.click(screen.getByText('收藏片段'));
    expect(screen.getByText('胃的运动形式')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('knowlattice-video-clips') ?? '[]')).toHaveLength(1);
  });

  it('备注框里按 Ctrl/⌘+Enter 可直接收藏片段', () => {
    setup();
    const note = screen.getByPlaceholderText(/这一段是什么/);
    fireEvent.change(note, { target: { value: '胃的运动形式' } });
    fireEvent.keyDown(note, { key: 'Enter', ctrlKey: true });
    expect(screen.getByText('胃的运动形式')).toBeTruthy();
  });

  it('收藏的片段可以一次整理成 Markdown 插回正文', () => {
    const { onInsert } = setup();
    fireEvent.change(screen.getByPlaceholderText(/这一段是什么/), { target: { value: '胃的运动形式' } });
    fireEvent.change(screen.getByPlaceholderText(/标签，用空格分开/), { target: { value: '生理 重点' } });
    fireEvent.click(screen.getByText('收藏片段'));
    fireEvent.click(screen.getByText('全部入笔记'));
    expect(onInsert).toHaveBeenCalledWith('- [▶ 0:00](#vn=0) 胃的运动形式 #生理 #重点');
  });

  it('单条片段也能直接插回正文', () => {
    const { onInsert } = setup();
    fireEvent.change(screen.getByPlaceholderText(/这一段是什么/), { target: { value: '胃的运动形式' } });
    fireEvent.click(screen.getByText('收藏片段'));
    fireEvent.click(screen.getByLabelText('把片段 0:00 插入笔记'));
    expect(onInsert).toHaveBeenCalledWith('- [▶ 0:00](#vn=0) 胃的运动形式');
  });

  it('画面没准备好时不截帧、不写附件', async () => {
    const { onAttach } = setup({ media: 'blob:x' });
    fireEvent.click(screen.getByText('截当前帧'));
    await Promise.resolve();
    expect(onAttach).not.toHaveBeenCalled();
  });

  it('提供可拖动、可键盘调整、可双击复位的缩放抓手', () => {
    const onResizeStart = vi.fn();
    const onResizeKeyDown = vi.fn();
    const onResizeReset = vi.fn();
    setup({ onResizeStart, onResizeKeyDown, onResizeReset });
    const handle = screen.getByLabelText('调整视频窗口大小');

    fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.doubleClick(handle);

    expect(onResizeStart).toHaveBeenCalledTimes(1);
    expect(onResizeKeyDown).toHaveBeenCalledTimes(1);
    expect(onResizeReset).toHaveBeenCalledTimes(1);
  });

  it('元数据就绪后可以用进度条精确定位', () => {
    setup();
    const video = document.querySelector('video');
    expect(video).toBeTruthy();
    Object.defineProperty(video, 'duration', { configurable: true, value: 120 });
    fireEvent.loadedMetadata(video!);
    fireEvent.change(screen.getByLabelText('播放进度'), { target: { value: '42' } });
    expect(video!.currentTime).toBe(42);
  });

  it('播到已收藏区间时在清单里标出当前片段', () => {
    addClip({ media: '生理学-01.mp4', start: 10, end: 30, label: '胃的运动形式', tags: [] });
    setup();
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'duration', { configurable: true, value: 120 });
    fireEvent.loadedMetadata(video);
    video.currentTime = 15;
    fireEvent.timeUpdate(video);
    expect(screen.getByText('胃的运动形式').closest('li')?.classList.contains('is-active')).toBe(true);
  });

  it('区间片段可以一键设为 A-B 复读', () => {
    addClip({ media: '生理学-01.mp4', start: 10, end: 30, label: '胃的运动形式', tags: [] });
    setup();
    fireEvent.click(screen.getByLabelText('把片段 A-B 循环设为 0:10–0:30'));
    expect(screen.getByText('设 A（0:10）')).toBeTruthy();
    expect(screen.getByText('设 B（0:30）')).toBeTruthy();
    expect(document.querySelector('video')!.currentTime).toBe(10);
  });
});

describe('链接来源', () => {
  it('粘 B 站链接交给上层打开（面板不自己存来源）', () => {
    const { onUrl } = setup();
    fireEvent.change(screen.getByPlaceholderText(/粘贴视频链接/), {
      target: { value: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    });
    fireEvent.click(screen.getByText('打开链接'));
    expect(onUrl).toHaveBeenCalledWith('https://www.bilibili.com/video/BV1xx411c7mD');
  });

  it('B 站来源走原生播放（默认），不出 iframe；未登录时给登录入口', () => {
    const { container } = render(
      <VideoNoteView
        {...({
          media: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
          title: 'B站 BV1xx411c7mD · P2',
          onPick: vi.fn(),
          onUrl: vi.fn(),
          onInsert: vi.fn(() => true),
          onAttach: vi.fn(async () => null),
          onClose: vi.fn(),
        } as React.ComponentProps<typeof VideoNoteView>)}
      />,
    );
    // 默认走原生播放：只有它读得到进度、能按账号权益切清晰度
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('input[placeholder*="SESSDATA"]')).not.toBeNull();
  });

  it('读不到进度的来源：手填时间才能记锚点', () => {
    const onInsert = vi.fn(() => true);
    render(
      <VideoNoteView
        {...({
          media: 'https://www.douyin.com/video/7412345678901234',
          onPick: vi.fn(),
          onUrl: vi.fn(),
          onInsert,
          onAttach: vi.fn(async () => null),
          onClose: vi.fn(),
        } as React.ComponentProps<typeof VideoNoteView>)}
      />,
    );
    // 没填时间时不许假装成功
    fireEvent.click(screen.getByText('记时间点'));
    expect(onInsert).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText(/时间 12:34/), { target: { value: '12:34' } });
    fireEvent.click(screen.getByText('记时间点'));
    expect(onInsert).toHaveBeenCalledWith('[▶ 12:34](#vn=754)');
  });

  it('B 站分P显示关联课程：能打开课程笔记 / 返回课程工坊', () => {
    const onOpenCourseNote = vi.fn();
    const onOpenCourse = vi.fn();
    setup({
      media: 'bili:BV1xx411c7mD:p3',
      src: null,
      course: {
        bvid: 'BV1xx411c7mD',
        page: 3,
        courseTitle: '病理学',
        part: '炎症',
        notePath: 'B站课程/病理学.md',
        noteTitle: '病理学',
      },
      onOpenCourseNote,
      onOpenCourse,
    });

    expect(screen.getByText('课程')).toBeTruthy();
    expect(screen.getByText('P3 · 炎症')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开课程笔记' }));
    expect(onOpenCourseNote).toHaveBeenCalledWith('B站课程/病理学.md');
    fireEvent.click(screen.getByRole('button', { name: '返回课程工坊' }));
    expect(onOpenCourse).toHaveBeenCalledWith('BV1xx411c7mD');
  });

  it('网盘来源给「打开原页」，且在浏览器里落到该秒', () => {    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(
      <VideoNoteView
        {...({
          media: 'https://pan.baidu.com/s/1abcdEFG',
          onPick: vi.fn(),
          onUrl: vi.fn(),
          onInsert: vi.fn(() => true),
          onAttach: vi.fn(async () => null),
          onClose: vi.fn(),
        } as React.ComponentProps<typeof VideoNoteView>)}
      />,
    );
    expect(screen.getByText(/网盘分享页要登录/)).toBeTruthy();
    fireEvent.click(screen.getByText('打开原页'));
    expect(open).toHaveBeenCalledWith('https://pan.baidu.com/s/1abcdEFG', '_blank', 'noopener');
    open.mockRestore();
  });

  it('传了抓手才显示拖动 affordance（title 提示 + 双击复位）', () => {
    const onDragReset = vi.fn();
    const { container } = render(
      <VideoNoteView
        {...({
          media: 'clips/panel-drag.mp4',
          onPick: vi.fn(),
          onUrl: vi.fn(),
          onInsert: vi.fn(() => true),
          onAttach: vi.fn(async () => null),
          onClose: vi.fn(),
          onDragStart: vi.fn(),
          onDragReset,
        } as React.ComponentProps<typeof VideoNoteView>)}
      />,
    );
    const head = container.querySelector('.vn__head--drag');
    expect(head?.getAttribute('title')).toContain('拖动');
    fireEvent.doubleClick(head!);
    expect(onDragReset).toHaveBeenCalled();
  });

  it('停靠进右栏（不传抓手）时不显示拖动 affordance：类名与 title 都不出现', () => {
    // 停靠态的尺寸由整栏抓手/分隔条负责；标题栏若仍挂 grab 光标与「拖动可移动面板」，
    // 就是在承诺一个做不到的动作（这是实测中 P4 的表现）。
    const { container } = render(
      <VideoNoteView
        {...({
          media: 'clips/panel-dock.mp4',
          onPick: vi.fn(),
          onUrl: vi.fn(),
          onInsert: vi.fn(() => true),
          onAttach: vi.fn(async () => null),
          onClose: vi.fn(),
        } as React.ComponentProps<typeof VideoNoteView>)}
      />,
    );
    const head = container.querySelector('header.vn__head');
    expect(head).toBeTruthy();
    expect(head!.className).not.toContain('vn__head--drag');
    expect(head!.getAttribute('title')).toBeNull();
  });
});

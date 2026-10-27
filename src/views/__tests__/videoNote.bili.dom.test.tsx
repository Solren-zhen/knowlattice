/**
 * @vitest-environment jsdom
 *
 * B 站原生播放器是异步取流后才挂 <video> 的。这个测试把播放器替成“元数据一就绪就通知上层”的
 * 最小壳，钉住面板必须在那一刻才开放自动记时、截帧和 A-B 控件，不能拿默认 0 秒冒充真实进度。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../BiliPlayer', async () => {
  const React = await import('react');
  const MockBiliPlayer = ({ videoRef, onReady }: {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    onReady?: (video: HTMLVideoElement) => void;
  }) => {
    const attach = React.useCallback((node: HTMLVideoElement | null) => {
      videoRef.current = node;
    }, [videoRef]);
    React.useEffect(() => {
      const video = videoRef.current;
      if (!video) return;
      Object.defineProperty(video, 'duration', { configurable: true, value: 120 });
      onReady?.(video);
    }, [onReady, videoRef]);
    return <video ref={attach} />;
  };
  return { default: MockBiliPlayer };
});

import VideoNoteView from '../VideoNoteView';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('B 站原生播放', () => {
  it('播放器就绪后能读当前时间、自动记锚点并截帧', async () => {
    const onInsert = vi.fn(() => true);
    render(
      <VideoNoteView
        media="https://www.bilibili.com/video/BV1xx411c7mD"
        onPick={vi.fn()}
        onUrl={vi.fn()}
        onInsert={onInsert}
        onAttach={vi.fn(async () => null)}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.queryByText('截当前帧')).not.toBeNull());
    const video = document.querySelector('video')!;
    video.currentTime = 12.8;
    fireEvent.timeUpdate(video);
    fireEvent.click(screen.getByText('记时间点'));

    expect(onInsert).toHaveBeenCalledWith('[▶ 0:12](#vn=12)');
  });
});

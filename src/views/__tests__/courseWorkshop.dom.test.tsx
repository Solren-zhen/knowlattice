// @vitest-environment jsdom
/**
 * 课程工坊 ↔ 视频笔记的接线：
 *   1. 从视频笔记带 initialBvid 进来，能直接读取课程；
 *   2. 每个分P 的「▶」把 { bvid, page, part, courseTitle } 交给 Workspace；
 *   3. 登录提示有直接入口；
 *   4. 读取后把课程大纲交给 Workspace（视频面板据此显示课程名/分P名）。
 *
 * B 站接口与 AI 配置都走 mock：这里验的是接线，不联网。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CourseWorkshopView from '../CourseWorkshopView';
import { resetWorkshopSessionForTests } from '../../core/courseSession';

const { fetchViewMock } = vi.hoisted(() => ({ fetchViewMock: vi.fn() }));

vi.mock('../../core/biliPlay', () => ({
  fetchView: fetchViewMock,
  loadAccount: () => null,
}));

vi.mock('../../core/agentSettings', () => ({
  loadAgentSettings: () => null,
}));

const VIEW = {
  bvid: 'BV1xx411c7mD',
  title: '测试课程',
  duration: 600,
  cid: 1,
  owner: '某讲师',
  parts: [
    { page: 1, cid: 11, part: '总论', duration: 300 },
    { page: 2, cid: 12, part: '发热', duration: 300 },
  ],
};

function props(over: Partial<React.ComponentProps<typeof CourseWorkshopView>> = {}) {
  return {
    onClose: vi.fn(),
    onToast: vi.fn(),
    docs: new Map<string, string>(),
    onSave: vi.fn(async () => {}),
    createNote: vi.fn(async () => 'B站课程/测试课程.md'),
    onOpenNote: vi.fn(),
    onOpenVideo: vi.fn(),
    onCourseMeta: vi.fn(),
    ...over,
  } as React.ComponentProps<typeof CourseWorkshopView>;
}

beforeEach(() => {
  localStorage.clear();
  resetWorkshopSessionForTests();
  fetchViewMock.mockReset();
  fetchViewMock.mockResolvedValue(VIEW);
});

afterEach(() => cleanup());

describe('课程工坊 · 与视频笔记联动', () => {
  it('带 initialBvid 直接读取课程，分P按钮把目标交给视频笔记', async () => {
    const p = props({ initialBvid: VIEW.bvid });
    render(<CourseWorkshopView {...p} />);

    await waitFor(() => expect(screen.getByRole('heading', { name: '测试课程' })).toBeTruthy());
    expect(fetchViewMock).toHaveBeenCalledWith(VIEW.bvid, null);
    // 大纲交给 Workspace：视频面板靠它显示课程名 / 分P名
    await waitFor(() =>
      expect(p.onCourseMeta).toHaveBeenCalledWith({
        bvid: VIEW.bvid,
        title: '测试课程',
        owner: '某讲师',
        parts: [
          { page: 1, part: '总论' },
          { page: 2, part: '发热' },
        ],
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: '播放 P2 发热' }));
    expect(p.onOpenVideo).toHaveBeenCalledWith({
      bvid: VIEW.bvid,
      page: 2,
      part: '发热',
      courseTitle: '测试课程',
    });
  });

  it('未登录时给出「去视频笔记登录」的直接入口', async () => {
    const p = props({ initialBvid: VIEW.bvid });
    render(<CourseWorkshopView {...p} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: '测试课程' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '去视频笔记登录' }));
    expect(p.onOpenVideo).toHaveBeenCalledWith({
      bvid: VIEW.bvid,
      page: 1,
      part: '总论',
      courseTitle: '测试课程',
    });
  });
});

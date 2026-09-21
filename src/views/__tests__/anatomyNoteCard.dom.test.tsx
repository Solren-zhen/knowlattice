// @vitest-environment jsdom
/**
 * 结构笔记卡片 DOM 测试（jsdom，不挂 WebGL）：
 * 守住「点结构 → 卡片浮在点击点旁 + 正文/空态 + CTA 接对回调」这条链路。
 * 定位数值由 core/anatomyCard 的纯函数决定（那边已有单测），这里只验接线是否真的接上。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AnatomyNoteCard from '../AnatomyNoteCard';
import type { ManifestOrgan } from '../../core/anatomy';
import { CARD_ESTIMATE } from '../../core/anatomyCard';

// jsdom 没有 ResizeObserver（卡片用它跟随舞台/自身尺寸变化）
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ROStub;

beforeAll(() => {
  // 中文词典拉取一律失败：卡片走「词典缺失回退英文名」的分支，不依赖网络
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
});

afterEach(() => cleanup());

const organ: ManifestOrgan = {
  organ_id: 'FMA-24474',
  ta2_latin: 'Femur',
  name_en: 'Femur',
  system: 'skeletal',
  mesh_file: 'skeletal.glb',
  node: 'Femur_l',
  path: ['Lower limb', 'Bones'],
};

/** 舞台：左 100 / 上 50 / 800×600，与 anatomyCard 单测同一组数值 */
function makeStage(): HTMLDivElement {
  const stage = document.createElement('div');
  stage.getBoundingClientRect = () => ({
    left: 100, top: 50, width: 800, height: 600,
    right: 900, bottom: 650, x: 100, y: 50, toJSON: () => ({}),
  }) as DOMRect;
  return stage;
}

function renderCard(overrides: Partial<Parameters<typeof AnatomyNoteCard>[0]> = {}) {
  const props = {
    organ,
    anchor: { x: 300, y: 250 },
    stage: makeStage(),
    resolve: (() => null) as (n: string) => string | null,
    readFile: (() => undefined) as (p: string) => string | undefined,
    onOpenNote: vi.fn(),
    onOpenLink: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<AnatomyNoteCard {...props} />), props };
}

describe('AnatomyNoteCard', () => {
  it('笔记存在：渲染笔记正文，CTA 变成「在编辑器中打开」', async () => {
    const { props } = renderCard({
      resolve: (n) => (n === 'Femur' ? '08-解剖学/骨骼/股骨.md' : null),
      readFile: (p) => (p === '08-解剖学/骨骼/股骨.md' ? '# 股骨\n\n- 定义: 大腿唯一的长骨' : undefined),
    });

    // 正文由 markdown-it 异步渲染（「- 定义: x」会被拆成 prop-key 加粗 + 文本节点，故用正则匹配）
    await waitFor(() => expect(screen.getByText(/大腿唯一的长骨/)).toBeTruthy());
    expect(screen.getByText('股骨')).toBeTruthy(); // 一级标题
    expect(screen.getByText('在编辑器中打开 →')).toBeTruthy();
    expect(screen.getByText('08-解剖学/骨骼/股骨.md')).toBeTruthy();

    fireEvent.click(screen.getByText('在编辑器中打开 →'));
    expect(props.onOpenNote).toHaveBeenCalledWith(organ);
  });

  it('没有笔记：显示空态与「创建笔记」，不渲染正文', () => {
    const { container } = renderCard();
    expect(screen.getByText('这个结构还没有笔记')).toBeTruthy();
    expect(screen.getByText('创建笔记 →')).toBeTruthy();
    expect(container.querySelector('.anatomy-note-card__body .preview')).toBeNull();
    expect(screen.getByText('（尚未创建）')).toBeTruthy();
  });

  it('中文名接不回笔记时回退英文名（词典缺失场景）', async () => {
    const seen: string[] = [];
    renderCard({
      resolve: (n) => { seen.push(n); return n === 'Femur' ? '08-解剖学/骨骼/股骨.md' : null; },
      readFile: () => '# 股骨',
    });
    await waitFor(() => expect(seen).toContain('Femur'));
    expect(screen.getByText('Femur')).toBeTruthy(); // 标题回退英文
  });

  it('关闭按钮回传 onClose', () => {
    const { props } = renderCard();
    fireEvent.click(screen.getByLabelText('关闭笔记卡片'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('卡片落在点击点右下（相对舞台坐标），绘制前就已可见', async () => {
    const { container } = renderCard();
    const card = container.querySelector<HTMLElement>('.anatomy-note-card')!;
    // anchor(300,250) 相对舞台(100,50) = (200,200)，偏移 16 → (216,216)
    await waitFor(() => expect(card.style.left).toBe('216px'));
    expect(card.style.top).toBe('216px');
    expect(card.style.visibility).toBe('visible');
  });

  it('没有点击点（从列表选中）时停靠左上角', async () => {
    const { container } = renderCard({ anchor: null });
    const card = container.querySelector<HTMLElement>('.anatomy-note-card')!;
    await waitFor(() => expect(card.style.visibility).toBe('visible'));
    expect(card.style.left).toBe('12px');
    expect(Number.parseInt(card.style.top, 10)).toBeGreaterThanOrEqual(48);
  });

  it('点靠近右边缘时翻到光标左侧且不越界（jsdom 下按估计尺寸算）', async () => {
    const { container } = renderCard({ anchor: { x: 100 + 790, y: 250 } });
    const card = container.querySelector<HTMLElement>('.anatomy-note-card')!;
    await waitFor(() => expect(card.style.visibility).toBe('visible'));
    const left = Number.parseInt(card.style.left, 10);
    expect(left).toBe(790 - CARD_ESTIMATE.width - 16);
    expect(left + CARD_ESTIMATE.width).toBeLessThanOrEqual(800 - 12);
  });
});

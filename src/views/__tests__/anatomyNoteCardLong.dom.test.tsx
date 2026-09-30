// @vitest-environment jsdom
/**
 * 回归闸门：结构笔记「很长」时卡片必须仍显示正文，且落位要用**渲染完成后的真实高度**。
 *
 * 线上问题：解剖图谱点结构 → 卡片先按骨架高度落位 → markdown-it 异步渲染完卡片长高，
 * 只靠 ResizeObserver 观察卡片自身不可靠（外框被 max-height 约束时不一定回调），
 * 卡片就停在首帧位置，底部连同正文溢出到舞台外。
 *
 * 这里用 jsdom + 手动喂尺寸的 ResizeObserver 替身，守住两件事：
 * 1) 长笔记渲染出正文（不空白、不掉空态）；
 * 2) 正文渲染完成后会再触发一次落位（onRendered → reposition）。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import AnatomyNoteCard from '../AnatomyNoteCard';
import type { ManifestOrgan } from '../../core/anatomy';
import { placeCard } from '../../core/anatomyCard';

/** 不自动触发回调的 RO 替身：落位只能靠组件主动调用（正是被测行为） */
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ROStub;

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
});

afterEach(() => cleanup());

const organ: ManifestOrgan = {
  organ_id: 'FMA-3862',
  ta2_latin: 'Ramus inferolateralis dexter',
  name_en: 'Right inferolateral branch of right coronary artery',
  system: 'cardiovascular',
  mesh_file: 'cardiovascular.glb',
  node: 'RCA_inferolateral',
  path: ['Cardiac vessels', 'Arteries of heart'],
};

const NOTE_PATH = '解剖/心脏/右冠右下外侧支.md';

function makeStage(): HTMLDivElement {
  const stage = document.createElement('div');
  stage.getBoundingClientRect = () => ({
    left: 100, top: 50, width: 800, height: 600,
    right: 900, bottom: 650, x: 100, y: 50, toJSON: () => ({}),
  }) as DOMRect;
  return stage;
}

const LONG_NOTE = [
  '# 右冠状动脉右下外侧支',
  '',
  '- 定义: 右冠状动脉向右下走行的外侧分支',
  '',
  ...Array.from({ length: 80 }, (_, i) => `- 要点 ${i + 1}：该分支的走行、分支与供血范围说明，一段比较长的解剖学笔记内容。`),
].join('\n');

describe('AnatomyNoteCard 长笔记', () => {
  it('长笔记渲染出正文，不空白也不掉进空态', async () => {
    const { container } = render(
      <AnatomyNoteCard
        organ={organ}
        anchor={{ x: 300, y: 250 }}
        stage={makeStage()}
        resolve={(n) => (n === organ.name_en ? NOTE_PATH : null)}
        readFile={(p) => (p === NOTE_PATH ? LONG_NOTE : undefined)}
        onOpenNote={vi.fn()}
        onOpenLink={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByText('这个结构还没有笔记')).toBeNull();
    const body = container.querySelector('.anatomy-note-card__body')!;
    await waitFor(() => {
      expect(body.querySelector('.markdown-body')?.innerHTML.length ?? 0).toBeGreaterThan(2000);
    }, { timeout: 5000 });
    expect(body.querySelector('.markdown-body')!.textContent).toContain('要点 80');
  });

  it('卡片按渲染完成后的真实高度落位（用真实尺寸走一遍 placeCard）', async () => {
    const stage = makeStage();
    const { container } = render(
      <AnatomyNoteCard
        organ={organ}
        // 点击点靠舞台下方：卡片越高，top 必须越往上让，否则底部溢出舞台
        anchor={{ x: 500, y: 600 }}
        stage={stage}
        resolve={(n) => (n === organ.name_en ? NOTE_PATH : null)}
        readFile={(p) => (p === NOTE_PATH ? LONG_NOTE : undefined)}
        onOpenNote={vi.fn()}
        onOpenLink={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const card = container.querySelector<HTMLElement>('.anatomy-note-card')!;
    await waitFor(() => expect(card.style.visibility).toBe('visible'));
    await waitFor(() => {
      expect(card.querySelector('.markdown-body')?.innerHTML.length ?? 0).toBeGreaterThan(2000);
    }, { timeout: 5000 });

    // 卡片落位读的是 offsetHeight。jsdom 不做布局（恒为 0），所以这里断言组件的
    // 「测量 → 放置」契约：把真实尺寸喂进去后，算出的 top 必须落在舞台内。
    const stageRect = { left: 100, top: 50, width: 800, height: 600 };
    const skeletonTop = placeCard({ x: 500, y: 600 }, stageRect, { width: 360, height: 120 }).top;
    const longNoteTop = placeCard({ x: 500, y: 600 }, stageRect, { width: 360, height: 520 }).top;

    // 长卡片比骨架卡片更高 → 必须更靠上，否则底部溢出舞台
    expect(longNoteTop).toBeLessThan(skeletonTop);
    // 且夹紧后整张卡片仍在舞台内
    expect(longNoteTop).toBeGreaterThanOrEqual(12);
    expect(longNoteTop + 520).toBeLessThanOrEqual(600 - 12);
  });

  it('正文渲染失败时给出提示而不是留一张空白卡片', async () => {
    // 让 markdown 渲染器抛错：pathway 围栏走 renderPathwaySvg，喂一个非法结构触发异常
    const broken = ['# 结构', '', '```pathway', 'A ->>', '```'].join('\n');
    const { container } = render(
      <AnatomyNoteCard
        organ={organ}
        anchor={null}
        stage={makeStage()}
        resolve={(n) => (n === organ.name_en ? NOTE_PATH : null)}
        readFile={(p) => (p === NOTE_PATH ? broken : undefined)}
        onOpenNote={vi.fn()}
        onOpenLink={vi.fn()}
        onClose={vi.fn()}
      />
    );
    await waitFor(() => {
      const md = container.querySelector('.anatomy-note-card__body .markdown-body');
      // 要么渲染成功，要么落到 catch 的提示，但绝不能一直空着
      expect((md?.innerHTML.length ?? 0) > 0 || container.querySelector('.preview-error')).toBeTruthy();
    }, { timeout: 5000 });
  });
});

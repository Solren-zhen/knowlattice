// @vitest-environment jsdom
/**
 * 「学习报告」接线（views/Workspace.tsx 的 openStudyReport + views/StudyReportPanel）的 DOM 测试。
 *
 * 守的是**接线与口径**，不是 core/studyReport 的聚合逻辑（那些数字有自己的单测）：
 *   1. 工具栏入口在，没点开时**不渲染**任何面板（不预跑聚合）；
 *   2. 点开后渲染模态面板，且数据真的来自既有数据线 ——
 *      题库（IndexedDB 异步）：概览里出现「题目 1 道」；
 *      逐题记录为空：如实写「还没有作答记录 … 正确率无从计算（不写 0%）」；
 *      错题本（localStorage）：错题分布里出现那条错题的标题；
 *      复习卡：由当前笔记的 `##` 小节切出（buildCards）。
 *   3. 点遮罩能关闭（面板把 onClose 挂在 .panel-backdrop 上）。
 *   4. 时间范围档位：默认「全部（累计）」= 不传 range 的累计口径；切到「近 7 天」后由 Workspace
 *      重算（面板只发档位），正文改成日期区间，且仍写明「题目练习仍是累计值」。
 *
 * 环境垫片只有一处：jsdom 没有 ResizeObserver（ChapterTree 虚拟滚动要用）。
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
/** 带一个 `##` 小节：core/srsCards 的规则是「一个小节 = 一张卡」，复习卡一节才有数 */
const NOTE_CONTENT =
  '---\ntitle: 波尔效应\ntype: concept\n---\n\n# 波尔效应\n\n## 解离曲线\n\npH 降低时氧解离曲线右移。\n';

/**
 * 错题本是 core/mistakes 的**模块级缓存**（只 JSON.parse 一次，见其 ensureCache），
 * 所以每个用例都种同一份：先跑的用例要是把空表缓存住了，后面的用例就种不进去了。
 */
const MISTAKES = {
  [NOTE_PATH]: {
    path: NOTE_PATH,
    chapter: '呼吸',
    title: '笔记甲',
    count: 2,
    lastFailedAt: Date.UTC(2026, 0, 15),
  },
};

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem('knowlattice-mistakes', JSON.stringify(MISTAKES));

  const db = await openDB('knowlattice', 2, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'path' });
      if (!d.objectStoreNames.contains('attachments')) d.createObjectStore('attachments', { keyPath: 'path' });
    },
  });
  await db.put('files', { path: NOTE_PATH, content: NOTE_CONTENT, mtime: Date.now(), size: 10 });
  db.close();

  // 题库是**独立库**（storage/qbank：knowlattice-qbank v2）。只种题库、不种逐题记录：
  // 报告应当如实说「还没有作答记录」，而不是编一个 0% —— 这正是这条断言要守的口径。
  const qb = await openDB('knowlattice-qbank', 2, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('banks')) d.createObjectStore('banks', { keyPath: 'name' });
      if (!d.objectStoreNames.contains('stats')) {
        const stats = d.createObjectStore('stats', { keyPath: ['bank', 'qid'] });
        stats.createIndex('bank', 'bank');
      }
      if (!d.objectStoreNames.contains('stars')) {
        const stars = d.createObjectStore('stars', { keyPath: ['bank', 'qid'] });
        stars.createIndex('bank', 'bank');
      }
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    },
  });
  await qb.put('banks', {
    name: '题库甲',
    importedAt: 1,
    questions: [
      {
        id: 'q1',
        type: 'choice',
        stem: '氧解离曲线右移的意义是？',
        options: ['容易放氧', '容易结合氧'],
        answer: 0,
        answerText: '容易放氧',
        chapter: '生理学',
      },
    ],
  });
  qb.close();
});

afterEach(() => cleanup());

/** 从目录树打开笔记（与 workspace.smoke 同一个入口），等到笔记区渲染出来 */
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
  await waitFor(() => expect(screen.getByLabelText('生成本次学习报告')).toBeTruthy(), { timeout: 8000 });
}

describe('Workspace 学习报告入口', () => {
  it('入口在，但没点开时不渲染面板（聚合只在点开时跑）', async () => {
    const { container } = render(<Workspace />);
    await openNote(container);

    const entry = screen.getByLabelText('生成本次学习报告');
    expect(entry.getAttribute('data-tip')).toBe('生成本次学习报告');
    expect(container.querySelector('.panel-backdrop')).toBeNull();
  }, 30000);

  it('点开后渲染报告（题库 / 错题本 / 复习卡三条数据线都接上），点遮罩关闭', async () => {
    const { container } = render(<Workspace />);
    await openNote(container);

    fireEvent.click(screen.getByLabelText('生成本次学习报告'));
    await waitFor(() => expect(container.querySelector('.panel-backdrop')).toBeTruthy(), { timeout: 8000 });

    const text = container.querySelector('.panel-backdrop')!.textContent ?? '';
    expect(text).toContain('本次学习报告');
    // 小节齐全（core/studyReport 的固定输出）
    expect(text).toContain('下一步建议');
    expect(text).toContain('口径说明');
    // 题库来自 IndexedDB 的异步读取（loadBanks → bankProgress）
    expect(text).toContain('题目 1 道');
    // 没有作答记录时如实说「无从计算」，不写 0%
    expect(text).toContain('还没有作答记录');
    // 错题本（localStorage → loadMistakes）
    expect(text).toContain('「笔记甲」');
    // 复习卡：由当前笔记的 `##` 小节切出（buildCards）
    expect(text).toContain('卡片：共 1 张');

    // 面板把 onClose 挂在遮罩上（见 StudyReportPanel 的根 div）
    fireEvent.click(container.querySelector('.panel-backdrop')!);
    await waitFor(() => expect(container.querySelector('.panel-backdrop')).toBeNull());
  }, 30000);

  it('面板里能切时间范围：默认「全部（累计）」，切到近 7 天后重算并写明口径', async () => {
    const { container } = render(<Workspace />);
    await openNote(container);
    fireEvent.click(screen.getByLabelText('生成本次学习报告'));
    await waitFor(() => expect(container.querySelector('.panel-backdrop')).toBeTruthy(), { timeout: 8000 });

    const backdropText = () => container.querySelector('.panel-backdrop')!.textContent ?? '';
    // 默认档必须是「全部（累计）」：正文与不传 range 时一致（累计口径）
    expect(screen.getByRole('button', { name: '全部（累计）' }).getAttribute('aria-pressed')).toBe('true');
    expect(backdropText()).toContain('（按累计口径）');

    // 切到近 7 天：档位交给 Workspace，由它在事件里重算（面板自己不读存储）
    fireEvent.click(screen.getByRole('button', { name: '近 7 天' }));
    await waitFor(
      () => expect(screen.getByRole('button', { name: '近 7 天' }).getAttribute('aria-pressed')).toBe('true'),
      { timeout: 8000 }
    );

    // 概览里的「（按累计口径）」换成具体日期区间
    expect(backdropText()).not.toContain('（按累计口径）');
    expect(backdropText()).toContain('时间范围：');
    // 范围只切带时间戳的字段：题目练习一节仍如实声明自己是累计口径
    expect(backdropText()).toContain('本节是累计口径');
    // 面板上必须写明这一点，否则用户会以为题目练习的数字也被过滤了
    expect(backdropText()).toContain('题目练习仍是累计值');

    // 切回「全部（累计）」：回到与默认同口径的正文
    fireEvent.click(screen.getByRole('button', { name: '全部（累计）' }));
    await waitFor(
      () => expect(screen.getByRole('button', { name: '全部（累计）' }).getAttribute('aria-pressed')).toBe('true'),
      { timeout: 8000 }
    );
    expect(backdropText()).toContain('（按累计口径）');
  }, 30000);
});

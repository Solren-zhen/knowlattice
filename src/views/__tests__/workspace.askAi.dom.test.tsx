// @vitest-environment jsdom
/**
 * 全链路验收：编辑器选中 → 右键「问 AI」→ AI 笔记面板出现并带上那段原文。
 *
 * 覆盖的是此前**完全没人守**的两段：
 *   · Workspace 的桥接（onAskAi → agentQuote → quote prop → 打开面板）
 *   · AiAgentPanel 的消费（quote prop → 待发送 chip）
 * 已有的 aiAgentPanel 测试是直接喂 quote prop 的，桥接断了它照样绿；
 * editorAskAi 测试只到 Editor 的回调为止。这条把两头接起来。
 */
import 'fake-indexeddb/auto';
import '@earendil-works/pi-agent-core';
import '@earendil-works/pi-ai/api/openai-completions';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { openDB } from 'idb';
import { EditorView } from '@codemirror/view';
import Workspace from '../Workspace';

// jsdom 缺的几样
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ROStub;
Element.prototype.scrollIntoView = () => {};
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const NOTE = { path: '心脏.md', content: '# 心脏\n\n心肌收缩泵血，舒张充盈。\n', mtime: Date.now(), size: 10 };

async function seed() {
  const db = await openDB('knowlattice', 2, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'path' });
      if (!d.objectStoreNames.contains('attachments')) d.createObjectStore('attachments', { keyPath: 'path' });
    },
  });
  await db.put('files', NOTE);
  db.close();
}

beforeAll(async () => {
  localStorage.clear();
  await seed();
});

/** 打开「心脏」这篇，返回 CodeMirror 视图 */
async function openNoteAndGetView(container: HTMLElement) {
  await waitFor(() => {
    const rows = [...container.querySelectorAll('.tree-row.file')];
    if (!rows.some((r) => r.textContent?.includes('心脏'))) throw new Error('目录尚未列出「心脏」');
  });
  const row = [...container.querySelectorAll('.tree-row.file')].find((r) => r.textContent?.includes('心脏')) as HTMLElement;
  fireEvent.click(row);
  await waitFor(() => expect(container.querySelector('.cm-content')?.textContent).toContain('心肌收缩泵血'), { timeout: 8000 });
  const content = container.querySelector<HTMLElement>('.cm-content')!;
  const view = EditorView.findFromDOM(content);
  expect(view).toBeTruthy();
  return { content, view: view! };
}

describe('编辑器选中 → 问 AI → 面板带原文', () => {
  it('右键菜单点「问 AI」后，AI 笔记面板打开且 chip 里是选中的那段原文', async () => {
    localStorage.setItem('knowlattice-ai-agent-settings', JSON.stringify({ baseUrl: 'https://mock.local/v1', apiKey: 'sk-test', model: 'mock' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    const { container } = render(<Workspace />);
    const { content, view } = await openNoteAndGetView(container);

    // 造一个真实选区
    const doc = view.state.doc.toString();
    const from = doc.indexOf('心肌收缩泵血');
    expect(from).toBeGreaterThanOrEqual(0);
    view.dispatch({ selection: { anchor: from, head: from + '心肌收缩泵血'.length } });

    // 右键 → 点「问 AI」
    fireEvent.contextMenu(content, { clientX: 40, clientY: 60, button: 2 });
    await waitFor(() => expect(container.querySelector('.cm-ctx-menu')).toBeTruthy(), { timeout: 8000 });
    fireEvent.click(screen.getByText(/问 AI/).closest('button')!);

    // 面板必须打开，并且 chip 里有那段原文
    const chip = await screen.findByLabelText('已附加选段', {}, { timeout: 10000 });
    expect(chip.textContent).toContain('心肌收缩泵血');
    // 来源路径也要在（模型据此知道出自哪篇）
    expect(chip.textContent).toContain('心脏.md');

    cleanup();
    vi.unstubAllGlobals();
  }, 40000);
});

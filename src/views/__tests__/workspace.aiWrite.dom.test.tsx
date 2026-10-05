// @vitest-environment jsdom
/**
 * 回归：AI 助手改写的若是「当前打开的笔记」，编辑器必须跟着换内容。
 * 历史 bug（浏览器实测复现）：应用后编辑器仍显示旧正文，用户随后敲一个字，
 * 0.8s 自动保存就把 AI 刚写进去的整段改动顶回旧内容。
 */
import 'fake-indexeddb/auto';
import '@earendil-works/pi-agent-core';
import '@earendil-works/pi-ai/api/openai-completions';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { openDB } from 'idb';
import Workspace from '../Workspace';

// jsdom 没有 ResizeObserver（ChapterTree 虚拟滚动用到）
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ROStub;

const NOTE = { path: '心脏.md', content: '# 心脏\n心肌收缩泵血。\n', mtime: Date.now(), size: 10 };

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

const dataLine = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
/** 一轮 propose_note_patch 工具调用（参数分两片流式给出） */
const patchChunks = (find: string, replace: string) => [
  dataLine({ choices: [{ delta: { content: '我来做定点修改。' } }] }),
  dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'propose_note_patch', arguments: `{"path":"心脏.md","find_text":"${find}","replace_text":"${replace}` } }] } }] }),
  dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }] }),
];
const finalChunks = (text: string) => [dataLine({ choices: [{ delta: { content: text } }] }), 'data: [DONE]\n\n'];
const sse = (chunks: string[]) => new Response(new ReadableStream<Uint8Array>({
  start(c) { const enc = new TextEncoder(); for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
}), { status: 200 });

async function noteOnDisk(): Promise<string> {
  const db = await openDB('knowlattice', 2);
  const rec: unknown = await db.get('files', '心脏.md');
  db.close();
  if (rec && typeof rec === 'object' && 'content' in rec && typeof rec.content === 'string') return rec.content;
  return '';
}

beforeAll(async () => {
  localStorage.clear();
  await seed();
});

describe('AI 改写当前打开的笔记', () => {
  it('应用后编辑器跟着换内容，随后的自动保存不会把 AI 的改动顶回旧内容', async () => {
    localStorage.setItem('knowlattice-ai-agent-settings', JSON.stringify({ baseUrl: 'http://mock.local/v1', apiKey: 'sk-test', model: 'mock' }));
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      return call === 1
        ? sse(patchChunks('心肌收缩泵血。', '心肌收缩泵血，维持循环。'))
        : sse(finalChunks('改好了。'));
    }));

    const { container } = render(<Workspace />);
    await waitFor(() => {
      const rows = [...container.querySelectorAll('.tree-row.file')];
      if (!rows.some((r) => r.textContent?.includes('心脏'))) throw new Error('目录尚未列出「心脏」');
    });
    fireEvent.click([...container.querySelectorAll('.tree-row.file')].find((r) => r.textContent?.includes('心脏')) as HTMLElement);
    await waitFor(() => expect(container.querySelector('.cm-content')?.textContent).toContain('心肌收缩泵血'), { timeout: 8000 });

    fireEvent.click(screen.getByLabelText('AI 笔记'));
    const ta = await screen.findByLabelText('对 AI 笔记说点什么');
    fireEvent.change(ta, { target: { value: '改一下心肌那句', selectionStart: 8, selectionEnd: 8 } });
    const send = screen.getByRole('button', { name: '发送' }) as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);

    fireEvent.click(await screen.findByRole('button', { name: '应用修改' }, { timeout: 10000 }));

    // 编辑器必须显示 AI 写入后的正文（bug 时这里仍是旧的「心肌收缩泵血。」）
    await waitFor(() => expect(container.querySelector('.cm-content')?.textContent).toContain('维持循环'), { timeout: 8000 });
    // 磁盘上也必须是 AI 的版本（用户没再敲字，不该被任何自动保存顶回去）
    await waitFor(async () => expect(await noteOnDisk()).toContain('维持循环'));
    cleanup();
    vi.unstubAllGlobals();
  }, 30000);
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AiAgentPanel from '../AiAgentPanel';

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) { const enc = new TextEncoder(); for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
  });
  return new Response(stream, { status: 200 });
}
const dataLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('knowlattice-ai-agent-settings', JSON.stringify({
    baseUrl: 'http://mock.local/v1', apiKey: 'k', model: 'm',
  }));
});

describe('readonly flow debug', () => {
  it('step by step', async () => {
    const mock = vi.fn(async () => sseResponse([
      dataLine({ choices: [{ delta: { content: '只读回答。' } }] }),
      'data: [DONE]\n\n',
    ]));
    vi.stubGlobal('fetch', mock);
    render(<AiAgentPanel docs={new Map([['解剖/心脏.md', '# 心脏']])} onSave={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '🔒 只读' }));
    console.log('STEP1 readonly clicked, fetch calls:', mock.mock.calls.length);

    const ta = screen.getByLabelText('对 AI 笔记助手说点什么') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '帮我看看', selectionStart: 4, selectionEnd: 4 } });
    console.log('STEP2 typed, ta.value:', JSON.stringify(ta.value));

    const btn = screen.getByRole('button', { name: '发送' }) as HTMLButtonElement;
    console.log('STEP3 btn disabled:', btn.disabled);
    fireEvent.click(btn);
    console.log('STEP4 clicked, fetch calls:', mock.mock.calls.length);

    await new Promise((r) => setTimeout(r, 1500));
    console.log('STEP5 after 1.5s, fetch calls:', mock.mock.calls.length, '| msgs:', document.querySelectorAll('.agent-msg').length, '| log:', JSON.stringify((document.querySelector('.agent-log') as HTMLElement)?.innerText?.slice(0, 200)));
    expect(true).toBe(true);
  }, 15000);
});

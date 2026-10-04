/**
 * 回归：空 API Key 时 pi 引擎仍必须把请求发出去。
 *
 * 背景：pi-ai 的 openai-completions 在缺 key 时直接抛
 * `No API key for provider: ...`，而本项目的设置面板明确写着「本地服务可留空」
 * （Ollama / vLLM 这类无需鉴权的端点）。旧实现把空 key 原样透传（`|| undefined`），
 * 于是这类端点连一次请求都发不出去——工具调用自然全部不可用。
 * 面板的回退只在 PiUnavailableError（包加载失败）时触发，救不了这条路径。
 *
 * 这里起一个真实 HTTP 端点，断言请求确实到达；顺带断言没被前置拦截。
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { runPiAgent } from '../piAgent';
import type { RunAgentOptions } from '../aiAgent';

let server: Server | null = null;

function sseBody(text: string): string {
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'mock',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return chunk({ role: 'assistant', content: '' }) + chunk({ content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n';
}

async function startServer(reply: string): Promise<{ url: string; seen: () => boolean }> {
  let hit = false;
  server = createServer((req, res) => {
    hit = true;
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.end(sseBody(reply));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const addr = server!.address();
  if (addr === null || typeof addr === 'string') throw new Error('无法获取测试端口');
  return { url: `http://127.0.0.1:${addr.port}/v1`, seen: () => hit };
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

function opts(baseUrl: string): RunAgentOptions {
  return {
    settings: { baseUrl, apiKey: '', model: 'mock' },
    messages: [{ role: 'user', content: '你好' }],
    tools: [],
    executeTool: async () => 'unused',
  };
}

describe('runPiAgent 空 API Key', () => {
  it('无 key 的本地端点仍发出请求并拿到回复', async () => {
    const s = await startServer('你好，我是本地模型。');
    const res = await runPiAgent(opts(s.url));
    expect(s.seen()).toBe(true);
    expect(res.content).toContain('我是本地模型');
  }, 20_000);
});

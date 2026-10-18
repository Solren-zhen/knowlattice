// @vitest-environment jsdom
/**
 * `readFile` 找附件的顺序（对齐 Obsidian 的 shortest path 语义）：
 *   ① 原样路径  ② 加 `_attachments/` 前缀  ③ 只写文件名时全库唯一同名
 * 重名算歧义 → 返回 undefined（界面显示「图片未导入」），不随便挑一张。
 * 这是「从 Obsidian 搬库不断图」的关键：正文里写的是 `![[fig/x.png|300]]`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { resetQbankStorageForTests } from '../../storage/qbank';
import { useEffect, useState } from 'react';

/** 对象 URL 的生成/吊销记录：用来验证「重名重传后旧 URL 被吊销」 */
let created = 0;
const revoked: string[] = [];

const h = vi.hoisted(() => ({
  notes: (async () => new Map<string, string>()) as () => Promise<Map<string, string>>,
  attachments: (async () => new Map<string, Blob>()) as () => Promise<Map<string, Blob>>,
}));

vi.mock('../../storage/web', () => ({
  WebAdapter: class {
    name = 'mock';
    listAll = async () => [];
    readAll = () => h.notes();
    read = async (p: string) => (await h.notes()).get(p) ?? '';
    exists = async (p: string) => (await h.notes()).has(p);
    stat = async (p: string) => ((await h.notes()).has(p) ? { mtime: 0, size: 0 } : null);
    write = async () => {};
    remove = async () => {};
    readAllAttachments = () => h.attachments();
    writeAttachment = async () => {};
    removeAttachment = async () => {};
    existsAttachment = async (p: string) => (await h.attachments()).has(p);
  },
}));

const { useVault } = await import('../vault');

const FIG = '_attachments/fig/曲率-定义.png';
const DUP_A = '_attachments/一章/a.png';
const DUP_B = '_attachments/二章/a.png';

function Probe() {
  const v = useVault();
  const [out, setOut] = useState('loading');
  const cases = ['fig/曲率-定义.png', '曲率-定义.png', '_attachments/fig/曲率-定义.png', 'a.png', '缺图.png'];
  return (
    <div>
      <span data-testid="state">{v.loaded ? 'ok' : 'loading'}</span>
      <button onClick={() => setOut(JSON.stringify(cases.map((c) => v.readFile(c) ?? null)))}>read</button>
      <span data-testid="out">{out}</span>
    </div>
  );
}

beforeEach(async () => {
  localStorage.clear();
  await resetQbankStorageForTests();
  h.notes = async () => new Map([['01-生理/波尔效应.md', '# 波尔效应\n']]);
  created = 0;
  revoked.length = 0;
  h.attachments = async () => new Map([
    [FIG, new Blob(['fig'])],
    [DUP_A, new Blob(['a1'])],
    [DUP_B, new Blob(['a2'])],
  ]);
  // readFile 对附件返回 blob 对象 URL；jsdom 没有 createObjectURL
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:test', writable: true, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, writable: true, configurable: true });
});

afterEach(() => cleanup());

describe('vault · 图片引用的找图顺序', () => {
  it('子目录相对路径 / 唯一同名 / 全路径都能找到，重名与缺图返回 undefined', async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    screen.getByText('read').click();
    await waitFor(() => expect(screen.getByTestId('out').textContent).not.toBe('loading'));

    expect(JSON.parse(screen.getByTestId('out').textContent ?? '[]')).toEqual([
      'blob:test', // fig/曲率-定义.png → _attachments/fig/曲率-定义.png
      'blob:test', // 曲率-定义.png → 全库唯一同名
      'blob:test', // 已经是 _attachments/ 全路径
      null,        // a.png 在库里重名：歧义不猜
      null,        // 库里没有这张图
    ]);
  });
});

describe('vault · 附件对象 URL 的失效与查重', () => {
  /** 最新一次渲染拿到的 vault API（useCallback 闭包随 state 更新） */
  let api: ReturnType<typeof useVault> | null = null;
  /**
   * 抓住 API 的载体组件。在 effect 里赋值而不是渲染期赋值：
   * 渲染期改组件外的变量会被 react 规则判为副作用。
   */
  function Catch() {
    const v = useVault();
    useEffect(() => { api = v; }, [v]);
    return <span data-testid="state">{v.loaded ? 'ok' : 'loading'}</span>;
  }
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      value: () => `blob:${++created}`, writable: true, configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: (u: string) => { revoked.push(u); }, writable: true, configurable: true,
    });
  });

  it('同名附件重新写入后，旧的对象 URL 被吊销、下次读取拿到新 URL', async () => {
    render(<Catch />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));

    expect(api!.readFile('fig/曲率-定义.png')).toBe(`blob:${created}`);
    const first = `blob:${created}`;

    // 重名重传：路径不变、内容变了。若不吊销，界面会一直显示旧图
    await api!.saveAttachment('fig/曲率-定义.png', new Blob(['新图']));
    expect(revoked).toContain(first);

    await waitFor(() => expect(api!.readFile('fig/曲率-定义.png')).not.toBe(first));
    expect(api!.readFile('fig/曲率-定义.png')).toBe(`blob:${created}`);
  });

  it('hasAttachment 只查不建 URL（不能拿 readFile 当查重用）', async () => {
    render(<Catch />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));

    const before = created;
    expect(api!.hasAttachment('fig/曲率-定义.png')).toBe(true);
    expect(api!.hasAttachment('_attachments/fig/曲率-定义.png')).toBe(true);
    expect(api!.hasAttachment('a.png')).toBe(false); // 重名歧义 → 不认
    expect(api!.hasAttachment('缺图.png')).toBe(false);
    expect(created).toBe(before);
  });
});

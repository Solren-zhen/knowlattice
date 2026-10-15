// @vitest-environment jsdom
/**
 * 附件清理的两个 vault 接口（`findOrphanAttachments` / `removeAttachments`）。
 * 判定逻辑本身在 core/attachmentOrphans 的单测里；这里守**接线与护栏**这两件事：
 *   ① `find` 读内存快照（全部附件 × 全部正文），计数与清单要给对；
 *   ② `remove` **只删 `_attachments/` 下的路径**——把笔记路径一起传进来也删不掉正文；
 *      并且「写盘成功才动内存」：删完立刻读不到，而仍被引用的那张图照旧读得到。
 * 适配器是 vault.ts 的模块级单例，没有注入点，所以照 vault.backup.test.tsx mock 掉 storage/web。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { addBank } from '../qbank';
import { resetQbankStorageForTests } from '../../storage/qbank';

import { useState } from 'react';

const USED = '_attachments/用着.png';
const ORPHAN = '_attachments/没人要.png';
const NOTE = '01-生理/波尔效应.md';

const h = vi.hoisted(() => ({
  readAll: (async () => new Map<string, string>()) as () => Promise<Map<string, string>>,
  attachments: (async () => new Map<string, Blob>()) as () => Promise<Map<string, Blob>>,
  /** 真正被删掉的附件路径（按调用顺序） */
  removed: [] as string[],
  /** 非 null 时让 removeAttachment 抛错，用来验证失败清单 */
  failOn: null as string | null,
}));

vi.mock('../../storage/web', () => ({
  WebAdapter: class {
    name = 'mock';
    listAll = async () => [];
    readAll = () => h.readAll();
    read = async (p: string) => (await h.readAll()).get(p) ?? '';
    exists = async (p: string) => (await h.readAll()).has(p);
    stat = async (p: string) => ((await h.readAll()).has(p) ? { mtime: 0, size: 0 } : null);
    write = async () => {};
    remove = async () => {};
    readAllAttachments = () => h.attachments();
    writeAttachment = async () => {};
    removeAttachment = async (p: string) => {
      if (h.failOn === p) throw new Error('模拟删除失败');
      h.removed.push(p);
    };
    existsAttachment = async (p: string) => (await h.attachments()).has(p);
  },
}));

const { useVault } = await import('../vault');

function Probe() {
  const v = useVault();
  const [out, setOut] = useState('');
  return (
    <div>
      <span data-testid="state">{!v.loaded ? 'loading' : v.loadError ? 'error' : 'ok'}</span>
      <button onClick={() => { void v.findOrphanAttachments().then((r) => setOut(JSON.stringify(r))); }}>find</button>
      <button onClick={() => { void v.removeAttachments([ORPHAN, NOTE]).then((r) => setOut(JSON.stringify(r))); }}>remove</button>
      <span data-testid="out">{out}</span>
      <span data-testid="used">{v.readFile(USED) ?? 'none'}</span>
      <span data-testid="orphan">{v.readFile(ORPHAN) ?? 'none'}</span>
    </div>
  );
}

const click = async (label: string) => {
  fireEvent.click(screen.getByText(label));
  await waitFor(() => expect(screen.getByTestId('out').textContent).not.toBe(''));
  return JSON.parse(screen.getByTestId('out').textContent ?? '{}') as Record<string, unknown>;
};

beforeEach(async () => {
  localStorage.clear();
  // 题库存 IndexedDB：用例之间必须清干净，否则上一条用例的题图会留在库里影响计数
  await resetQbankStorageForTests();
  h.removed.length = 0;
  h.failOn = null;
  h.readAll = async () => new Map([[NOTE, `正文引用了 ![](${USED})\n`]]);
  h.attachments = async () => new Map([
    [USED, new Blob(['used'])],
    [ORPHAN, new Blob(['orphan'])],
  ]);
  // readFile 对附件返回 blob 对象 URL；jsdom 没有 createObjectURL
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:test', writable: true, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, writable: true, configurable: true });
});

afterEach(() => cleanup());

describe('vault · 未引用附件的列出与删除', () => {
  it('find：正文引用到的那张不算孤儿，计数与清单都给对', async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));

    const r = await click('find');
    expect(r).toEqual({ orphans: [ORPHAN], referenced: 1, total: 2 });
    // 只是列出，不该动任何文件
    expect(h.removed).toEqual([]);
  });

  it('remove：只删 _attachments/ 下的路径（笔记路径传进来也删不掉），删完内存同步', async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    expect(screen.getByTestId('used').textContent).toBe('blob:test');
    expect(screen.getByTestId('orphan').textContent).toBe('blob:test');

    const r = await click('remove');
    expect(r).toEqual({ removed: 1, failed: [] });
    // 护栏：只把附件交给适配器，笔记路径与仍被引用的附件都没被删
    expect(h.removed).toEqual([ORPHAN]);
    // 内存同步：孤儿立刻读不到，仍被引用的照旧
    await waitFor(() => expect(screen.getByTestId('orphan').textContent).toBe('none'));
    expect(screen.getByTestId('used').textContent).toBe('blob:test');
  });
  it('删除失败时进 failed 清单，且失败的那条仍留在内存里（不谎报已删）', async () => {
    h.failOn = ORPHAN;
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));

    const r = await click('remove');
    expect(r).toEqual({ removed: 0, failed: [ORPHAN] });
    expect(screen.getByTestId('orphan').textContent).toBe('blob:test'); // 还在
  });

  it('正文之外的引用都算「在用」：挂载表、题库题图、卡片正反面、题库题干里的路径都别删', async () => {
    // 这些引用**都不在笔记正文里**（挂载表 / 题库 / 卡片自定义各存各的）。只看正文的判定会把它们
    // 列成孤儿，用户点一下确认就真删了——播放条断、题图变破图、卡片里的图消失。这条是那个事故的回归。
    const AUDIO = '_attachments/讲解.mp3';
    const QIMG = '_attachments/题图.png';
    const CARDIMG = '_attachments/卡片图.png';
    const STEMIMG = '_attachments/题干里的图.png';
    h.attachments = async () => new Map([
      [USED, new Blob(['used'])],
      [ORPHAN, new Blob(['orphan'])],
      [AUDIO, new Blob(['audio'])],
      [QIMG, new Blob(['img'])],
      [CARDIMG, new Blob(['card'])],
      [STEMIMG, new Blob(['stem'])],
    ]);
    localStorage.setItem('knowlattice-note-media', JSON.stringify({ [NOTE]: { audio: AUDIO } }));
    // 卡片自定义的正面/反面是用户写的文字，里面可能贴图
    localStorage.setItem('knowlattice-card-edits', JSON.stringify({ [NOTE]: { back: `![](${CARDIMG})` } }));
    await addBank('题库甲', [
      { id: 'q1', type: 'choice', stem: '甲', options: ['A'], answer: 0, answerText: 'A', chapter: '第1章', image: QIMG },
      // 题干里的文字同样可能引用附件（结构化字段 image 之外的那条路）
      { id: 'q2', type: 'choice', stem: `看图 ![](${STEMIMG})`, options: ['A'], answer: 0, answerText: 'A', chapter: '第1章' },
    ]);

    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    const r = await click('find');
    // 六张里只有真正没人提的那一张进清单
    expect(r).toEqual({ orphans: [ORPHAN], referenced: 5, total: 6 });
  });
});

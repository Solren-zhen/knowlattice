// @vitest-environment jsdom
/**
 * 整包备份回环 + 「只补不覆盖」验收。
 *
 * 用户要求：**「备份与恢复时不要覆盖已有内容，新增的内容单独增加」**。本文件守：
 *   ① 导出 → 清空 → 导入，专注记录/待办/打卡/题库统计都要回来；
 *   ② 恢复遇到**同路径且内容不同**的现有笔记：现有内容一字不改，备份那一篇另存到「恢复冲突/」；
 *   ③ 内容完全相同 → 只计「已存在」，不产生冲突副本；
 *   ④ 连续恢复两次 → 第二次 0 新增 0 冲突（幂等）；
 *   ⑤ 附件已存在 → 跳过并保留现有；
 *   ⑥ localStorage 存储逐条合并：现有键的值不被覆盖，新键补上。
 *   ⑦ v8/v9 旧备份缺字段照旧能恢复成功。
 * 适配器是 vault.ts 的模块级单例，没有注入点，所以照 vault.load.test.tsx 的做法 mock 掉 storage/web。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getAllQuestionStats, resetQbankStorageForTests } from '../../storage/qbank';
import { initializeStats, recordAnswer, resetQbankStatsForTests, statOf } from '../qbankStats';
import { getPdfBook, putPdfBook, removePdfBook, savePdfPage } from '../pdfLib';
import type { ImportResult } from '../vault';
import { makeStoryArchiveEntry } from '../wordStory';

const h = vi.hoisted(() => ({
  readAll: (async () => new Map<string, string>()) as () => Promise<Map<string, string>>,
  attachments: (async () => new Map<string, Blob>()) as () => Promise<Map<string, Blob>>,
  /** 写入的附件 Blob（按路径） */
  written: new Map<string, Blob>(),
  /** 写入的笔记文本（按路径）——恢复/导入的落盘结果 */
  writtenNotes: new Map<string, string>(),
}));

vi.mock('../../storage/web', () => ({
  WebAdapter: class {
    name = 'mock';
    listAll = async () => [];
    readAll = () => h.readAll();
    read = async (p: string) => (await h.readAll()).get(p) ?? '';
    exists = async (p: string) => (await h.readAll()).has(p);
    stat = async (p: string) => ((await h.readAll()).has(p) ? { mtime: 0, size: 0 } : null);
    write = async (p: string, c: string) => { h.writtenNotes.set(p, c); };
    remove = async () => {};
    readAllAttachments = () => h.attachments();
    writeAttachment = async (p: string, b: Blob) => { h.written.set(p, b); };
    removeAttachment = async () => {};
    existsAttachment = async (p: string) => (await h.attachments()).has(p);
  },
}));

const { useVault } = await import('../vault');

let backupText = '';
let captured: Blob | null = null;
/** 每次点「导入」都追加一条结果，供逐次断言（幂等测试要看第二次） */
const results: ImportResult[] = [];
/** 每次点「导出计数」都追加 exportAll 的返回（跳过的大附件数） */
const skippedCounts: number[] = [];

function Probe() {
  const v = useVault();
  return (
    <div>
      <span data-testid="state">{!v.loaded ? 'loading' : v.loadError ? 'error' : 'ok'}</span>
      <button onClick={v.exportAll}>导出</button>
      <button onClick={() => { void v.exportAll().then((r) => { skippedCounts.push(r.skippedAttachments); }); }}>导出计数</button>
      <button onClick={() => { void v.importBackup(backupText).then((r) => { results.push(r); }); }}>导入</button>
    </div>
  );
}

const store = (key: string): unknown[] => JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[];

/** 媒体挂载是「对象」而不是数组（键 = 笔记路径），因此不能复用上面按数组断言的 store() */
const mediaStore = (): Record<string, unknown> =>
  JSON.parse(localStorage.getItem('knowlattice-note-media') ?? '{}') as Record<string, unknown>;

/** 触发一次导入并等它把结果推进 results，返回这次的结果 */
async function importOnce(): Promise<ImportResult> {
  const before = results.length;
  fireEvent.click(screen.getByText('导入'));
  await waitFor(() => expect(results.length).toBe(before + 1));
  return results[results.length - 1];
}

beforeEach(async () => {
  localStorage.clear();
  resetQbankStatsForTests();
  await resetQbankStorageForTests();
  h.readAll = async () => new Map();
  h.attachments = async () => new Map();
  h.written = new Map();
  h.writtenNotes = new Map();
  backupText = '';
  captured = null;
  results.length = 0;
  skippedCounts.length = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    value: (b: Blob) => { captured = b; return 'blob:test'; }, writable: true, configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, writable: true, configurable: true });
});

afterEach(() => cleanup());

describe('整包备份：超大附件不进 JSON', () => {
  it('单件超过 20MB 的附件直接跳过并把数量报出来，小附件照常进备份', async () => {
    h.attachments = async () => new Map<string, Blob>([
      ['_attachments/small.bin', new Blob(['hi'])],
      ['_attachments/huge.bin', new Blob([new Uint8Array(21 * 1024 * 1024)])],
    ]);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    fireEvent.click(screen.getByText('导出计数'));
    await waitFor(() => expect(skippedCounts.length).toBe(1));
    // 只跳过 21MB 那份；小附件不计入跳过数
    expect(skippedCounts[0]).toBe(1);
    await waitFor(() => expect(captured).not.toBeNull());
    const payload = JSON.parse(await captured!.text()) as { files: Array<{ path: string }> };
    const paths = payload.files.map((f) => f.path);
    expect(paths).toContain('_attachments/small.bin');
    expect(paths).not.toContain('_attachments/huge.bin');
  });
});

describe('整包备份：PDF 书架随备份走', () => {
  it('导出 PDF 正文与页码，恢复后能读回同一本书', async () => {
    await removePdfBook('备份书.pdf').catch(() => {});
    await putPdfBook('备份书.pdf', new TextEncoder().encode('pdf-body').buffer as ArrayBuffer, 1);
    await savePdfPage('备份书.pdf', 17);

    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    fireEvent.click(screen.getByText('导出'));
    await waitFor(() => expect(captured).not.toBeNull());

    const payload = JSON.parse(await captured!.text()) as Record<string, unknown>;
    expect(payload.version).toBe(18);
    expect(payload.pdfBooks).toEqual([
      expect.objectContaining({ name: '备份书.pdf', page: 17, data: expect.any(String) }),
    ]);

    await removePdfBook('备份书.pdf');
    expect(await getPdfBook('备份书.pdf')).toBeNull();

    backupText = JSON.stringify(payload);
    const r = await importOnce();
    expect(r.failed).toBe(0);
    expect(r.storeMerges?.find((s) => s.name === 'PDF 书架')).toEqual({ name: 'PDF 书架', added: 1, kept: 0 });
    const rec = await getPdfBook('备份书.pdf');
    expect(new TextDecoder().decode(new Uint8Array(rec!.data))).toBe('pdf-body');
    expect(rec?.page).toBe(17);
  });
});

describe('整包备份：专注记录不丢', () => {
  it('导出带上专注记录，清空后导入能回来（待办里的专注次数也一起）', async () => {
    await recordAnswer('备份题库', 'q-1', false, Date.UTC(2026, 0, 15, 9));
    localStorage.setItem('knowlattice-pomodoros', JSON.stringify([
      { id: 'p-1', day: '2026-09-21', endedAt: 1758400000000, minutes: 25, taskId: 't-1' },
    ]));
    localStorage.setItem('knowlattice-todos', JSON.stringify([
      { id: 't-1', text: '复习呼吸', done: false, createdAt: 1, pomos: 1 },
    ]));
    localStorage.setItem('knowlattice-days', JSON.stringify({ '2026-09-21': 3 }));

    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    fireEvent.click(screen.getByText('导出'));
    await waitFor(() => expect(captured).not.toBeNull());

    const payload = JSON.parse(await captured!.text()) as Record<string, unknown>;
    expect(payload.app).toBe('knowlattice');
    expect(payload.version).toBe(18);
    expect(payload).toHaveProperty('stars'); // v11：收藏/重点题随备份走
    expect(payload.qbankStats).toMatchObject({ '备份题库': { 'q-1': { wrong: 1 } } });
    expect(payload.pomodoros).toEqual([
      { id: 'p-1', day: '2026-09-21', endedAt: 1758400000000, minutes: 25, taskId: 't-1' },
    ]);
    expect((payload.todos as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 't-1', pomos: 1 });
    expect(payload.days).toEqual({ '2026-09-21': 3 });

    // v8 新增：复习计划 / 每日提醒 / 本地速查也要随备份走
    expect(payload).toHaveProperty('reviewPlan');
    expect(payload).toHaveProperty('reminder');
    expect(payload).toHaveProperty('localRecall');

    // v9 新增：笔记媒体挂载也要随备份走
    expect(payload).toHaveProperty('noteMedia');

    // v10 新增：模拟考试成绩历史 / 每日一练进度
    expect(payload).toHaveProperty('examHistory');
    expect(payload).toHaveProperty('daily');

    // 换设备场景：本地全没了，只靠这份备份
    localStorage.removeItem('knowlattice-pomodoros');
    localStorage.removeItem('knowlattice-todos');
    localStorage.removeItem('knowlattice-days');
    await resetQbankStorageForTests();
    resetQbankStatsForTests();
    backupText = JSON.stringify(payload);
    const r = await importOnce();
    expect(r.failed).toBe(0);

    expect(store('knowlattice-pomodoros')).toHaveLength(1);
    expect(store('knowlattice-pomodoros')[0]).toMatchObject({ id: 'p-1', minutes: 25, taskId: 't-1' });
    expect(store('knowlattice-todos')[0]).toMatchObject({ id: 't-1', pomos: 1 });
    expect(localStorage.getItem('knowlattice-days')).toContain('2026-09-21');
    await expect(getAllQuestionStats()).resolves.toHaveLength(1);
    expect(statOf(await initializeStats(), '备份题库', 'q-1')?.wrong).toBe(1);
  });

  it('旧版备份（没有 pomodoros 字段）照样能导入，不会炸', async () => {
    localStorage.setItem('knowlattice-todos', JSON.stringify([{ id: 'old', text: '老数据', done: false, createdAt: 1 }]));
    backupText = JSON.stringify({
      app: 'knowlattice', version: 3, files: [{ path: '笔记.md', content: '# 笔记\n' }],
      // 待办里同 id 已存在：按「键已存在保留现有值」不该覆盖、也不该重复
      todos: [{ id: 'old', text: '老数据', done: false, createdAt: 1 }],
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    await importOnce();
    expect(store('knowlattice-todos')).toHaveLength(1);
    expect(store('knowlattice-pomodoros')).toHaveLength(0);
  });

  it('二进制附件并入 .json 备份：导出成 dataURL，导入时还原为 Blob 附件', async () => {
    h.attachments = async () => new Map([['_attachments/img.png', new Blob(['hello'], { type: 'image/png' })]]);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    fireEvent.click(screen.getByText('导出'));
    await waitFor(() => expect(captured).not.toBeNull());

    const payload = JSON.parse(await captured!.text()) as {
      version: number;
      files: Array<{ path: string; content: string }>;
    };
    const att = payload.files.find((f) => f.path === '_attachments/img.png');
    expect(att?.content).toMatch(/^data:image\/png;base64,/);

    // 换设备：附件库里没有这个附件了，才会真正写入（已存在则跳过，见下一个测试）
    h.attachments = async () => new Map();
    backupText = JSON.stringify(payload);
    await importOnce();
    await waitFor(() => expect(h.written.has('_attachments/img.png')).toBe(true));
    await expect(h.written.get('_attachments/img.png')!.text()).resolves.toBe('hello');
  });
});

describe('恢复：只补不覆盖', () => {
  it('现有笔记内容不同 → 现有不动，备份那一篇另存到「恢复冲突/」；附件已存在则跳过', async () => {
    // 库里已有：一篇被用户改过的笔记、一篇与备份完全相同的笔记、一个已存在的附件
    h.readAll = async () => new Map([['旧笔记.md', '# 旧内容\n'], ['相同.md', '# 相同\n']]);
    h.attachments = async () => new Map([['_attachments/old.png', new Blob(['old'])]]);
    backupText = JSON.stringify({
      app: 'knowlattice', version: 9,
      files: [
        { path: '旧笔记.md', content: '# 新内容（备份里那一篇）\n' },
        { path: '相同.md', content: '# 相同\n' },
        { path: '新笔记.md', content: '# 全新笔记\n' },
        { path: '_attachments/old.png', content: 'data:image/png;base64,bmV3' },
      ],
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    const r = await importOnce();

    // 现有笔记**没有被覆盖**
    expect(h.writtenNotes.has('旧笔记.md')).toBe(false);
    // 内容不同的那一篇另存了，且内容是备份里的那一份
    expect(r.conflictNotes).toBe(1);
    expect(r.conflictFiles![0]).toMatch(/^恢复冲突\/旧笔记（恢复 \d{4}-\d{2}-\d{2} \d{4}）\.md$/);
    expect(h.writtenNotes.get(r.conflictFiles![0])).toBe('# 新内容（备份里那一篇）\n');
    // 内容相同的只计「已存在」，不另存
    expect(r.unchangedNotes).toBe(1);
    // 新路径正常新增
    expect(r.ok).toBe(1);
    expect(h.writtenNotes.get('新笔记.md')).toBe('# 全新笔记\n');
    // 附件已存在 → 跳过并保留现有（不写、不另存）
    expect(r.skippedAttachments).toBe(1);
    expect(h.written.has('_attachments/old.png')).toBe(false);
    // overwritten 字段保留但如实反映「真正被覆盖的篇数」= 0
    expect(r.overwritten).toEqual([]);
  });

  it('内容完全相同的笔记 → 只计「已存在」，不产生任何冲突另存文件', async () => {
    h.readAll = async () => new Map([['相同.md', '# 相同\n']]);
    backupText = JSON.stringify({
      app: 'knowlattice', version: 9,
      files: [{ path: '相同.md', content: '# 相同\n' }],
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    const r = await importOnce();

    expect(r.ok).toBe(0);
    expect(r.conflictNotes).toBe(0);
    expect(r.unchangedNotes).toBe(1);
    expect(h.writtenNotes.size).toBe(0); // 一个字都没写
  });

  it('连续恢复同一个备份两次：第二次 0 新增 0 冲突', async () => {
    backupText = JSON.stringify({
      app: 'knowlattice', version: 9,
      files: [
        { path: '甲.md', content: '# 甲\n' },
        { path: '子/乙.md', content: '# 乙\n' },
      ],
      days: { '2026-09-21': 2 },
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));

    const first = await importOnce();
    expect(first.ok).toBe(2);
    expect(first.conflictNotes).toBe(0);

    const second = await importOnce();
    expect(second.ok).toBe(0);
    expect(second.conflictNotes).toBe(0);
    expect(second.unchangedNotes).toBe(2);
    expect(second.failed).toBe(0);
    // 两篇各自只写了一次，且没有产生任何冲突副本（首次恢复便直接落成新篇，不重复）
    expect(h.writtenNotes.get('甲.md')).toBe('# 甲\n');
    expect(h.writtenNotes.get('子/乙.md')).toBe('# 乙\n');
    expect([...h.writtenNotes.keys()].filter((p) => p.startsWith('恢复冲突/'))).toEqual([]);
    // 打卡第二次也不重复报新增
    expect(second.storeMerges?.find((s) => s.name === '打卡')).toEqual({ name: '打卡', added: 0, kept: 1 });
  });

  it('localStorage 存储：现有键的值不被覆盖，新键被补上', async () => {
    localStorage.setItem('knowlattice-note-media', JSON.stringify({
      '旧挂载.md': { audio: '_attachments/old.mp3' },
    }));
    backupText = JSON.stringify({
      app: 'knowlattice', version: 9,
      files: [],
      noteMedia: {
        '旧挂载.md': { audio: '_attachments/新.mp3' }, // 同键：必须保留现有值
        '新挂载.md': { audio: '_attachments/n.mp3' }, // 新键：补上
      },
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    const r = await importOnce();

    // 现有键的值原样留着（没有被备份里的 _attachments/新.mp3 覆盖）
    expect(mediaStore()['旧挂载.md']).toEqual({ audio: '_attachments/old.mp3' });
    // 新键补上
    expect(mediaStore()['新挂载.md']).toEqual({ audio: '_attachments/n.mp3' });
    expect(r.storeMerges?.find((s) => s.name === '笔记媒体')).toEqual({ name: '笔记媒体', added: 1, kept: 1 });
  });
});

describe('旧备份兼容（缺字段照旧恢复）', () => {
  it('v9：笔记媒体挂载随备份走，恢复后键仍是笔记路径（该笔记不在库里也照留）', async () => {
    localStorage.setItem('knowlattice-note-media', JSON.stringify({
      '呼吸音笔记.md': { audio: '_attachments/呼吸音.mp3', subtitle: '_attachments/呼吸音.srt' },
    }));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    fireEvent.click(screen.getByText('导出'));
    await waitFor(() => expect(captured).not.toBeNull());

    const payload = JSON.parse(await captured!.text()) as Record<string, unknown>;
    expect(payload.version).toBe(18);
    expect(payload.noteMedia).toEqual({
      '呼吸音笔记.md': { audio: '_attachments/呼吸音.mp3', subtitle: '_attachments/呼吸音.srt' },
    });

    // 换设备：本地挂载全没了，只靠这份备份
    localStorage.removeItem('knowlattice-note-media');
    backupText = JSON.stringify(payload);
    await importOnce();
    await waitFor(() => expect(Object.keys(mediaStore())).toHaveLength(1));
    expect(mediaStore()).toEqual({
      '呼吸音笔记.md': { audio: '_attachments/呼吸音.mp3', subtitle: '_attachments/呼吸音.srt' },
    });
  });

  it('v8 旧备份（没有 noteMedia 字段）照旧导入成功，也不清空本地已有的挂载', async () => {
    localStorage.setItem('knowlattice-note-media', JSON.stringify({ '旧挂载.md': { audio: '_attachments/old.mp3' } }));
    backupText = JSON.stringify({
      app: 'knowlattice', version: 8,
      files: [{ path: '笔记.md', content: '# 笔记\n' }],
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    const r = await importOnce();
    expect(r.ok).toBe(1);
    expect(r.failed).toBe(0);
    // 合并语义：旧备份根本没提挂载这件事，本地那一条原样留着（缺字段 ≠ 清空）
    expect(mediaStore()['旧挂载.md']).toEqual({ audio: '_attachments/old.mp3' });
  });
});

describe('v12：导图偏好（布局/主题/视图/连线/编号）随备份走', () => {
  /** 偏好是「对象」（键 = 笔记路径），不能复用按数组断言的 store() */
  const prefsStore = (): Record<string, unknown> =>
    JSON.parse(localStorage.getItem('knowlattice-mindmap-prefs') ?? '{}') as Record<string, unknown>;

  it('导出带上偏好；换设备（本地清空）后导入能回来，键仍是笔记路径', async () => {
    localStorage.setItem('knowlattice-mindmap-prefs', JSON.stringify({
      '呼吸音笔记.md': { direction: 'down', theme: 'warm' },
    }));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    fireEvent.click(screen.getByText('导出'));
    await waitFor(() => expect(captured).not.toBeNull());

    const payload = JSON.parse(await captured!.text()) as Record<string, unknown>;
    expect(payload.version).toBe(18);
    expect(payload.mindmapPrefs).toEqual({ '呼吸音笔记.md': { direction: 'down', theme: 'warm' } });

    localStorage.removeItem('knowlattice-mindmap-prefs');
    backupText = JSON.stringify(payload);
    await importOnce();
    await waitFor(() => expect(Object.keys(prefsStore())).toHaveLength(1));
    expect(prefsStore()).toEqual({ '呼吸音笔记.md': { direction: 'down', theme: 'warm' } });
  });

  it('v11 旧备份（没有 mindmapPrefs 字段）照旧导入成功，也不清空本地已有的偏好', async () => {
    localStorage.setItem('knowlattice-mindmap-prefs', JSON.stringify({ '旧偏好.md': { theme: 'eye' } }));
    backupText = JSON.stringify({
      app: 'knowlattice', version: 11,
      files: [{ path: '笔记.md', content: '# 笔记\n' }],
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    const r = await importOnce();
    expect(r.ok).toBe(1);
    expect(r.failed).toBe(0);
    // 合并语义：旧备份根本没提偏好这件事，本地那一条原样留着（缺字段 ≠ 清空）
    expect(prefsStore()['旧偏好.md']).toEqual({ theme: 'eye' });
  });
});

describe('v14：视频片段收藏随备份走', () => {
  const CLIPS = [
    { id: 'v-1', media: '生理学-01.mp4|100|1700000000000', start: 30, end: 45, label: '胃的运动形式', tags: ['胃'], at: 1 },
    { id: 'v-2', media: 'bili:BV1xx411c7mD:p1', start: 754, end: null, label: '', tags: [], at: 2 },
  ];

  it('导出带上片段；换设备（本地清空）后导入能回来', async () => {
    // 片段只活在 localStorage，锚点写在正文里能随笔记走 —— 片段不随备份走就会整批消失，
    // 而笔记里的 `#vn=` 锚点还在、清单却是空的（比彻底没有更让人困惑），所以这条必须钉住。
    localStorage.setItem('knowlattice-video-clips', JSON.stringify(CLIPS));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    fireEvent.click(screen.getByText('导出'));
    await waitFor(() => expect(captured).not.toBeNull());

    const payload = JSON.parse(await captured!.text()) as Record<string, unknown>;
    expect(payload.version).toBe(18);
    expect(payload.videoClips).toEqual(CLIPS);

    localStorage.removeItem('knowlattice-video-clips');
    backupText = JSON.stringify(payload);
    const r = await importOnce();
    expect(r.failed).toBe(0);
    expect(r.storeMerges?.find((s) => s.name === '视频片段')).toEqual({ name: '视频片段', added: 2, kept: 0 });
    expect(store('knowlattice-video-clips')).toEqual(CLIPS);
  });

  it('恢复只补不覆盖：本机同 id 的片段保留本地那份（旧备份不冲掉新备注）', async () => {
    localStorage.setItem('knowlattice-video-clips', JSON.stringify([
      { ...CLIPS[0], label: '本机较新的备注' },
    ]));
    backupText = JSON.stringify({
      app: 'knowlattice', version: 14,
      files: [{ path: '笔记.md', content: '# 笔记\n' }],
      videoClips: CLIPS,
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    const r = await importOnce();
    expect(r.failed).toBe(0);
    expect(r.storeMerges?.find((s) => s.name === '视频片段')).toEqual({ name: '视频片段', added: 1, kept: 1 });
    const after = store('knowlattice-video-clips') as Array<{ id: string; label: string }>;
    expect(after.find((c) => c.id === 'v-1')?.label).toBe('本机较新的备注');
    expect(after.some((c) => c.id === 'v-2')).toBe(true);
  });

  it('旧备份（没有 videoClips 字段）照旧导入成功，也不清空本地已有片段', async () => {
    localStorage.setItem('knowlattice-video-clips', JSON.stringify(CLIPS));
    backupText = JSON.stringify({
      app: 'knowlattice', version: 13,
      files: [{ path: '笔记.md', content: '# 笔记\n' }],
    });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    const r = await importOnce();
    expect(r.failed).toBe(0);
    expect(r.storeMerges?.some((s) => s.name === '视频片段')).toBeFalsy();
    expect(store('knowlattice-video-clips')).toEqual(CLIPS);
  });

  it('导出带上视频历史；清空后导入能恢复且同 media 只补不覆盖', async () => {
    const HISTORY = [
      {
        media: 'bili:BV1xx411c7mD:p1',
        url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=1',
        title: '生理学第1讲',
        kind: 'bilibili',
        at: 1_700_000_000_000,
        lastTime: 120,
        duration: 600,
      },
    ];
    localStorage.setItem('knowlattice-video-history', JSON.stringify(HISTORY));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    fireEvent.click(screen.getByText('导出'));
    await waitFor(() => expect(captured).not.toBeNull());

    const payload = JSON.parse(await captured!.text()) as Record<string, unknown>;
    expect(payload.videoHistory).toEqual(HISTORY);

    localStorage.setItem('knowlattice-video-history', JSON.stringify([
      { ...HISTORY[0], title: '本机更新的标题', lastTime: 240 },
    ]));
    backupText = JSON.stringify({
      app: 'knowlattice',
      version: 18,
      files: [{ path: '笔记.md', content: '# 笔记\n' }],
      videoHistory: [
        HISTORY[0],
        {
          media: 'https://example.com/2.mp4',
          url: 'https://example.com/2.mp4',
          title: '第二讲',
          kind: 'direct',
          at: 1_700_000_100_000,
        },
      ],
    });
    const r = await importOnce();
    expect(r.failed).toBe(0);
    expect(r.storeMerges?.find((s) => s.name === '视频历史')).toEqual({ name: '视频历史', added: 1, kept: 1 });
    const after = store('knowlattice-video-history') as Array<{ media: string; title: string }>;
    expect(after.find((h) => h.media === 'bili:BV1xx411c7mD:p1')?.title).toBe('本机更新的标题');
    expect(after.some((h) => h.media === 'https://example.com/2.mp4')).toBe(true);
  });

  it('导出带上笔记视频关联；恢复时只补不覆盖', async () => {
    const MAP = { '生理学/第1章.md': 'bili:BV1xx411c7mD:p1' };
    localStorage.setItem('knowlattice-note-video', JSON.stringify(MAP));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    fireEvent.click(screen.getByText('导出'));
    await waitFor(() => expect(captured).not.toBeNull());

    const payload = JSON.parse(await captured!.text()) as Record<string, unknown>;
    expect(payload.noteVideos).toEqual(MAP);

    localStorage.setItem('knowlattice-note-video', JSON.stringify({ '生理学/第1章.md': 'local-override' }));
    backupText = JSON.stringify({
      app: 'knowlattice',
      version: 18,
      files: [{ path: '笔记.md', content: '# 笔记\n' }],
      noteVideos: {
        '生理学/第1章.md': 'bili:BV1xx411c7mD:p1',
        '生理学/第2章.md': 'bili:BV1xx411c7mD:p2',
      },
    });
    const r = await importOnce();
    expect(r.failed).toBe(0);
    expect(r.storeMerges?.find((s) => s.name === '笔记视频关联')).toEqual({ name: '笔记视频关联', added: 1, kept: 1 });
    expect(store('knowlattice-note-video')).toEqual({
      '生理学/第1章.md': 'local-override',
      '生理学/第2章.md': 'bili:BV1xx411c7mD:p2',
    });
  });
});

describe('整包备份：单词工坊历史短文', () => {
  it('导出携带短文历史，清空后能恢复；重复导入只计保留不覆盖', async () => {
    const entry = makeStoryArchiveEntry({
      createdAt: 1_700_000_000_000,
      bankName: 'CET-6',
      words: [],
      story: {
        title: 'Backup Story',
        titleZh: '备份短文',
        sentences: [{ en: 'Keep going.', zh: '继续走。' }],
      },
      analysis: null,
      pinned: true,
    });
    localStorage.setItem('knowlattice-word-drill-stories', JSON.stringify([entry]));

    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('ok'));
    fireEvent.click(screen.getByText('导出'));
    await waitFor(() => expect(captured).not.toBeNull());
    const payload = JSON.parse(await captured!.text()) as {
      version: number;
      wordStories?: Array<{ id: string; pinned?: boolean }>;
    };
    expect(payload.version).toBe(18);
    expect(payload.wordStories).toHaveLength(1);
    expect(payload.wordStories?.[0]).toEqual(expect.objectContaining({ id: entry.id, pinned: true }));

    localStorage.removeItem('knowlattice-word-drill-stories');
    backupText = JSON.stringify(payload);
    const first = await importOnce();
    expect(first.failed).toBe(0);
    expect(first.storeMerges?.find((s) => s.name === '单词工坊短文')).toEqual({
      name: '单词工坊短文',
      added: 1,
      kept: 0,
    });
    const restored = store('knowlattice-word-drill-stories') as Array<{ id: string; pinned?: boolean }>;
    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual(expect.objectContaining({ id: entry.id, pinned: true }));

    const second = await importOnce();
    expect(second.storeMerges?.find((s) => s.name === '单词工坊短文')).toEqual({
      name: '单词工坊短文',
      added: 0,
      kept: 1,
    });
    expect(store('knowlattice-word-drill-stories')).toHaveLength(1);
  });
});

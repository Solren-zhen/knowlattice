// @vitest-environment jsdom
/**
 * 统一导入面板（views/ImportView）的 DOM 测试。
 *
 * 这个面板是「一个入口吃掉所有文件」的落地点：格式判定对、但**分派/聚合**写错，
 * 用户一样会丢数据。所以守三件事：
 *  ① 每种格式都真的转发到**既有**通道（备份 → onImportBackup；笔记/Anki/数据集 →
 *     onImportMd；题库 → addBank 写库；文档转换出的图 → onAttach）——没有第二条写盘路径；
 *  ② 批量：多个文件一次处理，**单个失败不中断整批**，逐条回报（哪个文件、识别成什么、成了没有）；
 *  ③ 认不出的文件**不导、不改**，只报原因。
 *
 * 样例全部自造（甲/乙 占位内容），不含任何真实资料。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import ImportView from '../ImportView';
import { resetQbankStorageForTests } from '../../storage/qbank';
import { addBank, loadBanks } from '../../core/qbank';

beforeEach(async () => {
  localStorage.clear();
  await resetQbankStorageForTests();
});

afterEach(() => {
  cleanup();
  // toast 宿主是模块级单例：清空内容而不是删节点（与 chapterTreeImport 测试同一理由）
  document.querySelector('.mv-toast-host')?.replaceChildren();
});

function setup() {
  const onImportBackup = vi.fn(async () => ({ ok: 1, failed: 0 }));
  const onImportMd = vi.fn(async (files: Array<{ path: string; content: string }>) => ({ ok: files.length, failed: 0 }));
  const onImportPack = vi.fn(async () => ({ created: 0, skipped: [] }));
  const onAttach = vi.fn(async (name: string) => `_attachments/${name}`);
  const { container } = render(
    <ImportView
      onImportBackup={onImportBackup}
      onImportMd={onImportMd}
      onImportPack={onImportPack}
      onAttach={onAttach}
      onClose={vi.fn()}
    />,
  );
  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));
  const file = inputs.find((i) => !i.hasAttribute('webkitdirectory'))!;
  const folder = inputs.find((i) => i.hasAttribute('webkitdirectory'))!;
  const report = () => Array.from(container.querySelectorAll<HTMLElement>('.quiz-import-report li'));
  return { onImportBackup, onImportMd, onImportPack, onAttach, file, folder, report };
}

const md = (name: string, content = '# 甲\n正文') => new File([content], name, { type: 'text/markdown' });
const jsonFile = (name: string, value: unknown) => new File([JSON.stringify(value)], name, { type: 'application/json' });

describe('ImportView · 自动识别后分派到既有通道', () => {
  it('Markdown 笔记走 onImportMd', async () => {
    const { onImportMd, file, report } = setup();
    fireEvent.change(file, { target: { files: [md('甲.md')] } });

    await waitFor(() => expect(onImportMd).toHaveBeenCalled());
    expect(onImportMd.mock.calls[0][0]).toEqual([{ path: '甲.md', content: '# 甲\n正文' }]);
    await waitFor(() => expect(report().length).toBe(2)); // 逐文件 + 批量汇总
    expect(report()[0].textContent).toContain('Markdown 笔记');
  });

  it('笔记备份走 onImportBackup（不是当笔记写）', async () => {
    const { onImportBackup, onImportMd, file } = setup();
    const backup = jsonFile('备份甲.json', { app: 'knowlattice', files: [{ path: '甲.md', content: '# 甲' }] });
    fireEvent.change(file, { target: { files: [backup] } });

    await waitFor(() => expect(onImportBackup).toHaveBeenCalled());
    expect(onImportMd).not.toHaveBeenCalled();
  });

  it('Anki「导出为 .txt」走 onImportMd，路径落成 imported/anki/*', async () => {
    const { onImportMd, file } = setup();
    const tsv = new File(['正面甲\t背面甲\t章节:章节甲\n'], '牌组甲.txt', { type: 'text/plain' });
    fireEvent.change(file, { target: { files: [tsv] } });

    await waitFor(() => expect(onImportMd).toHaveBeenCalled());
    const files = onImportMd.mock.calls[0][0] as Array<{ path: string }>;
    expect(files.map((f) => f.path)).toEqual(['imported/anki/正面甲.md']);
  });

  it('结构化数据集走 onImportMd，落成笔记', async () => {
    const { onImportMd, file, report } = setup();
    const ds = jsonFile('数据集甲.json', { entries: [{ symptom: '症状甲', diseases: ['疾病甲'] }] });
    fireEvent.change(file, { target: { files: [ds] } });

    await waitFor(() => expect(onImportMd).toHaveBeenCalled());
    const files = onImportMd.mock.calls[0][0] as Array<{ path: string }>;
    expect(files.map((f) => f.path)).toEqual(['症状甲.md']);
    expect(report()[0].textContent).toContain('数据集');
  });

  it('题库 JSON 直接写库（addBank），不走笔记通道', async () => {
    const { onImportMd, file, report } = setup();
    const bank = jsonFile('同业题库甲.json', [{ s: '题干甲？', o: ['甲', '乙'], a: 0 }]);
    fireEvent.change(file, { target: { files: [bank] } });

    await waitFor(() => expect(report()[0].textContent).toContain('题库'));
    expect((await loadBanks()).some((b) => b.name === '同业题库甲')).toBe(true);
    expect(onImportMd).not.toHaveBeenCalled();
  });

  it('同名题库再导入走增量合并：不覆盖用户已有题，旧题 id 不重发', async () => {
    const { file, report } = setup();
    // 先入库一份同名题库，带一个确定的 id（模拟用户已有的历史：逐题统计 / 错题本 / 复习排程都挂它）
    await addBank('同名库甲', [
      { id: 'old-1', type: 'choice', stem: '题干甲？', options: ['甲', '乙'], answer: 0, answerText: '甲' },
    ]);
    // 再导入同名文件：第一题与已有重复、第二题是新增
    const again = jsonFile('同名库甲.json', [
      { stem: '题干甲？', options: ['甲', '乙'], answer: 0 },
      { stem: '题干乙？', options: ['丙', '丁'], answer: 1 },
    ]);
    fireEvent.change(file, { target: { files: [again] } });

    await waitFor(() => expect(report()[0].textContent).toContain('增量导入'));
    const bank = (await loadBanks()).find((b) => b.name === '同名库甲')!;
    expect(bank.questions).toHaveLength(2);
    // 旧题原样保留（id 一个都不换）：整库覆盖会把 id 全部重发，历史进度整体作废
    expect(bank.questions[0].id).toBe('old-1');
    expect(report()[0].textContent).toContain('新增 1 题');
    expect(report()[0].textContent).toContain('已存在 1 题');
  });
});

describe('ImportView · 批量与容错', () => {
  it('一个坏文件不中断整批：好的照常导入，坏的逐条报原因', async () => {
    const { onImportMd, file, report } = setup();
    const good = md('甲.md');
    const bad = new File([new Uint8Array([1, 2, 3])], '病毒甲.exe');
    fireEvent.change(file, { target: { files: [good, bad] } });

    await waitFor(() => expect(onImportMd).toHaveBeenCalled());
    // 只有好的那篇进了批量写入
    const written = onImportMd.mock.calls[0][0] as Array<{ path: string }>;
    expect(written.map((f) => f.path)).toEqual(['甲.md']);
    // 逐条回报：坏文件那一条是失败态并说明原因
    await waitFor(() => expect(report().some((li) => li.className.includes('err'))).toBe(true));
    const err = report().find((li) => li.className.includes('err'))!;
    expect(err.textContent).toContain('病毒甲.exe');
    expect(err.textContent).toContain('无法识别的文件格式');
  });

  it('同一批里的文件逐个都出现在报告里（不静默丢弃）', async () => {
    const { file, report } = setup();
    fireEvent.change(file, { target: { files: [md('甲.md'), md('乙.md')] } });
    await waitFor(() => expect(report().length).toBeGreaterThanOrEqual(3)); // 2 文件 + 汇总
    const text = report().map((li) => li.textContent).join('\n');
    expect(text).toContain('甲.md');
    expect(text).toContain('乙.md');
  });
});

describe('ImportView · 导入整个文件夹', () => {
  it('只吃 .md，路径去掉顶层文件夹名（与目录树同口径）', async () => {
    const { onImportMd, folder } = setup();
    const a = md('甲.md', '# 甲');
    const b = new File(['图片二进制'], '封面.png', { type: 'image/png' });
    Object.defineProperty(a, 'webkitRelativePath', { value: '我的库/病理/甲.md' });
    Object.defineProperty(b, 'webkitRelativePath', { value: '我的库/病理/封面.png' });
    fireEvent.change(folder, { target: { files: [a, b] } });

    await waitFor(() => expect(onImportMd).toHaveBeenCalled());
    const files = onImportMd.mock.calls[0][0] as Array<{ path: string }>;
    expect(files.map((f) => f.path)).toEqual(['病理/甲.md']);
  });

  it('文件夹里没有 .md 时给出提示且不写库', async () => {
    const { onImportMd, folder } = setup();
    const img = new File(['x'], '封面.png', { type: 'image/png' });
    Object.defineProperty(img, 'webkitRelativePath', { value: '我的库/封面.png' });
    fireEvent.change(folder, { target: { files: [img] } });

    await waitFor(() => expect(document.querySelector('.mv-toast-host')?.textContent).toContain('没有 Markdown 笔记'));
    expect(onImportMd).not.toHaveBeenCalled();
  });
});

describe('ImportView · 报告不再吞掉底层的跳过与冲突', () => {
  it('Anki 文本导入：被跳过的卡片连原因一起报（不是只报「共 N 条…已加入待写入」）', async () => {
    const { onImportMd, file, report } = setup();
    // 两张卡标题相同 → 共用模块按「同一批里重名」跳过第二张（第一张正常落盘）
    const tsv = new File(['正面甲\t背面甲\n正面甲\t背面乙\n'], '牌组甲.txt', { type: 'text/plain' });
    fireEvent.change(file, { target: { files: [tsv] } });

    await waitFor(() => expect(onImportMd).toHaveBeenCalled());
    expect((onImportMd.mock.calls[0][0] as Array<{ path: string }>).map((f) => f.path))
      .toEqual(['imported/anki/正面甲.md']);
    const text = report().map((li) => li.textContent).join('\n');
    expect(text).toContain('未导入 1 篇'); // 底层算出来的数字必须出现在报告里
    expect(text).toContain('同一批里重名'); // 以及原因（用户据此知道该怎么办）
  });

  it('同一批里两个同名文件：只写第一篇，但把「有 N 篇同名被跳过」报出来', async () => {
    const { onImportMd, file, report } = setup();
    fireEvent.change(file, { target: { files: [md('同名甲.md', '# 甲之一'), md('同名甲.md', '# 甲之二')] } });

    await waitFor(() => expect(onImportMd).toHaveBeenCalled());
    expect((onImportMd.mock.calls[0][0] as Array<{ path: string }>).map((f) => f.path)).toEqual(['同名甲.md']);
    expect(report().map((li) => li.textContent).join('\n')).toContain('另有 1 篇同名路径只写入第一篇');
  });

  it('疑似非 UTF-8（出现替换字符）：照常导入，但在那一条上给出编码提示', async () => {
    const { onImportMd, file, report } = setup();
    fireEvent.change(file, { target: { files: [md('乱码甲.md', '# 甲\n正文\uFFFD内容')] } });

    await waitFor(() => expect(onImportMd).toHaveBeenCalled());
    const row = report().find((li) => (li.textContent ?? '').includes('乱码甲.md'))!;
    expect(row.textContent).toContain('⚠ 出现替换字符');
    // 只提示、不改变判定：文件确实写进去了（否则用户会以为整批失败）
    expect(row.className).not.toContain('err');
  });
});

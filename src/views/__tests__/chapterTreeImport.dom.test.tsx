// @vitest-environment jsdom
/**
 * 目录树「导入外来资料」两个入口的 DOM 测试（Anki 牌组 / 结构化数据集）。
 *
 * 守三件事：
 *  ① 菜单项真的在（用户点得到），并且读文件后**走既有的 onImportMd 写盘通道**——
 *     没有第二条写库路径（onImportMd 就是 Workspace 传进来的 vault.importMdFiles）；
 *  ② 落地的每篇笔记都带 `source:` 来源标注（版权预防措施，不许省）与 `章节:` 标签解析出的 chapter；
 *  ③ 数据集识别不出来时**不猜**：报出缺哪些字段，且一篇都不写。
 *
 * 样例全部自造（甲/乙/丙 占位内容），不含任何真实资料。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChapterTree from '../ChapterTree';
import type { TreeNode } from '../../core/vault';
import type { VaultFile } from '../../core/importToVault';

// jsdom 没有 ResizeObserver：树靠它更新视口高度
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ROStub;

const tree: TreeNode[] = [{ name: '甲.md', path: '甲.md', type: 'file' }];

/** 症状→疾病数据集的合成样例（字段名按常见写法，内容是占位符） */
const SYMPTOM_DATASET = {
  entries: [
    { symptom: '症状甲', diseases: ['疾病甲', '疾病乙'], category: '系统甲' },
    { symptom: '症状乙', diseases: '疾病丙、疾病丁' },
  ],
};

/** Anki「导出为 .txt」的制表符文本：正面<TAB>背面<TAB>标签 */
const ANKI_TSV = '正面甲\t背面甲\t章节:章节甲\n正面乙\t背面乙\n';

afterEach(() => {
  cleanup();
  // toast 的宿主是模块级单例：只能清空内容，**不能**把节点删掉，
  // 否则后续 toast 会挂到一个已脱离文档的节点上，断言永远读不到（假绿/假红都难查）
  document.querySelector('.mv-toast-host')?.replaceChildren();
});

function setup() {
  const onImportMd = vi.fn(async (files: VaultFile[]) => ({ ok: files.length, failed: 0 }));
  render(
    <ChapterTree
      tree={tree}
      currentPath={null}
      onOpen={vi.fn()}
      onCreate={vi.fn()}
      onExport={vi.fn(async () => {})}
      onExportFolder={vi.fn(async () => 0)}
      onImport={vi.fn(async () => ({ ok: 0, failed: 0 }))}
      onImportMd={onImportMd}
      onRemove={vi.fn()}
    />,
  );
  return { onImportMd };
}

/** 点 ⋯ 菜单里的某个入口 */
function clickMenu(label: string) {
  fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
  fireEvent.click(screen.getByText(label));
}

const fileInputs = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));

/** Anki 入口的隐藏 input（按 accept 认，不靠下标） */
function ankiInput(): HTMLInputElement {
  const el = fileInputs().find((i) => i.getAttribute('accept') === '.apkg,.txt,.tsv');
  if (!el) throw new Error('没找到 Anki 的 file input');
  return el;
}

/** 数据集入口的隐藏 input：源码里它紧跟在 Anki 那个之后（两个 json input 里靠位置区分） */
function datasetInput(): HTMLInputElement {
  const els = fileInputs();
  const el = els[els.indexOf(ankiInput()) + 1];
  if (!el) throw new Error('没找到数据集的 file input');
  return el;
}

const toastText = () => document.querySelector('.mv-toast-host')?.textContent ?? '';

describe('目录树 · 统一导入入口', () => {
  it('传了 onUnifiedImport 时：四个分门别类入口收敛成一个「导入笔记（…格式）」，点了就开统一面板', () => {
    const onUnifiedImport = vi.fn();
    render(
      <ChapterTree
        tree={tree}
        currentPath={null}
        onOpen={vi.fn()}
        onCreate={vi.fn()}
        onExport={vi.fn(async () => {})}
        onExportFolder={vi.fn(async () => 0)}
        onImport={vi.fn(async () => ({ ok: 0, failed: 0 }))}
        onImportMd={vi.fn(async () => ({ ok: 0, failed: 0 }))}
        onImportPack={vi.fn(async () => ({ created: 0, skipped: [] }))}
        onUnifiedImport={onUnifiedImport}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));

    // 统一入口在，「分门别类」的几个不再出现（用户不必先判断文件属于哪一类）
    // 一条入口。菜单项只写动作名：以前括号里那串扩展名会把菜单顶得比侧栏宽而被裁掉
    // （清单在导入面板与「无法识别的文件格式（支持 …）」的提示里都有）
    const unified = screen.getByText('导入笔记');
    expect(screen.queryByText('导入 Anki 牌组 (.apkg/.txt)')).toBeNull();
    expect(screen.queryByText('导入数据集 (.json)')).toBeNull();
    expect(screen.queryByText('从备份 .json 恢复')).toBeNull();
    // 「导入 md 文件夹」也并进统一面板（统一面板本身就能「导入整个文件夹（.md）」），
    // 不再留一条平行的文件夹入口让用户再选一次
    expect(screen.queryByText('导入 md 文件夹')).toBeNull();

    // 格式修复不再是菜单项：已改成「打开库时自动执行」（vault 加载路径），
    // 混在备份/导出/导入里只会让人误以为那是常规导出的一步。
    expect(screen.queryByText('扫描并修复 Markdown 格式')).toBeNull();
    // 批量删除挪到菜单最后：这一组里只有它是破坏性操作，从上往下扫不会误点
    const items = [...(document.querySelector('.more-menu')?.children ?? [])]
      .map((el) => el.textContent?.trim() ?? '');
    expect(items[items.length - 1]).toContain('批量删除');

    fireEvent.click(unified);
    expect(onUnifiedImport).toHaveBeenCalledTimes(1);
  });
});

describe('目录树 · 导入 Anki 牌组', () => {
  it('.txt 导出落成笔记：带 source 标注，标签里的「章节:」解析成 chapter', async () => {
    const { onImportMd } = setup();
    clickMenu('导入 Anki 牌组 (.apkg/.txt)');

    const file = new File([ANKI_TSV], '牌组甲.txt', { type: 'text/plain' });
    fireEvent.change(ankiInput(), { target: { files: [file] } });

    await waitFor(() => expect(onImportMd).toHaveBeenCalled());
    const files = onImportMd.mock.calls[0][0] as VaultFile[];
    expect(files.map((f) => f.path)).toEqual(['imported/anki/正面甲.md', 'imported/anki/正面乙.md']);
    // 来源标注必带（可追溯到「文件名 + 识别出的形状」）
    expect(files[0].content).toContain('source: Anki 导入（Anki 文本导入，来自 牌组甲.txt）');
    // 标签里的 `章节:` 是本项目认的显式标记，解析后写进 frontmatter
    expect(files[0].content).toContain('chapter: 章节甲');
    await waitFor(() => expect(toastText()).toContain('新增 2 篇笔记'));
  });
});

describe('目录树 · 导入数据集', () => {
  it('症状→疾病数据集落成笔记，提示里带 datasetSummary 的文案', async () => {
    const { onImportMd } = setup();
    clickMenu('导入数据集 (.json)');

    const file = new File([JSON.stringify(SYMPTOM_DATASET)], '数据集甲.json', { type: 'application/json' });
    fireEvent.change(datasetInput(), { target: { files: [file] } });

    await waitFor(() => expect(onImportMd).toHaveBeenCalled());
    const files = onImportMd.mock.calls[0][0] as VaultFile[];
    expect(files.map((f) => f.path)).toEqual(['症状甲.md', '症状乙.md']);
    expect(files[0].content).toContain('- 相关疾病: [[疾病甲]]、[[疾病乙]]');
    expect(files[0].content).toContain('source: 数据集导入（症状→疾病对照，来自 数据集甲.json）');
    expect(files[0].content).toContain('chapter: 系统甲');
    await waitFor(() => expect(toastText()).toContain('识别为症状→疾病对照数据集'));
    await waitFor(() => expect(toastText()).toContain('新增 2 篇笔记'));
  });

  it('识别不出类型时：报出缺哪些字段，一篇都不写', async () => {
    const { onImportMd } = setup();
    clickMenu('导入数据集 (.json)');

    const file = new File(
      [JSON.stringify({ records: [{ foo: '甲', bar: '乙' }] })],
      '不认识的乙.json',
      { type: 'application/json' },
    );
    fireEvent.change(datasetInput(), { target: { files: [file] } });

    await waitFor(() => expect(toastText()).toContain('未能识别这份文件'));
    expect(toastText()).toContain('症状→疾病：需要 symptom/症状');
    expect(onImportMd).not.toHaveBeenCalled();
  });

  it('JSON 坏掉时**不**崩：报错而不是静默什么都不做', async () => {
    const { onImportMd } = setup();
    clickMenu('导入数据集 (.json)');

    const file = new File(['{不是 JSON'], '坏掉的丙.json', { type: 'application/json' });
    fireEvent.change(datasetInput(), { target: { files: [file] } });

    await waitFor(() => expect(toastText()).toContain('导入失败'));
    expect(onImportMd).not.toHaveBeenCalled();
  });
});

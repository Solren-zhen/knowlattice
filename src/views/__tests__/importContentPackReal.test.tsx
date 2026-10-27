// @vitest-environment jsdom
/**
 * 临时复现：用**真实内容包文件**走一遍统一导入面板的 content-pack / content-pack-pages 通道，
 * 看它到底报成功还是抛错。默认跳过，需要真包时显式开：
 *   KQ_PACK_DIR=content-packs/import npx vitest run src/views/__tests__/importContentPackReal.tmp.test.tsx
 * 只读少量单元 + 少量图片，不整包读 1.9 GB。
 */
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ImportView from '../ImportView';

const DIR = process.env.KQ_PACK_DIR ? join(process.cwd(), process.env.KQ_PACK_DIR) : '';
const suite = DIR ? describe : describe.skip;

const ROOT = 'import';

function rel(rel: string): string {
  return join(DIR, ...rel.split('/'));
}

function fileOf(relPath: string, type = 'application/json'): File {
  const buf = readFileSync(rel(relPath));
  const f = new File([buf], relPath.split('/').pop()!, { type });
  Object.defineProperty(f, 'webkitRelativePath', { value: `${ROOT}/${relPath}` });
  return f;
}

suite('统一导入面板 · 真实内容包', () => {
  it('整包文件夹：单元进题库、讲义页落成笔记、图片落库', async () => {
    const onAttach = vi.fn(async (name: string) => `_attachments/${name}`);
    const onImportMd = vi.fn(async (files: Array<{ path: string; content: string }>) => ({ ok: files.length, failed: 0 }));
    const onImportBackup = vi.fn(async () => ({ ok: 0, failed: 0 }));
    const onImportPack = vi.fn(async () => ({ created: 0, skipped: [] }));
    const { container } = render(
      <ImportView
        onImportBackup={onImportBackup}
        onImportMd={onImportMd}
        onImportPack={onImportPack}
        onAttach={onAttach}
        onClose={vi.fn()}
      />,
    );
    const folder = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'))
      .find((i) => i.hasAttribute('webkitdirectory'))!;

    const unitFiles = readdirSync(rel('unit')).filter((n) => /^douqi-.*\.json$/.test(n)).slice(0, 2);
    const imgDir = readdirSync(rel('media/files'));
    const picks = [
      fileOf('index.json'),
      fileOf('topic/jiangyi-pages.json'),
      fileOf('topic/douqi-topics.json'),
      fileOf('link/page2item.json'),
      fileOf('link/topic2item.json'),
      ...unitFiles.map((n) => fileOf(`unit/${n}`)),
      ...imgDir.slice(0, 30).map((n) => fileOf(`media/files/${n}`, 'image/png')),
    ];

    const t0 = Date.now();
    fireEvent.change(folder, { target: { files: picks } });
    await waitFor(() => expect(container.querySelectorAll('.quiz-import-report li').length).toBeGreaterThan(0), { timeout: 120000 });

    const lines = Array.from(container.querySelectorAll<HTMLElement>('.quiz-import-report li')).map((li) => li.textContent || '');
    console.log('耗时 ms:', Date.now() - t0);
    console.log('报告行:', JSON.stringify(lines, null, 2));
    console.log('onAttach 次数:', onAttach.mock.calls.length, '｜onImportMd:', onImportMd.mock.calls.length);

    expect(lines.length).toBeGreaterThan(0);
    cleanup();
  }, 180000);
});

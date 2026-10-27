// @vitest-environment jsdom
/**
 * 图片库面板：把附件里的图片集中浏览、过滤、插入当前笔记。
 *
 * 钉的是「用户点得到、点得对」：
 * 1) 面板列出全部图片（附件里的 pdf/md 不能混进来）；
 * 2) 过滤只影响显示，不影响库里条目；
 * 3) 点缩略图放大，放大里能插入；
 * 4) 没打开笔记时插入按钮禁用——不解释的按钮最招人骂，这里连文案一起钉。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ImageLibrary from '../ImageLibrary';
import { imageEntries } from '../../core/imageLib';

const ENTRIES = imageEntries([
  '_attachments/膀胱三角.png',
  '_attachments/动作电位.webp',
  '_attachments/讲义.pdf',
]);

const resolveAsset = (path: string): string | undefined => `blob:mock/${encodeURIComponent(path)}`;

afterEach(cleanup);

describe('图片库', () => {
  it('列出全部图片，pdf 之类的附件不混进来', () => {
    render(<ImageLibrary entries={ENTRIES} resolveAsset={resolveAsset} onInsert={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText('查看 膀胱三角.png')).toBeTruthy();
    expect(screen.getByLabelText('查看 动作电位.webp')).toBeTruthy();
    expect(screen.queryByText('讲义.pdf')).toBeNull();
    // 计数写明「几张图、在哪个目录」
    expect(screen.getByText(/2 张图片/)).toBeTruthy();
  });

  it('按文件名过滤，只影响显示', () => {
    render(<ImageLibrary entries={ENTRIES} resolveAsset={resolveAsset} onInsert={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('图片库搜索'), { target: { value: '动作' } });
    expect(screen.getByLabelText('查看 动作电位.webp')).toBeTruthy();
    expect(screen.queryByLabelText('查看 膀胱三角.png')).toBeNull();
    // 清空查询后全部回来
    fireEvent.change(screen.getByLabelText('图片库搜索'), { target: { value: '' } });
    expect(screen.getByLabelText('查看 膀胱三角.png')).toBeTruthy();
  });

  it('点缩略图放大，放大里插入当前笔记', () => {
    const onInsert = vi.fn();
    render(<ImageLibrary entries={ENTRIES} resolveAsset={resolveAsset} onInsert={onInsert} onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('查看 膀胱三角.png'));
    expect(screen.getByLabelText('膀胱三角.png 大图')).toBeTruthy();
    // 放大面板里多了 OCR 那栏之后，插入按钮的文案是「插入图片」而不是原来的「插入到当前笔记」
    fireEvent.click(screen.getByText('插入图片'));
    // alt 用去掉扩展名的文件名；路径含中文但不含空格/括号 → 不加尖括号（含空格时才加，见 core/imageLib 单测）
    expect(onInsert).toHaveBeenCalledWith('![膀胱三角](_attachments/膀胱三角.png)');
  });

  it('没有打开笔记时插入按钮禁用（并说明原因）', () => {
    render(<ImageLibrary entries={ENTRIES} resolveAsset={resolveAsset} onClose={vi.fn()} />);
    const inserts = screen.getAllByText('插入') as HTMLButtonElement[];
    expect(inserts.every((b) => b.disabled)).toBe(true);
  });

  it('空库给一句为什么是空的', () => {
    render(<ImageLibrary entries={[]} resolveAsset={resolveAsset} onInsert={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/还没有图片/)).toBeTruthy();
  });
});

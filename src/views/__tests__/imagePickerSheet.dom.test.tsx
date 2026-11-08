// @vitest-environment jsdom
/**
 * 内嵌图片选择器：题库边刷边记 / 思维导图大纲等编辑场景里选库内图片。
 *
 * 钉的是「选得中、插得对、关得掉」：
 * 1) 只列图片附件，pdf 之类不混进来；
 * 2) 点「插入」返回 imageMarkdown 并关闭；
 * 3) 按文件名过滤；空库给一句为什么是空的。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ImagePickerSheet from '../ImagePickerSheet';
import { imageEntries } from '../../core/imageLib';

const ENTRIES = imageEntries([
  '_attachments/膀胱三角.png',
  '_attachments/动作电位.webp',
  '_attachments/讲义.pdf',
]);

const resolveAsset = (path: string): string | undefined => `blob:mock/${encodeURIComponent(path)}`;

afterEach(cleanup);

describe('内嵌图片选择器', () => {
  it('列出全部图片，pdf 之类的附件不混进来', () => {
    render(<ImagePickerSheet entries={ENTRIES} resolveAsset={resolveAsset} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText('查看 膀胱三角.png')).toBeTruthy();
    expect(screen.getByLabelText('查看 动作电位.webp')).toBeTruthy();
    expect(screen.queryByText('讲义.pdf')).toBeNull();
  });

  it('点「插入」返回 imageMarkdown 并关闭选择器', () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<ImagePickerSheet entries={ENTRIES} resolveAsset={resolveAsset} onPick={onPick} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('查看 动作电位.webp').closest('figure')!.querySelector('button.btn-small')!);
    expect(onPick).toHaveBeenCalledWith('![动作电位](_attachments/动作电位.webp)');
    expect(onClose).toHaveBeenCalled();
  });

  it('点缩略图放大，放大里也能插入', () => {
    const onPick = vi.fn();
    render(<ImagePickerSheet entries={ENTRIES} resolveAsset={resolveAsset} onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('查看 膀胱三角.png'));
    expect(screen.getByLabelText('膀胱三角.png 大图')).toBeTruthy();
    fireEvent.click(screen.getByText('插入图片'));
    expect(onPick).toHaveBeenCalledWith('![膀胱三角](_attachments/膀胱三角.png)');
  });

  it('按文件名过滤，只影响显示', () => {
    render(<ImagePickerSheet entries={ENTRIES} resolveAsset={resolveAsset} onPick={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('图片过滤'), { target: { value: '动作' } });
    expect(screen.getByLabelText('查看 动作电位.webp')).toBeTruthy();
    expect(screen.queryByLabelText('查看 膀胱三角.png')).toBeNull();
  });

  it('空库给一句为什么是空的', () => {
    render(<ImagePickerSheet entries={[]} resolveAsset={resolveAsset} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/还没有图片/)).toBeTruthy();
  });
});

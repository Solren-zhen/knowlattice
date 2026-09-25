// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import OutlinePanel from '../OutlinePanel';
import { parseOutline } from '../../core/outline';

afterEach(cleanup);

const outline = parseOutline('# 心脏\n\n## 结构\n\n### 传导束\n\n## 电生理');

describe('OutlinePanel（本页目录）', () => {
  it('按级别缩进渲染全部标题，点击回调行号', () => {
    const onJump = vi.fn();
    const { container } = render(<OutlinePanel outline={outline} activeLine={null} onJump={onJump} />);

    const items = [...container.querySelectorAll('.outline-item')];
    expect(items.map((el) => el.textContent)).toEqual(['心脏', '结构', '传导束', '电生理']);
    expect(items[0].className).toContain('lv1');
    expect(items[2].className).toContain('lv3');

    fireEvent.click(screen.getByRole('button', { name: '传导束' }));
    expect(onJump).toHaveBeenCalledOnce();
    expect(onJump).toHaveBeenCalledWith(5);
  });

  it('活动小节带 on 态与 aria-current，其余不带', () => {
    const { container } = render(<OutlinePanel outline={outline} activeLine={3} onJump={() => {}} />);
    const on = container.querySelector('.outline-item.on');
    expect(on?.textContent).toBe('结构');
    expect(on?.getAttribute('aria-current')).toBe('location');
    expect(container.querySelectorAll('.outline-item.on')).toHaveLength(1);
  });

  it('面板带「本页目录」标签与导航语义', () => {
    render(<OutlinePanel outline={outline} activeLine={null} onJump={() => {}} />);
    expect(screen.getByRole('navigation', { name: '本页目录' })).toBeTruthy();
    expect(screen.getByText('本页目录')).toBeTruthy();
  });
});

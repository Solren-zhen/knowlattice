// @vitest-environment jsdom
/**
 * 笔记里的「背诵模式」：挖空在预览中是一段可揭的胶带。
 *
 * 守三件事：
 * 1. 阅读态不遮挡，点挖空也不产生任何状态（避免误以为在背诵）；
 * 2. 背诵态点一下揭开、再点盖回，且**读屏名不能泄露答案**；
 * 3. 退出背诵 / 点「全部重新盖住」都把已揭开的痕迹清干净（第二遍还能考）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import Preview from '../Preview';

afterEach(() => cleanup());

const CONTENT = '# 心脏\n\n左心室{{收缩}}时，二尖瓣{{关闭}}。';

async function ready(ui: React.ReactElement) {
  const result = render(ui);
  await waitFor(() => expect(result.container.querySelectorAll('.cloze-blank')).toHaveLength(2));
  return result;
}

function blanks(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.cloze-blank')];
}

describe('Preview 背诵模式', () => {
  it('阅读态：容器没有 md-recite，点挖空不产生已揭开标记', async () => {
    const { container } = await ready(<Preview content={CONTENT} />);
    expect(container.querySelector('.markdown-body')!.classList.contains('md-recite')).toBe(false);
    fireEvent.click(blanks(container)[0]);
    expect(blanks(container)[0].hasAttribute('data-revealed')).toBe(false);
    expect(blanks(container)[0].getAttribute('aria-label')).toBeNull();
  });

  it('背诵态：点一下揭开、再点盖回；读屏名不泄露答案', async () => {
    const { container } = await ready(<Preview content={CONTENT} recite />);
    expect(container.querySelector('.markdown-body')!.classList.contains('md-recite')).toBe(true);
    const [first] = blanks(container);
    expect(first.getAttribute('aria-label')).toBe('挖空，按 Enter 揭晓');
    expect(first.textContent).toBe('收缩');

    fireEvent.click(first);
    expect(first.getAttribute('data-revealed')).toBe('1');
    expect(first.getAttribute('aria-label')).toBeNull();

    fireEvent.click(first);
    expect(first.hasAttribute('data-revealed')).toBe(false);
    expect(first.getAttribute('aria-label')).toBe('挖空，按 Enter 揭晓');
  });

  it('宿主给的揭开清单决定遮盖状态，清空即复位', async () => {
    const { container, rerender } = await ready(<Preview content={CONTENT} recite revealed={[0, 1]} />);
    await waitFor(() => {
      expect(blanks(container).every((el) => el.hasAttribute('data-revealed'))).toBe(true);
    });

    rerender(<Preview content={CONTENT} recite revealed={[]} />);
    await waitFor(() => {
      expect(blanks(container).some((el) => el.hasAttribute('data-revealed'))).toBe(false);
    });
  });

  it('退出背诵：已揭开的痕迹清空，读屏名恢复成答案本身', async () => {
    const { container, rerender } = await ready(<Preview content={CONTENT} recite />);
    fireEvent.click(blanks(container)[0]);
    expect(blanks(container)[0].hasAttribute('data-revealed')).toBe(true);

    rerender(<Preview content={CONTENT} recite={false} />);
    await waitFor(() => {
      const [first] = blanks(container);
      expect(first.hasAttribute('data-revealed')).toBe(false);
      expect(first.getAttribute('aria-label')).toBeNull();
    });
  });

  it('正文里没有挖空时，背诵开关是空操作、不报错', async () => {
    const { container } = render(<Preview content={'# 无挖空\n\n普通段落。'} recite />);
    await waitFor(() => {
      expect(container.querySelector('.markdown-body')!.textContent).toContain('普通段落');
    });
    expect(container.querySelectorAll('.cloze-blank')).toHaveLength(0);
    expect(container.querySelector('.markdown-body')!.classList.contains('md-recite')).toBe(true);
  });
});

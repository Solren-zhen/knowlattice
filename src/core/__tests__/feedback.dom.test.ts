// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/dom';
import { confirmBox } from '../feedback';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('confirmBox', () => {
  it('renders untrusted copy as text instead of HTML', async () => {
    const result = confirmBox({
      title: '<img src=x onerror=alert(1)>',
      detail: '<svg onload=alert(2)>说明</svg>',
      okText: '<b>删除</b>',
      danger: true,
    });
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;

    expect(dialog.querySelector('img')).toBeNull();
    expect(dialog.querySelector('svg')).toBeNull();
    expect(dialog.querySelector('.mv-confirm-title')?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(dialog.querySelector('.mv-confirm-detail')?.textContent).toBe('<svg onload=alert(2)>说明</svg>');
    expect(dialog.querySelector('.mv-confirm-ok')?.textContent).toBe('<b>删除</b>');

    fireEvent.click(dialog.querySelector('.mv-confirm-cancel')!);
    await expect(result).resolves.toBe(false);
  });
});

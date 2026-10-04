// @vitest-environment jsdom
/**
 * 错题本「错因标注」的 DOM 验收。
 *
 * 守三件事：
 *  ① 每条错题旁的紧凑选择器点一下就把错因写进 localStorage，点选中的那一档 = 取消；
 *  ② 列表上方的错因分布（堆叠条 + 图例）随标注实时变化，且未标注也占一格；
 *  ③ 旧数据（reason 字段引入前写入的错题）照样渲染，一律按「未标注」展示。
 *
 * 为什么不用 vi.resetModules 造干净缓存：那会让组件动态 import 到另一份 React 实例，
 * hooks 直接抛「Invalid hook call」。这里改用公开 API（clearMistake/importMistakes）
 * 清空并播种，模块级缓存与组件读到的是同一份数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import MistakeBook from '../MistakeBook';
import { clearMistake, importMistakes, loadMistakes, type MistakeRecord } from '../../core/mistakes';

beforeEach(() => {
  localStorage.clear();
  for (const p of Object.keys(loadMistakes())) clearMistake(p);
});

afterEach(() => cleanup());

function seed(records: MistakeRecord[]) {
  importMistakes(Object.fromEntries(records.map((r) => [r.path, r])));
}

function renderBook() {
  const onOpenPath = vi.fn();
  const onClose = vi.fn();
  render(<MistakeBook onOpenPath={onOpenPath} onClose={onClose} />);
  return { onOpenPath, onClose };
}

const stored = () => JSON.parse(localStorage.getItem('knowlattice-mistakes')!) as Record<string, MistakeRecord>;
const legendText = () => document.querySelector('.reason-legend')!.textContent ?? '';

/** 旧数据形态：没有 reason 字段（字段引入前的 localStorage / 备份） */
const LEGACY: MistakeRecord = { path: 'a.md', chapter: '生理学', title: '氧解离曲线', count: 2, lastFailedAt: 1 };

describe('错因选择器', () => {
  it('旧数据（无 reason）照常展示，默认落在「未标注」', () => {
    seed([LEGACY]);
    renderBook();

    expect(screen.getByText('氧解离曲线')).toBeTruthy();
    expect(screen.getByRole('button', { name: '未标注' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '知识没记住' }).getAttribute('aria-pressed')).toBe('false');
    // 图例：1 条未标注，占 100%
    expect(legendText()).toContain('未标注1100%');
  });

  it('点一档即写入 localStorage 并更新分布，且不会顺带打开笔记', () => {
    seed([LEGACY]);
    const { onOpenPath } = renderBook();

    fireEvent.click(screen.getByRole('button', { name: '概念混淆' }));

    expect(onOpenPath).not.toHaveBeenCalled();
    expect(stored()['a.md'].reason).toBe('confusion');
    expect(screen.getByRole('button', { name: '概念混淆' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '未标注' }).getAttribute('aria-pressed')).toBe('false');
    expect(legendText()).toContain('概念混淆1100%');
  });

  it('再点已选中的那一档 = 取消标注（回到未标注）', () => {
    seed([LEGACY]);
    renderBook();

    fireEvent.click(screen.getByRole('button', { name: '审题偏差' }));
    expect(stored()['a.md'].reason).toBe('careless');

    fireEvent.click(screen.getByRole('button', { name: '审题偏差' }));
    expect(stored()['a.md'].reason).toBeUndefined();
    expect('reason' in stored()['a.md']).toBe(false);
    expect(screen.getByRole('button', { name: '未标注' }).getAttribute('aria-pressed')).toBe('true');
    expect(legendText()).toContain('未标注1100%');
  });

  it('点「未标注」清除已标注的错因', () => {
    seed([{ ...LEGACY, reason: 'reasoning' }]);
    renderBook();

    expect(screen.getByRole('button', { name: '临床推理跳步' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '未标注' }));

    expect(stored()['a.md'].reason).toBeUndefined();
    expect(screen.getByRole('button', { name: '临床推理跳步' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: '未标注' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('错因分布条', () => {
  it('已标注 + 未标注各占一段，图例给出计数与占比', () => {
    seed([
      { ...LEGACY, path: 'a.md', reason: 'careless' },
      { ...LEGACY, path: 'b.md', title: '静息电位' },
    ]);
    renderBook();

    const segs = document.querySelectorAll('.reason-bar > .reason-seg');
    expect(segs).toHaveLength(2); // careless 一段 + 未标注一段
    expect((segs[0] as HTMLElement).style.flexGrow).toBe('1');
    expect((segs[1] as HTMLElement).style.flexGrow).toBe('1');
    expect(legendText()).toContain('审题偏差150%');
    expect(legendText()).toContain('未标注150%');
  });

  it('全部未标注时分布条只剩未标注一段', () => {
    seed([LEGACY, { ...LEGACY, path: 'b.md', title: '静息电位' }]);
    renderBook();

    const segs = document.querySelectorAll('.reason-bar > .reason-seg');
    expect(segs).toHaveLength(1);
    expect(segs[0].classList.contains('reason-seg--none')).toBe(true);
    expect(legendText()).toContain('未标注2100%');
  });

  it('没有错题时不渲染分布条（走空态）', () => {
    renderBook();
    expect(screen.getByText('暂无错题')).toBeTruthy();
    expect(document.querySelector('.reason-bar')).toBeNull();
  });
});

describe('既有行为不回退', () => {
  it('点条目本身仍然打开笔记', () => {
    seed([LEGACY]);
    const { onOpenPath } = renderBook();

    fireEvent.click(screen.getByText('氧解离曲线'));
    expect(onOpenPath).toHaveBeenCalledWith('a.md');
  });

  it('✕ 仍能移出错题本，分布条随之清空', () => {
    seed([LEGACY]);
    renderBook();

    fireEvent.click(screen.getByRole('button', { name: '移出错题本' }));
    expect(loadMistakes()).toEqual({});
    expect(screen.getByText('暂无错题')).toBeTruthy();
  });
});

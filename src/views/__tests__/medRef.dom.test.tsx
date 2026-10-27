// @vitest-environment jsdom
/**
 * 医学速查的挂载冒烟：用**仓库内的测试夹具**喂 fetch，确认
 * 1) 取数路径（app-data/medref/...）是对的，2) 首屏真的渲染出内容而不是空白，
 * 3) 自建条目能存能改能删（存本机，不进仓库），4) 公有领域口诀随包带着。
 *
 * 夹具必须入库：public/app-data/ 是运行时生成物（CI 上没有），测试不能依赖本机
 * 跑过 ingest 脚本。只桩 fetch（网络出口），不桩我们自己的解析逻辑。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MedRefView from '../MedRefView';
import { loadUserSymptoms } from '../../core/medRefStore';

const FIXTURE = join(process.cwd(), 'src', 'views', '__tests__', 'fixtures', 'medref');

function stubFetch() {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const rel = url.replace(/^.*app-data\/medref\//, '');
    try {
      const buf = readFileSync(join(FIXTURE, rel));
      return new Response(buf, { status: 200, headers: { 'content-type': 'application/json' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('医学速查', () => {
  it('默认落在症状页，首屏就有条目', async () => {
    stubFetch();
    const { container } = render(<MedRefView onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/条症状/)).toBeTruthy());
    expect(container.querySelectorAll('.medref-row').length).toBeGreaterThan(10);
  });

  it('搜症状名能筛到那一条', async () => {
    stubFetch();
    const { container } = render(<MedRefView onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/条症状/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText('速查搜索'), { target: { value: '稽留热' } });
    await waitFor(() => expect(container.querySelectorAll('.medref-row')).toHaveLength(1));
    expect(screen.getByText('稽留热')).toBeTruthy();
  });

  it('新增症状存进本机，并且能在列表里编辑它', async () => {
    stubFetch();
    const { container } = render(<MedRefView onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/条症状/)).toBeTruthy());

    fireEvent.click(screen.getByText('＋ 新增'));
    fireEvent.change(screen.getByLabelText('症状名'), { target: { value: '自测症状甲' } });
    fireEvent.change(screen.getByLabelText('关联疾病'), { target: { value: '甲病、乙病' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(loadUserSymptoms()).toHaveLength(1));
    expect(loadUserSymptoms()[0]).toMatchObject({ name: '自测症状甲', diseases: ['甲病', '乙病'] });

    // 搜出来 → 自建条目带「编辑/删除」
    fireEvent.change(screen.getByLabelText('速查搜索'), { target: { value: '自测症状甲' } });
    await waitFor(() => expect(screen.getByText('编辑')).toBeTruthy());
    fireEvent.click(screen.getByText('编辑'));
    fireEvent.change(screen.getByLabelText('症状名'), { target: { value: '自测症状乙' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(loadUserSymptoms()[0].name).toBe('自测症状乙'));
    expect(container.querySelectorAll('.medref-row')).toHaveLength(0); // 旧名字搜不到了
  });

  it('自定义分类：条目里写下新分类，立刻能按它筛，也能在编辑时选回来', async () => {
    stubFetch();
    const { container } = render(<MedRefView onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/条症状/)).toBeTruthy());

    const add = (name: string, cat: string) => {
      fireEvent.click(screen.getByText('＋ 新增'));
      fireEvent.change(screen.getByLabelText('症状名'), { target: { value: name } });
      fireEvent.change(screen.getByLabelText('症状分类'), { target: { value: cat } });
      fireEvent.click(screen.getByText('保存'));
    };
    add('自测甲', '自测分类X');
    add('自测乙', '自测分类Y');
    await waitFor(() => expect(loadUserSymptoms()).toHaveLength(2));

    // 两条一起搜出来
    fireEvent.change(screen.getByLabelText('速查搜索'), { target: { value: '自测' } });
    await waitFor(() => expect(container.querySelectorAll('.medref-row')).toHaveLength(2));

    // 新写的分类立刻成为筛选 chip：点它只剩一条，再点一次取消
    fireEvent.click(screen.getByRole('button', { name: /自测分类X/ }));
    await waitFor(() => expect(container.querySelectorAll('.medref-row')).toHaveLength(1));
    expect(screen.getByText('自测甲')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /自测分类X/ }));
    await waitFor(() => expect(container.querySelectorAll('.medref-row')).toHaveLength(2));

    // 编辑表单的分类候选里也有自建分类，下次不用再手打
    fireEvent.click(screen.getByText('＋ 新增'));
    const opts = [...container.querySelectorAll('#medref-sym-cats option')]
      .map((o) => (o as HTMLOptionElement).value);
    expect(opts).toEqual(expect.arrayContaining(['自测分类X', '自测分类Y']));
  });

  it('口诀页带着公有领域歌诀，且能新增自己的', async () => {
    stubFetch();
    render(<MedRefView onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/条症状/)).toBeTruthy());

    fireEvent.click(screen.getByText('口诀'));
    await waitFor(() => expect(screen.getByText('汤头歌诀')).toBeTruthy());
    expect(screen.getByText(/公有领域/)).toBeTruthy();

    fireEvent.click(screen.getByText('＋ 新增'));
    fireEvent.change(screen.getByLabelText('方名'), { target: { value: '自编方一' } });
    fireEvent.change(screen.getByLabelText('歌诀正文'), { target: { value: '一二三四五六七' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(screen.getByText('自编方一')).toBeTruthy());
  });

  it('口诀页也按自建分类筛，且不再显示别的门类', async () => {
    stubFetch();
    const { container } = render(<MedRefView onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/条症状/)).toBeTruthy());
    fireEvent.click(screen.getByText('口诀'));
    await waitFor(() => expect(screen.getByText('汤头歌诀')).toBeTruthy());

    fireEvent.click(screen.getByText('＋ 新增'));
    fireEvent.change(screen.getByLabelText('方名'), { target: { value: '自编方甲' } });
    fireEvent.change(screen.getByLabelText('口诀分类'), { target: { value: '自测门类' } });
    fireEvent.change(screen.getByLabelText('歌诀正文'), { target: { value: '甲乙丙丁' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(screen.getByText('自编方甲')).toBeTruthy());

    const before = container.querySelectorAll('.medref-row').length;
    fireEvent.click(screen.getByRole('button', { name: /自测门类/ }));
    await waitFor(() => expect(container.querySelectorAll('.medref-row')).toHaveLength(1));
    expect(screen.getByText('自编方甲')).toBeTruthy();
    expect(container.querySelectorAll('.medref-row').length).toBeLessThan(before);
  });
});

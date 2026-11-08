// @vitest-environment jsdom
/**
 * 单词工坊的视图接线：这些是「界面层才能暴露」的漏洞，核心规则有自己的单测。
 *
 * 钉住：
 *   1. 抬头 / 侧栏统计只算当前词库（切库后数字不能串）；
 *   2. 「每轮题量」对今日计划也生效（否则下拉框写着 5，一点开始却出 10 个）；
 *   3. 中文输入法组词期间回车不提交；
 *   4. 结果页「只练本轮错词」只拿本轮错的那一个，不是全部历史错词；
 *   5. 词库加载失败有「重试」，点完真的重新拉。
 *
 * 词库走 fetch：测试里用固定数据替换，不联网。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import WordDrillView from '../WordDrillView';
import { resetBankCacheForTests, type WordRecord } from '../../core/wordDrill';
import { makeStoryArchiveEntry, type WeakWord } from '../../core/wordStory';

const rec = (en: string, patch: Partial<WordRecord> = {}): WordRecord => ({
  en,
  right: 0,
  wrong: 0,
  reps: 0,
  due: 0,
  mastered: false,
  stability: 1,
  difficulty: 5,
  lastReview: 0,
  lapses: 0,
  ...patch,
});

const bankOf = (pairs: Array<[string, string]>) => ({
  count: pairs.length,
  source: 'TypeWords',
  words: pairs.map(([en, zh]) => ({ en, zh })),
});

const okResponse = (data: unknown) => ({ ok: true, json: async () => data });

/** 把一段文本折成 OpenAI 兼容的 SSE 流（runAgent 只认 `data:` 行） */
const sseResponse = (text: string) => {
  const encoder = new TextEncoder();
  const chunks = text.match(/[\s\S]{1,40}/g) ?? [text];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`),
        );
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, body, text: async () => '' };
};

/** 抬头那一段（侧栏的「当前词库」也会提到词库名，按文字找会命中多个） */
const headerText = () => document.querySelector('.wd-head__meta')?.textContent ?? '';

beforeEach(() => {
  localStorage.clear();
  resetBankCacheForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('单词工坊 · 视图', () => {
  it('抬头只统计当前词库；每轮题量对今日计划生效', async () => {
    localStorage.setItem(
      'knowlattice-word-drill',
      JSON.stringify({
        alpha: rec('alpha', { mastered: true, reps: 5, due: Date.now() + 86_400_000 }),
        // 不在 CET-6 词库里的记录：不能被算进抬头
        zeta: rec('zeta', { mastered: true, reps: 5, due: Date.now() + 86_400_000 }),
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okResponse(
          bankOf([
            ['alpha', '甲'],
            ...Array.from({ length: 11 }, (_, i) => [`word${i}`, `词${i}`] as [string, string]),
          ]),
        ),
      ),
    );

    render(<WordDrillView onClose={vi.fn()} />);
    await waitFor(() => expect(headerText()).toMatch(/CET-6 · 12 词 · 已掌握 1/));

    fireEvent.change(screen.getByLabelText('每轮题量'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '开始练习' }));
    // 今日计划本可挑 10 个新词，但每轮题量选了 5
    expect(document.querySelector('.wd-progress')?.textContent).toContain('1 / 5');
  });

  it('输入法组词回车不提交；结果页只练本轮错词', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse(bankOf([['alpha', '甲'], ['beta', '乙']]))),
    );
    // beta 是历史错词（本轮之前就错了），用来区分「本轮错词」和「全部错词」
    localStorage.setItem(
      'knowlattice-word-drill',
      JSON.stringify({ beta: rec('beta', { wrong: 1, due: 0 }) }),
    );

    render(<WordDrillView onClose={vi.fn()} />);
    await waitFor(() => expect(headerText()).toMatch(/CET-6 · 2 词/));
    // 这个用例要读题面里的单词来作答，切回「跟打」
    fireEvent.click(screen.getByRole('button', { name: '跟打' }));
    fireEvent.click(screen.getByRole('button', { name: '开始练习' }));

    const input = screen.getByLabelText('拼写输入');
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'wrong' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // 组词中的回车是「上屏」，不能判错
    expect(screen.queryByText('打错了')).toBeNull();

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('打错了')).toBeTruthy();

    // 复盘 → 继续 → 第二个词按它自己的提示答对 → 结果页
    fireEvent.click(screen.getByRole('button', { name: '继续（Enter）' }));
    const second = await waitFor(() => screen.getByLabelText('拼写输入'));
    const secondWord = document.querySelector('.wd-word')?.textContent ?? '';
    expect(secondWord).not.toBe('');
    fireEvent.change(second, { target: { value: secondWord } });
    fireEvent.keyDown(second, { key: 'Enter' });

    // 本轮只错 1 个；历史错词 beta 若被带进来，队列会是 2 个
    const roundWrong = await waitFor(() => screen.getByRole('button', { name: /只练本轮错词/ }));
    fireEvent.click(roundWrong);
    expect(document.querySelector('.wd-progress')?.textContent).toContain('1 / 1');
  });

  it('词库加载失败可以重试', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('网络断了');
        return okResponse(bankOf([['alpha', '甲']]));
      }),
    );

    render(<WordDrillView onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/词库加载失败/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(headerText()).toMatch(/CET-6 · 1 词/));
  });

  it('听写 / 自测答题中收起词表，答案不从错词本漏出', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okResponse({
          count: 1,
          source: 'TypeWords',
          words: [{ en: 'alpha', zh: '甲', example: 'The alpha male leads the pack.' }],
        }),
      ),
    );
    // 这个词就在错词本里；如果侧栏照常显示，题目还没答答案就先露出来了
    localStorage.setItem(
      'knowlattice-word-drill',
      JSON.stringify({ alpha: rec('alpha', { wrong: 2, due: 0 }) }),
    );

    render(<WordDrillView onClose={vi.fn()} />);
    await waitFor(() => expect(headerText()).toMatch(/CET-6 · 1 词/));
    fireEvent.click(screen.getByRole('button', { name: '听写' }));
    fireEvent.click(screen.getByRole('button', { name: '开始练习' }));

    const text = document.querySelector('.wd-panel')?.textContent ?? '';
    expect(text.toLowerCase()).not.toContain('alpha');
    expect(text).toContain('词表暂时收起');
    // 例句里的原词也要遮掉
    expect(text).toContain('____');
  });

  it('听写例句会遮住词形变化，不只遮原词', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okResponse({
          count: 1,
          source: 'TypeWords',
          words: [
            { en: 'spectator', zh: '观众', example: 'Many spectators gathered from all parts of Greece.' },
          ],
        }),
      ),
    );

    render(<WordDrillView onClose={vi.fn()} />);
    await waitFor(() => expect(headerText()).toMatch(/CET-6 · 1 词/));
    fireEvent.click(screen.getByRole('button', { name: '听写' }));
    fireEvent.click(screen.getByRole('button', { name: '开始练习' }));

    const text = (document.querySelector('.wd-panel')?.textContent ?? '').toLowerCase();
    expect(text).not.toContain('spectator');
    expect(text).not.toContain('spectators');
    expect(text).toContain('____');
  });

  it('薄弱词成文：按记录取 8 个最弱词，生成短文后再逐句精读', async () => {
    const pairs: Array<[string, string]> = [
      ['alpha', '甲'],
      ['beta', '乙'],
      ['gamma', '丙'],
      ['delta', '丁'],
      ['epsilon', '戊'],
      ['zeta', '己'],
      ['eta', '庚'],
      ['theta', '辛'],
      ['iota', '壬'],
      ['kappa', '癸'],
      ['lambda', '子'],
      ['mu', '丑'],
    ];
    const now = Date.now();
    localStorage.setItem(
      'knowlattice-word-drill',
      JSON.stringify(
        Object.fromEntries(
          pairs.map(([en], i) => [
            en,
            rec(en, {
              wrong: i + 1,
              right: 0,
              lapses: i % 3,
              difficulty: 3 + (i % 5),
              stability: 1,
              lastReview: now - i * 86_400_000,
            }),
          ]),
        ),
      ),
    );
    // 与课程工坊 / AI 助手共用同一份配置；本机 HTTP 回环允许，请求由下面的桩接住
    localStorage.setItem(
      'knowlattice-ai-agent-settings',
      JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-key', model: 'mock' }),
    );

    const calls: string[] = [];
    const bodies: string[] = [];
    const story = {
      title: 'The Quiet Shift',
      titleZh: '安静的转变',
      sentences: [
        { en: 'Mira had been on the verge of giving up.', zh: '米拉当时快要放弃了。' },
        { en: 'A small habit, repeated daily, changed everything.', zh: '一个每天重复的小习惯改变了一切。' },
      ],
    };
    const analysis = {
      sentences: [
        {
          index: 1,
          grammar: '过去完成时',
          points: [{ phrase: 'on the verge of', kind: '固定搭配', zh: '濒临', tip: '后接名词或动名词' }],
        },
        {
          index: 2,
          points: [{ phrase: 'repeated daily', kind: '高分词组', zh: '每天重复', tip: '分词短语作后置定语' }],
        },
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('wordbanks/')) return okResponse(bankOf(pairs));
        bodies.push(String(init?.body ?? ''));
        return sseResponse(JSON.stringify(bodies.length === 1 ? story : analysis));
      }),
    );

    const view = render(<WordDrillView onClose={vi.fn()} />);
    await waitFor(() => expect(headerText()).toMatch(/CET-6 · 12 词/));

    fireEvent.click(screen.getByRole('button', { name: '薄弱词成文' }));
    expect(screen.getByText(/本次目标词 8 个/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '生成短文' }));
    await waitFor(() => expect(screen.getByText('The Quiet Shift')).toBeTruthy());
    // 短文先落定，精读随后补上
    await waitFor(() => expect(screen.getByText('逐句精读')).toBeTruthy());
    await waitFor(() => expect(screen.getAllByText('on the verge of').length).toBeGreaterThan(0));
    expect(screen.getByText(/过去完成时/)).toBeTruthy();
    expect(screen.getAllByText('repeated daily').length).toBeGreaterThan(0);

    const chats = calls.filter((url) => url.includes('/chat/completions'));
    expect(chats).toHaveLength(2);
    expect(bodies[0]).toContain('只输出一个 JSON 对象');
    expect(bodies[0]).toContain('目标词');
    expect(bodies[1]).toContain('Mira had been on the verge of giving up.');

    // 生成即落盘：关闭面板（卸载）后重新打开，历史里仍能找到，且不需要再调模型
    const archived = JSON.parse(localStorage.getItem('knowlattice-word-drill-stories') ?? '[]') as Array<{
      story: { title: string };
      analysis: { lines: unknown[] } | null;
    }>;
    expect(archived).toHaveLength(1);
    expect(archived[0].story.title).toBe('The Quiet Shift');
    expect(archived[0].analysis?.lines).toHaveLength(2);

    view.unmount();
    render(<WordDrillView onClose={vi.fn()} />);
    await waitFor(() => expect(headerText()).toMatch(/CET-6 · 12 词/));
    fireEvent.click(screen.getByRole('button', { name: '薄弱词成文' }));
    fireEvent.click(screen.getByRole('button', { name: /历史短文（1）/ }));
    fireEvent.click(screen.getByRole('button', { name: /^The Quiet Shift/ }));
    expect(screen.getByText('The Quiet Shift')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('on the verge of').length).toBeGreaterThan(0));
    expect(calls.filter((url) => url.includes('/chat/completions'))).toHaveLength(2);

    // 删除：确认后本地存储真的清空
    fireEvent.click(screen.getByRole('button', { name: /历史短文（1）/ }));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '删除历史：The Quiet Shift' }));
    confirmSpy.mockRestore();
    expect(JSON.parse(localStorage.getItem('knowlattice-word-drill-stories') ?? '[]')).toEqual([]);
  });
});

describe('单词工坊 · 历史短文', () => {
  it('精读未生成的历史短文可单独重试，且不会多存一篇', async () => {
    const weak: WeakWord = {
      word: { en: 'alpha', zh: '甲' },
      record: rec('alpha', { wrong: 2 }),
      score: 2,
    };
    const story = {
      title: 'Archived Story',
      titleZh: '',
      sentences: [{ en: 'She kept walking.', zh: '她继续走着。' }],
    };
    localStorage.setItem(
      'knowlattice-word-drill-stories',
      JSON.stringify([
        makeStoryArchiveEntry({ createdAt: Date.now(), bankName: 'CET-6', words: [weak], story, analysis: null }),
      ]),
    );
    localStorage.setItem(
      'knowlattice-ai-agent-settings',
      JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-key', model: 'mock' }),
    );

    const analysis = {
      sentences: [
        { index: 1, points: [{ phrase: 'kept walking', kind: '动词短语', zh: '继续走', tip: 'keep + doing' }] },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('wordbanks/')) return okResponse(bankOf([['alpha', '甲']]));
        return sseResponse(JSON.stringify(analysis));
      }),
    );

    render(<WordDrillView onClose={vi.fn()} />);
    await waitFor(() => expect(headerText()).toMatch(/CET-6 · 1 词/));
    fireEvent.click(screen.getByRole('button', { name: '薄弱词成文' }));
    fireEvent.click(screen.getByRole('button', { name: /历史短文（1）/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Archived Story/ }));
    expect(screen.getByText('Archived Story')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '重试精读' }));
    await waitFor(() => expect(screen.getAllByText('kept walking').length).toBeGreaterThan(0));

    const saved = JSON.parse(localStorage.getItem('knowlattice-word-drill-stories') ?? '[]') as Array<{
      analysis: { lines: Array<{ points: Array<{ phrase: string }> }> } | null;
    }>;
    expect(saved).toHaveLength(1);
    expect(saved[0].analysis?.lines[0].points[0].phrase).toBe('kept walking');
  });

  it('精读首次返回坏 JSON 时自动重试一次，不丢短文', async () => {
    const weak: WeakWord = {
      word: { en: 'alpha', zh: '甲' },
      record: rec('alpha', { wrong: 2 }),
      score: 2,
    };
    const story = {
      title: 'Retry Story',
      titleZh: '',
      sentences: [{ en: 'She kept walking.', zh: '她继续走着。' }],
    };
    localStorage.setItem(
      'knowlattice-word-drill-stories',
      JSON.stringify([
        makeStoryArchiveEntry({ createdAt: Date.now(), bankName: 'CET-6', words: [weak], story, analysis: null }),
      ]),
    );
    localStorage.setItem(
      'knowlattice-ai-agent-settings',
      JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-key', model: 'mock' }),
    );
    const analysis = {
      sentences: [
        { index: 1, points: [{ phrase: 'kept walking', kind: '动词短语', zh: '继续走', tip: 'keep + doing' }] },
      ],
    };
    let analysisCalls = 0;
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('wordbanks/')) return okResponse(bankOf([['alpha', '甲']]));
        analysisCalls += 1;
        bodies.push(String(init?.body ?? ''));
        return sseResponse(analysisCalls === 1 ? '抱歉，我忘了 JSON' : JSON.stringify(analysis));
      }),
    );

    render(<WordDrillView onClose={vi.fn()} />);
    await waitFor(() => expect(headerText()).toMatch(/CET-6 · 1 词/));
    fireEvent.click(screen.getByRole('button', { name: '薄弱词成文' }));
    fireEvent.click(screen.getByRole('button', { name: /历史短文（1）/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Retry Story/ }));
    fireEvent.click(screen.getByRole('button', { name: '重试精读' }));

    await waitFor(() => expect(screen.getAllByText('kept walking').length).toBeGreaterThan(0));
    expect(analysisCalls).toBe(2);
    expect(bodies[1]).toContain('上一次输出无法解析');
    // 短文仍在，历史没有被重试删掉
    expect(screen.getByText('Retry Story')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('knowlattice-word-drill-stories') ?? '[]')).toHaveLength(1);
  });
});

describe('单词工坊 · 背诵与历史操作', () => {
  const weak = (en: string, zh: string): WeakWord => ({
    word: { en, zh },
    record: rec(en, { wrong: 3, lapses: 1, due: Date.now() + 86_400_000 }),
    score: 3,
  });

  const seedStory = (pinned = false) => {
    const story = {
      title: 'Walk On',
      titleZh: '继续走',
      sentences: [{ en: 'She kept walking home.', zh: '她继续走回家。' }],
    };
    const analysis = {
      lines: [
        {
          index: 1,
          grammar: '过去进行时',
          points: [{ phrase: 'kept walking', kind: '动词短语', zh: '继续走', tip: 'keep + doing' }],
        },
      ],
    };
    localStorage.setItem(
      'knowlattice-word-drill-stories',
      JSON.stringify([
        makeStoryArchiveEntry({
          createdAt: Date.now(),
          bankName: 'CET-6',
          words: [weak('walking', '走')],
          story,
          analysis,
          pinned,
        }),
      ]),
    );
    return story;
  };

  it('背诵模式先挖空并隐藏译文，显示答案后恢复精读', async () => {
    seedStory();
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(bankOf([['walking', '走']]))));
    const speak = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak, cancel });
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        lang = '';
        rate = 1;
        text: string;
        constructor(text: string) {
          this.text = text;
        }
      },
    );

    render(<WordDrillView onClose={vi.fn()} />);
    await waitFor(() => expect(headerText()).toMatch(/CET-6 · 1 词/));
    fireEvent.click(screen.getByRole('button', { name: '薄弱词成文' }));
    fireEvent.click(screen.getByRole('button', { name: /历史短文（1）/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Walk On/ }));

    fireEvent.click(screen.getByRole('button', { name: '背诵模式' }));
    expect(document.querySelectorAll('.wd-story__blank').length).toBeGreaterThan(0);
    expect(screen.queryByText(/本次目标词/)).toBeNull();
    expect(screen.queryByText('逐句精读')).toBeNull();
    expect(screen.queryByText('她继续走回家。')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '朗读短文' }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledTimes(1);
    expect((speak.mock.calls[0][0] as { text: string }).text).toContain('She kept walking home.');

    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    expect(document.querySelectorAll('.wd-story__blank')).toHaveLength(0);
    expect(screen.getByText('逐句精读')).toBeTruthy();
    expect(screen.getByText('她继续走回家。')).toBeTruthy();
  });

  it('收藏置顶、只看收藏与搜索都落到历史列表', async () => {
    seedStory();
    const story2 = {
      title: 'Another Day',
      titleZh: '',
      sentences: [{ en: 'She kept walking home again.', zh: '' }],
    };
    const saved = JSON.parse(localStorage.getItem('knowlattice-word-drill-stories') ?? '[]');
    saved.push(
      makeStoryArchiveEntry({
        createdAt: Date.now() - 60_000,
        bankName: 'CET-6',
        words: [weak('walking', '走')],
        story: story2,
        analysis: null,
      }),
    );
    localStorage.setItem('knowlattice-word-drill-stories', JSON.stringify(saved));
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(bankOf([['walking', '走']]))));

    render(<WordDrillView onClose={vi.fn()} />);
    await waitFor(() => expect(headerText()).toMatch(/CET-6 · 1 词/));
    fireEvent.click(screen.getByRole('button', { name: '薄弱词成文' }));
    fireEvent.click(screen.getByRole('button', { name: /历史短文（2）/ }));
    fireEvent.click(screen.getByRole('button', { name: '收藏：Walk On' }));

    const afterPin = JSON.parse(localStorage.getItem('knowlattice-word-drill-stories') ?? '[]');
    expect(afterPin[0].story.title).toBe('Walk On');
    expect(afterPin[0].pinned).toBe(true);
    const rows = document.querySelectorAll('.wd-archive__open b');
    expect(rows[0]?.textContent).toContain('Walk On');

    fireEvent.click(screen.getByRole('button', { name: '只看收藏' }));
    expect(document.querySelectorAll('.wd-archive')).toHaveLength(1);

    const search = screen.getByLabelText('搜索历史短文');
    fireEvent.change(search, { target: { value: '不存在' } });
    expect(screen.getByText(/没有匹配的历史短文/)).toBeTruthy();
  });

  it('当前短文可存为知识库笔记，目录与标题稳定', async () => {
    seedStory();
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(bankOf([['walking', '走']]))));
    const onSaveNote = vi.fn(async (dir: string, title: string, content: string) => {
      void content;
      return `${dir}/${title}.md`;
    });

    render(<WordDrillView onClose={vi.fn()} onSaveNote={onSaveNote} />);
    await waitFor(() => expect(headerText()).toMatch(/CET-6 · 1 词/));
    fireEvent.click(screen.getByRole('button', { name: '薄弱词成文' }));
    fireEvent.click(screen.getByRole('button', { name: /历史短文（1）/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Walk On/ }));
    fireEvent.click(screen.getByRole('button', { name: '存为笔记' }));

    await waitFor(() => expect(onSaveNote).toHaveBeenCalledTimes(1));
    const [dir, title, content] = onSaveNote.mock.calls[0];
    expect(dir).toBe('单词工坊');
    expect(title).toContain('Walk-On');
    expect(content).toContain('Walk On');
    expect(content).toContain('kept walking');
  });
});

describe('单词工坊 · 自定义词库入口', () => {
  it('工具栏入口切到「我的词库」导入区并聚焦输入框', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse(bankOf([['alpha', '甲']]))),
    );

    render(<WordDrillView onClose={vi.fn()} />);
    await waitFor(() => expect(headerText()).toMatch(/CET-6 · 1 词/));

    fireEvent.click(screen.getByRole('button', { name: /自定义词库/ }));
    const area = screen.getByPlaceholderText(/homeostasis 内环境稳态/);
    await waitFor(() => expect(document.activeElement).toBe(area));
    await waitFor(() => expect(headerText()).toMatch(/我的词库 · 0 词/));
    expect(screen.getByRole('tab', { name: /我的词库/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('词库文件先预览再导入，导入后切到我的词库', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse(bankOf([['alpha', '甲']]))),
    );
    if (typeof File.prototype.text !== 'function') {
      Object.defineProperty(File.prototype, 'text', {
        configurable: true,
        value(this: File) {
          return new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ''));
            reader.onerror = () => reject(reader.error);
            reader.readAsText(this);
          });
        },
      });
    }

    render(<WordDrillView onClose={vi.fn()} />);
    await waitFor(() => expect(headerText()).toMatch(/CET-6 · 1 词/));
    fireEvent.click(screen.getByRole('button', { name: /自定义词库/ }));

    const input = screen.getByLabelText('选择词库文件') as HTMLInputElement;
    const file = new File(['fragile 脆弱的\n'], 'bank.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(document.querySelector('.wd-file__preview')?.textContent).toContain('bank.txt'));
    expect(document.querySelector('.wd-import')).toHaveProperty('value', 'fragile 脆弱的');

    fireEvent.click(screen.getByRole('button', { name: '导入到我的词库' }));
    await waitFor(() => expect(headerText()).toMatch(/我的词库 · 1 词/));
    const saved = JSON.parse(localStorage.getItem('knowlattice-word-drill-bank') ?? '[]');
    expect(saved).toEqual([{ en: 'fragile', zh: '脆弱的' }]);
  });
});

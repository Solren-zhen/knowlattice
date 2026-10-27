import { describe, expect, it } from 'vitest';
import {
  createTraceRecorder,
  hashArgs,
  intentKeyOf,
  isRepeatAsk,
  similarity,
  tokensOf,
} from '../agentTrace';

describe('hashArgs', () => {
  it('输出 8 位小写 hex，且同一输入稳定', () => {
    const first = hashArgs('{"tool":"read","args":{"path":"a.md"}}');
    expect(first).toBe(hashArgs('{"tool":"read","args":{"path":"a.md"}}'));
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(hashArgs('{"tool":"write"}')).not.toBe(first);
  });

  it('对空串与 "a" 落到 FNV-1a 32 位已知向量（证明算法不是随便拼的）', () => {
    expect(hashArgs('')).toBe('811c9dc5');
    expect(hashArgs('a')).toBe('e40c292c');
  });

  it('非法 JSON 不抛，且按原始字符串稳定哈希', () => {
    expect(() => hashArgs('{not json')).not.toThrow();
    expect(hashArgs('{not json')).toMatch(/^[0-9a-f]{8}$/);
    expect(hashArgs('{not json')).toBe(hashArgs('{not json'));
    expect(hashArgs('{not json')).not.toBe(hashArgs('[1,'));
  });

  it('合法 JSON 的空白差异不影响指纹', () => {
    expect(hashArgs('{"a": 1, "b": [1, 2]}')).toBe(hashArgs('{"a":1,"b":[1,2]}'));
  });
});

describe('tokensOf', () => {
  it('中英混合：ASCII 整词、汉字 bigram、被隔开的孤立单字', () => {
    expect(tokensOf('用 SQL 查 Hello, SQL!')).toEqual(['用', 'sql', '查', 'hello']);
  });

  it('汉字连写取双字 bigram', () => {
    expect(tokensOf('中文测试')).toEqual(['中文', '文测', '测试']);
  });

  it('小写归一、去标点、去重保序', () => {
    expect(tokensOf('A a, B!')).toEqual(['a', 'b']);
    expect(tokensOf('Node.js 与 Vite')).toEqual(['node', 'js', '与', 'vite']);
  });

  it('空白与标点输入返回空数组', () => {
    expect(tokensOf('')).toEqual([]);
    expect(tokensOf(' ,.!?\n\t')).toEqual([]);
  });
});

describe('intentKeyOf', () => {
  it('token 排序后拼接，词序不同得到同一个键', () => {
    expect(intentKeyOf('beta alpha beta')).toBe('alpha beta');
    expect(intentKeyOf('alpha beta')).toBe(intentKeyOf('beta, alpha!'));
  });

  it('空输入返回空串', () => {
    expect(intentKeyOf('')).toBe('');
    expect(intentKeyOf('  ...  ')).toBe('');
  });
});

describe('similarity', () => {
  it('对称，且落在 Jaccard 的 1/3 值上', () => {
    const forward = similarity('alpha beta', 'beta gamma');
    expect(forward).toBeCloseTo(1 / 3, 12);
    expect(similarity('beta gamma', 'alpha beta')).toBeCloseTo(forward, 12);
  });

  it('0 与 1 的边界', () => {
    expect(similarity('alpha beta', 'alpha beta')).toBe(1);
    expect(similarity('alpha', 'beta')).toBe(0);
  });

  it('空集合返回 0（不是数学上的 1）', () => {
    expect(similarity('', '')).toBe(0);
    expect(similarity('', 'alpha')).toBe(0);
    expect(similarity('  ', '  ')).toBe(0);
  });
});

describe('isRepeatAsk', () => {
  it('默认阈值 0.7：0.6 不算重复，0.8 算重复', () => {
    expect(isRepeatAsk('a b c d', ['a b c x'])).toBe(false);
    expect(isRepeatAsk('a b c d', ['a b c d e'])).toBe(true);
  });

  it('阈值可调，命中任一条历史即 true', () => {
    expect(isRepeatAsk('alpha beta', ['alpha gamma'], 0.4)).toBe(false);
    expect(isRepeatAsk('alpha beta', ['alpha gamma'], 0.3)).toBe(true);
    expect(isRepeatAsk('alpha beta', ['zzz', 'alpha beta'])).toBe(true);
    expect(isRepeatAsk('alpha beta', [])).toBe(false);
  });
});

describe('createTraceRecorder', () => {
  it('默认 id 递增、默认取真实时间', () => {
    const recorder = createTraceRecorder();
    const startedAt = Date.now();
    const first = recorder.begin({ sessionId: 's', userText: '第一问' }).value();
    const second = recorder.begin({ sessionId: 's', userText: '第二问' }).value();
    expect(first.traceId).toBe('tr-1');
    expect(second.traceId).toBe('tr-2');
    expect(first.startedAt).toBeGreaterThanOrEqual(startedAt);
  });

  it('可注入 now 与 idFactory，轨迹因此可复现', () => {
    let tick = 0;
    const recorder = createTraceRecorder({
      now: () => 1_700_000_000_000 + tick++,
      idFactory: () => 'fixed-id',
    });
    const first = recorder.begin({ sessionId: 's', userText: 'q1' }).finish('ok');
    const second = recorder.begin({ sessionId: 's', userText: 'q2' }).finish('ok');
    expect(first.traceId).toBe('fixed-id');
    expect(first.startedAt).toBe(1_700_000_000_000);
    expect(second.startedAt).toBe(1_700_000_000_001);
  });

  it('limit 生效：超出后 FIFO 丢最旧的', () => {
    const recorder = createTraceRecorder({ limit: 3 });
    for (let i = 0; i < 4; i++) {
      recorder.begin({ sessionId: 's', userText: `问题 ${i}` }).finish('ok');
    }
    expect(recorder.list().map((trace) => trace.traceId)).toEqual(['tr-2', 'tr-3', 'tr-4']);
  });

  it('bySession 只返回该会话的轨迹', () => {
    const recorder = createTraceRecorder();
    recorder.begin({ sessionId: 'a', userText: 'q1' }).finish('ok');
    recorder.begin({ sessionId: 'b', userText: 'q2' }).finish('error');
    recorder.begin({ sessionId: 'a', userText: 'q3' }).finish('aborted');
    expect(recorder.bySession('a').map((trace) => trace.traceId)).toEqual(['tr-1', 'tr-3']);
    expect(recorder.bySession('b')).toHaveLength(1);
    expect(recorder.bySession('missing')).toEqual([]);
  });

  it('select / decide / call 按调用顺序落盘，command 默认 null', () => {
    const recorder = createTraceRecorder();
    const handle = recorder.begin({ sessionId: 's', userText: '修 parser 边界' });
    handle.select('read');
    handle.select('edit');
    handle.call('read', '{"path":"src/core/parser.ts"}', true, 1200);
    handle.decide('act-1', 'auto');
    handle.decide('act-2', 'rejected');

    const trace = handle.value();
    expect(trace.command).toBeNull();
    expect(trace.selectedTools).toEqual(['read', 'edit']);
    expect(trace.calls).toEqual([
      {
        name: 'read',
        argsHash: hashArgs('{"path":"src/core/parser.ts"}'),
        ok: true,
        chars: 1200,
      },
    ]);
    expect(trace.decisions).toEqual([
      { actionId: 'act-1', approval: 'auto' },
      { actionId: 'act-2', approval: 'rejected' },
    ]);
    // 未 finish 时不写 command 字段也拿到 null，而不是 undefined
    expect(recorder.list()[0].command).toBeNull();
  });

  it('command 原样保留，intentKey 由 userText 归一化而来', () => {
    const recorder = createTraceRecorder();
    const trace = recorder
      .begin({ sessionId: 's', userText: 'beta alpha', command: 'npm test' })
      .finish('ok');
    expect(trace.command).toBe('npm test');
    expect(trace.intentKey).toBe('alpha beta');
  });

  it('未 finish 的轨迹在 list() 里可见，outcome 是中性占位', () => {
    const recorder = createTraceRecorder();
    const handle = recorder.begin({ sessionId: 's', userText: '第一问' });
    handle.call('read', '{}', true, 10);
    const listed = recorder.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].calls).toHaveLength(1);
    expect(listed[0].outcome).toBe('ok');
  });

  it('finish 之后返回冻结快照：迟到回调与外部改写都不影响它', () => {
    const recorder = createTraceRecorder();
    const handle = recorder.begin({ sessionId: 's', userText: 'q' });
    handle.call('read', '{}', true, 42);
    const finished = handle.finish('error');

    handle.call('write', '{}', false, 999);
    handle.decide('late', 'rejected');
    handle.select('late');
    expect(handle.value().calls).toHaveLength(1);
    expect(handle.value().decisions).toEqual([]);
    expect(handle.value().selectedTools).toEqual([]);

    // finish 是终态：再 finish 一次不会改写 outcome
    expect(handle.finish('ok').outcome).toBe('error');

    // 快照与记录器互不共享数组
    finished.calls.push({ name: 'x', argsHash: '00000000', ok: false, chars: 0 });
    expect(handle.value().calls).toHaveLength(1);
    const listed = recorder.list();
    listed[0].decisions.push({ actionId: 'ghost', approval: 'auto' });
    expect(recorder.list()[0].decisions).toEqual([]);
  });

  it('repeatAskCount 统计 priorUserTexts 判定为重复的回合', () => {
    const recorder = createTraceRecorder();
    recorder.begin({
      sessionId: 's',
      userText: '修 parser 边界',
      priorUserTexts: ['修 parser 边界', '部署 docker'],
    });
    recorder.begin({
      sessionId: 's',
      userText: '部署 docker compose',
      priorUserTexts: ['修 parser 边界'],
    });
    recorder.begin({ sessionId: 's', userText: '写一个统计脚本' });
    expect(recorder.list().map((trace) => trace.repeatedAsk)).toEqual([true, false, false]);
    expect(recorder.repeatAskCount()).toBe(1);
  });

  it('clear 清空历史，之后 id 继续递增', () => {
    const recorder = createTraceRecorder();
    recorder.begin({ sessionId: 's', userText: 'q1' }).finish('ok');
    recorder.clear();
    expect(recorder.list()).toEqual([]);
    expect(recorder.repeatAskCount()).toBe(0);
    expect(recorder.begin({ sessionId: 's', userText: 'q2' }).value().traceId).toBe('tr-2');
  });
});

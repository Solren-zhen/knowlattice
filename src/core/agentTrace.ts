/**
 * Agent 回合轨迹：「一次用户回合里做了什么」的可比较记录，供后续技能蒸馏按意图聚类。
 *
 * 设计取向是纯函数 + 可注入依赖：同样的入参必须得到同样的轨迹，
 * 所以时间戳和 traceId 都从外部传入，模块自身不读 Date.now / 不产生随机 id。
 */

export interface TraceCall {
  name: string;
  argsHash: string;
  ok: boolean;
  chars: number;
}

export interface TraceDecision {
  actionId: string;
  approval: 'auto' | 'applied' | 'rejected';
}

export type TraceOutcome = 'ok' | 'error' | 'aborted';

export interface TurnTrace {
  traceId: string;
  sessionId: string;
  startedAt: number;
  intentKey: string;
  command: string | null;
  selectedTools: string[];
  calls: TraceCall[];
  decisions: TraceDecision[];
  outcome: TraceOutcome;
  repeatedAsk: boolean;
}

/** FNV-1a 32 位常量 */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * 参数指纹：FNV-1a 32 位，输出 8 位小写 hex。
 *
 * 合法 JSON 先重新序列化再哈希，这样同一个参数对象写成带空格/换行的形式也落到同一个指纹上
 * （模型生成的 JSON 空白写法不稳定，直接哈希原文会让「同一次调用」算成两次）。
 * 解析失败或空串不抛：这类输入在记录链路上只会让轨迹断掉，不如按原始字符串参与哈希。
 */
export function hashArgs(argsJson: string): string {
  let payload = argsJson;
  try {
    payload = JSON.stringify(JSON.parse(argsJson)) ?? argsJson;
  } catch {
    payload = argsJson;
  }
  // 按 UTF-8 字节而不是 UTF-16 码元：跨平台/跨语言重算同一个指纹。
  const bytes = new TextEncoder().encode(payload);
  let hash = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 汉字覆盖区：基本区、扩展 A、兼容区、〇、扩展 B 及以后的星形面。 */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x3007, 0x3007],
  [0x20000, 0x2fa1f],
];

function isCjk(codePoint: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return true;
  }
  return false;
}

const ASCII_WORD_CHAR = /^[a-z0-9]$/;
const OTHER_LETTER = /[\p{L}\p{N}]/u;

/**
 * 分词：小写归一、去标点空白，ASCII 按整词切；汉字连写取双字 bigram，
 * 被标点/ASCII 隔开的孤立单字自成 token；输出按首次出现去重。
 *
 * 汉字取 bigram 是因为中文没有空格边界，单字噪音太大、整句又不可比；
 * 双字保留足够上下文，代价是「测试」和「测试集」会被当成不同 token（可接受）。
 */
export function tokensOf(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();

  const push = (token: string): void => {
    if (token.length > 0 && !seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  };

  let word = '';
  let otherWord = '';
  let cjkRun: string[] = [];

  const flush = (): void => {
    if (word.length > 0) {
      push(word);
      word = '';
    }
    if (otherWord.length > 0) {
      push(otherWord);
      otherWord = '';
    }
    if (cjkRun.length === 1) {
      push(cjkRun[0]);
    } else {
      for (let i = 0; i + 1 < cjkRun.length; i++) push(cjkRun[i] + cjkRun[i + 1]);
    }
    cjkRun = [];
  };

  // 按码点遍历：星形面汉字是代理对，按 code unit 切会切出半个字。
  for (const ch of text.toLowerCase()) {
    const codePoint = ch.codePointAt(0) as number;
    if (ASCII_WORD_CHAR.test(ch)) {
      if (otherWord.length > 0 || cjkRun.length > 0) flush();
      word += ch;
    } else if (isCjk(codePoint)) {
      if (word.length > 0 || otherWord.length > 0) flush();
      cjkRun.push(ch);
    } else if (OTHER_LETTER.test(ch)) {
      if (word.length > 0 || cjkRun.length > 0) flush();
      otherWord += ch;
    } else {
      flush();
    }
  }
  flush();

  return tokens;
}

/** 意图键：token 排序后空格拼接，词序不同的同一句话得到同一个键。 */
export function intentKeyOf(text: string): string {
  return tokensOf(text).sort().join(' ');
}

/**
 * token 集合 Jaccard 相似度，取值 [0, 1]。
 *
 * 空集合一律 0（而不是数学约定的 1）：空文本之间没有共同意图，
 * 判成「重复提问」会把两条空轨迹错误合并。
 */
export function similarity(a: string, b: string): number {
  const setA = new Set(tokensOf(a));
  const setB = new Set(tokensOf(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let intersection = 0;
  for (const token of small) {
    if (large.has(token)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/** 与历史任一提问相似度达到阈值即视为重复提问（默认 0.7）。 */
export function isRepeatAsk(current: string, history: readonly string[], threshold = 0.7): boolean {
  return history.some((previous) => similarity(current, previous) >= threshold);
}

export interface TraceInput {
  sessionId: string;
  userText: string;
  command?: string | null;
  priorUserTexts?: readonly string[];
}

export interface TraceHandle {
  traceId: string;
  call(name: string, argsJson: string, ok: boolean, chars: number): void;
  decide(actionId: string, approval: TraceDecision['approval']): void;
  select(name: string): void;
  finish(outcome: TraceOutcome): TurnTrace;
  value(): TurnTrace;
}

export interface TraceRecorder {
  begin(input: TraceInput): TraceHandle;
  list(): TurnTrace[];
  bySession(sessionId: string): TurnTrace[];
  repeatAskCount(): number;
  clear(): void;
}

/**
 * 轨迹记录器。
 *
 * - limit 默认 200，超出后 FIFO 丢最旧：长会话里工具历史无上限增长会拖垮内存与序列化。
 * - 未 finish 的轨迹也在 list() 里可见，方便中途统计；finish 之后 handle 变成只读。
 * - 对外返回的一律是深拷贝快照，调用方改返回值不会污染记录器内部状态。
 */
export function createTraceRecorder(opts?: {
  limit?: number;
  now?: () => number;
  idFactory?: () => string;
}): TraceRecorder {
  const rawLimit = opts?.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : 200;
  const now = opts?.now ?? (() => Date.now());
  let sequence = 0;
  const idFactory = opts?.idFactory ?? (() => `tr-${++sequence}`);

  const traces: TurnTrace[] = [];

  const snapshot = (trace: TurnTrace): TurnTrace => ({
    ...trace,
    selectedTools: [...trace.selectedTools],
    calls: trace.calls.map((call) => ({ ...call })),
    decisions: trace.decisions.map((decision) => ({ ...decision })),
  });

  const begin = (input: TraceInput): TraceHandle => {
    const traceId = idFactory();
    const trace: TurnTrace = {
      traceId,
      sessionId: input.sessionId,
      startedAt: now(),
      intentKey: intentKeyOf(input.userText),
      command: input.command ?? null,
      selectedTools: [],
      calls: [],
      decisions: [],
      // TraceOutcome 没有「进行中」态，未 finish 时用 'ok' 作中性占位，finish() 会覆盖。
      outcome: 'ok',
      repeatedAsk: isRepeatAsk(input.userText, input.priorUserTexts ?? []),
    };

    traces.push(trace);
    while (traces.length > limit) traces.shift();

    let archived: TurnTrace | null = null;

    return {
      traceId,
      call(name: string, argsJson: string, ok: boolean, chars: number): void {
        // finish 之后迟到的回调不应改脏已归档轨迹（蒸馏读的是归档快照）。
        if (archived) return;
        trace.calls.push({ name, argsHash: hashArgs(argsJson), ok, chars });
      },
      decide(actionId: string, approval: TraceDecision['approval']): void {
        if (archived) return;
        trace.decisions.push({ actionId, approval });
      },
      select(name: string): void {
        if (archived) return;
        trace.selectedTools.push(name);
      },
      finish(outcome: TraceOutcome): TurnTrace {
        if (!archived) {
          trace.outcome = outcome;
          archived = snapshot(trace);
        }
        return snapshot(archived);
      },
      value(): TurnTrace {
        return archived ? snapshot(archived) : snapshot(trace);
      },
    };
  };

  return {
    begin,
    list: () => traces.map(snapshot),
    bySession: (sessionId: string) => traces.filter((trace) => trace.sessionId === sessionId).map(snapshot),
    repeatAskCount: () => traces.reduce((count, trace) => count + (trace.repeatedAsk ? 1 : 0), 0),
    clear: () => {
      traces.length = 0;
    },
  };
}

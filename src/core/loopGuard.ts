/**
 * 原地打转防护：同一个工具、同一份参数连着调，多半是模型在绕圈，不是在推进任务。
 *
 * 为什么放在执行前而不是统计后：绕圈的代价是「每一轮都把整段上下文重发一次」，
 * 事后统计只能告诉用户浪费了多少。拦住第 3 次重复，这一轮就省下来了。
 *
 * 判定故意宽松：相同调用允许重复 `maxRepeat` 次（模型确实可能需要再读一次刚改过的笔记），
 * 只有第 3 次起才算绕圈；参数按键名递归排序后序列化，`{a,b}` 与 `{b,a}` 视为同一份参数。
 *
 * 纯函数 + 计数器：不依赖运行时，可单独测；运行时接不接它都能跑。
 */

/** 参数递归按键名排序后序列化，保证「同样内容得到同样的 key」。 */
export function repeatKey(name: string, args: Record<string, unknown>): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) out[k] = norm(obj[k]);
      return out;
    }
    return v;
  };
  let json: string;
  try {
    json = JSON.stringify(norm(args ?? {})) ?? '{}';
  } catch {
    // 循环引用之类的病态参数：退化成「同名即同参」，仍然能拦住最典型的绕圈
    json = '{}';
  }
  return name + ':' + json;
}

export interface LoopGuard {
  /** 记录一次调用，返回这是第几次相同调用（从 1 开始） */
  hit(key: string): number;
  /** 这个 key 被拦过几次 */
  blocks(key: string): number;
  /** 本轮是否有调用被拦过 */
  blockedAny(): boolean;
  /** 新的一轮用户提问：清空计数（跨轮重复是正常的，比如每轮都先读同一篇笔记） */
  reset(): void;
}

export function createLoopGuard(maxRepeat = 2): LoopGuard {
  const blocked = new Map<string, number>();
  let lastKey = '';
  let lastCount = 0;
  let anyBlocked = false;
  return {
    hit(key) {
      // 只数「连续」：中间插了一次别的调用就重新计数。跨轮重复（每轮先读同一篇）是正常行为，
      // 不该被当绕圈——真正要拦的是「一步没推进，原地又调一次一模一样」。
      if (key === lastKey) lastCount += 1;
      else {
        lastKey = key;
        lastCount = 1;
      }
      if (lastCount > maxRepeat) {
        blocked.set(key, (blocked.get(key) ?? 0) + 1);
        anyBlocked = true;
      }
      return lastCount;
    },
    blocks(key) {
      return blocked.get(key) ?? 0;
    },
    blockedAny() {
      return anyBlocked;
    },
    reset() {
      lastKey = '';
      lastCount = 0;
      blocked.clear();
      anyBlocked = false;
    },
  };
}

/** 被拦时回填给模型的话：说清为什么、以及该怎么做（只说「被拦」会让它原样重试）。 */
export function repeatHint(name: string, times: number): string {
  return (
    '已拦截：' + name + ' 用相同参数被调用了 ' + times + ' 次，结果不会变。'
    + '请改用别的参数、换一个工具，或者直接基于已有结果回答。/ '
    + 'Blocked: identical call repeated ' + times + ' times; change arguments/tool or answer with what you have.'
  );
}

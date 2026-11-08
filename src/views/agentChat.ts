/**
 * AI 助手的会话存储与聊天条目模型。
 *
 * 从 AiAgentPanel.tsx 搬出来的是「持久化 + 类型」，不是 UI：
 *   - 会话列表的读写、旧版单线程对话的迁移、配额超限时的淘汰；
 *   - 上次意外退出留下的待确认提案一律标为 stale（审批 promise 不持久化，兑现不了）；
 *   - yolo 权限的读取（旧三档配置迁移成两档）。
 * 这些是最容易造成「对话丢了 / 权限悄悄放宽」的地方，独立出来才能单测。
 */
import type { StructureWarning } from '../core/aiPatch';

/** 从别处「问 AI」带进来的上下文：发送时附进消息上下文，气泡里展示引用卡。
 *  - 编辑器右键选段：只有 text + path
 *  - 复习卡 / 错题本 / 题库：额外带 ask（预填一句话，用户可改再发）
 *  ask 只预填、不自动发送 —— 与「先预览后写入」同一条原则：AI 动手前先让用户过一眼。 */
export type QuoteSelection = {
  text: string;
  path: string | null;
  /** 预填到输入框的建议问法（输入框已有内容时不覆盖） */
  ask?: string;
};

export const SESSIONS_KEY = 'knowlattice-ai-agent-sessions';
export const PREFS_KEY = 'knowlattice-ai-agent-prefs';
/** 旧版单线程对话的存储键：首次加载时迁移进会话列表 */
export const OLD_CHAT_KEY = 'knowlattice-ai-agent-chat';
export const SESSIONS_LIMIT = 20;
/** 持久化总体积上限：超了从最旧会话开始丢（当前会话保底不动） */
const SESSIONS_STORE_LIMIT = 600_000;
export const PERSIST_CONTENT_LIMIT = 4_000;

export type ChatItem =
  | {
      kind: 'msg'; id: number; role: 'user' | 'assistant'; text: string; quote?: QuoteSelection;
      /** 用户中途停止（或流中途出错）时留下的未写完回答 */
      partial?: boolean;
    }
  /** 已完成的只读工具：一行摘要 + 可展开的原始结果 */
  | { kind: 'tool'; id: number; name: string; summary: string; detail: string }
  /** 推理模型的思考过程（折叠展示，不回传给模型） */
  | { kind: 'thinking'; id: number; text: string }
  /** 写入提案：diff + 应用 / 拒绝；drifted = 笔记在提案后被用户改过，应用需二次确认 */
  | {
      kind: 'proposal'; id: number; path: string; old: string; next: string;
      isNew: boolean;
      status: 'pending' | 'applied' | 'rejected' | 'stale' | 'failed';
      /** yolo 静默落盘（未漂移） */
      autoApplied?: boolean;
      drifted?: boolean;
      /** 整篇重写的结构丢失提醒（frontmatter 键 / 双链 / 大段缩水） */
      warnings?: StructureWarning[];
      /** 目标是助手自己的指令文件（AGENT.md / AI命令/）：任何模式下都要人工确认 */
      configGuard?: boolean;
      /** status = failed 时的写入错误信息 */
      error?: string;
    }
  | { kind: 'error'; id: number; text: string };

export interface SessionUsage { promptTokens: number; completionTokens: number; estimated: boolean }

/** 只有一个开关：yolo=true 时所有写入提案免确认直接落盘（漂移确认保留）；
 *  缺省即 read——写入先出 diff 卡片等用户点「应用」。两档工具集相同，
 *  差别只在落盘要不要等确认，所以一个布尔就够；用枚举会多一层无用的互斥判断。 */
export interface AgentPrefs { yolo: boolean }

export interface AgentSession {
  id: string;
  title: string;
  updatedAt: number;
  usage: SessionUsage;
  items: ChatItem[];
  /** 陪练模式：会话级开关。开着的会话在系统提示里加陪练契约（先测后讲、一次一题） */
  coach?: boolean;
  /** 导师模式：会话级开关。比陪练更严格——掌握度门禁 + 台账，未过门槛不推进 */
  tutor?: boolean;
}

const ZERO_USAGE: SessionUsage = { promptTokens: 0, completionTokens: 0, estimated: false };
const DEFAULT_PREFS: AgentPrefs = { yolo: false };

export function freshSession(): AgentSession {
  return {
    id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    title: '新对话',
    updatedAt: Date.now(),
    usage: { ...ZERO_USAGE },
    items: [],
  };
}

/** 上次会话遗留的待确认提案无法兑现（审批 promise 不持久化），标记过期 */
function markStale(items: ChatItem[]): ChatItem[] {
  return items.map((i) => (i.kind === 'proposal' && i.status === 'pending' ? { ...i, status: 'stale' as const } : i));
}

function firstUserTitle(items: ChatItem[]): string | null {
  const first = items.find((i): i is Extract<ChatItem, { kind: 'msg' }> => i.kind === 'msg' && i.role === 'user');
  return first ? first.text.slice(0, 24) : null;
}

export function loadSessions(): AgentSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AgentSession[];
      if (Array.isArray(parsed)) {
        // 按条过滤，不做整表否决：任何一条畸形（历史脏数据/版本偏差）都不该把其余
        // 完好会话全判无效——整表丢弃后挂载时的持久化 effect 会立刻用短列表覆盖写回。
        const okList = parsed.filter((s) => s && typeof s.id === 'string' && Array.isArray(s.items));
        if (okList.length) {
          return okList.map((s) => ({ ...s, usage: s.usage ?? { ...ZERO_USAGE }, items: markStale(s.items) }));
        }
      }
    }
  } catch { /* 损坏则走迁移/新建 */ }
  try {
    const old = localStorage.getItem(OLD_CHAT_KEY);
    if (old) {
      const items = JSON.parse(old) as ChatItem[];
      if (Array.isArray(items) && items.length) {
        return [{
          id: 's-migrated',
          title: firstUserTitle(items) ?? '旧对话',
          updatedAt: Date.now(),
          usage: { ...ZERO_USAGE },
          items: markStale(items),
        }];
      }
    }
  } catch { /* ignore */ }
  return [];
}

export function persistSessions(sessions: AgentSession[], activeId: string): boolean {
  // 提案卡里的全文截断后保存（持久化只为回看，diff 渲染容忍截断）
  const slim = sessions.map((s) => ({
    ...s,
    items: s.items.map((i) => (i.kind === 'proposal'
      ? { ...i, old: i.old.slice(0, PERSIST_CONTENT_LIMIT), next: i.next.slice(0, PERSIST_CONTENT_LIMIT) }
      : i)),
  }));
  let list = slim;
  const oldestOther = () => [...list]
    .filter((s) => s.id !== activeId)
    .sort((a, b) => a.updatedAt - b.updatedAt)[0];
  while (list.length > SESSIONS_LIMIT) {
    const victim = oldestOther();
    if (!victim) break;
    list = list.filter((s) => s.id !== victim.id);
  }
  let json = JSON.stringify(list);
  while (json.length > SESSIONS_STORE_LIMIT) {
    const victim = oldestOther();
    if (!victim) break;
    list = list.filter((s) => s.id !== victim.id);
    json = JSON.stringify(list);
  }
  try {
    localStorage.setItem(SESSIONS_KEY, json);
    // 旧单会话键迁移成功后才删：loadSessions 的迁移分支只读不删，靠这里的「已持久化才清」
    // 兜底——中途崩溃也不会丢对话，下次启动还会再走一次迁移。删除失败（配额/隐私模式）留着下次再清。
    if (localStorage.getItem(OLD_CHAT_KEY) !== null) {
      try { localStorage.removeItem(OLD_CHAT_KEY); } catch { /* 留待下次 */ }
    }
    return true;
  } catch {
    // 配额满：会话只是不再持久化。但必须回一个 false 让调用方提示——
    // 静默失败会让用户以为「关掉面板还能回来」，实际整段对话已经丢了。
    return false;
  }
}

export function loadPrefs(): AgentPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    // 旧版本存的是 { readonly, autoApply, autonomous } 三档。只把 autonomous 迁到 yolo：
    // 老的 autoApply（仅 patch 免确认、整篇重写仍问）语义已不存在，把它当 yolo 会悄悄
    // 放宽权限，宁可退回默认的 read 让用户自己重开一次。
    const p = JSON.parse(raw) as Partial<AgentPrefs> & { autonomous?: boolean };
    return { yolo: p.yolo === true || p.autonomous === true };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}


export function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

/** 相对时间（会话列表用）：分钟内「刚刚」，当天按小时，其余按天 */
export function fmtAgo(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString();
}


/** 写入 yolo 权限（面板的 effect 调用；配额满时静默失败） */
export function savePrefs(prefs: AgentPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch { /* 忽略 */ }
}

/**
 * Obsidian 的 Callout 语法（纯函数，编辑器实时预览与右侧预览共用）。
 *
 *   > [!warning] 网络问题
 *   > 正文……
 *   > [!question]- 折叠的提问      ← `+` 展开 / `-` 折叠
 *
 * 用户库里用得极多（1500+ 处，question/success/tip/abstract/warning/example 是主力），
 * 不认的话在编辑器里就是一条普通引用，提示块该有的颜色、图标、标题全丢了。
 */

/** `>` 可重复（嵌套引用），类型只认常见标识符，`+`/`-` 是折叠标记 */
export const CALLOUT_RE = /^\s*>(?:>|\s)*\s*\[!([A-Za-z][\w-]*)\]([+-]?)\s?(.*)$/;

export interface Callout {
  /** 小写类型名，如 warning */
  type: string;
  /** 同一行的自定义标题（可能为空 → 用类型的默认名） */
  title: string;
  /** `-` 折叠 / `+` 展开 / null 无标记 */
  fold: 'open' | 'closed' | null;
}

export function parseCallout(text: string): Callout | null {
  const m = CALLOUT_RE.exec(text);
  if (!m) return null;
  return {
    type: m[1].toLowerCase(),
    title: (m[3] ?? '').trim(),
    fold: m[2] === '-' ? 'closed' : m[2] === '+' ? 'open' : null,
  };
}

/** 类型 → 默认标题（中文界面口径；未收录的类型原样显示，不编造） */
const LABELS: Record<string, string> = {
  note: '笔记', abstract: '摘要', summary: '小结', info: '信息', todo: '待办',
  tip: '提示', hint: '提示', important: '重要', success: '成功', check: '完成',
  done: '完成', question: '问题', help: '问题', faq: '问题', warning: '注意',
  caution: '注意', attention: '注意', failure: '失败', fail: '失败',
  missing: '缺失', danger: '危险', error: '错误', bug: '缺陷', example: '示例',
  quote: '引用', cite: '引用', goal: '目标',
};

export function calloutLabel(type: string): string {
  return LABELS[type.toLowerCase()] ?? type;
}

/** 有专属配色的类型（决定 CSS 类名；未收录的走默认色） */
const KNOWN = new Set(Object.keys(LABELS));
export function isKnownCalloutType(type: string): boolean {
  return KNOWN.has(type.toLowerCase());
}

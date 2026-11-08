/**
 * PDF 摘录的存储层。
 *
 * 原先这段代码只写在 `views/PdfSplitView.tsx` 里，导致两件事：
 * 1. 整包备份（core/vault）拿不到它——换设备后摘录历史整批消失；
 * 2. 「存储」与「视图」耦合，视图成了唯一知道键名与格式的地方。
 *
 * 现在把键、校验、容量兜底、备份用的导出/导入都收在这里：
 * - `saveExcerpts` 保留原有的「配额满 → 截断正文重试」策略；
 * - `importExcerpts` 只补不覆盖：按 `id` 去重，本机已有条目原样保留。
 */

export interface PdfExcerpt {
  id: string;
  ts: number;
  text: string;
  page: number;
  file: string;
  title: string;
  body: string;
  chapter: string;
  source: string;
  savedPath?: string;
}

const EX_KEY = 'knowlattice-excerpts';

function isExcerpt(x: unknown): x is PdfExcerpt {
  const e = x as PdfExcerpt;
  return Boolean(
    e
    && typeof e === 'object'
    && typeof e.id === 'string'
    && e.id.trim()
    && typeof e.text === 'string'
    && typeof e.body === 'string',
  );
}

export function loadExcerpts(): PdfExcerpt[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(EX_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isExcerpt);
  } catch {
    return [];
  }
}

export function saveExcerpts(list: PdfExcerpt[]): void {
  try {
    localStorage.setItem(EX_KEY, JSON.stringify(list));
  } catch {
    // 配额满：先截断正文再存；仍失败就保持本次会话可用，不打断用户
    try {
      const slim = list.map((x) => ({ ...x, body: x.body.slice(0, 2000) }));
      localStorage.setItem(EX_KEY, JSON.stringify(slim));
    } catch {
      /* keep the in-memory list usable */
    }
  }
}

/** 备份用：原样交出当前摘录（含已回填的 `savedPath`） */
export function exportExcerpts(): PdfExcerpt[] {
  return loadExcerpts();
}

/** 恢复用：只补不覆盖，按 id 去重。返回新增 / 已存在条数。 */
export function importExcerpts(incoming: unknown): { added: number; kept: number } {
  if (!Array.isArray(incoming)) return { added: 0, kept: 0 };
  const current = loadExcerpts();
  const seen = new Set(current.map((e) => e.id));
  const valid = incoming.filter(isExcerpt);
  const fresh = valid.filter((e) => !seen.has(e.id));
  if (fresh.length > 0) saveExcerpts([...current, ...fresh]);
  return { added: fresh.length, kept: valid.length - fresh.length };
}

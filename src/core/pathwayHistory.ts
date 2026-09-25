export interface PathwayHistoryItem {
  id: string;
  title: string;
  markdown: string;
  updatedAt: number;
}

export interface PathwayTemplateItem extends PathwayHistoryItem {
  createdAt: number;
}

const KEY = 'knowlattice-pathway-history';
const MAX_ITEMS = 30;
const TEMPLATE_KEY = 'knowlattice-pathway-templates';

function read(): PathwayHistoryItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is PathwayHistoryItem =>
      !!item && typeof item === 'object' && typeof (item as PathwayHistoryItem).id === 'string' &&
      typeof (item as PathwayHistoryItem).title === 'string' && typeof (item as PathwayHistoryItem).markdown === 'string' &&
      typeof (item as PathwayHistoryItem).updatedAt === 'number',
    ).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

function readTemplates(): PathwayTemplateItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TEMPLATE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is PathwayTemplateItem => !!item && typeof item === 'object' &&
      typeof (item as PathwayTemplateItem).id === 'string' && typeof (item as PathwayTemplateItem).title === 'string' &&
      typeof (item as PathwayTemplateItem).markdown === 'string' && typeof (item as PathwayTemplateItem).updatedAt === 'number' &&
      typeof (item as PathwayTemplateItem).createdAt === 'number').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ITEMS);
  } catch { return []; }
}

export function loadPathwayHistory(): PathwayHistoryItem[] {
  return read();
}

export function savePathwayHistory(title: string, markdown: string): PathwayHistoryItem[] {
  const now = Date.now();
  const cleanTitle = title.trim() || '未命名通路';
  const items = read();
  const existing = items.find((item) => item.markdown === markdown);
  const next: PathwayHistoryItem = {
    id: existing?.id ?? `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: cleanTitle,
    markdown,
    updatedAt: now,
  };
  const out = [next, ...items.filter((item) => item.id !== next.id && item.markdown !== markdown)].slice(0, MAX_ITEMS);
  try { localStorage.setItem(KEY, JSON.stringify(out)); } catch { /* 隐私模式或配额不足时，当前编辑仍可继续 */ }
  return out;
}

export function removePathwayHistory(id: string): PathwayHistoryItem[] {
  const out = read().filter((item) => item.id !== id);
  try { localStorage.setItem(KEY, JSON.stringify(out)); } catch { /* best effort */ }
  return out;
}

export function loadPathwayTemplates(): PathwayTemplateItem[] { return readTemplates(); }

export function savePathwayTemplate(title: string, markdown: string): PathwayTemplateItem[] {
  const now = Date.now(); const cleanTitle = title.trim() || '未命名通路'; const items = readTemplates();
  const existing = items.find((item) => item.markdown === markdown);
  const next: PathwayTemplateItem = { id: existing?.id ?? `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, title: cleanTitle, markdown, createdAt: existing?.createdAt ?? now, updatedAt: now };
  const out = [next, ...items.filter((item) => item.id !== next.id && item.markdown !== markdown)].slice(0, MAX_ITEMS);
  try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(out)); } catch { /* best effort */ }
  return out;
}

export function removePathwayTemplate(id: string): PathwayTemplateItem[] {
  const out = readTemplates().filter((item) => item.id !== id);
  try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(out)); } catch { /* best effort */ }
  return out;
}

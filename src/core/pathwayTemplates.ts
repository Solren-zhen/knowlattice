import { openDB, type IDBPDatabase } from 'idb';

export interface PathwayTemplate {
  id: string;
  title: string;
  markdown: string;
  createdAt: number;
  updatedAt: number;
}

const DB_NAME = 'knowlattice-pathways';
const STORE = 'templates';
let dbPromise: Promise<IDBPDatabase> | null = null;

function database() {
  if (!dbPromise) dbPromise = openDB(DB_NAME, 1, { upgrade(db) { if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }); } });
  return dbPromise;
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function listPathwayTemplates(): Promise<PathwayTemplate[]> {
  return (await (await database()).getAll(STORE)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function savePathwayTemplate(title: string, markdown: string): Promise<PathwayTemplate[]> {
  const db = await database(); const all = await db.getAll(STORE) as PathwayTemplate[]; const now = Date.now();
  const existing = all.find((item) => item.markdown === markdown);
  const item: PathwayTemplate = { id: existing?.id ?? newId(), title: title.trim() || '未命名通路', markdown, createdAt: existing?.createdAt ?? now, updatedAt: now };
  await db.put(STORE, item);
  return listPathwayTemplates();
}

export async function renamePathwayTemplate(id: string, title: string): Promise<PathwayTemplate[]> {
  const db = await database(); const item = await db.get(STORE, id) as PathwayTemplate | undefined;
  if (item) await db.put(STORE, { ...item, title: title.trim() || item.title, updatedAt: Date.now() });
  return listPathwayTemplates();
}

export async function duplicatePathwayTemplate(id: string): Promise<PathwayTemplate[]> {
  const db = await database(); const item = await db.get(STORE, id) as PathwayTemplate | undefined;
  if (item) await db.put(STORE, { ...item, id: newId(), title: `${item.title} 副本`, createdAt: Date.now(), updatedAt: Date.now() });
  return listPathwayTemplates();
}

export async function removePathwayTemplate(id: string): Promise<PathwayTemplate[]> {
  await (await database()).delete(STORE, id);
  return listPathwayTemplates();
}

export async function exportPathwayTemplates(): Promise<PathwayTemplate[]> { return listPathwayTemplates(); }

export async function importPathwayTemplates(value: unknown): Promise<void> {
  if (!Array.isArray(value)) return;
  const db = await database(); const tx = db.transaction(STORE, 'readwrite');
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<PathwayTemplate>;
    if (typeof item.title !== 'string' || typeof item.markdown !== 'string') continue;
    const now = Date.now();
    await tx.store.put({ id: typeof item.id === 'string' ? item.id : newId(), title: item.title, markdown: item.markdown, createdAt: typeof item.createdAt === 'number' ? item.createdAt : now, updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : now });
  }
  await tx.done;
}

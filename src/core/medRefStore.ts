/**
 * 医学速查的用户条目（本机保存，不进仓库）。
 *
 * 为什么要单独一层：内置数据是「生成物」（改一次生成脚本就没了），用户自己加的症候、
 * 自己改的歌诀不能被覆盖掉。所以用户条目单独存，读取时**同名以用户那条为准**。
 *
 * 写入一律返回 boolean 而不是抛：localStorage 满/被禁用时界面要能说「没存上」，
 * 不能表现为「点了没反应」。读取遇到脏数据直接丢键，不带着坏数据跑。
 */
import type { MedMnemonic, MedMnemonicLib, MedSymptom } from './medRef';

const SYM_KEY = 'knowlattice-medref-symptoms';
const MNE_KEY = 'knowlattice-medref-mnemonics';
/** 用户自制歌诀统一挂在这本「书」下，和公有领域/内置口诀分开展示 */
export const MY_BOOK = '我的口诀';

export interface UserMnemonic extends MedMnemonic {
  book: string;
}

function readArray<T>(key: string, ok: (x: unknown) => boolean): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      localStorage.removeItem(key);
      return [];
    }
    return parsed.filter(ok) as T[];
  } catch {
    try { localStorage.removeItem(key); } catch { /* 存储不可用时只能放弃 */ }
    return [];
  }
}

function writeArray(key: string, list: unknown[]): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

const isSymptom = (x: unknown): boolean => {
  const s = x as MedSymptom;
  return Boolean(s && typeof s.name === 'string' && s.name.trim() && Array.isArray(s.diseases));
};

const isMnemonic = (x: unknown): boolean => {
  const m = x as UserMnemonic;
  return Boolean(m && typeof m.term === 'string' && m.term.trim() && typeof m.body === 'string');
};

export function loadUserSymptoms(): MedSymptom[] {
  return readArray<MedSymptom>(SYM_KEY, isSymptom).map((s) => ({
    name: s.name.trim(),
    cat: typeof s.cat === 'string' ? s.cat : '',
    diseases: s.diseases.filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim()),
  }));
}

/** 新增或修改一条症状。`original` 是改名前的老名字；改名时要把老名字那条删掉。 */
export function upsertUserSymptom(next: MedSymptom, original?: string): boolean {
  const name = next.name.trim();
  if (!name) return false;
  const list = loadUserSymptoms().filter((s) => s.name !== name && s.name !== original);
  list.push({
    name,
    cat: next.cat.trim(),
    diseases: next.diseases.map((d) => d.trim()).filter(Boolean),
  });
  return writeArray(SYM_KEY, list);
}

export function removeUserSymptom(name: string): boolean {
  return writeArray(SYM_KEY, loadUserSymptoms().filter((s) => s.name !== name));
}

export function loadUserMnemonics(): UserMnemonic[] {
  return readArray<UserMnemonic>(MNE_KEY, isMnemonic).map((m) => ({
    book: typeof m.book === 'string' && m.book.trim() ? m.book : MY_BOOK,
    term: m.term.trim(),
    cat: typeof m.cat === 'string' ? m.cat : '',
    body: m.body,
    tip: typeof m.tip === 'string' ? m.tip : '',
  }));
}

/** 新增或修改一条歌诀（同一本书内按方名唯一）。 */
export function upsertUserMnemonic(next: UserMnemonic, originalTerm?: string): boolean {
  const term = next.term.trim();
  const book = next.book.trim() || MY_BOOK;
  if (!term) return false;
  const list = loadUserMnemonics().filter((m) => !(m.book === book && (m.term === term || m.term === originalTerm)));
  list.push({ book, term, cat: next.cat.trim(), body: next.body, tip: next.tip.trim() });
  return writeArray(MNE_KEY, list);
}

export function removeUserMnemonic(book: string, term: string): boolean {
  return writeArray(MNE_KEY, loadUserMnemonics().filter((m) => !(m.book === book && m.term === term)));
}

/**
 * 把用户条目并进书列表：同名同书替换内置，书不存在就多一本「我的口诀」。
 * 用户改过的条目排在该书最前面——那是他自己刚写的，翻到第一眼就该看见。
 */
export function mergeMnemonicBooks(builtin: MedMnemonicLib[], user: UserMnemonic[]): MedMnemonicLib[] {
  if (!user.length) return builtin;
  const out = builtin.map((b) => ({ ...b, entries: [...b.entries] }));
  for (const m of user) {
    const entry: MedMnemonic = { term: m.term, cat: m.cat, body: m.body, tip: m.tip };
    let book = out.find((b) => b.book === m.book);
    if (!book) {
      book = { book: m.book, note: '本机添加', entries: [] };
      out.unshift(book);
    }
    const at = book.entries.findIndex((e) => e.term === m.term);
    if (at >= 0) book.entries[at] = entry;
    else book.entries.unshift(entry);
  }
  return out;
}

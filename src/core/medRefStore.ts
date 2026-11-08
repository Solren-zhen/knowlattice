/**
 * 医学速查的用户条目（本机保存，不进仓库）。
 *
 * 为什么要单独一层：内置数据是生成物，用户自己加的症候、自己改的口诀不能被覆盖掉。
 * 用户条目单独存，读取时同名以用户那条为准；内置项删除/改名另存隐藏键，
 * 这样下次生成内部数据时不会悄悄回来。
 *
 * 写入一律返回 boolean 而不是抛：localStorage 满/被禁用时界面要能说「没存上」，
 * 不能表现为「点了没反应」。读取遇到脏数据直接丢键，不带着坏数据跑。
 */
import type { MedMnemonic, MedMnemonicLib, MedSymptom } from './medRef';

const SYM_KEY = 'knowlattice-medref-symptoms';
const MNE_KEY = 'knowlattice-medref-mnemonics';
const HIDDEN_SYM_KEY = 'knowlattice-medref-symptoms-hidden';
const HIDDEN_MNE_KEY = 'knowlattice-medref-mnemonics-hidden';
/** 用户自制口诀统一挂在这本「书」下 */
export const MY_BOOK = '我的口诀';

export interface UserMnemonic extends MedMnemonic {
  book: string;
}

/** 内置条目在本机的删除记录；只存键，不复制正文。 */
export interface HiddenMnemonic {
  book: string;
  term: string;
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

export function loadHiddenSymptoms(): string[] {
  return readArray<string>(HIDDEN_SYM_KEY, (x) => typeof x === 'string' && Boolean(x.trim()))
    .map((x) => x.trim());
}

/** 新增或修改一条症状。`original` 是改名前的老名字。 */
export function upsertUserSymptom(next: MedSymptom, original?: string): boolean {
  const name = next.name.trim();
  if (!name) return false;
  const list = loadUserSymptoms().filter((s) => s.name !== name && s.name !== original);
  list.push({
    name,
    cat: next.cat.trim(),
    diseases: next.diseases.map((d) => d.trim()).filter(Boolean),
  });
  if (!writeArray(SYM_KEY, list)) return false;
  return true;
}

export function removeUserSymptom(name: string): boolean {
  const list = loadUserSymptoms().filter((s) => s.name !== name);
  if (!writeArray(SYM_KEY, list)) return false;
  const hidden = loadHiddenSymptoms();
  if (!hidden.includes(name)) hidden.push(name);
  return writeArray(HIDDEN_SYM_KEY, hidden);
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

export function loadHiddenMnemonics(): HiddenMnemonic[] {
  return readArray<HiddenMnemonic>(
    HIDDEN_MNE_KEY,
    (x) => {
      const h = x as HiddenMnemonic;
      return Boolean(h && typeof h.book === 'string' && h.book.trim()
        && typeof h.term === 'string' && h.term.trim());
    },
  ).map((h) => ({ book: h.book.trim(), term: h.term.trim() }));
}

/** 新增或修改一条歌诀（同一本书内按原名称定位修改项）。 */
export function upsertUserMnemonic(next: UserMnemonic, originalTerm?: string): boolean {
  const term = next.term.trim();
  const book = next.book.trim() || MY_BOOK;
  if (!term) return false;
  const list = loadUserMnemonics().filter((m) => !(m.book === book && (m.term === term || m.term === originalTerm)));
  list.push({ book, term, cat: next.cat.trim(), body: next.body, tip: next.tip.trim() });
  return writeArray(MNE_KEY, list);
}

export function removeUserMnemonic(book: string, term: string): boolean {
  const list = loadUserMnemonics().filter((m) => !(m.book === book && m.term === term));
  if (!writeArray(MNE_KEY, list)) return false;
  const hidden = loadHiddenMnemonics();
  if (!hidden.some((h) => h.book === book && h.term === term)) hidden.push({ book, term });
  return writeArray(HIDDEN_MNE_KEY, hidden);
}

/**
 * 把用户条目并进书列表：同名同书替换内置，书不存在就多一本「我的口诀」。
 * 用户改过的条目排在该书最前面——那是他自己刚写的，翻到第一眼就该看见。
 */
export function mergeMnemonicBooks(
  builtin: MedMnemonicLib[],
  user: UserMnemonic[],
  hidden: HiddenMnemonic[] = [],
): MedMnemonicLib[] {
  if (!user.length && !hidden.length) return builtin;
  const blocked = new Set(hidden.map((h) => `${h.book}\u0000${h.term}`));
  const out = builtin.map((b) => ({
    ...b,
    entries: b.entries.filter((e) => !blocked.has(`${b.book}\u0000${e.term}`)),
  })).filter((b) => b.entries.length > 0);
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

export interface MedRefBackup {
  symptoms: MedSymptom[];
  mnemonics: UserMnemonic[];
  hiddenSymptoms: string[];
  hiddenMnemonics: HiddenMnemonic[];
}

/** 备份用：医学速查里所有「本机自建 / 本机删除」的数据。 */
export function exportMedRef(): MedRefBackup {
  return {
    symptoms: loadUserSymptoms(),
    mnemonics: loadUserMnemonics(),
    hiddenSymptoms: loadHiddenSymptoms(),
    hiddenMnemonics: loadHiddenMnemonics(),
  };
}

/** 恢复用：按身份键只补不覆盖（症状按名称、口诀按书+名称、隐藏项按同一身份）。 */
export function importMedRef(incoming: unknown): { added: number; kept: number } {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { added: 0, kept: 0 };
  }
  const data = incoming as Partial<MedRefBackup>;
  let added = 0;
  let kept = 0;

  const symptoms = loadUserSymptoms();
  const symptomNames = new Set(symptoms.map((s) => s.name));
  const freshSymptoms = Array.isArray(data.symptoms) ? data.symptoms.filter(isSymptom) : [];
  const newSymptoms = freshSymptoms.filter((s) => {
    const name = s.name.trim();
    if (symptomNames.has(name)) {
      kept += 1;
      return false;
    }
    symptomNames.add(name);
    added += 1;
    return true;
  });
  if (newSymptoms.length > 0) writeArray(SYM_KEY, [...symptoms, ...newSymptoms]);

  const mnemonics = loadUserMnemonics();
  const mnemonicKeys = new Set(mnemonics.map((m) => `${m.book}\u0000${m.term}`));
  const freshMnemonics = Array.isArray(data.mnemonics) ? data.mnemonics.filter(isMnemonic) : [];
  const newMnemonics = freshMnemonics.filter((m) => {
    const key = `${m.book}\u0000${m.term}`;
    if (mnemonicKeys.has(key)) {
      kept += 1;
      return false;
    }
    mnemonicKeys.add(key);
    added += 1;
    return true;
  });
  if (newMnemonics.length > 0) writeArray(MNE_KEY, [...mnemonics, ...newMnemonics]);

  const hiddenSymptoms = loadHiddenSymptoms();
  const hiddenSymptomSet = new Set(hiddenSymptoms);
  const freshHiddenSymptoms = Array.isArray(data.hiddenSymptoms)
    ? data.hiddenSymptoms.filter((x): x is string => typeof x === 'string' && Boolean(x.trim()))
    : [];
  const newHiddenSymptoms = freshHiddenSymptoms.filter((name) => {
    const key = name.trim();
    if (hiddenSymptomSet.has(key)) {
      kept += 1;
      return false;
    }
    hiddenSymptomSet.add(key);
    added += 1;
    return true;
  });
  if (newHiddenSymptoms.length > 0) writeArray(HIDDEN_SYM_KEY, [...hiddenSymptoms, ...newHiddenSymptoms]);

  const hiddenMnemonics = loadHiddenMnemonics();
  const hiddenMnemonicKeys = new Set(hiddenMnemonics.map((h) => `${h.book}\u0000${h.term}`));
  const freshHiddenMnemonics = Array.isArray(data.hiddenMnemonics)
    ? data.hiddenMnemonics.filter((h): h is HiddenMnemonic =>
      Boolean(h && typeof h.book === 'string' && typeof h.term === 'string' && h.book.trim() && h.term.trim()))
    : [];
  const newHiddenMnemonics = freshHiddenMnemonics.filter((h) => {
    const key = `${h.book.trim()}\u0000${h.term.trim()}`;
    if (hiddenMnemonicKeys.has(key)) {
      kept += 1;
      return false;
    }
    hiddenMnemonicKeys.add(key);
    added += 1;
    return true;
  });
  if (newHiddenMnemonics.length > 0) writeArray(HIDDEN_MNE_KEY, [...hiddenMnemonics, ...newHiddenMnemonics]);

  return { added, kept };
}

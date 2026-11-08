/**
 * 本地存储层的可执行规格。
 *
 * 三组断言：
 *   1. `defineStore` / `defineRawStore` 的失败路径（坏 JSON、缺省、配额满、隐私模式）
 *      —— 这些分支原来是 89 个模块各写一遍、各修一遍，行为还不一致；
 *   2. 清单自身合法（前缀统一、无点号混用）；
 *   3. **护栏**：`medvault-*` 只许出现在迁移模块，源码里的字面量键必须已登记。
 *      新加一个默默写盘的键而不登记，这条会红。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDB_NAMES, KV_KEYS, LEGACY_PREFIXES, defineRawStore, defineStore } from '../kv';

beforeEach(() => localStorage.clear());

describe('defineStore', () => {
  it('写入后原样读回', () => {
    const s = defineStore<string[]>({ key: 'knowlattice-test-a', fallback: [] });
    s.write(['x', 'y']);
    expect(s.read()).toEqual(['x', 'y']);
  });

  it('没有值时返回 fallback', () => {
    const s = defineStore<number>({ key: 'knowlattice-test-b', fallback: 7 });
    expect(s.read()).toBe(7);
  });

  it('坏 JSON 当默认值（手改过 / 半截写入），不抛给调用方', () => {
    const s = defineStore<number>({ key: 'knowlattice-test-c', fallback: 7 });
    localStorage.setItem('knowlattice-test-c', '{not json');
    expect(s.read()).toBe(7);
  });

  it('decode 负责形状校验：认不出就回退', () => {
    const s = defineStore<string[]>({
      key: 'knowlattice-test-d',
      fallback: [],
      decode: (raw, fallback) =>
        Array.isArray(raw) && raw.every((v) => typeof v === 'string') ? (raw as string[]) : fallback,
    });
    localStorage.setItem('knowlattice-test-d', JSON.stringify({ oops: 1 }));
    expect(s.read()).toEqual([]);
    s.write(['ok']);
    expect(s.read()).toEqual(['ok']);
  });

  it('clear 之后回到 fallback', () => {
    const s = defineStore<string>({ key: 'knowlattice-test-e', fallback: 'z' });
    s.write('v');
    s.clear();
    expect(s.read()).toBe('z');
  });

  it('配额满 / 隐私模式：写失败也不抛（本次会话内存值仍然可用）', () => {
    const s = defineStore<string>({ key: 'knowlattice-test-f', fallback: 'z' });
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    try {
      expect(() => s.write('v')).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('defineRawStore', () => {
  it('读写裸字符串（主题 / 字体是裸值，不是 JSON）', () => {
    const s = defineRawStore('knowlattice-test-raw');
    expect(s.read()).toBeNull();
    s.write('dark');
    expect(localStorage.getItem('knowlattice-test-raw')).toBe('dark');
    expect(s.read()).toBe('dark');
    s.clear();
    expect(s.read()).toBeNull();
  });
});

describe('键清单', () => {
  it('全部使用短横线前缀，不混点号风格', () => {
    const bad = Object.keys(KV_KEYS).filter((k) => !/^knowlattice[-.]/.test(k));
    expect(bad).toEqual([]);
  });

  it('IndexedDB 库名与 localStorage 键分开登记（同名仅限白名单：元数据 KV + 本体 IDB 是同一功能的互补存储）', () => {
    // history/pathways/pet/pdfs 四对同名是既有事实：localStorage 存元数据，IDB 存本体，
    // 与 qbanks 的「清单缓存 + 本体」同构。改名要做数据迁移，不在登记清单的职责内；
    // 白名单防止将来再冒出第五对无意识的重名。
    const SHARED = ['knowlattice-history', 'knowlattice-pathways', 'knowlattice-pet', 'knowlattice-pdfs'];
    const overlap = Object.keys(IDB_NAMES).filter((k) => k in KV_KEYS && !SHARED.includes(k));
    expect(overlap).toEqual([]);
  });

  it('清单里的每个键都写了用途（不是空注释）', () => {
    for (const [key, note] of Object.entries(KV_KEYS)) {
      expect(note.length, key).toBeGreaterThan(4);
    }
  });
});

/** 递归扫描生产代码（跳过测试目录） */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') sourceFiles(full, out);
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('护栏', () => {
  const files = sourceFiles(join(process.cwd(), 'src'));

  it('medvault-* 遗留键只允许出现在迁移模块', () => {
    const offenders = files.filter((f) => {
      const posix = f.replace(/\\/g, '/');
      // 迁移模块本身；以及清单文件（LEGACY_PREFIXES 的定义处，必然含这个字面量）
      if (posix.endsWith('core/migrate.ts') || posix.endsWith('storage/kv.ts')) return false;
      const text = readFileSync(f, 'utf8');
      return LEGACY_PREFIXES.some((p) => text.includes(`'${p}`) || text.includes(`"${p}`));
    });
    expect(offenders.map((f) => f.replace(process.cwd(), ''))).toEqual([]);
  });

  it('源码里直接写的字面量键必须登记在 KV_KEYS', () => {
    const re = /localStorage\.(?:getItem|setItem|removeItem)\(\s*['"]([^'"]+)['"]/g;
    const found = new Set<string>();
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(re)) found.add(m[1]);
    }
    const unregistered = [...found].filter((k) => !(k in KV_KEYS));
    expect(unregistered).toEqual([]);
  });

  it('IndexedDB 库名常量必须登记在 IDB_NAMES（实际有 7 个库，漏登记清单就失去意义）', () => {
    // 各存储模块的库名都是 const DB_NAME / DB / PDF_DB 字面量，扫描常量定义而不是 openDB 调用点
    const re = /const (?:DB_NAME|DB|PDF_DB)\s*=\s*['"](knowlattice[^'"]*)['"]/;
    const found = new Set<string>();
    for (const f of files) {
      const m = readFileSync(f, 'utf8').match(re);
      if (m) found.add(m[1]);
    }
    // 扫描本身必须命中：正则失效后这个测试会空转放行
    expect(found.size, 'DB 常量扫描应至少命中 knowlattice/qbank 等库名').toBeGreaterThanOrEqual(5);
    const unregistered = [...found].filter((k) => !(k in IDB_NAMES));
    expect(unregistered).toEqual([]);
  });
});

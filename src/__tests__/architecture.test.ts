/**
 * 架构不变量（零依赖版的 import-linter）
 *
 * 为什么要有这个文件：分层约定写在文档里只能靠自觉，而「core 里塞一个 React 组件」
 * 「storage 回头 import 视图」这类反向依赖，一旦发生就是循环依赖与测试环境崩坏的起点。
 * 这里把 5 条**今天成立**的约定变成断言：谁破坏，跑测试就红，并直接告诉你违反了哪条、怎么改。
 *
 * 参考：HKUDS/DeepTutor 用 `.importlinter` 把「core 只放值与协议」「runtime/services 不得
 * 反向 import api」写成 CI 契约。本项目不想为此加依赖，就用 vitest + 正则做同一件事
 * （够用：我们只需要「方向」和「禁用符号」，不需要完整 AST）。
 *
 * 加白名单的规矩：不要为了让测试变绿而删规则。确实需要例外时，在对应规则的 EXCEPTIONS
 * 里加一行并写清理由——例外清单本身就是架构决策记录。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** 收集 src 下所有 ts/tsx（含测试：有些规则要反过来排除它们） */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

const ALL = walk(SRC);
const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/');
const isTest = (p: string) => /\.test\.tsx?$/.test(p) || rel(p).startsWith('__tests__/');
const PROD = ALL.filter((p) => !isTest(p));

interface ImportRef {
  spec: string;
  typeOnly: boolean;
  line: number;
}

/** 够用的 import 抽取：取 `import|export … from 'x'`，并标记 type-only */
function importsOf(file: string): ImportRef[] {
  const out: ImportRef[] = [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((text, i) => {
    const m = text.match(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/);
    if (!m) return;
    out.push({ spec: m[1], typeOnly: /\bimport\s+type\b/.test(text), line: i + 1 });
  });
  return out;
}

/** 规则 1/2 共用：某个目录下的文件不得反向 import 另一层 */
function forbidBackImport(fromDir: string, forbidden: string, exceptions: string[] = []) {
  const offenders: string[] = [];
  for (const file of PROD.filter((p) => rel(p).startsWith(`${fromDir}/`))) {
    if (exceptions.includes(rel(file))) continue;
    for (const imp of importsOf(file)) {
      if (imp.spec.includes(`/${forbidden}/`) || imp.spec.startsWith(`../${forbidden}`)) {
        offenders.push(`${rel(file)}:${imp.line} → ${imp.spec}`);
      }
    }
  }
  return offenders;
}

describe('架构不变量', () => {
  it('取样覆盖足够广（防止 walk 出问题导致「空跑全绿」）', () => {
    expect(ALL.length).toBeGreaterThan(300);
    expect(PROD.length).toBeGreaterThan(200);
    expect(ALL.some((p) => rel(p).startsWith('core/'))).toBe(true);
    expect(ALL.some((p) => rel(p).startsWith('views/'))).toBe(true);
  });

  it('R1 · core 不得反向依赖 views（领域层不许拖进 UI/DOM）', () => {
    // 理由：core 是纯领域逻辑，被 CLI 脚本、Node 测试、worker 复用。
    // 一旦 import 视图，就把 React/DOM 一起绑进这些环境，最先炸的是纯 Node 测试。
    expect(forbidBackImport('core', 'views')).toEqual([]);
  });

  it('R2 · storage 不得反向依赖 views（存储层不认识界面）', () => {
    // 理由：storage 要能在 Node（迁移脚本、备份工具）里独立跑；
    // 视图反过来调用 storage 是正常方向，这里只禁反向。
    const offenders = forbidBackImport('storage', 'views');
    expect(offenders).toEqual([]);
  });

  it('R3 · 生产代码不得 import 测试文件', () => {
    // 理由：测试文件会被排除在产物之外；生产代码引用它，构建时才炸，且带着测试依赖上路。
    const offenders: string[] = [];
    for (const file of PROD) {
      for (const imp of importsOf(file)) {
        if (/\.test\.tsx?$/.test(imp.spec) || imp.spec.includes('__tests__')) {
          offenders.push(`${rel(file)}:${imp.line} → ${imp.spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('R4 · 生产代码不留 console.log（调试残留会进产物）', () => {
    // 理由：console.log 是最典型的提交残留；需要给用户看的提示走 core/feedback（toast/confirm），
    // 需要留痕的诊断走 console.warn/error（这两类不拦，出问题时它们是唯一线索）。
    const offenders: string[] = [];
    for (const file of PROD) {
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((text, i) => {
        const code = text.replace(/\/\/.*$/, '');
        if (/^\s*[*]/.test(text)) return; // 块注释行
        if (/\bconsole\.log\s*\(/.test(code)) offenders.push(`${rel(file)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('R5 · core 只允许「类型级」的 Tauri 依赖（运行时 API 一律走 storage/platform）', () => {
    // 理由：core 要能在纯 Node 下跑（测试、脚本）。`import type` 编译后不留痕，安全；
    // 运行时 import 会把 WebView 专属 API 带进 Node，跑测试时直接失败。
    // 例外：确实需要在 core 里做平台判断时，把实现下沉到 storage，再从 core 通过接口调用。
    const offenders: string[] = [];
    for (const file of PROD.filter((p) => rel(p).startsWith('core/'))) {
      for (const imp of importsOf(file)) {
        if (imp.spec.startsWith('@tauri-apps') && !imp.typeOnly) {
          offenders.push(`${rel(file)}:${imp.line} → ${imp.spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

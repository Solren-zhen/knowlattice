/**
 * 界面规则静态自审（R6–R9）。
 *
 * 与 `architecture.test.ts` 的分工：那边管**分层方向与禁用符号**，这里管**用户能感知的界面契约**
 * ——按钮有没有名字、图片有没有替代文本、输入框有没有标签、删东西前有没有确认。
 * 共同点是都用「正则 + 白名单」而不是 AST：只挡新增，不做重构，命中即人工看一眼。
 *
 * 三条纪律：
 * 1. 规则只负责「值得人看一眼」，命中不等于一定错；修不准就登记理由，不要改规则。
 * 2. 存量债务按**文件计数**登记（见 `INPUT_DEBT`），上限只能降不能升：
 *    在干净文件里新增一个无标签输入框会立刻红。
 * 3. 注释与字符串里的标签不算元素——先抹掉注释，再要求标签出现在**行首**（JSX 的写法）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/');
const isTest = (p: string) => /\.test\.tsx?$/.test(p) || rel(p).startsWith('__tests__/');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      walk(p, out);
    } else if (/\.tsx$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

const VIEWS = walk(join(SRC, 'views')).filter((p) => !isTest(p)).sort();

/** 抹掉块注释与 `//` 行注释（保留换行，行号才不乱）；`/*` 之后的 `*` 行整体清空。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}


describe('界面规则静态自审', () => {
  it('取样覆盖足够广（防止 walk 出问题导致「空跑全绿」）', () => {
    expect(VIEWS.length).toBeGreaterThan(40);
  });

  it('R6 · 每个按钮都有可读文案或 aria-label', () => {
    const offenders: string[] = [];
    for (const file of VIEWS) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const m of text.matchAll(/^[ \t]*<button\b[\s\S]*?>/gm)) {
        const tag = m[0];
        if (/aria-label=|aria-labelledby=|\btitle=/.test(tag)) continue;
        const selfClosing = /\/>\s*$/.test(tag);
        const rest = text.slice(m.index! + tag.length);
        const close = rest.indexOf('</button>');
        const inner = close >= 0 ? rest.slice(0, close) : '';
        // `{icon}` / `{cond ? 'a' : 'b'}` 一律当「有内容」，只判真正的空标签
        const visible = inner.replace(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, 'X').trim();
        if (selfClosing || visible === '') {
          offenders.push(rel(file) + ':' + (text.slice(0, m.index!).split('\n').length));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('R7 · 图片都有 alt（装饰图写空 alt，不要省略属性）', () => {
    const offenders: string[] = [];
    for (const file of VIEWS) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const m of text.matchAll(/^[ \t]*<img\b[^>]*>/gm)) {
        if (!/\balt=/.test(m[0])) offenders.push(rel(file) + ':' + (text.slice(0, m.index!).split('\n').length));
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * R8 的存量债务：文件 → 目前「无 aria-label / aria-labelledby / id，且不在 <label> 内」的输入框数。
   * 逐类原因：placeholder-only 搜索框与行内改名框（读屏没有可读名）、`type="file"` 的隐藏代理
   * （由旁边的按钮代点，键盘路径走按钮）。上限只能降：修一个就把数字改小，修到 0 就删掉这一行。
   */
  const INPUT_DEBT: Record<string, number> = {
    'views/AgentSettingsForm.tsx': 1,
    'views/AiAgentPanel.tsx': 1,
    'views/AiPanel.tsx': 1,
    'views/AnatomyBrowser.tsx': 1,
    'views/BiliPlayer.tsx': 1,
    'views/BrainAtlasView.tsx': 1,
    'views/ChapterTree.tsx': 6,
    'views/CommandPalette.tsx': 1,
    'views/ConvertView.tsx': 3,
    'views/DraftGen.tsx': 6,
    'views/ImportView.tsx': 2,
    'views/MedRefView.tsx': 1,
    'views/PdfSplitView.tsx': 3,
    'views/QuickSearch.tsx': 1,
    'views/QuizView.tsx': 3,
    'views/ReviewView.tsx': 1,
    'views/TagBrowser.tsx': 1,
    'views/TodoView.tsx': 5,
    'views/VideoNoteView.tsx': 2,
    'views/VocabView.tsx': 3,
    'views/Workspace.tsx': 2,
  };

  it('R8 · 输入框都有 label 或 aria-label（存量按文件计数只降不升）', () => {
    const counts = new Map<string, number>();
    for (const file of VIEWS) {
      const text = stripComments(readFileSync(file, 'utf8'));
      let n = 0;
      for (const m of text.matchAll(/^[ \t]*<input\b[^>]*>/gm)) {
        const tag = m[0];
        if (/aria-label=|aria-labelledby=|\bid=/.test(tag)) continue;
        if (/type="hidden"|type=\{[^}]*hidden/.test(tag)) continue;
        if (/\{\.\.\.[\w.]+\}/.test(tag)) continue; // 展开 props：可能在调用方带了 aria-label
        const before = text.slice(0, m.index!);
        if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue; // 包在 label 里
        n += 1;
      }
      if (n > 0) counts.set(rel(file), n);
    }
    const regressions: string[] = [];
    for (const [file, n] of counts) {
      const allowed = INPUT_DEBT[file] ?? 0;
      if (n > allowed) regressions.push(`${file}：${n} 个无标签输入框，上限 ${allowed}`);
    }
    expect(regressions).toEqual([]);
    // 反向提醒：把某文件修到 0 之后记得把债务表里的那条删掉，否则表会慢慢变成谎话
    const stale = Object.keys(INPUT_DEBT).filter((f) => (counts.get(f) ?? 0) === 0);
    expect(stale, '这些文件已经没有无标签输入框，请从 INPUT_DEBT 删除').toEqual([]);
  });

  /**
   * R9 · 直接调用破坏性 API 的文件必须出现确认入口。
   *
   * 确认原语在本仓是 `confirmBox(`（core/feedback 的模态确认，带 danger/okText）。
   * 只检查「同一文件」：跨文件下传回调（Workspace → ChapterTree 的 onRemove）由承接方负责，
   * 所以规则在这里是**下限**，不是完整证明。
   */
  const DESTRUCTIVE = /\b(removeMany|removeAttachments|removeFile|clearAll|resetVault|deleteAll)\s*\(/;
  const CONFIRM = /confirmBox\(|confirm\(|<Confirm\b/;

  it('R9 · 破坏性操作都有二次确认', () => {
    const offenders: string[] = [];
    for (const file of VIEWS) {
      const text = stripComments(readFileSync(file, 'utf8'));
      if (!DESTRUCTIVE.test(text)) continue;
      if (CONFIRM.test(text)) continue;
      offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  it('R9 有覆盖：确实有文件在调破坏性 API（防止规则变成空跑）', () => {
    const withDestructive = VIEWS.filter((f) => DESTRUCTIVE.test(stripComments(readFileSync(f, 'utf8'))));
    expect(withDestructive.length).toBeGreaterThan(0);
  });
});

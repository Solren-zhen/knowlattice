#!/usr/bin/env node
/**
 * hooks-order-check —— 找「组件里 hooks 之前有早退 return」的 bug。
 *
 * 这类 bug 的表现：数据从「无」变「有」时早退分支消失，后面的 hooks 多调用一次，
 * React 直接抛 #310（Rendered more hooks than during the previous render）。
 * oxlint 抓不到：它不是语法错误，而是「两次渲染走了不同分支」的运行时约束。
 *
 * 用法：
 *   node scripts/hooks-order-check.mjs                  # 全仓扫，有命中就 exit 1
 *   node scripts/hooks-order-check.mjs --domain views,core
 *   node scripts/hooks-order-check.mjs --json
 *
 * 实现是启发式的（文本层，不解析 AST）：它只负责「值得人看一眼」的清单，
 * 命中不一定都是 bug（例如早退在事件回调里），反向漏报也可能存在。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const HOOK =
  /\buse(?:State|Effect|LayoutEffect|Memo|Ref|Callback|Reducer|Context|SyncExternalStore|ImperativeHandle|DeferredValue|Transition|Id)\s*\(/;

const args = process.argv.slice(2);
const json = args.includes('--json');
const dIdx = args.indexOf('--domain');
const domainArg = args.find((a) => a.startsWith('--domain=')) ?? (dIdx >= 0 ? '--domain=' + (args[dIdx + 1] ?? '') : '');
const domains = domainArg
  ? domainArg
      .slice('--domain='.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      walk(full, out);
    } else if (/\.(tsx?|jsx?)$/.test(name) && !/\.(test|spec)\.(tsx?|jsx?)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** 抹掉注释与字符串内容（保留换行与花括号），避免注释里的 `if (...) return` 误报。 */
function strip(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '\x60') {
      const quote = c;
      out += quote;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src[i + 1] === '\n' ? '\n' : ' ';
          out += src[i + 1] === '\n' ? '\n' : ' ';
          i += 2;
          continue;
        }
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += quote;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const BODY_OPEN = /\)\s*\{\s*$|=>\s*\{\s*$|^\s*\{\s*$/;

/** 从函数体那一行往前找组件名（支持多行签名） */
function nameBefore(lines, bodyLine) {
  for (let l = bodyLine; l >= 0 && l > bodyLine - 40; l -= 1) {
    const m = lines[l].match(/function\s+([A-Za-z_$][\w$]*)/) ?? lines[l].match(/const\s+([A-Za-z_$][\w$]*)/);
    if (m) return m[1];
  }
  return '(匿名)';
}

function scan(file) {
  const raw = readFileSync(file, 'utf8');
  const lines = strip(raw).split('\n');
  const hits = [];
  let analyzed = 0;

  for (let bodyLine = 0; bodyLine < lines.length; bodyLine += 1) {
    if (!BODY_OPEN.test(lines[bodyLine])) continue;
    if (!/\)|=>/.test(lines[bodyLine])) continue;
    if (/^\s*(if|for|while|switch|catch)\b/.test(lines[bodyLine])) continue;

    const openAt = lines[bodyLine].lastIndexOf('{');
    let depth = 1;
    let firstHook = -1;
    const earlyReturns = [];
    for (let l = bodyLine; l < lines.length; l += 1) {
      const line = lines[l];
      const depthAtStart = depth;
      const from = l === bodyLine ? openAt + 1 : 0;
      for (let ci = from; ci < line.length; ci += 1) {
        const ch = line[ci];
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
      if (depthAtStart >= 1 && firstHook < 0 && HOOK.test(line)) firstHook = l;
      if (depthAtStart === 1) {
        const trimmed = line.trim();
        if (/^return\b/.test(trimmed)) earlyReturns.push(l);
        else if (/^if\s*\(.*\)\s*return\b/.test(trimmed)) earlyReturns.push(l);
        else if (/^if\s*\(/.test(trimmed) && /return/.test(lines[l + 1] ?? '')) earlyReturns.push(l);
      }
      if (depth <= 0) break;
    }

    if (firstHook < 0) continue;
    analyzed += 1;
    const before = earlyReturns.filter((l) => l < firstHook);
    if (before.length === 0) continue;
    hits.push({
      file,
      line: before[0] + 1,
      hookLine: firstHook + 1,
      name: nameBefore(lines, bodyLine),
      code: lines[before[0]].trim(),
    });
  }
  return { hits, analyzed };
}

const files = walk(SRC);
const results = files.map(scan);
const all = results.flatMap((r) => r.hits);
const analyzed = results.reduce((n, r) => n + r.analyzed, 0);
const rel = (f) => relative(ROOT, f).split(sep).join('/');
const domainOf = (f) => {
  const parts = rel(f).split('/');
  return parts[1] === 'features' ? (parts[2] ?? '') : (parts[1] ?? '');
};

const filtered = domains.length ? all.filter((h) => domains.includes(domainOf(h.file))) : all;

if (domains.length && !files.some((f) => domains.includes(domainOf(f)))) {
  console.error('[hooks-order-check] 警告：--domain 没匹配到任何文件（可用值如 views/core/storage），本次结果为空不代表没问题。');
}

if (json) {
  console.log(JSON.stringify(filtered.map((h) => ({ ...h, file: rel(h.file), domain: domainOf(h.file) })), null, 2));
} else {
  const byDomain = new Map();
  for (const h of filtered) {
    const d = domainOf(h.file);
    byDomain.set(d, [...(byDomain.get(d) ?? []), h]);
  }
  console.log('hooks-order-check：扫描 ' + files.length + ' 个源文件、检查 ' + analyzed + ' 个 hook 组件，命中 ' + filtered.length + ' 处' + (domains.length ? '（域：' + domains.join(',') + '）' : ''));
  for (const [d, list] of [...byDomain].sort()) {
    console.log('\n# ' + (d || '(src 根)') + ' — ' + list.length + ' 处');
    for (const h of list) {
      console.log('  ' + rel(h.file) + ':' + h.line + '  ' + h.name + '  ← ' + h.code + '  (首个 hook 在第 ' + h.hookLine + ' 行)');
    }
  }
}
process.exit(filtered.length > 0 ? 1 : 0);

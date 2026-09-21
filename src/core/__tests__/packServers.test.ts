// @vitest-environment node
/**
 * 离线包的两个平台服务器必须保持行为一致。
 *
 * 为什么值得专门守：server.ps1（Windows）和 server.py（macOS/Linux）是两套独立实现，
 * 唯一的共同保证是「它们此刻的行为一样」。一旦有人只改一边——比如往 .ps1 的 MIME 表里
 * 加了 .avif 却忘了 .py——那个平台上就有一类文件静默失效（最典型的是 .wasm：
 * MIME 不是 application/wasm 时，浏览器的流式编译会直接拒绝执行）。
 *
 * 这里只做静态对账（不执行 Python：CI 里没有 Python），盯三件事：
 *   1. 两边的 MIME 表逐项一致；
 *   2. 两边都只监听回环、都有 SPA 回退、都有「已在运行就复用」策略；
 *   3. pack.mjs 确实把这四个启动文件都装进了包。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');

const ps1 = read('scripts/pack/server.ps1');
const py = read('scripts/pack/server.py');
const bat = read('scripts/pack/Start-KnowLattice.bat');
const cmd = read('scripts/pack/start-knowlattice.command');
const pack = read('scripts/pack.mjs');

/** 从 PowerShell 的 @{ '.ext' = 'type' } 里取扩展名 -> 类型 */
function mimeFromPs1(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /'(\.[A-Za-z0-9]+)'\s*=\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.set(m[1].toLowerCase(), m[2]);
  return out;
}

/** 从 Python 的 {'.ext': 'type',} 里取扩展名 -> 类型 */
function mimeFromPy(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /'(\.[A-Za-z0-9]+)':\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.set(m[1].toLowerCase(), m[2]);
  return out;
}

describe('离线包：Windows / macOS 两套服务器不许漂移', () => {
  it('MIME 表逐项一致', () => {
    const a = mimeFromPs1(ps1);
    const b = mimeFromPy(py);
    expect(a.size).toBeGreaterThan(20);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [ext, type] of a) expect(`${ext}=${b.get(ext)}`).toBe(`${ext}=${type}`);
  });

  it('.wasm 在两边都是 application/wasm（否则流式编译会被浏览器拒绝）', () => {
    expect(mimeFromPs1(ps1).get('.wasm')).toBe('application/wasm');
    expect(mimeFromPy(py).get('.wasm')).toBe('application/wasm');
  });

  it('两边都只监听回环地址，都不对外暴露', () => {
    expect(ps1).toContain('Loopback');
    expect(py).toContain("'127.0.0.1'");
    for (const text of [ps1, py]) {
      expect(text).not.toMatch(/0\.0\.0\.0/);
      expect(text).not.toMatch(/bind\(.*['"]::['"]/);
    }
  });

  it('两边都有 SPA 回退（无扩展名的路径回 index.html）与 403 穿越防护', () => {
    expect(ps1).toContain('SPA fallback');
    expect(py).toContain('SPA');
    expect(ps1).toContain('403 Forbidden');
    expect(py).toContain('403');
  });

  it('两边都有「已经在运行就打开它，不另起空库」的端口策略', () => {
    // 笔记按 origin 隔离，换端口 = 另一个空库，这条策略是防止用户以为笔记丢了
    expect(ps1).toContain('already running');
    expect(py).toContain('already running');
    expect(ps1).toContain('NOT the same site');
    expect(py).toContain('NOT the same site');
  });

  it('启动入口都在，且 macOS 入口是可执行 shell 脚本、缺 Python 时给出指引', () => {
    expect(bat).toContain('server.ps1');
    expect(cmd.startsWith('#!/bin/bash')).toBe(true);
    expect(cmd).toContain('server.py');
    expect(cmd).toContain('xcode-select --install');
  });

  it('pack.mjs 把四个启动文件都装进包（少一个 = 那个平台打不开）', () => {
    for (const f of ['server.ps1', 'Start-KnowLattice.bat', 'server.py', 'start-knowlattice.command']) {
      expect(pack).toContain(`'${f}'`);
    }
  });

  it('pack.mjs 会给 macOS 入口补 Unix 可执行位（Windows 文件系统没有这个位）', () => {
    expect(pack).toContain('setZipUnixMode');
    expect(pack).toContain('start-knowlattice.command');
    expect(pack).toContain('0o755');
  });
});

import { describe, expect, it } from 'vitest';
import { buildTree, safeVaultPath } from '../vault';

describe('buildTree', () => {
  it('按路径层级构建目录树，目录在前文件在后', () => {
    const tree = buildTree([
      '01-生理/05-呼吸/肺.md',
      '01-生理/05-呼吸/氧.md',
      '01-生理/01-绪论.md',
      '02-生化/1.md',
      '00-上手.md',
    ]);
    // 目录永远排在文件前面
    expect(tree.map((n) => n.name)).toEqual(['01-生理', '02-生化', '00-上手.md']);
    const physio = tree.find((n) => n.name === '01-生理')!;
    expect(physio.type).toBe('dir');
    expect(physio.children!.map((c) => c.name)).toEqual(['05-呼吸', '01-绪论.md']);
    const resp = physio.children!.find((c) => c.name === '05-呼吸')!;
    // 中文按拼音序：肺(fei) < 氧(yang)
    expect(resp.children!.map((c) => c.name)).toEqual(['肺.md', '氧.md']);
  });

  it('只保留 .md 文件', () => {
    const tree = buildTree([
      'a.md',
      'b.png',
      '_attachments/img.png',
      'dir/c.md',
    ]);
    expect(tree.map((n) => n.name)).toEqual(['dir', 'a.md']);
  });

  it('同名文件与目录共存不冲突', () => {
    const tree = buildTree(['呼吸/肺.md', '呼吸.md']);
    expect(tree.map((n) => n.name)).toEqual(['呼吸', '呼吸.md']);
  });

  it('中文按拼音排序（localeCompare zh）', () => {
    const tree = buildTree(['生理.md', '生化.md', '病理.md']);
    // 拼音序：病理(bing) < 生化(sheng hua) < 生理(sheng li)
    expect(tree.map((n) => n.name)).toEqual(['病理.md', '生化.md', '生理.md']);
  });

  it('空与无 .md 输入返回空树', () => {
    expect(buildTree([])).toEqual([]);
    expect(buildTree(['x.txt'])).toEqual([]);
  });
});

describe('safeVaultPath', () => {
  it('只允许 vault 相对路径，拒绝穿越与绝对路径', () => {
    expect(safeVaultPath('01-生理/呼吸.md')).toBe('01-生理/呼吸.md');
    expect(safeVaultPath('01-生理\\呼吸.md')).toBe('01-生理/呼吸.md');
    expect(safeVaultPath('../secret.md')).toBeNull();
    expect(safeVaultPath('a/../../secret.md')).toBeNull();
    expect(safeVaultPath('/secret.md')).toBeNull();
    expect(safeVaultPath('C:/secret.md')).toBeNull();
    expect(safeVaultPath(null)).toBeNull();
  });
});

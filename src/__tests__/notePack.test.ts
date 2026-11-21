import { describe, expect, it } from 'vitest';
import { buildNotePack } from '../core/notePack';

describe('桌面手机笔记包', () => {
  it('只输出选中的笔记，并剥掉 frontmatter', () => {
    const docs = new Map<string, string>([
      ['呼吸/哮喘.md', '---\nchapter: 呼吸系统\ntags: [呼吸, 哮喘]\n---\n# 支气管哮喘\n\n- 可逆性气流受限'],
      ['循环/心衰.md', '# 心力衰竭\n\n利钠肽升高'],
    ]);
    const pack = JSON.parse(buildNotePack(docs, ['呼吸/哮喘.md'], 1700000000000));
    expect(pack.schema).toBe('knowlattice.notes/1');
    expect(pack.notes).toHaveLength(1);
    expect(pack.notes[0]).toMatchObject({
      path: '呼吸/哮喘.md',
      title: '支气管哮喘',
      chapter: '呼吸系统',
      tags: ['呼吸', '哮喘'],
    });
    expect(pack.notes[0].content.startsWith('# 支气管哮喘')).toBe(true);
    expect(pack.notes[0].content).not.toContain('chapter:');
  });
});

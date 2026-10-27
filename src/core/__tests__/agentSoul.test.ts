import { describe, expect, it } from 'vitest';
import { collectSouls, formatSoulPrefix, SOUL_DIR, SOUL_PREFIX_LIMIT } from '../agentSkills';
import { buildNoteSystemPrompt } from '../aiAgent';

const card = (persona: string, body: string) => `---\npersona: ${persona}\n---\n${body}`;

describe('人格卡', () => {
  it('只收 AI命令/人格/ 下的 md，并按路径排序取第一张', () => {
    const docs = new Map<string, string>([
      [SOUL_DIR + 'b-严格.md', card('严格考官', '只给结论，不许安慰。')],
      [SOUL_DIR + 'a-温和.md', card('温和学长', '先肯定再纠正。')],
      ['AI命令/技能/x.md', card('不是人格', '不该被收进来')],
      [SOUL_DIR + '空.md', '---\npersona: 空\n---\n   '],
    ]);
    const cards = collectSouls(docs);
    expect(cards.map((c) => c.name)).toEqual(['温和学长', '严格考官']);
    expect(formatSoulPrefix(cards)).toBe('先肯定再纠正。');
  });

  it('没有卡返回空串，超长按预算截断', () => {
    expect(formatSoulPrefix([])).toBe('');
    const long = 'x'.repeat(SOUL_PREFIX_LIMIT + 50);
    const out = formatSoulPrefix([{ path: SOUL_DIR + 'a.md', name: 'a', text: long }]);
    expect(out.length).toBe(SOUL_PREFIX_LIMIT + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('人格进了 system prompt，但明确不改变写入门槛', () => {
    const withSoul = buildNoteSystemPrompt(null, null, false, 0, '', '只给结论。');
    expect(withSoul).toContain('【人格】');
    expect(withSoul).toContain('只给结论。');
    expect(withSoul).toContain('该确认的写入仍要用户点应用');
    expect(buildNoteSystemPrompt(null, null, false, 0, '', '')).not.toContain('【人格】');
  });
});

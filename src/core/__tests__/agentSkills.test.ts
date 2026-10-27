import { describe, expect, it } from 'vitest';
import {
  SKILL_DIR, collectSkills, distillSkills, findSkill, formatSkillCatalog, parseSkillCard,
  parseFrontmatter, signatureOf, skillBody, stripFrontmatter, toSkillMarkdown, validateSkills,
  type SkillCard,
} from '../agentSkills';
import type { TurnTrace } from '../agentTrace';

const card = (id: string, tools: string[], extra: Partial<SkillCard> = {}): SkillCard => ({
  id, path: SKILL_DIR + id + '.md', name: id, when: '什么时候用', tools,
  confidence: 0.5, samples: 0, updated: 0, retired: false, ...extra,
});

const md = (body: string, fm: Record<string, string>): string =>
  ['---', ...Object.entries(fm).map(([k, v]) => k + ': ' + v), '---', '', body].join('\n');

function trace(intentKey: string, tools: string[], outcome: TurnTrace['outcome'] = 'ok', ok = true): TurnTrace {
  return {
    traceId: 'tr-' + Math.random().toString(36).slice(2, 8),
    sessionId: 's-1',
    startedAt: 1,
    intentKey,
    command: null,
    selectedTools: tools,
    calls: tools.map((name) => ({ name, argsHash: 'deadbeef', ok, chars: 10 })),
    decisions: [],
    outcome,
    repeatedAsk: false,
  };
}

describe('parseFrontmatter / stripFrontmatter', () => {
  it('解析标量键并去掉引号', () => {
    const fm = parseFrontmatter('---\nskill: "心衰复盘"\nwhen: 用户要求复盘\ntools: read_note, propose_note_patch\n---\n正文');
    expect(fm).toEqual({ skill: '心衰复盘', when: '用户要求复盘', tools: 'read_note, propose_note_patch' });
  });
  it('没有收尾 --- 时不当 frontmatter', () => {
    expect(parseFrontmatter('---\nskill: x\n正文')).toBeNull();
    expect(parseFrontmatter('正文\n---\nskill: x\n---')).toBeNull();
  });
  it('stripFrontmatter 只剥头部', () => {
    expect(stripFrontmatter('---\nskill: x\n---\n\n正文一\n正文二')).toBe('正文一\n正文二');
    expect(stripFrontmatter('没有头部')).toBe('没有头部');
  });
});

describe('parseSkillCard', () => {
  it('完整卡', () => {
    const c = parseSkillCard(SKILL_DIR + 'xinfu.md', md('步骤…', {
      skill: '心衰复盘', when: '梳理心衰笔记时', tools: 'read_note、search_notes', confidence: '0.7', samples: '2', updated: '123',
    }));
    expect(c).not.toBeNull();
    expect(c!.id).toBe('xinfu');
    expect(c!.name).toBe('心衰复盘');
    expect(c!.tools).toEqual(['read_note', 'search_notes']);
    expect(c!.confidence).toBe(0.7);
    expect(c!.samples).toBe(2);
  });
  it('缺 when / 缺 tools / 无 frontmatter 一律不算技能', () => {
    expect(parseSkillCard(SKILL_DIR + 'a.md', md('x', { skill: 'a', tools: 'read_note' }))).toBeNull();
    expect(parseSkillCard(SKILL_DIR + 'a.md', md('x', { skill: 'a', when: 'y' }))).toBeNull();
    expect(parseSkillCard(SKILL_DIR + 'a.md', '没有 frontmatter')).toBeNull();
  });
  it('confidence 越界被夹紧，name 缺省用 id', () => {
    const c = parseSkillCard(SKILL_DIR + 'b.md', md('x', { when: 'y', tools: 'read_note', confidence: '3' }))!;
    expect(c.confidence).toBe(1);
    expect(c.name).toBe('b');
  });
});

describe('collectSkills / findSkill', () => {
  const docs = new Map<string, string>([
    [SKILL_DIR + 'one.md', md('步骤', { when: '一', tools: 'read_note' })],
    [SKILL_DIR + 'two.md', md('步骤', { skill: '第二张', when: '二', tools: 'list_notes' })],
    ['普通笔记.md', md('步骤', { when: '三', tools: 'read_note' })],
  ]);
  it('只收技能目录下的 md', () => {
    expect(collectSkills(docs).map((c) => c.id).sort()).toEqual(['one', 'two']);
  });
  it('按 id 或 name 找卡', () => {
    expect(findSkill(docs, 'one')!.id).toBe('one');
    expect(findSkill(docs, '第二张')!.id).toBe('two');
    expect(findSkill(docs, '不存在')).toBeNull();
  });
});

describe('validateSkills', () => {
  const reg = (t: string) => ['read_note', 'search_notes', 'propose_note_patch'].includes(t);
  it('未注册工具整卡作废', () => {
    const { active, dropped } = validateSkills([card('a', ['read_note']), card('b', ['read_note', 'delete_all'])], reg);
    expect(active.map((c) => c.id)).toEqual(['a']);
    expect(dropped[0]).toMatchObject({ id: 'b', reason: 'tool_unregistered', detail: 'delete_all' });
  });
  it('步骤过多与已退休出列', () => {
    const many = card('m', Array.from({ length: 13 }, () => 'read_note'));
    const { active, dropped } = validateSkills([many, card('r', ['read_note'], { retired: true })], reg);
    expect(active).toHaveLength(0);
    expect(dropped.map((d) => d.reason).sort()).toEqual(['retired', 'too_many_tools']);
  });
  it('超上限按 confidence 截断', () => {
    const cards = [card('low', ['read_note'], { confidence: 0.1 }), card('high', ['read_note'], { confidence: 0.9 })];
    const { active, dropped } = validateSkills(cards, reg, { max: 1 });
    expect(active.map((c) => c.id)).toEqual(['high']);
    expect(dropped[0].reason).toBe('over_limit');
  });
});

describe('formatSkillCatalog / skillBody', () => {
  it('目录只给 id 与适用场景，空集返回空串', () => {
    expect(formatSkillCatalog([])).toBe('');
    expect(formatSkillCatalog([card('a', ['read_note'], { when: '整理笔记时' })])).toBe('- a：整理笔记时');
  });
  it('目录受字符预算限制', () => {
    const cards = [card('a', ['read_note'], { when: 'x'.repeat(50) }), card('b', ['read_note'], { when: 'y'.repeat(50) })];
    const out = formatSkillCatalog(cards, 30);
    expect(out.split('\n')).toHaveLength(1);
  });
  it('正文去掉 frontmatter 并带建议顺序', () => {
    const docs = new Map([[SKILL_DIR + 'a.md', md('第一步\n第二步', { when: '整理时', tools: 'read_note, propose_note_patch' })]]);
    const c = collectSkills(docs)[0];
    const body = skillBody(docs, c);
    expect(body).toContain('【技能卡】a');
    expect(body).toContain('read_note → propose_note_patch');
    expect(body).toContain('第一步');
    expect(body).not.toContain('when:');
  });
  it('toSkillMarkdown 能被 parseSkillCard 读回', () => {
    const c = card('a', ['read_note', 'search_notes'], { name: '甲', when: '乙', confidence: 0.66, samples: 4, updated: 9 });
    const back = parseSkillCard(c.path, toSkillMarkdown(c, '正文'))!;
    expect(back).toMatchObject({ id: 'a', name: '甲', when: '乙', tools: ['read_note', 'search_notes'], confidence: 0.66, samples: 4, updated: 9 });
  });
});

describe('distillSkills', () => {
  it('反复成功提升已有卡置信度', () => {
    const c = card('a', ['read_note', 'propose_note_patch'], { confidence: 0.5, samples: 2 });
    const traces = [trace('k', ['read_note', 'propose_note_patch']), trace('k', ['read_note', 'propose_note_patch'])];
    const { updates } = distillSkills(traces, [c], { alpha: 0.2, now: 100 });
    expect(updates).toHaveLength(1);
    expect(updates[0].confidence).toBeCloseTo(0.6, 5);
    expect(updates[0].samples).toBe(4);
    expect(updates[0].updated).toBe(100);
  });
  it('反复失败逐步拉低置信度，跌到阈值下退休', () => {
    // 置信度是滑动平均，单轮最多走 α 步——退休要几轮，这是有意的：
    // 一次失败就下线一张卡太脆，反复不行才该退休。
    const tools = ['read_note', 'propose_note_patch'];
    let cards = [card('a', tools, { confidence: 0.5, samples: 5 })];
    const bad = [trace('k', tools), ...Array.from({ length: 9 }, () => trace('k', tools, 'error', false))];
    for (let i = 0; i < 8; i++) {
      const { updates } = distillSkills(bad, cards, { alpha: 0.2, minDelta: 0 });
      expect(updates).toHaveLength(1);
      cards = [updates[0]];
    }
    expect(cards[0].confidence).toBeLessThan(0.2);
    expect(cards[0].retired).toBe(true);
  });
  it('变化太小不写回', () => {
    const c = card('a', ['read_note', 'propose_note_patch'], { confidence: 1 });
    const { updates } = distillSkills([trace('k', ['read_note', 'propose_note_patch'])], [c], { alpha: 0.2 });
    expect(updates).toHaveLength(0);
  });
  it('无卡且样本够了才给建议，且不自动落盘', () => {
    const tools = ['read_note', 'propose_note_patch'];
    const two = [trace('k', tools), trace('k', tools)];
    expect(distillSkills(two, [], { minSamples: 3 }).suggestions).toHaveLength(0);
    const three = [...two, trace('k', tools)];
    const { suggestions } = distillSkills(three, [], { minSamples: 3 });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].path.startsWith(SKILL_DIR + 'auto-')).toBe(true);
    expect(suggestions[0].tools).toEqual(tools);
    expect(suggestions[0].samples).toBe(3);
  });
  it('单步任务与同工具连调不算技能', () => {
    expect(distillSkills([trace('k', ['read_note'])], [], { minSamples: 1 }).suggestions).toHaveLength(0);
    const doubled = trace('k', ['read_note', 'read_note']);
    expect(distillSkills([doubled, doubled, doubled], [], { minSamples: 1 }).suggestions).toHaveLength(0);
  });
  it('同一签名只处理一次，建议数受 maxSuggestions 限制', () => {
    const traces = [trace('k1', ['read_note', 'search_notes']), trace('k2', ['read_note', 'propose_note_patch'])];
    const out = distillSkills(traces, [], { minSamples: 1, maxSuggestions: 1 });
    expect(out.suggestions).toHaveLength(1);
  });
  it('signatureOf 用序列做键', () => {
    expect(signatureOf(['a', 'b'])).toBe('a>b');
    expect(signatureOf(['b', 'a'])).not.toBe(signatureOf(['a', 'b']));
  });
});

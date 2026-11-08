// @vitest-environment node
/**
 * core/matgen 的纯逻辑纪律：
 * - 大纲解析：容忍代码围栏与前后废话；越界素材 id 会被过滤掉；
 * - 素材预算：超预算素材按节标题挑片段、退回首尾；规划摘要受 PLAN_BUDGET 约束；
 * - 拼装：完成节进正文，未完成节进「未完成」；
 * - KV decode：坏数据回退 null，running 复位。
 */
import { describe, expect, it } from 'vitest';
import {
  assembleMatNote,
  asMatStyle,
  buildPlanMessages,
  buildReviewMessages,
  buildSectionMaterials,
  buildSectionMessages,
  MAT_STYLE_LIST,
  newMatJob,
  parseOutline,
  parseReview,
  pickSourceSlice,
  planDigest,
  resetRunningSections,
  sectionDigest,
  SOURCE_BUDGET,
  PLAN_BUDGET,
} from '../matgen';
import type { MatSource } from '../matgen';

const src = (id: string, content: string): MatSource => ({ id, name: `${id}.md`, kind: '教材', content });

describe('parseOutline', () => {
  it('解析裸 JSON', () => {
    const secs = parseOutline('[{"title":"肺炎","sources":["s1"]}]', ['s1']);
    expect(secs).toHaveLength(1);
    expect(secs[0].title).toBe('肺炎');
    expect(secs[0].sources).toEqual(['s1']);
    expect(secs[0].phase).toBe('idle');
  });

  it('容忍 ```json 围栏与前后废话', () => {
    const raw = '好的，以下是大纲：\n```json\n[{"title":"A"},{"title":"B"}]\n```\n请确认。';
    const secs = parseOutline(raw, []);
    expect(secs.map((s) => s.title)).toEqual(['A', 'B']);
  });

  it('越界的素材 id 被过滤，无效项被跳过，空数组抛错', () => {
    const secs = parseOutline('[{"title":"A","sources":["s1","s9"]},{"title":""},{"nope":1}]', ['s1']);
    expect(secs).toHaveLength(1);
    expect(secs[0].sources).toEqual(['s1']);
    expect(() => parseOutline('[]', [])).toThrow();
  });
});

describe('pickSourceSlice', () => {
  it('不超预算整份返回', () => {
    const s = src('s1', '短文本');
    expect(pickSourceSlice(s, '肺炎')).toBe('短文本');
  });

  it('超预算按节标题挑命中段落', () => {
    const hit = `肺炎的病理改变。`.repeat(30);
    const fill = '无关内容。'.repeat(60);
    const text = [fill, hit, fill].join('\n\n');
    const out = pickSourceSlice(src('s1', text), '肺炎', 400);
    expect(out).toContain('肺炎的病理改变');
    expect(out.length).toBeLessThanOrEqual(400 + 2);
  });

  it('命中不足退回首尾', () => {
    const text = '开头总起。\n\n'.repeat(10) + '中段'.repeat(300) + '\n\n结尾小结。';
    const out = pickSourceSlice(src('s1', text), '不相关主题', 200);
    expect(out).toContain('开头总起');
    expect(out).toContain('结尾小结');
    expect(out).toContain('…（中间省略）…');
  });

  it('SOURCE_BUDGET 常量存在且合理', () => {
    expect(SOURCE_BUDGET).toBeGreaterThan(5_000);
  });
});

describe('planDigest', () => {
  it('超预算时优先保留标题行', () => {
    const headings = Array.from({ length: 40 }, (_, i) => `## 第${i}章 标题内容很长很长很长`).join('\n');
    const body = '\n\n正文'.repeat(200);
    const out = planDigest(src('s1', headings + body), PLAN_BUDGET);
    expect(out.length).toBeLessThanOrEqual(PLAN_BUDGET);
    expect(out).toContain('##');
  });
});

describe('buildSectionMaterials', () => {
  it('指定素材优先，总预算被尊重；有考题素材时标记有考点', () => {
    const a = src('s1', '教材内容'.repeat(50));
    const b: MatSource = { id: 's2', name: 'b.md', kind: '考题', content: '真题若干' };
    const sec = { id: 'x', title: '主题', sources: ['s2'], phase: 'idle' as const, body: '' };
    const out = buildSectionMaterials([a, b], sec, 800);
    expect(out).toContain('真题若干');
    expect(out).not.toContain('教材内容');
    expect(out).toContain('有');
  });
});

describe('assembleMatNote', () => {
  it('完成节进正文，未完成节进「未完成」', () => {
    const job = {
      ...newMatJob('测试讲义', [src('s1', '内容')], ''),
      sections: [
        { id: 'a', title: '第一节', sources: [], phase: 'done' as const, body: '正文一' },
        { id: 'b', title: '第二节', sources: [], phase: 'error' as const, body: '', error: '超时' },
      ],
    };
    const out = assembleMatNote({ job });
    expect(out).toContain('# 测试讲义');
    expect(out).toContain('## 第一节');
    expect(out).toContain('正文一');
    expect(out).toContain('## 未完成');
    expect(out).toContain('第二节');
    expect(out).toContain('超时');
  });

  it('frontmatter 标签含「复习讲义」', () => {
    const job = newMatJob('T', [], '');
    expect(assembleMatNote({ job })).toContain('- 复习讲义');
  });
});

describe('resetRunningSections', () => {
  it('running 复位为 idle，其余不动', () => {
    const secs = [
      { id: 'a', title: 'A', sources: [], phase: 'running' as const, body: '' },
      { id: 'b', title: 'B', sources: [], phase: 'done' as const, body: 'x' },
    ];
    const next = resetRunningSections(secs);
    expect(next[0].phase).toBe('idle');
    expect(next[1].phase).toBe('done');
  });
});

describe('sectionDigest', () => {
  it('去掉 Markdown 记号并截断', () => {
    const d = sectionDigest('### 核心结论\n- 要点一\n- 要点二 ' + '长'.repeat(400), 100);
    expect(d).not.toContain('#');
    expect(d.length).toBeLessThanOrEqual(101);
    expect(d.endsWith('…')).toBe(true);
  });
});

describe('buildSectionMessages 跨节上下文', () => {
  it('带 crossRef 时提示词含其他节清单与不重复指令', () => {
    const msgs = buildSectionMessages({
      title: 'T', brief: '', sectionTitle: 'S', materials: 'm', isExamStyle: false,
      crossRef: '其他节：A、B\n「A」已覆盖：要点',
    });
    const sys = msgs[0].content as string;
    const user = msgs[1].content as string;
    expect(sys).toContain('不要重复展开');
    expect(user).toContain('其他节：A、B');
    expect(user).toContain('「A」已覆盖：要点');
  });
  it('不带 crossRef 时不含跨节指令', () => {
    const msgs = buildSectionMessages({ title: 'T', brief: '', sectionTitle: 'S', materials: 'm', isExamStyle: false });
    expect(msgs[0].content as string).not.toContain('不要重复展开');
  });
});

describe('parseReview', () => {
  const base = (): ReturnType<typeof newMatJob>['sections'] => [
    { id: 'a', title: '第一节', sources: [], phase: 'done', body: '旧正文一' },
    { id: 'b', title: '第二节', sources: [], phase: 'done', body: '旧正文二' },
  ];

  it('按标题回填修订正文', () => {
    const out = parseReview('## 第一节\n\n新正文一\n\n## 第二节\n\n新正文二', base());
    expect(out[0].body).toBe('新正文一');
    expect(out[1].body).toBe('新正文二');
  });

  it('容忍标题加粗与代码围栏；缺节保持原样', () => {
    const raw = '```markdown\n## **第一节**\n\n修订一\n\n## 第三节\n\n不匹配的节\n```';
    const out = parseReview(raw, base());
    expect(out[0].body).toBe('修订一');
    expect(out[1].body).toBe('旧正文二');
  });

  it('H1 总标题与开场白被忽略；一个都对不上时抛错', () => {
    expect(() => parseReview('# 讲义\n开场白\n\n## 完全无关\n\nx', base())).toThrow();
  });
});

describe('buildReviewMessages', () => {
  it('全文带 ## 标题进入输入，总预算被尊重', () => {
    const long = { id: 'a', title: 'A', sources: [], phase: 'done' as const, body: '内容'.repeat(7000) };
    const short = { id: 'b', title: 'B', sources: [], phase: 'done' as const, body: '短' };
    const msgs = buildReviewMessages({ title: 'T', brief: '', sections: [long, short] });
    const user = msgs[1].content as string;
    expect(user).toContain('## A');
    expect(user).toContain('## B');
    expect(user.length).toBeLessThan(30000);
    expect(msgs[0].content as string).toContain('节数不增不减');
  });

  it('单节超过总预算时截断该节而不是静默丢弃', () => {
    const huge = { id: 'a', title: 'A', sources: [], phase: 'done' as const, body: '内容'.repeat(20000) };
    const msgs = buildReviewMessages({ title: 'T', brief: '', sections: [huge] });
    const user = msgs[1].content as string;
    expect(user).toContain('## A');
    expect(user).toContain('超出预算已截断');
    expect(user.length).toBeLessThan(30000);
  });

  it('审校结构口径随形式变化', () => {
    const secs = [{ id: 'a', title: 'A', sources: [], phase: 'done' as const, body: 'x' }];
    const lecture = buildReviewMessages({ title: 'T', brief: '', sections: secs, style: 'lecture' });
    const quiz = buildReviewMessages({ title: 'T', brief: '', sections: secs, style: 'quiz' });
    expect(lecture[0].content as string).toContain('四小节');
    expect(quiz[0].content as string).toContain('题号与答案编号一一对应');
  });
});

describe('形式注册表（MAT_STYLES）', () => {
  it('四种形式各自带分节结构与标签；默认讲义', () => {
    expect(MAT_STYLE_LIST).toHaveLength(4);
    for (const s of MAT_STYLE_LIST) {
      expect(s.sectionSpec.length).toBeGreaterThan(0);
      expect(s.tag).toBeTruthy();
      expect(s.dir).toBeTruthy();
      expect(s.planFocus).toBeTruthy();
    }
    expect(asMatStyle('nope')).toBe('lecture');
    expect(asMatStyle('cards')).toBe('cards');
    expect(asMatStyle(undefined)).toBe('lecture');
  });

  it('分节提示词按形式切换输出结构', () => {
    const base = { title: 'T', brief: '', sectionTitle: 'S', materials: 'm', isExamStyle: false };
    const lecture = buildSectionMessages({ ...base, style: 'lecture' });
    const cards = buildSectionMessages({ ...base, style: 'cards' });
    const quiz = buildSectionMessages({ ...base, style: 'quiz' });
    const outline = buildSectionMessages({ ...base, style: 'outline' });
    expect((lecture[1].content as string)).toContain('### 核心结论');
    expect((cards[1].content as string)).toContain('**Q：**');
    expect((quiz[1].content as string)).toContain('### 参考答案');
    expect((outline[1].content as string)).toContain('### 要点树');
    // quiz 的额外约束（考点必须有依据）出现在系统提示里
    expect((quiz[0].content as string)).toContain('考点必须能在素材里找到依据');
  });

  it('规划提示词侧重随形式变化', () => {
    const srcs: MatSource[] = [{ id: 's1', name: 'a.md', kind: '教材', content: '内容' }];
    const lecture = buildPlanMessages({ title: 'T', brief: '', sources: srcs, style: 'lecture' });
    const cards = buildPlanMessages({ title: 'T', brief: '', sources: srcs, style: 'cards' });
    expect((lecture[0].content as string)).toContain('先机制后临床');
    expect((cards[0].content as string)).toContain('可出卡的考点');
  });

  it('拼装随形式：目录名、frontmatter 标签与 style 字段', () => {
    const job = newMatJob('测试', [], '', 'cards');
    job.sections = [{ id: 'a', title: '第一节', sources: [], phase: 'done', body: 'Q：x\nA：y' }];
    const out = assembleMatNote({ job });
    expect(out).toContain('style: "速记卡"');
    expect(out).toContain('- 速记卡');
    expect(out).toContain('（速记卡）');
  });
});

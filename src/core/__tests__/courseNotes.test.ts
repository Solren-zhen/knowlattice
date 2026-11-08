/**
 * 课程讲义 / 人格卡的纯逻辑契约测试。
 *
 * 这些字符串最终会原样落进用户的笔记库，所以钉的是：
 * 1) frontmatter 里的标题与来源不能把 Markdown/YAML 弄坏；
 * 2) 讲义必须保留未收录分P的说明（否则用户会以为整门课都整理完了）；
 * 3) 人格卡必须被截到注入预算内（超了会被 agentSkills 截断，界面却显示全文）。
 */
import { describe, expect, it } from 'vitest';
import { SOUL_PREFIX_LIMIT } from '../agentSkills';
import {
  assembleCourseNote,
  assembleEssenceNote,
  auditEssence,
  buildDigestMessages,
  buildEssenceMessages,
  buildCourseFrontmatter,
  buildLectureMessages,
  buildPersonaCard,
  buildPersonaMessages,
  courseNotePath,
  courseAnchorHref,
  linkEssenceAnchors,
  linkTimeAnchors,
  LOCAL_COURSE_DIR,
  parseCourseAnchorHref,
  personaPath,
  safeTitle,
  splitTranscript,
  stripCodeFence,
  transcriptLines,
  type CourseMeta,
} from '../courseNotes';

const BV = 'BV1xx411c7mD';

const meta: CourseMeta = {
  bvid: 'BV1xx411c7mD',
  title: '诊断学：症状学 "总论"',
  owner: '某讲师',
  partCount: 2,
  duration: 3725,
};

describe('safeTitle', () => {
  it('清掉 Windows 非法字符与会破坏链接的符号', () => {
    expect(safeTitle('a/b:c*d?e"f<g>h|i#j[k]l{m}')).toBe('a b c d e f g h i j k l m');
  });

  it('压平空白，空标题有兜底', () => {
    expect(safeTitle('  诊断学   \n 总论 ')).toBe('诊断学 总论');
    expect(safeTitle('   ')).toBe('未命名课程');
  });
});

describe('buildCourseFrontmatter', () => {
  it('按剪藏格式写来源字段并转义双引号', () => {
    const yaml = buildCourseFrontmatter(meta, new Date(2026, 10, 4));
    expect(yaml).toContain('title: "诊断学：症状学 总论"');
    expect(yaml).toContain('source: "https://www.bilibili.com/video/BV1xx411c7mD"');
    expect(yaml).toContain('author: "某讲师"');
    expect(yaml).toContain('clipped: 2026-11-04');
    expect(yaml.startsWith('---\n')).toBe(true);
    expect(yaml.endsWith('\n---')).toBe(true);
    // 没填网盘链接时不留空字段
    expect(yaml).not.toContain('material:');
  });

  it('网盘链接只在是 http(s) 时写进 frontmatter', () => {
    const withPan = buildCourseFrontmatter(
      { ...meta, materialUrl: '  https://pan.baidu.com/s/1abc?pwd=1234  ' },
      new Date(2026, 10, 4),
    );
    expect(withPan).toContain('material: "https://pan.baidu.com/s/1abc?pwd=1234"');
    const bad = buildCourseFrontmatter({ ...meta, materialUrl: 'pan.baidu.com/s/1abc' });
    expect(bad).not.toContain('material:');
  });

  it('本地导入课程不写 bvid，source 用来源标签', () => {
    const local = { ...meta, bvid: undefined, sourceLabel: '本地文件：内科学.srt' };
    const yaml = buildCourseFrontmatter(local, new Date(2026, 10, 4));
    expect(yaml).toContain('source: "本地文件：内科学.srt"');
    expect(yaml).not.toContain('bvid:');
    const fallback = buildCourseFrontmatter({ ...meta, bvid: undefined });
    expect(fallback).toContain('source: "本地导入"');
  });
});

describe('stripCodeFence', () => {
  it('剥掉模型自带的 markdown 围栏', () => {
    expect(stripCodeFence('```markdown\n### 核心结论\n- x\n```')).toBe('### 核心结论\n- x');
  });

  it('没有围栏时原样返回并去首尾空白', () => {
    expect(stripCodeFence('  ### 核心结论  ')).toBe('### 核心结论');
  });
});

describe('splitTranscript', () => {
  it('按行切分，拼回后与原文一致', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `[0:${String(i).padStart(2, '0')}] 第 ${i} 句，这里补足长度让每行超过三十个字符`);
    const text = lines.join('\n');
    const chunks = splitTranscript(text, 600);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('\n')).toBe(text);
    expect(chunks.every((c) => c.split('\n').every((l) => lines.includes(l)))).toBe(true);
  });

  it('空字幕返回空数组', () => {
    expect(splitTranscript('   ')).toEqual([]);
  });
});

describe('buildLectureMessages', () => {
  it('提示词包含讲次、时长与时间锚点要求', () => {
    const messages = buildLectureMessages({
      meta,
      page: 2,
      part: '发热',
      duration: 754,
      transcript: '[0:00] 发热的定义……',
    });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('只依据用户提供的字幕');
    expect(messages[1].content).toContain('P2《发热》');
    expect(messages[1].content).toContain('[m:ss]');
    expect(messages[1].content).toContain('[0:00] 发热的定义');
  });

  it('分段生成时标出第几段', () => {
    const messages = buildLectureMessages({
      meta,
      page: 1,
      part: '总论',
      duration: 100,
      transcript: 'x',
      chunkIndex: 2,
      chunkCount: 3,
    });
    expect(messages[1].content).toContain('第 2/3 段');
  });
});

describe('课程锚点 · 课程笔记 ↔ 视频笔记', () => {
  it('生成与解析可往返，带不带秒数都认', () => {
    expect(courseAnchorHref({ bvid: BV, page: 3 })).toBe(`#cw=${BV}:p3`);
    expect(courseAnchorHref({ bvid: BV, page: 3, seconds: 754 })).toBe(`#cw=${BV}:p3:t754`);
    expect(parseCourseAnchorHref(`#cw=${BV}:p3`)).toEqual({ bvid: BV, page: 3 });
    expect(parseCourseAnchorHref(`#cw=${BV}:p3:t754`)).toEqual({
      bvid: BV,
      page: 3,
      seconds: 754,
    });
    expect(parseCourseAnchorHref('#vn=754')).toBeNull();
    expect(parseCourseAnchorHref(`#cw=av170001:p3`)).toBeNull();
    expect(parseCourseAnchorHref('')).toBeNull();
  });

  it('讲义里的 [m:ss] 转成可点锚点，普通文字不误伤', () => {
    const body = '### 核心结论\n- 发热是症状 [0:12]\n- 不是诊断 [12:34]\n- 参考值 37.3 摄氏度';
    const linked = linkTimeAnchors(body, BV, 2);
    expect(linked).toContain(`[▶ 0:12](#cw=${BV}:p2:t12)`);
    expect(linked).toContain(`[▶ 12:34](#cw=${BV}:p2:t754)`);
    expect(linked).toContain('参考值 37.3 摄氏度');
    expect(linked).not.toContain('[0:12]');
  });

  it('精华里的 Pn m:ss 转成可点锚点', () => {
    const linked = linkEssenceAnchors('P3 12:34 先测体温\nP1 0:10 发热是症状', BV);
    expect(linked).toContain(`P3 [▶ 12:34](#cw=${BV}:p3:t754)`);
    expect(linked).toContain(`P1 [▶ 0:10](#cw=${BV}:p1:t10)`);
  });

  it('字幕行拆成可点击的时间点，坏行跳过', () => {
    expect(transcriptLines('[0:12] 发热是症状\n[1:02:03] 长视频\n不是字幕')).toEqual([
      { stamp: '0:12', seconds: 12, text: '发热是症状' },
      { stamp: '1:02:03', seconds: 3723, text: '长视频' },
    ]);
  });
});

describe('assembleCourseNote', () => {
  it('按分P 排序、保留未收录说明、不重复标题', () => {
    const note = assembleCourseNote(
      meta,
      [
        { page: 2, part: '发热', duration: 754, body: '### 核心结论\n- 内容二 [0:12]' },
        { page: 1, part: '总论', duration: 100, body: '```markdown\n### 核心结论\n- 内容一\n```' },
      ],
      [{ page: 3, part: '疼痛', reason: '该分P没有 CC 字幕' }],
      new Date(2026, 10, 4),
    );
    expect(note.indexOf('## P1 总论')).toBeLessThan(note.indexOf('## P2 发热'));
    expect(note).toContain('### 核心结论\n- 内容一');
    expect(note).not.toContain('```markdown');
    // 每个分P 都带「打开本节视频」，正文里的 [m:ss] 也转成课程锚点
    expect(note).toContain(`> [▶ 打开本节视频](#cw=${BV}:p2)`);
    expect(note).toContain(`[▶ 0:12](#cw=${BV}:p2:t12)`);
    expect(note).toContain('## 未收录');
    expect(note).toContain('P3《疼痛》：该分P没有 CC 字幕');
    expect(note.match(/^# /gm)?.length).toBe(1);
  });

  it('全部收录时不出现未收录段', () => {
    const note = assembleCourseNote(meta, [{ page: 1, part: '总论', duration: 0, body: 'x' }]);
    expect(note).not.toContain('## 未收录');
  });

  it('带网盘链接时正文与 frontmatter 都记下来源', () => {
    const withPan = { ...meta, materialUrl: 'https://pan.quark.cn/s/abc123' };
    const note = assembleCourseNote(withPan, [{ page: 1, part: '总论', duration: 0, body: 'x' }]);
    expect(note).toContain('material: "https://pan.quark.cn/s/abc123"');
    expect(note).toContain('> 网盘资料：https://pan.quark.cn/s/abc123');
    const essence = assembleEssenceNote(withPan, '### 核心结论\n- 内容');
    expect(essence).toContain('> 网盘资料：https://pan.quark.cn/s/abc123');
  });

  it('本地导入课程不生成 B 站跳转与锚点，按文件名分节', () => {
    const local = { ...meta, bvid: undefined };
    const note = assembleCourseNote(local, [
      { page: 1, part: '第一讲.srt', duration: 0, body: '### 结论\n- 内容 [0:12]' },
    ]);
    expect(note).toContain('> 来源：本地导入 · 2 个文件');
    expect(note).not.toContain('打开本节视频');
    expect(note).not.toContain('#cw=');
    expect(note).toContain('## 第一讲.srt');
    expect(note).toContain('[0:12]');
    const essence = assembleEssenceNote(local, '### 结论\n- 内容 [0:12]');
    expect(essence).not.toContain('#cw=');
    expect(essence).toContain('[0:12]');
  });
});

describe('courseNotePath', () => {
  it('默认落 B 站课程目录，本地导入可指定目录', () => {
    expect(courseNotePath('内科学')).toBe('B站课程/内科学.md');
    expect(courseNotePath('内科学', LOCAL_COURSE_DIR)).toBe('课程笔记/内科学.md');
  });
});

describe('人格卡', () => {
  it('提示词要求不编造生平并限制字数', () => {
    const messages = buildPersonaMessages({ meta, evidence: '讲义' });
    expect(messages[0].content).toContain('不编造生平');
    expect(messages[0].content).toContain(String(SOUL_PREFIX_LIMIT - 80));
  });

  it('人格分两层、要求原话样本，并有减废话判据', () => {
    const messages = buildPersonaMessages({
      meta,
      evidence: '讲义',
      styleSample: '同学你看，这个先放一放。',
    });
    expect(messages[0].content).toContain('第一层');
    expect(messages[0].content).toContain('第二层');
    expect(messages[0].content).toContain('删掉这条');
    expect(messages[1].content ?? '').toContain('同学你看');
  });

  it('超长正文截断到注入预算内', () => {
    const card = buildPersonaCard('某讲师', 'x'.repeat(SOUL_PREFIX_LIMIT + 500), meta);
    const body = card.split('---')[2].trim();
    expect(body.length).toBeLessThanOrEqual(SOUL_PREFIX_LIMIT);
    expect(body.endsWith('…')).toBe(true);
    expect(card).toContain('persona: "某讲师"');
  });

  it('路径按约定落在课程目录与人格目录', () => {
    expect(courseNotePath('诊断学/总论')).toBe('B站课程/诊断学 总论.md');
    expect(personaPath('某讲师')).toBe('AI命令/人格/某讲师-perspective.md');
  });
});

describe('精华模式', () => {
  it('逐P压缩要求只删不写、单条限长、带时间锚点', () => {
    const messages = buildDigestMessages({
      meta,
      page: 3,
      part: '发热',
      transcript: '[0:00] 发热的定义……',
    });
    expect(messages[0].content).toContain('只做删减，不做扩写');
    expect(messages[0].content).toContain('35 个字');
    expect(messages[0].content).toContain('P3 12:34');
    expect(messages[0].content).toContain('分P 不能省');
    expect(messages[1].content).toContain('P3《发热》');
    expect(messages[1].content).toContain('[0:00] 发热的定义');
  });

  it('合并阶段按主题组织并固定五节', () => {
    const messages = buildEssenceMessages({
      meta,
      digests: [
        { page: 2, part: '发热', digest: '- [1:00] 要点二' },
        { page: 1, part: '总论', digest: '- [0:10] 要点一' },
      ],
    });
    expect(messages[0].content).toContain('按主题聚类');
    expect(messages[0].content).toContain('1000 字');
    for (const section of ['一句话总结', '核心概念', '机制与步骤', '易错与考点', '自测']) {
      expect(messages[0].content).toContain(section);
    }
    const user = messages[1].content ?? '';
    expect(user.indexOf('P1《总论》')).toBeLessThan(user.indexOf('P2《发热》'));
  });

  it('精华笔记只放合并结果，不含逐P讲义与字幕', () => {
    const note = assembleEssenceNote(
      meta,
      '### 一句话总结\n鉴别发热的病因。\n\n### 核心概念\n- 发热 ≠ 高热（P3 12:34）',
      [{ page: 3, part: '疼痛', reason: '该分P没有 CC 字幕' }],
      new Date(2026, 10, 4),
    );
    expect(note).toContain('# ');
    expect(note).toContain('### 一句话总结');
    expect(note).toContain(`P3 [▶ 12:34](#cw=${BV}:p3:t754)`);
    expect(note).toContain('## 未收录');
    expect(note).toContain('P3《疼痛》');
    expect(note).not.toContain('## P1');
    expect(note.match(/^# /gm)?.length).toBe(1);
    expect(note).toContain('clipped: 2026-11-04');
  });
});

describe('精华自检', () => {
  const good = [
    '### 一句话总结',
    '鉴别发热的病因。',
    '### 核心概念',
    '- P1 0:10 发热是症状不是诊断',
    '### 机制与步骤',
    '1. P1 1:00 先测体温',
    '### 易错与考点',
    '- P2 3:20 不要见热就退',
    '### 自测',
    '1. 发热的定义是什么？',
  ].join('\n');

  it('结构齐全且有分P锚点时通过', () => {
    expect(auditEssence(good)).toEqual({ ok: true, issues: [] });
  });

  it('缺节、缺锚点、超预算都会被指出', () => {
    const bad = auditEssence('### 一句话总结\n只有一句话' + 'x'.repeat(1200));
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => i.includes('核心概念'))).toBe(true);
    expect(bad.issues.some((i) => i.includes('锚点'))).toBe(true);
    expect(bad.issues.some((i) => i.includes('预算'))).toBe(true);
  });

  it('本地导入课程不要求时间锚点', () => {
    const text = good.replace(/P\d+\s+/g, '').replace(/\d+:\d{2}\s?/g, '');
    const audit = auditEssence(text, { anchors: false });
    expect(audit.issues.some((i) => i.includes('锚点'))).toBe(false);
  });
});

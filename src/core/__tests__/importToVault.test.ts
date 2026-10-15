/**
 * importToVault 的单测：三条导入入口（Anki / 同业题库 / 结构化数据集）共用的写盘通道。
 *
 * 本文件主要钉住两条最容易出错的契约：
 *  1. **标题里的非法字符是清洗，不是丢弃**。早期实现把含 `?` `/` `:` 的标题连正文一起跳过，
 *     对英文 Anki 卡组是灾难（`What is P50?`、`A/B 分型` 成片落空），而用户看到的是"导入完成"。
 *     静默丢正文是本项目最忌讳的失败形态，所以这里既测"落盘了"也测"报了名"（renamed）。
 *  2. **安全标题逐字不变、清洗幂等**。清洗若把本来安全的标题也改了名（或再导一次名字又变），
 *     路径就不再稳定——路径是复习卡、错题本、双链的键，改一次等于丢一批历史。
 * 目录（dir）保持严格：不安全就整批拒绝，不放宽（清洗只适用于从卡片内容里抽出来的标题）。
 */
import { describe, expect, it } from 'vitest';
import { EXISTING_NOTE_REASON, importSummary, notesToVaultFiles, skipExistingNotes, type ImportNoteItem } from '../importToVault';

/** 一条最简单的资料（标题 + 正文），其余字段按需覆盖 */
const item = (title: string, body = '正文内容'): ImportNoteItem => ({ title, body });

const run = (items: ImportNoteItem[], dir?: string, existing?: ReadonlySet<string>) =>
  notesToVaultFiles(items, {
    sourceNote: '测试来源',
    ...(dir ? { dir } : {}),
    ...(existing ? { existing } : {}),
  });

describe('notesToVaultFiles · 安全标题逐字不变', () => {
  it('中文/英文/带空格/带下划线/全角标点的标题一个字都不改', () => {
    const titles = [
      '氧解离曲线的意义',
      'What is P50',
      'A_B 对比',
      '肺的通气功能（含氧量）',
      '第 1 章 绪论',
      'P50 与 2,3-DPG', // 逗号、连字符、点号都不是非法字符
    ];
    const r = run(titles.map((t) => item(t)));
    expect(r.skipped).toEqual([]);
    expect(r.renamed).toEqual([]); // 不能出现"所有标题都被改名"的意外
    expect(r.files.map((f) => f.path)).toEqual(titles.map((t) => `${t}.md`));
    // H1 也逐字不变（标题 = H1 = 文件名，本项目的既有不变式）
    titles.forEach((t, i) => expect(r.files[i].content).toContain(`\n# ${t}\n`));
  });
});

describe('notesToVaultFiles · 非法字符清洗（不丢笔记）', () => {
  it('`?` 与 `/` 被换成 `_`，整条照常落盘（Anki 英文卡组的关键回归）', () => {
    const r = run([item('What is P50?'), item('A/B 分型')]);
    expect(r.skipped).toEqual([]);
    expect(r.files.map((f) => f.path)).toEqual(['What is P50.md', 'A_B 分型.md']);
    // 用户必须看得见"我的卡片被叫什么名字了"，否则会以为卡丢了
    expect(r.renamed).toEqual([
      { from: 'What is P50?', to: 'What is P50' },
      { from: 'A/B 分型', to: 'A_B 分型' },
    ]);
  });

  it('连续非法字符合并成一个 `_`，首尾的空白/点号/下划线去掉', () => {
    expect(run([item('A?*B')]).files[0].path).toBe('A_B.md'); // 合并，不写成 A__B
    expect(run([item('P50?')]).files[0].path).toBe('P50.md'); // 尾部 `_` 是清洗痕迹，去掉
    expect(run([item('?. 甲 .?')]).files[0].path).toBe('甲.md');
  });

  it('控制字符（换行/制表）也按字符层面的不安全处理，不因此丢整条', () => {
    const r = run([item('甲\n乙')]);
    expect(r.files.map((f) => f.path)).toEqual(['甲_乙.md']);
  });

  it('正文一字未动（只动标题里的非法字符），source 照旧写入', () => {
    const body = '问题原文：What is P50? 答：甲。';
    const r = run([item('What is P50?', body)]);
    expect(r.files[0].content).toContain(body);
    expect(r.files[0].content).toContain('source: 测试来源');
    expect(r.files[0].content).toContain('\n# What is P50\n');
  });

  it('目录穿越被清洗化解在文件名内（不会写到库外）', () => {
    const r = run([item('../../etc/passwd')], 'imported/anki');
    expect(r.files).toHaveLength(1);
    expect(r.files[0].path).toBe('imported/anki/etc_passwd.md');
    expect(r.files[0].path.includes('..')).toBe(false);
  });

  it('清洗后撞名时第二条报重名（不静默覆盖第一篇）', () => {
    const r = run([item('A?B'), item('A*B')]); // 两条都清洗成 A_B
    expect(r.files.map((f) => f.path)).toEqual(['A_B.md']);
    expect(r.skipped).toEqual([{ title: 'A_B', reason: '同一批里重名' }]);
  });

  it('清洗**幂等**：拿落盘用的标题再跑一次，路径逐字不变、不再产生 renamed', () => {
    const first = run([item('What is P50?'), item('A/B 分型'), item('?甲?')]);
    const again = run(first.files.map((f) => item(f.path.replace(/\.md$/, ''))));
    expect(again.renamed).toEqual([]);
    expect(again.files.map((f) => f.path)).toEqual(first.files.map((f) => f.path));
  });
});

describe('notesToVaultFiles · 清洗后仍不能用才跳过（每条都给中文原因）', () => {
  it('标题为空 / 只剩空白或点号 → 跳过并说明原因', () => {
    const r = run([item(''), item('   '), item('..'), item('???'), item('. ? .')]);
    expect(r.files).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual([
      '标题为空',
      '标题为空',
      '标题清洗后不能作为文件名（只剩空白或点号）',
      '标题清洗后不能作为文件名（只剩空白或点号）',
      '标题清洗后不能作为文件名（只剩空白或点号）',
    ]);
    for (const s of r.skipped) expect(s.reason).toMatch(/[\u4e00-\u9fa5]/);
    expect(r.skipped[0].title).toBe('(空标题)');
    expect(r.renamed).toEqual([]); // 跳过的条目不进 renamed（它没落盘）
  });

  it('正文为空 → 跳过（不留空笔记），标题仍照常清洗后报出', () => {
    const r = run([item('A?B', '   ')]);
    expect(r.files).toEqual([]);
    expect(r.skipped).toEqual([{ title: 'A_B', reason: '正文为空' }]);
  });
});

describe('notesToVaultFiles · 目录保持严格（清洗不适用于目录）', () => {
  it('目录不安全 → 整批拒绝，一篇都不写', () => {
    const r = run([item('甲'), item('乙')], '../库外');
    expect(r.files).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['目录名不安全', '目录名不安全']);
    expect(r.renamed).toEqual([]);
  });

  it('以 `.` 开头的目录（隐藏目录）仍整批拒绝', () => {
    const r = run([item('甲')], '.imported/anki');
    expect(r.files).toEqual([]);
    expect(r.skipped).toEqual([{ title: '甲', reason: '目录名不安全' }]);
  });

  it('目录里的非法字符不会像标题那样被清洗掉', () => {
    const r = run([item('甲')], 'a:b');
    expect(r.files).toEqual([]);
    expect(r.skipped[0].reason).toBe('目录名不安全');
  });

  it('安全目录不变（含多级目录）', () => {
    const r = run([item('What is P50?')], 'imported/anki');
    expect(r.files[0].path).toBe('imported/anki/What is P50.md');
  });
});

describe('importSummary · 标题清洗后要出现在给用户的一句话里', () => {
  it('没有清洗时输出与既有口径逐字相同', () => {
    expect(importSummary(3, 0, 'Anki 导入')).toBe('来源：Anki 导入 · 新增 3 篇');
    expect(importSummary(3, 1, 'Anki 导入')).toBe('来源：Anki 导入 · 新增 3 篇，跳过 1 篇');
  });

  it('有清洗时多一句，但"新增/跳过"的计数不受影响', () => {
    expect(importSummary(3, 1, 'Anki 导入', 2)).toBe('来源：Anki 导入 · 新增 3 篇，跳过 1 篇，2 篇标题含非法字符已清洗');
  });
});

/**
 * 资料侧增量导入（O3）：同一份资料更新后再导一遍，只补新篇、不覆盖用户已改过的内容。
 *
 * 为什么这组测试非写不可：落盘通道 vault.importMdFiles 是**无条件覆盖写**（web 端 db.put /
 * 桌面端 writeAtomic，既不查重也不推历史快照），所以「再导一遍」曾经=把用户改过的笔记整篇
 * 换掉且找不回来。纯函数层是唯一能拦住这件事的地方，这里把「已存在就不写盘」钉死。
 */
describe('notesToVaultFiles · 增量导入（existing 已存在路径集合）', () => {
  it('不传 existing 时返回值与加参数之前逐字一致（向后兼容的关键）', () => {
    const items = [item('What is P50?'), item('A/B 分型'), item(''), item('A?B'), item('A*B')];
    // 两种写法对比：既有调用方（core/ankiImport / core/datasetImport）就是这么调的
    const explicit = notesToVaultFiles(items, { sourceNote: '测试来源' });
    expect(run(items)).toEqual(explicit);
    // 不能多出字段：既有调用方的返回值形状必须不变
    expect(Object.keys(run(items)).sort()).toEqual(['files', 'renamed', 'skipped']);
  });

  it('命中的条目进 skipped（明确中文原因）并计入 existingSkipped，不再写盘', () => {
    const r = run([item('What is P50?'), item('A/B 分型')], undefined, new Set(['What is P50.md']));
    expect(r.files.map((f) => f.path)).toEqual(['A_B 分型.md']); // 只补新篇
    expect(r.skipped).toEqual([{ title: 'What is P50', reason: EXISTING_NOTE_REASON }]);
    expect(r.existingSkipped).toBe(1); // 界面靠它一次报出「新增 N 篇 / 已存在 M 篇」
    expect(EXISTING_NOTE_REASON).toMatch(/[\u4e00-\u9fa5]/); // 中文，不甩英文码
    expect(EXISTING_NOTE_REASON).toContain('不会覆盖'); // 文案必须说清后果，不能只说「已跳过」
  });

  it('全部命中时 files 为空、计数等于命中篇数（重复导入同一份资料的常态）', () => {
    const r = run([item('甲'), item('乙')], 'imported/anki', new Set(['imported/anki/甲.md', 'imported/anki/乙.md']));
    expect(r.files).toEqual([]);
    expect(r.existingSkipped).toBe(2);
    expect(r.skipped.map((s) => s.title)).toEqual(['甲', '乙']);
    expect(r.skipped.every((s) => s.reason === EXISTING_NOTE_REASON)).toBe(true);
  });

  it('existing 为空集或不命中时与不传逐字一致（不能凭空多出字段或跳过项）', () => {
    const items = [item('甲'), item('乙')];
    expect(run(items, undefined, new Set())).toEqual(notesToVaultFiles(items, { sourceNote: '测试来源' }));
    const miss = run(items, undefined, new Set(['别的笔记.md']));
    expect(miss.files.map((f) => f.path)).toEqual(['甲.md', '乙.md']);
    expect(miss.skipped).toEqual([]);
    expect(miss.existingSkipped).toBeUndefined();
  });

  it('按**完整路径**精确匹配：裸标题、别的目录的同名笔记都不算「已存在」', () => {
    // 裸标题（无目录）不该拦住 imported/anki 下的同名文件——路径才是键
    expect(run([item('甲')], 'imported/anki', new Set(['甲.md'])).files.map((f) => f.path))
      .toEqual(['imported/anki/甲.md']);
    // 同名不同目录是两篇不同的笔记：只挡住路径完全相同的那一篇
    const r = run([item('甲')], 'a', new Set(['b/甲.md']));
    expect(r.files.map((f) => f.path)).toEqual(['a/甲.md']);
    expect(r.existingSkipped).toBeUndefined();
  });

  it('跳过的篇目不进 renamed：只有真正写出去的那篇才报「名字被清洗过」', () => {
    const r = run([item('What is P50?'), item('A/B 分型')], undefined, new Set(['What is P50.md']));
    expect(r.renamed).toEqual([{ from: 'A/B 分型', to: 'A_B 分型' }]);
  });

  it('目录不安全仍是整批拒绝，existing 不改变这条既有语义', () => {
    const r = run([item('甲')], '../库外', new Set(['甲.md']));
    expect(r.files).toEqual([]);
    expect(r.skipped).toEqual([{ title: '甲', reason: '目录名不安全' }]);
    expect(r.existingSkipped).toBeUndefined();
  });
});

describe('skipExistingNotes · 直接作用于既有结果（Anki / 数据集入口走的就是这条）', () => {
  // 这两行的形状与 apkgToVaultFiles / datasetToVaultFiles 的返回一致：
  // 那两个模块不在本次改动范围内（不能给它们的 opts 加 existing），所以界面拿到结果后
  // 必须能自己过一道——同一个函数、同一句原因，判定只有一份。
  const apkgLikeResult = {
    files: [
      { path: 'imported/anki/甲.md', content: 'AAAA' },
      { path: 'imported/anki/乙.md', content: 'BBBB' },
    ],
    skipped: [{ title: '丙', reason: '没有字段内容' }],
    renamed: [{ from: '甲?', to: '甲' }],
  };

  it('命中项改记为「已存在」，其余跳过原因原样保留、顺序不变', () => {
    const r = skipExistingNotes(apkgLikeResult, new Set(['imported/anki/甲.md']));
    expect(r.files.map((f) => f.path)).toEqual(['imported/anki/乙.md']);
    expect(r.skipped).toEqual([
      { title: '丙', reason: '没有字段内容' },
      { title: '甲', reason: EXISTING_NOTE_REASON },
    ]);
    expect(r.existingSkipped).toBe(1);
    // 原对象不能被就地改坏（React state / 调用方的 res 还要继续用）
    expect(apkgLikeResult.files).toHaveLength(2);
    expect(apkgLikeResult.skipped).toHaveLength(1);
  });

  it('未传 / 空集 / 不命中时返回**原对象**（同一引用，零开销）', () => {
    expect(skipExistingNotes(apkgLikeResult)).toBe(apkgLikeResult);
    expect(skipExistingNotes(apkgLikeResult, new Set())).toBe(apkgLikeResult);
    expect(skipExistingNotes(apkgLikeResult, new Set(['imported/anki/丙.md']))).toBe(apkgLikeResult);
  });

  it('幂等：对已过滤的结果再过滤一次，不重复计数、不再新增跳过项', () => {
    const once = skipExistingNotes(apkgLikeResult, new Set(['imported/anki/甲.md']));
    const twice = skipExistingNotes(once, new Set(['imported/anki/甲.md']));
    expect(twice.skipped).toEqual(once.skipped);
    expect(twice.existingSkipped).toBe(1);
  });
});

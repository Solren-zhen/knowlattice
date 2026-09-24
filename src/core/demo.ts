/**
 * 演示数据：一键载入一批带 [[双链]]、#标签、frontmatter 的示例笔记 + 题库/待办/错题/打卡，
 * 让用户马上体验 树/双链/标签/图谱/复习/题库/错题/待办/学习统计 全部功能。
 * 数据写入 IndexedDB(knowlattice.files) + localStorage；写入后调用方 reload 重新加载 vault。
 */
import { openDB } from 'idb';
import { saveTodos, dayKey, addDays, type Todo } from './todos';
import { importDays } from './stats';
import { importQbanks } from './qbank';

const DB_NAME = 'knowlattice';
interface DemoNote {
  path: string;
  title: string;
  chapter: string;
  tags: string[];
  aliases: string[];
  exam?: string[];
  links: string[];
  body: string;
}

function build(n: DemoNote): string {
  const today = new Date().toISOString().slice(0, 10);
  const fm = [
    '---',
    `aliases: [${(n.aliases ?? []).join(', ')}]`,
    `tags: [${n.tags.join(', ')}]`,
    `chapter: ${n.chapter}`,
    'source: 演示数据',
    `created: ${today}`,
    `exam: [${(n.exam ?? []).join(', ')}]`,
    '---',
    '',
  ].join('\n');
  return fm + `# ${n.title}\n\n` + n.body + '\n';
}

const NOTES: DemoNote[] = [
  {
    path: '01-生理学/呼吸/氧解离曲线.md', title: '氧解离曲线', chapter: '生理学/呼吸',
    tags: ['生理', '呼吸', '氧解离'], aliases: ['氧离曲线'], exam: ['2023-生理-12'],
    links: ['波尔效应', '血氧饱和度'],
    body: '- 定义: 反映 Hb 与 O2 亲和力随 PO2 变化的 S 形曲线。\n- 机制: 协同效应——一个血红素结合氧后其余更容易结合氧。\n- 口诀: 「右移放氧，左移吸氧」\n- 相关: [[波尔效应]]、[[血氧饱和度]]',
  },
  {
    path: '01-生理学/呼吸/波尔效应.md', title: '波尔效应', chapter: '生理学/呼吸',
    tags: ['生理', '呼吸'], aliases: [],
    links: ['氧解离曲线'],
    body: '- 定义: pH 降低或 CO2 升高使 Hb 对氧亲和力下降、曲线右移。\n- 机制: H+ 与 CO2 与脱氧 Hb 结合，稳定其 T 态。\n- 关联: [[氧解离曲线]]\n- 记忆: 酸多放氧，利于组织供氧。',
  },
  {
    path: '01-生理学/呼吸/肺牵张反射.md', title: '肺牵张反射', chapter: '生理学/呼吸',
    tags: ['生理', '呼吸'], aliases: ['黑-伯反射'], exam: ['2022-生理-8'],
    links: [],
    body: '- 定义: 肺扩张引起吸气抑制的负反馈。\n- 机制: 牵张感受器经迷走神经传入，抑制吸气。\n- 意义: 防止肺过度扩张。',
  },
  {
    path: '01-生理学/血液/血氧饱和度.md', title: '血氧饱和度', chapter: '生理学/血液',
    tags: ['生理', '血液', '呼吸'], aliases: [],
    links: ['氧解离曲线'],
    body: '- 定义: 实际结合的氧量占最大结合氧量的百分比。\n- 正常值: 动脉血约 95%~98%。\n- 关联: [[氧解离曲线]]',
  },
  {
    path: '01-生理学/循环/心输出量.md', title: '心输出量', chapter: '生理学/循环',
    tags: ['生理', '循环'], aliases: [], exam: ['2023-生理-20'],
    links: ['每搏输出量'],
    body: '- 定义: 一侧心室每分钟泵出的血量 = 心率 × 每搏输出量。\n- 正常值: 安静约 5L/min。\n- 调节: [[每搏输出量]] + 心率。',
  },
  {
    path: '01-生理学/循环/每搏输出量.md', title: '每搏输出量', chapter: '生理学/循环',
    tags: ['生理', '循环'], aliases: [],
    links: ['心输出量'],
    body: '- 定义: 一次心搏一侧心室射出的血量。\n- 影响因素: 前负荷 / 心肌收缩力 / 后负荷。\n- 关联: [[心输出量]]',
  },
  {
    path: '02-生化/代谢/糖酵解.md', title: '糖酵解', chapter: '生化/代谢',
    tags: ['生化', '代谢', '糖代谢'], aliases: [],
    links: ['三羧酸循环'],
    body: '- 场所: 细胞质。\n- 净生成: 2 ATP + 2 NADH + 2 丙酮酸。\n- 关键酶: 己糖激酶 / 磷酸果糖激酶-1 / 丙酮酸激酶。\n- 去向: [[三羧酸循环]]',
  },
  {
    path: '02-生化/代谢/三羧酸循环.md', title: '三羧酸循环', chapter: '生化/代谢',
    tags: ['生化', '代谢', '糖代谢'], aliases: ['TCA 循环', '柠檬酸循环'],
    links: ['糖酵解'],
    body: '- 场所: 线粒体基质。\n- 生成: 1 次循环生成 3 NADH、1 FADH2、1 GTP、2 CO2。\n- 输入: 乙酰 CoA（来自[[糖酵解]]）。',
  },
  {
    path: '02-生化/酶/米氏常数.md', title: '米氏常数', chapter: '生化/酶学',
    tags: ['生化', '酶'], aliases: ['Km'],
    links: [],
    body: '- 定义: 反应速率为最大速率一半时的底物浓度。\n- 意义: Km 越小，酶与底物亲和力越大。\n- 记忆: Km 是「半速浓度」。',
  },
  {
    path: '03-解剖/呼吸系统/气管.md', title: '气管', chapter: '解剖/呼吸系统',
    tags: ['解剖', '呼吸'], aliases: [],
    links: [],
    body: '- 结构: 由 C 形软骨环支撑。\n- 位置: 喉与主支气管之间。',
  },
  {
    path: '03-解剖/循环系统/心脏.md', title: '心脏', chapter: '解剖/循环系统',
    tags: ['解剖', '循环'], aliases: [],
    links: [],
    body: '- 位置: 中纵隔。\n- 心腔: 4 个腔室，右房室口有三尖瓣。',
  },
  {
    path: '04-药理/呼吸系统/茶碱.md', title: '茶碱', chapter: '药理/呼吸系统',
    tags: ['药理', '呼吸'], aliases: [],
    links: [],
    body: '- 作用: 非选择性磷酸二酯酶抑制剂，扩张支气管。\n- 机制: 升高细胞内 cAMP。\n- 注意: 治疗窗窄，易中毒。',
  },
];

const DEMO_BANK = {
  name: '演示题库·生理/生化',
  importedAt: Date.now(),
  questions: [
    { id: 'd1', type: 'choice', stem: '氧解离曲线右移的意义是？', options: ['Hb 容易放氧', 'Hb 容易结合氧', '亲和力增大', 'P50 减小'], answer: 0, answerText: 'Hb 容易放氧', explanation: '右移=亲和力下降、P50 增大，利于组织放氧。', chapter: '生理', note: '氧解离曲线' },
    { id: 'd2', type: 'choice', stem: '波尔效应指什么对 Hb 氧亲和力的影响？', options: ['pH 和 CO2', '温度', '2,3-DPG', 'PO2 本身'], answer: 0, answerText: 'pH 和 CO2', explanation: 'pH 降低或 CO2 升高使曲线右移。', chapter: '生理', note: '波尔效应' },
    { id: 'd3', type: 'choice', stem: '肺牵张反射的生理意义是？', options: ['促进吸气', '防止肺过度扩张', '兴奋呼吸中枢', '降低肺泡通气'], answer: 1, answerText: '防止肺过度扩张', explanation: '负反馈，防止肺过度扩张。', chapter: '生理', note: '肺牵张反射' },
    { id: 'd4', type: 'choice', stem: '糖酵解的净生成 ATP 是？', options: ['0', '1', '2', '4'], answer: 2, answerText: '2', explanation: '2 ATP + 2 NADH + 2 丙酮酸。', chapter: '生化', note: '糖酵解' },
    { id: 'd5', type: 'choice', stem: '米氏常数 Km 越小说明？', options: ['酶与底物亲和力越大', '亲和力越小', '最大速率越大', '最适温度升高'], answer: 0, answerText: '酶与底物亲和力越大', chapter: '生化', note: '米氏常数' },
    { id: 'd6', type: 'recall', stem: '简述心输出量的定义。', answer: -1, answerText: '一侧心室每分钟泵出的血量 = 心率 × 每搏输出量。', chapter: '生理', note: '心输出量' },
    { id: 'd7', type: 'recall', stem: '三羧酸循环每循环生成哪些还原当量？', answer: -1, answerText: '3 NADH、1 FADH2（另 1 GTP、2 CO2）。', chapter: '生化', note: '三羧酸循环' },
  ],
};

const DEMO_TODOS: Todo[] = [
  {
    id: 'd1', text: '复习·呼吸章节（氧解离曲线/波尔效应）', done: false, createdAt: Date.now(),
    due: dayKey(), priority: 1,
    subtasks: [
      { id: 'd1s1', text: '画一遍氧解离曲线', done: true },
      { id: 'd1s2', text: '背波尔效应三个影响因素', done: false },
    ],
  },
  { id: 'd2', text: '整理生化·糖代谢思维导图', done: false, createdAt: Date.now(), due: addDays(dayKey(), 1), priority: 2 },
  { id: 'd3', text: '刷一遍「演示题库·生理/生化」', done: false, createdAt: Date.now(), due: dayKey(), priority: 3 },
  { id: 'd4', text: '背诵三尖瓣位置口诀', done: true, createdAt: Date.now(), completedAt: Date.now() },
  { id: 'd5', text: '每天背 30 个解剖名词', done: false, createdAt: Date.now(), repeat: 'daily' },
];

/** 近 7 天学习记录（含今天，便于展示打卡与柱状图） */
function demoDays(): Record<string, number> {
  const out: Record<string, number> = {};
  const counts = [2, 4, 3, 5, 1, 3, 2];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out[key] = counts[6 - i];
  }
  return out;
}

const DEMO_MISTAKES: Record<string, { path: string; chapter: string; title: string; count: number; lastFailedAt: number }> = {
  '01-生理学/呼吸/肺牵张反射.md': { path: '01-生理学/呼吸/肺牵张反射.md', chapter: '生理学/呼吸', title: '肺牵张反射', count: 2, lastFailedAt: Date.now() },
  '02-生化/代谢/三羧酸循环.md': { path: '02-生化/代谢/三羧酸循环.md', chapter: '生化/代谢', title: '三羧酸循环', count: 1, lastFailedAt: Date.now() },
};

/** 写入演示数据；返回写入的笔记数。调用方写入后调用 location.reload() 重新加载 vault。 */
export async function seedDemo(): Promise<number> {
  const db = await openDB(DB_NAME, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'path' });
    },
  });
  const mtime = Date.now();
  const tx = db.transaction('files', 'readwrite');
  for (const n of NOTES) {
    const content = build(n);
    tx.objectStore('files').put({ path: n.path, content, mtime, size: new TextEncoder().encode(content).length });
  }
  await tx.done;
  await importQbanks([DEMO_BANK]);
  saveTodos(DEMO_TODOS);
  localStorage.setItem('knowlattice-mistakes', JSON.stringify(DEMO_MISTAKES));
  importDays(demoDays());
  return NOTES.length;
}

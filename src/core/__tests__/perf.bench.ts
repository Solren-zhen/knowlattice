/**
 * 性能基线（Vitest 5 benchmark）：用 5000 篇合成笔记模拟「5227 篇量级」，量化核心路径耗时。
 *
 * 运行：npx vitest bench --run
 *（benchmark.include 默认匹配 *.bench.ts，`vitest` 普通测试不会跑到本文件。）
 *
 * 只做度量与回归对比，不设阈值断言（机器不同、CI 抖动大）；
 * 若某项出现明显病态（数量级异常）再单独排查。
 */
import { test } from 'vitest';
import { buildTree } from '../vault';
import { rebuildLinkIndex } from '../linkIndex';
import { VaultSearch } from '../searchIndex';
import { parseFrontmatter } from '../parser';
import { dueQueue, loadCards } from '../srs';
import { buildCards } from '../srsCards';
import { chapterHeat, loadMistakes, type MistakeMap } from '../mistakes';

const N = 5000;
const MISTAKES = 3000;

const SUBJECTS = ['01-生理学', '02-生物化学', '03-病理学', '04-药理学', '05-内科学', '06-外科学', '07-解剖学', '08-诊断学'];
const CHAPTERS = ['循环', '呼吸', '消化', '神经', '泌尿', '血液', '内分泌', '运动'];

const paths: string[] = [];
const docs = new Map<string, string>();
const raws: string[] = [];

for (let i = 0; i < N; i++) {
  const subject = SUBJECTS[i % SUBJECTS.length];
  const chapter = CHAPTERS[i % CHAPTERS.length];
  const title = `知识点${i}`;
  const path = `${subject}/${chapter}/${title}.md`;
  const raw =
    `---\naliases: [别名${i}]\ntags: [${chapter}, 考点]\nchapter: ${subject}/${chapter}\n` +
    `source: 讲义 P${i % 400}\ncreated: 2025-01-01\n---\n\n# ${title}\n\n` +
    `- 定义: 这是第 ${i} 个知识点的定义，涉及${chapter}系统的生理与病理机制说明文本。\n` +
    `- 机制:\n\t- 第一环节：感受器激活\n\t- 第二环节：信号转导通路\n` +
    `- 鉴别: [[知识点${(i + 1) % N}]] vs [[知识点${(i * 7 + 3) % N}]]\n` +
    `- 口诀: 甲乙丙丁\n- 我的理解: 个人批注内容若干。\n`;
  docs.set(path, raw);
  paths.push(path);
  raws.push(raw);
}

// 预置 localStorage 数据（srs / mistakes 走 localStorage，模块级缓存惰性读取）
const now = Date.now();
const cards: Record<string, unknown> = {};
paths.forEach((p, i) => {
  cards[p] = {
    due: new Date(now - (i % 100) * 86_400_000).toISOString(),
    reps: 3,
    stability: 2.5,
    difficulty: 5.1,
    state: 2,
    elapsed_days: 1,
    scheduled_days: 2,
    lapses: 0,
    learning_steps: 0,
    last_review: new Date(now - 86_400_000).toISOString(),
  };
});
localStorage.setItem('knowlattice-srs', JSON.stringify(cards));

const mistakes: MistakeMap = {};
for (let i = 0; i < MISTAKES; i++) {
  const p = paths[i % paths.length];
  mistakes[`${p}#${i}`] = {
    path: p,
    chapter: CHAPTERS[i % CHAPTERS.length],
    title: `错题${i}`,
    count: (i % 5) + 1,
    lastFailedAt: now - i * 1000,
  };
}
localStorage.setItem('knowlattice-mistakes', JSON.stringify(mistakes));

// 预热模块级缓存，避免把「首次 JSON.parse 全库」算进每次迭代
loadCards();
const mistakesLoaded = loadMistakes();
// 建卡（一篇一卡 → 按小节切）本身也要测：全库建卡是复习面板打开时的一次性开销
const benchCards = buildCards(paths, docs);

test('全库建卡 buildCards', async ({ bench }) => {
  await bench(`buildCards @${N}`, () => buildCards(paths, docs)).run();
});

test('目录树 buildTree', async ({ bench }) => {
  await bench(`buildTree @${N}`, () => buildTree(paths)).run();
});

test('双链索引 rebuildLinkIndex', async ({ bench }) => {
  await bench(`rebuildLinkIndex @${N}`, () => rebuildLinkIndex(docs)).run();
});

test('frontmatter 解析（未走缓存）', async ({ bench }) => {
  await bench(`parseFrontmatter ×${N}`, () => {
    for (let i = 0; i < raws.length; i++) parseFrontmatter(raws[i]);
  }).run();
});

test('复习到期队列 dueQueue', async ({ bench }) => {
  await bench(`dueQueue @${benchCards.length}`, () => dueQueue(benchCards, now)).run();
});

test('错题章节热力 chapterHeat', async ({ bench }) => {
  await bench(`chapterHeat @${MISTAKES}`, () => chapterHeat(mistakesLoaded)).run();
});

test('全文检索：已建索引单次查询', { timeout: 300_000 }, async ({ bench }) => {
  const s = new VaultSearch();
  s.sync(docs);
  await s.warm();
  await bench(`search 单次查询（索引就绪）@${N}`, () => s.search('知识点1234')).run();
});

test('全文检索：全量构建 sync + warm', { timeout: 300_000 }, async ({ bench }) => {
  // 构建是重操作：run 选项固定只跑 1 次（关闭 warmup），避免反复迭代拖满测试超时
  await bench(`sync + warm 全量构建 @${N}`, async () => {
    const s = new VaultSearch();
    s.sync(docs);
    await s.warm();
  }).run({ iterations: 1, warmupIterations: 0, warmupTime: 0 });
});

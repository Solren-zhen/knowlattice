// @vitest-environment node
/**
 * 题库导入失败时，报错必须说人话。
 *
 * 起因（真实反馈）：拿「笔记备份」文件去「题库练习 → 导入题库文件」导入，
 * 屏幕上只有「导入失败：题库格式：JSON 数组，或含 questions 数组的对象」——
 * 用户不知道下一步该点哪里。备份文件名叫「…题库.json」，而入口叫「题库练习」，
 * 这个坑迟早会有人踩，所以报错要自己指路，而不是只说格式不对。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { addBank, parseQbankJson } from '../qbank';

const repo = new URL('../../../', import.meta.url);
const backupPath = new URL('knowlattice-导入-绿皮书题库.json', repo);
const bankDir = new URL('knowlattice-题库/', repo);
const haveBackup = existsSync(backupPath);
const haveBanks = existsSync(bankDir) && readdirSync(bankDir).some((f) => f.endsWith('.json'));

/** 抓一次错误信息，便于对多处措辞做断言 */
function catchMessage(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

describe('题库导入：失败也要指路', () => {
  it('笔记备份文件 → 明确告知走「数据管理 → 导入备份」', () => {
    const backup = {
      app: 'knowlattice',
      version: 5,
      exportedAt: '2026-09-21T00:00:00.000Z',
      files: [{ path: '题库/绿皮书/病理生理学/1.md', content: '正文' }],
    };
    const msg = catchMessage(() => parseQbankJson(JSON.stringify(backup), '绿皮书'));
    expect(msg).toMatch(/笔记备份/);
    expect(msg).toMatch(/数据管理 → 导入备份/);
    expect(msg).toMatch(/questions/);
  });

  it('既不是题库也不是备份的 JSON → 说清题库该长什么样', () => {
    expect(catchMessage(() => parseQbankJson('{"foo":1}', 'x'))).toMatch(/题库格式/);
  });

  it('不是 JSON → 提示可能没下载完整或选错文件', () => {
    const msg = catchMessage(() => parseQbankJson('{"name":"x","questions":[{', 'x'));
    expect(msg).toMatch(/不是有效的 JSON/);
    expect(msg).toMatch(/questions/);
  });

  it('真正的题库 JSON → 解析成功并取到题库名', () => {
    const bank = { name: '内科学·呼吸', questions: [{ stem: '题', options: ['a', 'b'], answer: 0 }] };
    const { name, questions } = parseQbankJson(JSON.stringify(bank), 'fallback');
    expect(name).toBe('内科学·呼吸');
    expect(questions).toHaveLength(1);
    expect(questions[0].type).toBe('choice');
  });

  it('纯数组形式也认（用文件名兜底当题库名）', () => {
    const { name, questions } = parseQbankJson(JSON.stringify([{ stem: '题', answer: '答案' }]), '我的题库');
    expect(name).toBe('我的题库');
    expect(questions[0].type).toBe('recall');
  });
});

describe('题库存不下时：不能把浏览器英文原文甩给用户', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as Record<string, unknown>).localStorage;
  });

  it('配额写满 → 中文说明 + 两条出路', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => '[]',
        setItem: () => {
          throw new Error("Failed to execute 'setItem' on 'Storage': exceeded the quota.");
        },
      },
    });
    const msg = catchMessage(() =>
      addBank('大题库', [{ id: 'q1', type: 'recall', stem: '题', options: [], answer: -1, answerText: '答' }])
    );
    expect(msg).toMatch(/题库存不下/);
    expect(msg).toMatch(/约 5 MB/);
    expect(msg).toMatch(/删掉几个/);
    expect(msg).toMatch(/数据管理 → 导入备份/);
    expect(msg).not.toMatch(/quota|Storage/); // 英文原文不该漏出去
  });
});

describe.skipIf(!haveBackup || !haveBanks)('真实文件（本机有生成物时才跑）', () => {
  it('把备份文件当题库导入 → 报「笔记备份」而不是「格式不对」', () => {
    expect(catchMessage(() => parseQbankJson(readFileSync(backupPath, 'utf8'), '绿皮书'))).toMatch(/笔记备份/);
  });

  it('knowlattice-题库/ 里的题库文件全部能解析', () => {
    const files = readdirSync(bankDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const { questions } = parseQbankJson(readFileSync(new URL(f, bankDir), 'utf8'), f);
      expect(questions.length, `${f} 应解析出题目`).toBeGreaterThan(0);
    }
  }, 120_000);
});

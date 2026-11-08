/**
 * v16 备份扩展：这些数据此前只活在 localStorage，换设备就整批消失。
 * 这里只测「导出 → 清空 → 恢复」与「只补不覆盖」两条纪律，不重复测整包文件结构。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  exportDrillBackup,
  importDrillBackup,
  loadCustomWords,
  loadDaily,
  loadRecords,
  loadSettings,
  saveCustomWords,
  saveDaily,
  saveRecords,
  type WordRecord,
} from '../wordDrill';
import { exportMastery, importMastery, loadMastery, saveMastery } from '../tutor';
import { exportDayNotes, importDayNotes, readDayNote, writeDayNote } from '../studyCalendar';
import { exportExcerpts, importExcerpts, loadExcerpts, saveExcerpts, type PdfExcerpt } from '../pdfExcerpts';
import { exportMedRef, importMedRef, loadUserSymptoms, upsertUserSymptom } from '../medRefStore';
import {
  exportAchievements,
  importAchievements,
  loadAchievements,
} from '../achievementStore';
import { exportBindings, getBindings, importBindings, saveBinding } from '../keybindings';
import { addGeneratedCards, exportGeneratedCards, importGeneratedCards, loadGeneratedCards, type GeneratedCard } from '../generatedCards';
import { exportStudyLog, importStudyLog, loadStudyLog, recordQuiz, recordReview } from '../studyLog';
import type { Achievement } from '../achievementSystem';

const record = (en: string, wrong = 0): WordRecord => ({
  en,
  right: 1,
  wrong,
  reps: 1,
  due: 0,
  mastered: false,
  stability: 1,
  difficulty: 5,
  lastReview: 0,
  lapses: 0,
});

const achievement = (id: string, unlockedAt = 1): Achievement => ({
  id,
  name: id,
  description: id,
  type: 'milestone',
  tier: 1,
  icon: '🏅',
  requirement: '',
  unlocked: true,
  unlockedAt,
});

const excerpt = (id: string, text: string): PdfExcerpt => ({
  id,
  ts: 1,
  text,
  page: 1,
  file: 'a.pdf',
  title: text,
  body: text,
  chapter: '',
  source: '',
});

beforeEach(() => {
  localStorage.clear();
});

describe('单词工坊备份', () => {
  it('记录 / 词库 / 每日统计导出后能恢复，且本机已有条目优先', () => {
    saveRecords({ apple: record('apple', 1) });
    saveCustomWords([{ en: 'apple', zh: '苹果' }]);
    saveDaily({ '2026-11-01': { newWords: 3, reviews: 2, correct: 4, total: 5 } });

    const backup = exportDrillBackup();
    localStorage.clear();

    const merged = importDrillBackup({
      ...backup,
      // 备份里还有一个本机没有的香蕉
      customBank: [...backup.customBank, { en: 'banana', zh: '香蕉' }],
    });

    expect(merged.added).toBeGreaterThan(0);
    expect(loadRecords().apple.wrong).toBe(1);
    expect(loadCustomWords().map((w) => w.en)).toContain('banana');
    expect(loadDaily()['2026-11-01'].newWords).toBe(3);
  });

  it('设置只在本机仍是默认值时采用备份', () => {
    const first = importDrillBackup({ settings: { ...DEFAULT_SETTINGS, mode: 'recall', size: 20 } });
    expect(first.added).toBe(1);
    expect(loadSettings().mode).toBe('recall');

    const second = importDrillBackup({ settings: { ...DEFAULT_SETTINGS, mode: 'copy', size: 30 } });
    expect(second.added).toBe(0);
    expect(loadSettings().mode).toBe('recall');
  });
});

describe('导师掌握度 / 每日小结 / PDF 摘录', () => {
  it('同一主题保留本机判定，只补新主题', () => {
    saveMastery({ 心血管: { level: 3, evidence: '本机', attempts: 2, updatedAt: 10 } });
    const merged = importMastery({
      心血管: { level: 1, evidence: '备份', attempts: 1, updatedAt: 1 },
      呼吸: { level: 2, evidence: '备份', attempts: 1, updatedAt: 1 },
    });
    expect(merged).toEqual({ added: 1, kept: 1 });
    expect(loadMastery().心血管.level).toBe(3);
    expect(loadMastery().呼吸.level).toBe(2);
    expect(exportMastery().心血管.evidence).toBe('本机');
  });

  it('每日小结按日期只补不覆盖', () => {
    writeDayNote('2026-11-01', '本机小结');
    const merged = importDayNotes({ '2026-11-01': '备份小结', '2026-11-02': '补进来的' });
    expect(merged).toEqual({ added: 1, kept: 1 });
    expect(readDayNote('2026-11-01')).toBe('本机小结');
    expect(readDayNote('2026-11-02')).toBe('补进来的');
    expect(Object.keys(exportDayNotes())).toHaveLength(2);
  });

  it('PDF 摘录按 id 去重', () => {
    saveExcerpts([excerpt('e1', '本地')]);
    const merged = importExcerpts([excerpt('e1', '备份'), excerpt('e2', '新增')]);
    expect(merged).toEqual({ added: 1, kept: 1 });
    expect(loadExcerpts().map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(loadExcerpts()[0].text).toBe('本地');
    expect(exportExcerpts()).toHaveLength(2);
  });
});

describe('医学速查 / 成就 / 快捷键', () => {
  it('速查条目按名称与书+名称合并', () => {
    upsertUserSymptom({ name: '眩晕', cat: '神经', diseases: ['本机病'] });
    const merged = importMedRef({
      symptoms: [
        { name: '眩晕', cat: '神经', diseases: ['备份病'] },
        { name: '耳鸣', cat: '耳鼻喉', diseases: ['备份病'] },
      ],
      mnemonics: [],
      hiddenSymptoms: ['眩晕'],
      hiddenMnemonics: [],
    });
    expect(merged.added).toBe(2); // 耳鸣 + 隐藏项
    expect(merged.kept).toBe(1);
    const symptoms = loadUserSymptoms();
    expect(symptoms.find((s) => s.name === '眩晕')?.diseases).toEqual(['本机病']);
    expect(symptoms.map((s) => s.name)).toContain('耳鸣');
    expect(exportMedRef().hiddenSymptoms).toContain('眩晕');
  });

  it('成就按 id 合并，本机解锁时间不被旧备份覆盖', () => {
    // importAchievements 只写存储；先用一次导入建立本机记录
    importAchievements([achievement('a', 100)]);
    const merged = importAchievements([achievement('a', 1), achievement('b', 1)]);
    expect(merged).toEqual({ added: 1, kept: 1 });
    expect(loadAchievements().find((a) => a.id === 'a')?.unlockedAt).toBe(100);
    expect(exportAchievements()).toHaveLength(2);
  });

  it('快捷键只补本机没有的键', () => {
    saveBinding('save', 'Mod+Shift+S');
    const merged = importBindings({ save: 'Mod+Alt+S', print: 'Mod+Alt+P' });
    expect(merged).toEqual({ added: 1, kept: 1 });
    expect(getBindings().save).toBe('Mod+Shift+S');
    expect(getBindings().print).toBe('Mod+Alt+P');
    expect(exportBindings().print).toBe('Mod+Alt+P');
  });

  it('错题复习卡按卡片键去重，导出后可恢复', () => {
    const card: GeneratedCard = {
      key: 'qbank:q1',
      path: '',
      noteTitle: '生理学',
      heading: '氧解离曲线右移的意义',
      body: '答案',
      hints: [],
      source: 'mistake',
      questionId: 'q1',
      createdAt: 1,
    };
    expect(addGeneratedCards([card])).toBe(1);
    expect(addGeneratedCards([card])).toBe(0);
    const merged = importGeneratedCards([card, { ...card, key: 'qbank:q2' }]);
    expect(merged).toEqual({ added: 1, kept: 1 });
    expect(loadGeneratedCards().map((c) => c.key)).toEqual(['qbank:q1', 'qbank:q2']);
    expect(exportGeneratedCards()).toHaveLength(2);
  });

  it('学习流水按天累加，跨备份只取较大值', () => {
    recordReview('good');
    recordReview('again');
    recordQuiz(true, true);
    const today = Object.keys(loadStudyLog())[0];
    const current = loadStudyLog()[today];
    expect(current.reviews).toBe(2);
    expect(current.reviewGood).toBe(1);
    expect(current.quizzes).toBe(1);
    expect(current.fixed).toBe(1);

    // 重复导入同一份备份：不累加
    importStudyLog(exportStudyLog());
    expect(loadStudyLog()[today].reviews).toBe(2);
    // 备份里更大的值可以补齐（例如换设备后恢复）
    importStudyLog({ [today]: { reviews: 5, reviewGood: 4, quizzes: 2, quizCorrect: 2, fixed: 1 } });
    expect(loadStudyLog()[today].reviews).toBe(5);
  });
});

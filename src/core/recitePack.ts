/**
 * 桌面 → 手机的背诵包（knowlattice.recite/1）。
 *
 * 手机端 `parsePack` 同时接受扁平短文和 StoryArchiveEntry 的嵌套结构；
 * 这里显式输出扁平字段，避免把桌面记录里的 `WeakWord.record` 等大对象带过去。
 * 复习事件从手机端回传，桌面暂不生成事件，所以 baseline 为空。
 */
import type { StoryArchiveEntry } from './wordStory';

export interface RecitePackStory {
  id: string;
  createdAt: number;
  bankName: string;
  title: string;
  titleZh: string;
  sentences: Array<{ en: string; zh: string }>;
  targets: Array<{ en: string; zh: string }>;
  used: Array<{ word: string; form: string }>;
  analysis?: unknown;
}

export function buildRecitePack(entries: readonly StoryArchiveEntry[], now = Date.now()): string {
  const stories: RecitePackStory[] = entries.map((entry) => {
    const targets = entry.words.length
      ? entry.words.map((pick) => ({ en: pick.word.en, zh: pick.word.zh }))
      : (entry.story.used ?? []).map((use) => ({ en: use.word, zh: '' }));
    return {
      id: entry.id,
      createdAt: entry.createdAt,
      bankName: entry.bankName,
      title: entry.story.title,
      titleZh: entry.story.titleZh,
      sentences: entry.story.sentences.map((sentence) => ({ en: sentence.en, zh: sentence.zh })),
      targets,
      used: (entry.story.used ?? []).map((use) => ({ word: use.word, form: use.form })),
      ...(entry.analysis ? { analysis: entry.analysis } : {}),
    };
  });

  return JSON.stringify({
    schema: 'knowlattice.recite/1',
    packId: `desktop-${now.toString(36)}`,
    exportedAt: new Date(now).toISOString(),
    stories,
    baseline: { at: 0, records: {} },
    events: [],
  });
}

/**
 * 知识点录音：形状识别 / 解析 / 合并 / 搜索 / 当前句定位。
 *
 * 为什么这些点值得钉：录音乐谱是「点了没反应」的高发区——字幕 cue 的键名在导出侧是
 * 压缩过的 s/e/t，而界面按秒定位；一旦某处按 start/end 读，字幕会静默全空（面板看起来正常，
 * 只是一句都不高亮）。
 */
import { describe, expect, it } from 'vitest';
import {
  activeCueIndex,
  cuesOf,
  loadKnowledgeAudio,
  looksLikeKnowledgeTopics,
  parseKnowledgeTopics,
  searchKnowledgeAudio,
  saveKnowledgeAudio,
  KNOWLEDGE_AUDIO_KEY,
} from '../knowledgeAudio';

const topic = (over: Record<string, unknown> = {}) => ({
  topicId: 't1',
  name: '机体的内环境',
  path: ['生理学', '第一章 绪论'],
  minutes: 40,
  audio: 'https://cdn.example/a.mp3',
  srt: [
    { s: 0.07, e: 1.2, t: '内环境' },
    { s: 1.53, e: 3.53, t: '细胞外液' },
  ],
  ...over,
});

describe('looksLikeKnowledgeTopics', () => {
  it('认得出带 audio 的知识点清单', () => {
    expect(looksLikeKnowledgeTopics([topic()])).toBe(true);
  });

  it('只有字幕也算（有录音没字幕的课程反过来也一样要能进）', () => {
    expect(looksLikeKnowledgeTopics([topic({ audio: '' })])).toBe(true);
  });

  it('题库数组/题目数组不误判', () => {
    expect(looksLikeKnowledgeTopics([{ stem: '题干', options: ['甲', '乙'] }])).toBe(false);
    expect(looksLikeKnowledgeTopics([])).toBe(false);
    expect(looksLikeKnowledgeTopics({ topics: [] })).toBe(false);
  });
});

describe('parseKnowledgeTopics', () => {
  it('压缩键 s/e/t 与完整键 start/end/text 都收，并按时间排序', () => {
    const [k] = parseKnowledgeTopics([
      topic({
        srt: [
          { start: 5, end: 6, text: '第二句' },
          { s: 1, e: 2, t: '第一句' },
        ],
      }),
    ]);
    expect(k.cues.map((c) => c.t)).toEqual(['第一句', '第二句']);
    expect(k.cues[0]).toEqual({ s: 1, e: 2, t: '第一句' });
  });

  it('没有音频也没有字幕的条目丢掉（点开只能看个名字）', () => {
    expect(parseKnowledgeTopics([topic({ audio: '', srt: [] })])).toEqual([]);
  });

  it('缺名与倒挂的时间轴都跳过', () => {
    const list = parseKnowledgeTopics([
      topic({ topicId: 'a', name: '  ' }),
      // 有录音就该留下（字幕坏了不影响听），所以这条要同时清掉 audio 才该被丢掉
      topic({ topicId: 'b', audio: '', srt: [{ s: 9, e: 3, t: '倒挂' }] }),
    ]);
    expect(list).toHaveLength(0);
  });

  it('cuesOf 转成 subtitle.ts 的 Cue 形状', () => {
    const [k] = parseKnowledgeTopics([topic()]);
    expect(cuesOf(k)[1]).toEqual({ start: 1.53, end: 3.53, text: '细胞外液' });
  });
});

describe('存取与搜索', () => {
  it('重导同一条知识点只覆盖不重复', () => {
    localStorage.clear();
    expect(saveKnowledgeAudio(parseKnowledgeTopics([topic()])).added).toBe(1);
    const again = saveKnowledgeAudio(parseKnowledgeTopics([topic({ minutes: 55 })]));
    expect(again.added).toBe(0);
    expect(again.total).toBe(1);
    expect(loadKnowledgeAudio()[0].minutes).toBe(55);
  });

  it('坏数据当作没有，开发环境不炸', () => {
    localStorage.setItem(KNOWLEDGE_AUDIO_KEY, '{oops');
    expect(loadKnowledgeAudio()).toEqual([]);
  });

  it('按知识点名、路径、字幕正文都能搜到，前缀命中排前面', () => {
    const list = parseKnowledgeTopics([
      topic({ topicId: 'a', name: '内环境稳态' }),
      // b 必须有自己的一段字幕：默认 fixture 的字幕里就有「内环境」，否则它也会命中
      topic({ topicId: 'b', name: '血液凝固', path: ['生理学', '第三章 血液'], srt: [{ s: 0, e: 1, t: '凝血因子' }] }),
      topic({ topicId: 'c', name: '胃的运动', srt: [{ s: 0, e: 1, t: '内环境相关的反射' }] }),
    ]);
    expect(searchKnowledgeAudio(list, '').length).toBe(3);
    const hit = searchKnowledgeAudio(list, '内环境');
    expect(hit.map((k) => k.id)).toEqual(['a', 'c']); // 前缀命中的 a 在前，字幕命中的 c 在后
    expect(searchKnowledgeAudio(list, '血液').map((k) => k.id)).toEqual(['b']);
    expect(searchKnowledgeAudio(list, '找不到的词')).toEqual([]);
  });
});

describe('activeCueIndex', () => {
  const cues = [
    { s: 0, e: 2, t: 'a' },
    { s: 2, e: 4, t: 'b' },
    { s: 10, e: 12, t: 'c' },
  ];

  it('落在句内返回该句，落在句间断档返回 -1', () => {
    expect(activeCueIndex(cues, 0)).toBe(0);
    expect(activeCueIndex(cues, 1.9)).toBe(0);
    expect(activeCueIndex(cues, 2)).toBe(1);
    expect(activeCueIndex(cues, 7)).toBe(-1);
    expect(activeCueIndex(cues, 11)).toBe(2);
  });

  it('空字幕不抛', () => {
    expect(activeCueIndex([], 3)).toBe(-1);
  });
});

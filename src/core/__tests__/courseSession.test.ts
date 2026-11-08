// @vitest-environment node
/**
 * 课程会话是内存缓存：关掉工坊去看视频再回来，课程/分P/生成结果要还在。
 * 唯一需要守的是「关面板时正在跑的请求不会在重开后假装还在跑」。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadWorkshopSession,
  resetWorkshopSessionForTests,
  saveWorkshopSession,
  type CourseState,
  type PartRow,
} from '../courseSession';

const row: PartRow = {
  page: 1,
  cid: 11,
  part: '总论',
  duration: 100,
  picked: true,
  phase: 'probing',
  notePhase: 'running',
  digestPhase: 'running',
};

const course: CourseState = {
  view: {
    bvid: 'BV1xx411c7mD',
    title: '测试课程',
    duration: 100,
    cid: 1,
    parts: [{ page: 1, cid: 11, part: '总论', duration: 100 }],
  },
  rows: [row],
};

beforeEach(() => resetWorkshopSessionForTests());

describe('课程工坊会话', () => {
  it('没有会话时返回 null', () => {
    expect(loadWorkshopSession()).toBeNull();
  });

  it('保存后能读回；running / probing 落回 idle', () => {
    saveWorkshopSession({
      input: 'BV1xx411c7mD',
      course,
      noteTitle: '测试课程',
      mode: 'essence',
      essence: '精华',
      persona: '',
      personaName: '讲师',
      materialUrl: 'https://pan.baidu.com/s/1abc',
    });
    const restored = loadWorkshopSession();
    expect(restored?.input).toBe('BV1xx411c7mD');
    expect(restored?.noteTitle).toBe('测试课程');
    expect(restored?.essence).toBe('精华');
    expect(restored?.materialUrl).toBe('https://pan.baidu.com/s/1abc');
    expect(restored?.course?.rows[0]).toMatchObject({
      phase: 'idle',
      notePhase: 'idle',
      digestPhase: 'idle',
    });
  });
});

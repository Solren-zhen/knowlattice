/**
 * 课程工坊的「本次会话」缓存。
 *
 * 课程工坊是整屏面板，关闭即卸载；而「播放本节」需要先关掉工坊、去视频笔记里看。
 * 没有这层缓存，看完回来课程、分P、已生成讲义全没了，联动就变成“点一次重来一次”。
 *
 * 只放在内存里（模块级）：转录和生成结果可能很大，不进 localStorage；
 * 跨重启要恢复的是课程笔记本身（frontmatter 的 source + bvid），不是这份临时状态。
 */
import type { BiliView } from './biliPlay';
import type { NoteMode } from './courseNotes';

export type PartPhase = 'idle' | 'probing' | 'ready' | 'empty' | 'error';
export type NotePhase = 'idle' | 'running' | 'done' | 'error';

export interface PartRow {
  page: number;
  cid: number;
  part: string;
  duration: number;
  picked: boolean;
  phase: PartPhase;
  lan?: string;
  chars?: number;
  transcript?: string;
  error?: string;
  note?: string;
  notePhase: NotePhase;
  /** 精华模式的第一级压缩结果（逐P要点） */
  digest?: string;
  digestPhase: 'idle' | 'running' | 'done' | 'error';
  noteError?: string;
}

export interface CourseState {
  view: BiliView;
  rows: PartRow[];
}

export interface WorkshopSession {
  input: string;
  course: CourseState | null;
  noteTitle: string;
  mode: NoteMode;
  essence: string;
  persona: string;
  personaName: string;
  /** 整门课的网盘 / 资料链接（只记录与打开，不抓取） */
  materialUrl: string;
  /** 仅供调试/判断新鲜度，不参与业务逻辑 */
  savedAt: number;
}

let session: WorkshopSession | null = null;

/**
 * 关面板时可能正卡在「抓字幕 / 生成中」：重新挂载后没有对应的请求了，
 * 这些 phase 必须落回 idle，否则界面会永远显示「抓取中… / 生成中」。
 */
function sanitizeCourse(course: CourseState | null): CourseState | null {
  if (!course) return null;
  return {
    ...course,
    rows: course.rows.map((row) => ({
      ...row,
      phase: row.phase === 'probing' ? 'idle' : row.phase,
      notePhase: row.notePhase === 'running' ? 'idle' : row.notePhase,
      digestPhase: row.digestPhase === 'running' ? 'idle' : row.digestPhase,
    })),
  };
}

export function loadWorkshopSession(): WorkshopSession | null {
  if (!session) return null;
  return { ...session, course: sanitizeCourse(session.course) };
}

export function saveWorkshopSession(next: Omit<WorkshopSession, 'savedAt'>): void {
  session = { ...next, savedAt: Date.now() };
}

/** 仅供测试：清掉模块级缓存，避免用例之间互相串 */
export function resetWorkshopSessionForTests(): void {
  session = null;
}

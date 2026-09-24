/**
 * 题库练习：导入 JSON 题库（文件或粘贴）→ 选库组卷 → 逐题作答 → 结果页错题回顾。
 * 答错且题目关联笔记（note 字段可解析）时自动记入错题本。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import DialogSurface from './DialogSurface';
import { useEsc } from './useEsc';
import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import {
  addBank, loadBanks, parseQbankJson, pickQuestions, removeBank, setOptionNote,
  parseQuestionsFromText, rowsToQuestions,
  type QuizBank, type QuizQuestion,
} from '../core/qbank';
import {
  DEFAULT_RULES, chapterCounts, composeQuestions, filterPool,
  type ComposeOrder, type ComposeRules, type ComposeScope,
} from '../core/qbankCompose';
import { bankProgress, consumeSaveFailure, initializeStats, loadStats, recordAnswer } from '../core/qbankStats';
import { buildChapterIndex, questionNoteLabel, resolveQuestionNote } from '../core/qbankNotes';
import { recordMistake } from '../core/mistakes';
import { toast, confirmBox } from '../core/feedback';
import { markStudy } from '../core/stats';
import { bankToAnki, downloadFile } from '../core/anki';
import { IconRestore, IconClose, IconHelp, IconPencil } from './icons';

interface Props {
  docs: Map<string, string>;
  resolveLink: (name: string) => string | null;
  /** 打开关联笔记（同时关闭本面板） */
  onOpenPath: (path: string) => void;
  onClose: () => void;
}

/** rules 为 null = 不组题，整库洗牌（「全部」入口）；非 null 时「再练一轮」沿用同一套规则 */
type Session = { bankName: string; questions: QuizQuestion[]; rules: ComposeRules | null };

const HELP_TEXT = `[
  {
    "stem": "氧解离曲线右移的意义是？",
    "options": ["Hb 容易放氧", "Hb 容易结合氧", "亲和力增大", "P50 减小"],
    "answer": 0,
    "explanation": "右移 = 亲和力下降，P50 增大，利于向组织放氧。",
    "chapter": "生理学",
    "note": "氧解离曲线"
  }
]
字段中文名（题干/选项/答案/解析/章节/笔记）同样支持；
options 缺省即为简答题，显示答案后自行判定对错。
optionNotes 逐选项批注，下标对齐 options，可写可不写（应用里作答后点选项右侧的铅笔即可添加）。

· JSON 文件：数组，或 {"name":"题库名","questions":[…]}
· Word(.docx)：直接导入，自动抽取文本并按「1.题干 → A.选项 → 答案：A」识别
· Excel/CSV：表头含「题干/答案」，选项列用 A/B/C/D 或 选项1..4
· 识别不到时会把原文填入输入框，手动整理后再粘贴导入
· 整库备份（笔记）在这里不认：请走「笔记树右上角 ⋯ → 从备份 .json 恢复」；这里只吃上面的题库格式
· 题库与逐题复习记录保存在浏览器 IndexedDB；首次打开会自动迁移旧数据`;

export default function QuizView({ docs, resolveLink, onOpenPath, onClose }: Props) {
  const [banks, setBanks] = useState<QuizBank[]>([]);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [idx, setIdx] = useState(0);
  /** 每题作答结果：true 对 / false 错 / undefined 未答 */
  const [results, setResults] = useState<(boolean | undefined)[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  /** 正在写批注的选项下标（null = 没在写）与草稿文本 */
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const docxRef = useRef<HTMLInputElement>(null);
  const xlsxRef = useRef<HTMLInputElement>(null);
  /** 组题弹窗正在给哪个题库出题（null = 没开） */
  const [composing, setComposing] = useState<QuizBank | null>(null);
  const [rules, setRules] = useState<ComposeRules>(DEFAULT_RULES);
  const [stats, setStats] = useState(loadStats);

  useEffect(() => {
    let active = true;
    Promise.all([loadBanks(), initializeStats()]).then(([loadedBanks, loadedStats]) => {
      if (!active) return;
      setBanks(loadedBanks);
      if (loadedBanks.length === 0) setImportOpen(true);
      setStats(loadedStats);
      setLoadError(null);
      setReady(true);
    }).catch((error: unknown) => {
      if (!active) return;
      setLoadError(error instanceof Error ? error.message : String(error));
      setReady(true);
    });
    return () => { active = false; };
  }, [reloadKey]);

  /** 题库列表上的进度行。按 banks/stats 缓存——127 个库 × 上千题，
   *  每次渲染都重算会把题库面板拖垮。 */
  const progress = useMemo(() => {
    const m = new Map<string, ReturnType<typeof bankProgress>>();
    for (const b of banks) m.set(b.name, bankProgress(b.name, b.questions.map((x) => x.id), stats));
    return m;
  }, [banks, stats]);

  /** 题库笔记索引：题库题目的 chapter 是「学科·章节」，题库笔记路径是
   *  「题库/<源>/<学科>/<章节>.md」，两边精确对应（详见 core/qbankNotes.ts）。 */
  const chapterIndex = useMemo(() => buildChapterIndex(docs.keys()), [docs]);

  /** 这道题关联哪篇笔记：note 字段与 chapter 反查都试，都没有就 null。
   *  必须先试 chapter——转换器产出的题库 note 字段是空的（111,548 题全空），
   *  只看 note 会让「答错进错题本」静默失效。 */
  const notePathOf = (question: QuizQuestion) =>
    resolveQuestionNote(question, resolveLink, chapterIndex, (p) => docs.has(p));

  // Exit policy: a practice run in progress must not be lost to a stray click.
  const inProgress = Boolean(session) && results.some((r) => r === true || r === false);
  const requestClose = () => {
    if (inProgress === false) { onClose(); return; }
    void confirmBox({
      title: '练习题还没做完，确定退出？',
      detail: '已作答的记录不会保存',
      okText: '退出',
      danger: true,
    }).then((ok) => { if (ok) onClose(); });
  };

  // Esc 快捷关闭（走全局 Esc 栈）。批注输入框里的 Esc 只退出编辑、不关整个面板：
  // 这里仍按**事件目标**判断（而不是当前焦点）——输入框自己的 onKeyDown 会先退出编辑，
  // 那时焦点已经不在输入框上了，看焦点就会误判成「该关面板」。
  useEsc((e) => {
    if ((e.target as HTMLElement | null)?.dataset?.noteInput) return;
    requestClose();
  });

  const q = session?.questions[idx];
  const correctCount = results.filter((r) => r === true).length;

  // ---------- 导入 ----------
  const importQuestions = async (questions: QuizQuestion[], name: string) => {
    setBanks(await addBank(name, questions));
    setPasteText('');
    setImportOpen(false);
    toast(`已导入「${name}」：${questions.length} 题`, 'ok');
  };
  const doImport = async (text: string, fallbackName: string) => {
    try {
      // 解析与报错都在 core（parseQbankJson）：这条提示是用户唯一的线索，必须可测。
      const { name, questions } = parseQbankJson(text, fallbackName);
      await importQuestions(questions, name);
    } catch (err) {
      toast(`导入失败：${(err as Error).message}`, 'err', 8000);
    }
  };
  const onFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => doImport(reader.result as string, file.name.replace(/\.json$/i, ''));
    reader.readAsText(file);
  };

  /** Word(.docx)：mammoth 抽文本 → 启发式识别题目；识别不到则把原文填入输入框供整理 */
  const onDocx = async (file: File) => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const { value } = await mammoth.extractRawText({ arrayBuffer });
      const questions = parseQuestionsFromText(value);
      if (questions.length === 0) {
        setPasteText(value.trim());
        setImportOpen(true);
        toast('未能从 Word 中自动识别出题目。文档全文已填入下方输入框，请按「题目/选项/答案」格式整理后导入。', 'info', 6500);
        return;
      }
      await importQuestions(questions, file.name.replace(/\.docx?$/i, ''));
    } catch (err) {
      toast(`Word 导入失败：${(err as Error).message}（仅支持 .docx，旧版 .doc 请先转存为 .docx）`, 'err');
    }
  };

  /** Excel/CSV：SheetJS 读表 → 表头映射为题目 */
  const onXlsx = async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
      const questions = rowsToQuestions(rows);
      await importQuestions(questions, file.name.replace(/\.(xlsx?|csv)$/i, ''));
    } catch (err) {
      toast(`Excel 导入失败：${(err as Error).message}（表头需含「题干/答案」，选项列可用 A/B/C/D 或 选项1..4）`, 'err');
    }
  };

  // ---------- 练习 ----------
  /** 开一轮练习。rules 为 null 时按旧行为整库洗牌（「全部」入口） */
  const start = (bank: QuizBank, rules: ComposeRules | null) => {
    const qs = rules ? composeQuestions(bank, rules, loadStats()) : pickQuestions(bank);
    setSession({ bankName: bank.name, questions: qs, rules });
    setIdx(0);
    setResults(new Array(qs.length).fill(undefined));
    setPicked(null);
    setRevealed(false);
    setEditing(null);
  };

  /** 答错且关联笔记存在 → 记入错题本；同时对每道题记一次逐题历史（错题加权与 FSRS 排程的数据源） */
  const judge = async (correct: boolean) => {
    if (!q) return;
    markStudy(); // 打卡
    setResults((prev) => prev.map((r, i) => (i === idx ? correct : r)));
    await recordAnswer(session!.bankName, q.id, correct);
    setStats(loadStats());
    // 持久化失败时记录只在内存里活着，本轮结束就没了——必须告知用户
    if (consumeSaveFailure()) {
      toast('逐题记录保存失败：请检查浏览器存储空间和权限。', 'err', 9000);
    }
    if (!correct) {
      const path = notePathOf(q);
      const content = path ? docs.get(path) : undefined;
      // content 必须存在：错题本要拿原文提章节与标题（core/mistakes.ts）
      if (path && content !== undefined) recordMistake(path, content);
    }
  };

  const next = () => {
    setPicked(null);
    setRevealed(false);
    setEditing(null);
    setIdx((i) => i + 1);
  };

  // ---------- 选项批注（作答后） ----------
  /** 打开某选项的批注输入框，草稿取该选项已有的批注 */
  const beginNote = (i: number) => {
    setDraft(q?.optionNotes?.[i] ?? '');
    setEditing(i);
  };

  /** 存批注：空文本即删除。写完要把面板里的题库列表和本轮题目一起刷新，
   *  否则同一题再进来读到的还是旧副本。 */
  const commitNote = async (i: number) => {
    setEditing(null);
    if (!q || !session) return;
    if ((q.optionNotes?.[i] ?? '') === draft.trim()) return;
    const banks = await setOptionNote(session.bankName, q.id, i, draft);
    setBanks(banks);
    const saved = banks.find((b) => b.name === session.bankName)?.questions.find((x) => x.id === q.id);
    setSession((s) => (s
      ? { ...s, questions: s.questions.map((x) => (x.id === q.id ? { ...x, optionNotes: saved?.optionNotes } : x)) }
      : s));
  };

  // ---------- 渲染 ----------
  if (!ready || loadError) {
    return (
      <div className="panel-backdrop quiz-overlay">
        <DialogSurface className="panel quiz-panel" label={loadError ? '题库加载失败' : '题库正在加载'}>
          <div className="panel__body quiz-body">
            <p role="status">{loadError ?? '\u6b63\u5728\u52a0\u8f7d\u9898\u5e93...'}</p>
            {loadError && <button className="btn-small" onClick={() => setReloadKey((key) => key + 1)}>{'\u91cd\u8bd5'}</button>}
          </div>
        </DialogSurface>
      </div>
    );
  }

  if (session && q) {
    const answered = results[idx] !== undefined;
    const notePath = notePathOf(q);
    return (
      <div className="panel-backdrop quiz-overlay" onClick={requestClose}>
        <DialogSurface className="panel quiz-panel" label={`${session.bankName}练习，第 ${idx + 1} 题`} onClick={(e) => e.stopPropagation()}>
          <div className="panel__head quiz-header">
            <span className="panel__title quiz-title">{session.bankName} · 第 {idx + 1} / {session.questions.length} 题</span>
            <span className="muted">已对 {correctCount}</span>
            <button className="btn-icon" onClick={requestClose} aria-label="关闭"><IconClose /></button>
          </div>
          <div className="quiz-progress"><i style={{ width: `${((idx + (answered ? 1 : 0)) / session.questions.length) * 100}%` }} /></div>

          <div className="panel__body quiz-body">
            {q.chapter && <span className="quiz-chapter">{q.chapter}</span>}
            <p className="quiz-stem">{q.stem}</p>

            {q.type === 'choice' ? (
              <div className="quiz-opts">
                {q.options.map((opt, i) => {
                  const isRight = i === q.answer;
                  const cls = !answered ? 'opt' : isRight ? 'opt right' : i === picked ? 'opt wrong' : 'opt';
                  const letter = String.fromCharCode(65 + i);
                  const note = q.optionNotes?.[i] ?? '';
                  return (
                    <div key={i} className="quiz-opt">
                      <button
                        className={cls}
                        disabled={answered}
                        onClick={() => {
                          setPicked(i);
                          void judge(i === q.answer);
                        }}
                      >
                        <b>{letter}</b> {opt}
                        {answered && isRight && <span className="opt-mark">✓</span>}
                        {answered && i === picked && !isRight && <span className="opt-mark">✗</span>}
                      </button>
                      {/* 批注只在答案出现后可写：先看答案再记「为什么」，避免猜着写 */}
                      {answered && (
                        <button
                          className={`btn-icon opt-note-btn${note ? ' has-note' : ''}`}
                          aria-label={note ? `修改选项 ${letter} 的批注` : `给选项 ${letter} 写批注`}
                          title={note ? '修改批注' : '给这个选项写批注'}
                          onClick={() => (editing === i ? setEditing(null) : beginNote(i))}
                        >
                          <IconPencil size={14} />
                        </button>
                      )}
                      {answered && editing === i ? (
                        <div className="opt-note-edit">
                          <textarea
                            className="opt-note-input"
                            data-note-input="1"
                            rows={2}
                            autoFocus
                            value={draft}
                            placeholder="这个选项为什么对、为什么错，写下来下次一眼看到"
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') { setEditing(null); return; }
                              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                e.preventDefault();
                                commitNote(i);
                              }
                            }}
                            onBlur={() => commitNote(i)}
                          />
                          <span className="opt-note-hint">Ctrl/⌘+Enter 保存 · Esc 取消 · 清空即删除</span>
                        </div>
                      ) : answered && note ? (
                        <div className="opt-note">
                          <span className="opt-note-icon" aria-hidden="true"><IconPencil size={12} /></span>
                          <span className="opt-note-text">{note}</span>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : revealed ? (
              <div className="quiz-answer">
                <b>参考答案</b>
                <p>{q.answerText}</p>
              </div>
            ) : (
              <button className="btn-small" onClick={() => setRevealed(true)}>显示答案</button>
            )}

            {answered && q.explanation && (
              <div className={`quiz-expl ${results[idx] ? 'is-right' : 'is-wrong'}`}>
                <b>{results[idx] ? '✓ 答对了' : '✗ 答错了'}</b>
                <p>{q.explanation}</p>
              </div>
            )}
            {q.type === 'recall' && revealed && !answered && (
              <div className="quiz-actions">
                <button className="btn-small" onClick={() => void judge(true)}>我答对了</button>
                <button className="btn-small danger" onClick={() => void judge(false)}>我答错了</button>
              </div>
            )}
          </div>

          {answered && (
            <div className="quiz-footer">
              {notePath && (
                <button className="btn-small" onClick={() => { onClose(); onOpenPath(notePath); }}>
                  打开笔记「{questionNoteLabel(q, notePath)}」
                </button>
              )}
              {idx + 1 < session.questions.length ? (
                <button className="btn-primary quiz-next" onClick={next}>下一题 →</button>
              ) : (
                <button className="btn-primary quiz-next" onClick={next}>查看成绩 →</button>
              )}
            </div>
          )}
        </DialogSurface>
      </div>
    );
  }

  // ---------- 成绩页 ----------
  if (session) {
    const total = session.questions.length;
    const wrong = session.questions.filter((_, i) => results[i] === false);
    /** 真正进了错题本的错题数（关联不到笔记的题进不去，别把话说满） */
    const wrongFiled = wrong.filter((w) => notePathOf(w)).length;
    return (
      <div className="panel-backdrop quiz-overlay" onClick={requestClose}>
        <DialogSurface className="panel quiz-panel" label={`练习成绩：${session.bankName}`} onClick={(e) => e.stopPropagation()}>
          <div className="panel__head quiz-header">
            <span className="panel__title quiz-title">练习成绩 · {session.bankName}</span>
            <button className="btn-icon" onClick={requestClose} aria-label="关闭"><IconClose /></button>
          </div>
          <div className="quiz-result">
            <div className="score">{total ? Math.round((correctCount / total) * 100) : 0}<small>分</small></div>
            <p className="muted">{correctCount} / {total} 题正确{wrong.length > 0 && (
              wrongFiled === wrong.length
                ? `，答错的 ${wrongFiled} 题已收录进错题本`
                : `，答错的 ${wrong.length} 题中 ${wrongFiled} 题已收录进错题本`
            )}</p>
            {wrong.length > 0 && (
              <div className="quiz-wrong-list">
                {wrong.map((w) => {
                  const wp = notePathOf(w);
                  return (
                    <div key={w.id} className="quiz-wrong-item">
                      <span>{w.stem}</span>
                      <i>正解：{w.answerText}</i>
                      {wp && (
                        <button className="btn-small" onClick={() => { onClose(); onOpenPath(wp); }}>
                          打开笔记
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="quiz-actions center">
              <button className="btn-primary" onClick={async () => {
                const b = (await loadBanks()).find((x) => x.name === session.bankName);
                if (b) start(b, session.rules); // 沿用同一套组题规则，不偷偷换回「全部」
              }}>再练一轮</button>
              <button className="btn-small" onClick={() => setSession(null)}>返回题库列表</button>
            </div>
          </div>
        </DialogSurface>
      </div>
    );
  }

  // ---------- 自动组题 ----------
  if (composing) {
    const b = composing;
    // 候选池与「将要抽几题」实时算给用户看：范围/章节一改就能看到还剩多少题可抽，
    // 不然「做错过 + 某章」这种组合抽不到题时，用户只会以为按钮坏了
    const pool = filterPool(b.questions, rules, stats, b.name);
    const willPick = rules.count > 0 ? Math.min(rules.count, pool.length) : pool.length;
    const chapters = chapterCounts(b.questions);
    const toggleChapter = (c: string) =>
      setRules((r) => ({
        ...r,
        chapters: r.chapters.includes(c) ? r.chapters.filter((x) => x !== c) : [...r.chapters, c],
      }));
    return (
      <div className="panel-backdrop quiz-overlay" onClick={() => setComposing(null)}>
        <DialogSurface className="panel quiz-panel" label={`自动组题：${b.name}`} onClick={(e) => e.stopPropagation()}>
          <div className="panel__head quiz-header">
            <span className="panel__title quiz-title">自动组题 · {b.name}</span>
            <button className="btn-icon" onClick={() => setComposing(null)} aria-label="关闭"><IconClose /></button>
          </div>
          <div className="panel__body quiz-body">
            <div className="compose-row">
              <span className="compose-label">题量</span>
              <div className="compose-chips">
                {[10, 20, 50, 100].map((c) => (
                  <button key={c} className={`chip${rules.count === c ? ' on' : ''}`} onClick={() => setRules((r) => ({ ...r, count: c }))}>{c}</button>
                ))}
                <button className={`chip${rules.count === 0 ? ' on' : ''}`} onClick={() => setRules((r) => ({ ...r, count: 0 }))}>全部</button>
              </div>
            </div>

            <div className="compose-row">
              <span className="compose-label">范围</span>
              <div className="compose-chips">
                {([
                  ['all', '全部题目'], ['new', '没做过'], ['wrong', '做错过'], ['due', '今日待复习'],
                ] as Array<[ComposeScope, string]>).map(([v, label]) => (
                  <button key={v} className={`chip${rules.scope === v ? ' on' : ''}`} onClick={() => setRules((r) => ({ ...r, scope: v }))}>{label}</button>
                ))}
              </div>
            </div>

            <div className="compose-row">
              <span className="compose-label">顺序</span>
              <div className="compose-chips">
                {([['shuffle', '乱序'], ['chapter', '按章节']] as Array<[ComposeOrder, string]>).map(([v, label]) => (
                  <button key={v} className={`chip${rules.order === v ? ' on' : ''}`} onClick={() => setRules((r) => ({ ...r, order: v }))}>{label}</button>
                ))}
              </div>
            </div>

            <div className="compose-row">
              <span className="compose-label">章节{rules.chapters.length > 0 && <b className="compose-picked">{rules.chapters.length}</b>}</span>
              <div className="compose-chapters">
                {chapters.map(({ chapter, count }) => (
                  <label key={chapter || '~none'} className={`compose-chapter${rules.chapters.includes(chapter) ? ' on' : ''}`}>
                    <input type="checkbox" checked={rules.chapters.includes(chapter)} onChange={() => toggleChapter(chapter)} />
                    <span className="compose-chapter-name">{chapter || '未标章节'}</span>
                    <span className="muted">{count}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="compose-chips compose-chips--end">
              <button className="chip" onClick={() => setRules((r) => ({ ...r, chapters: [] }))}>不限章节</button>
              <button className="chip" onClick={() => setRules((r) => ({ ...r, chapters: chapters.map((c) => c.chapter) }))}>全选</button>
            </div>

            <p className="muted compose-summary">
              本轮将抽 <b>{willPick}</b> 题（候选 {pool.length} 题）。答错过的题与已到期的题权重更高，会优先出现。
            </p>

            <div className="quiz-actions">
              <button className="btn-primary" disabled={willPick === 0} onClick={() => { setComposing(null); start(b, rules); }}>
                开始练习
              </button>
              <button className="btn-small" onClick={() => setRules(DEFAULT_RULES)}>恢复默认</button>
            </div>
          </div>
        </DialogSurface>
      </div>
    );
  }

  // ---------- 题库列表 ----------
  return (
    <div className="panel-backdrop quiz-overlay" onClick={requestClose}>
      <DialogSurface className="panel quiz-panel" label="题库练习" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head quiz-header">
          <span className="panel__title quiz-title">题库练习</span>
          <button className="btn-primary quiz-import-toggle" aria-expanded={importOpen} aria-controls="quiz-import-options" onClick={() => setImportOpen((open) => !open)}>
            {importOpen ? '收起导入' : '导入题库'}
          </button>
          <button className="btn-icon" onClick={() => setShowHelp(!showHelp)} aria-label="格式说明" aria-expanded={showHelp} aria-controls="quiz-format-help" title="题库 JSON 格式说明"><IconHelp /></button>
          <button className="btn-icon" onClick={requestClose} aria-label="关闭"><IconClose /></button>
        </div>

        <div className="quiz-help" id="quiz-format-help" hidden={!showHelp}>
            <p className="muted">导入格式（保存为 .json 文件导入，或直接粘贴）：</p>
            <pre>{HELP_TEXT}</pre>
        </div>

        <div className="quiz-import" id="quiz-import-options" hidden={!importOpen}>
          <button className="btn-small" onClick={() => fileRef.current?.click()}>
            <IconRestore /> 题库文件 (.json)
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
              e.target.value = '';
            }}
          />
          <button className="btn-small" onClick={() => docxRef.current?.click()} title="Word 文档：自动抽取文本并识别题目（仅支持 .docx）">
            Word (.docx)
          </button>
          <input
            ref={docxRef}
            type="file"
            accept=".docx,.doc"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onDocx(f);
              e.target.value = '';
            }}
          />
          <button className="btn-small" onClick={() => xlsxRef.current?.click()} title="Excel/CSV：表头含「题干/答案」，选项列用 A/B/C/D 或 选项1..4">
            Excel/CSV (.xlsx/.csv)
          </button>
          <input
            ref={xlsxRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onXlsx(f);
              e.target.value = '';
            }}
          />
          <span className="muted">或粘贴 JSON：</span>
          <textarea
            className="quiz-paste"
            placeholder='[{"stem": "题干", "options": ["A", "B"], "answer": 0, "note": "关联笔记名"}]'
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={3}
          />
          <button className="btn-small" disabled={!pasteText.trim()} onClick={() => doImport(pasteText, `粘贴题库 ${new Date().toLocaleDateString()}`)}>
            粘贴导入
          </button>
        </div>

        <div className="quiz-banks">
          {banks.length === 0 && (
            <div className="quiz-empty">
              <h2>还没有题库</h2>
              <p className="muted">导入 JSON、Word 或 Excel 题目开始练习；答错的题会自动收录进错题本</p>
              <button className="btn-primary" onClick={() => setImportOpen(true)}>导入第一份题库</button>
            </div>
          )}
          {banks.map((b) => {
            const p = progress.get(b.name);
            return (
              <div key={b.name} className="bank-item">
                <div className="bank-info">
                  <div className="bank-name">{b.name}</div>
                  <div className="muted">
                    {b.questions.length} 题 · {new Date(b.importedAt).toLocaleDateString()} 导入
                    {p && p.seen > 0 && (
                      <>
                        {' · '}做过 {p.seen}
                        {p.wrong > 0 && <> · 错过 {p.wrong}</>}
                        {p.due > 0 && <> · <b className="bank-due">待复习 {p.due}</b></>}
                      </>
                    )}
                  </div>
                </div>
                <button className="btn-small" onClick={() => { setRules(DEFAULT_RULES); setComposing(b); }}>组题</button>
                <details className="bank-more">
                  <summary aria-label={`更多操作：${b.name}`}>更多</summary>
                  <div className="bank-more-menu">
                    <button className="btn-small" title="不组题，整库洗牌后全部做完" onClick={() => start(b, null)}>整库练习</button>
                    <button className="btn-small" title="导出本题库为 Anki 导入文件" onClick={() => downloadFile(`${b.name}-anki.txt`, bankToAnki(b))}>导出 Anki</button>
                    <button
                      className="btn-small danger"
                      onClick={() => {
                        void confirmBox({ title: `删除题库「${b.name}」？`, danger: true, okText: '删除' })
                          .then(async (ok) => { if (ok) setBanks(await removeBank(b.name)); });
                      }}
                    >删除题库</button>
                  </div>
                </details>
              </div>
            );
          })}
        </div>
      </DialogSurface>
    </div>
  );
}

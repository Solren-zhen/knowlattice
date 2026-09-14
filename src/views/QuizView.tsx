/**
 * 题库练习：导入 JSON 题库（文件或粘贴）→ 选库组卷 → 逐题作答 → 结果页错题回顾。
 * 答错且题目关联笔记（note 字段可解析）时自动记入错题本。
 */
import { useEffect, useRef, useState } from 'react';
import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import {
  addBank, loadBanks, normalizeQuestions, pickQuestions, removeBank,
  parseQuestionsFromText, rowsToQuestions,
  type QuizBank, type QuizQuestion,
} from '../core/qbank';
import { recordMistake } from '../core/mistakes';
import { toast, confirmBox } from '../core/feedback';
import { markStudy } from '../core/stats';
import { bankToAnki, downloadFile } from '../core/anki';
import { IconRestore, IconTrash } from './icons';

interface Props {
  docs: Map<string, string>;
  resolveLink: (name: string) => string | null;
  /** 打开关联笔记（同时关闭本面板） */
  onOpenPath: (path: string) => void;
  onClose: () => void;
}

type Session = { bankName: string; questions: QuizQuestion[] };

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

· Word(.docx)：直接导入，自动抽取文本并按「1.题干 → A.选项 → 答案：A」识别
· Excel/CSV：表头含「题干/答案」，选项列用 A/B/C/D 或 选项1..4
· 识别不到时会把原文填入输入框，手动整理后再粘贴导入`;

export default function QuizView({ docs, resolveLink, onOpenPath, onClose }: Props) {
  const [banks, setBanks] = useState<QuizBank[]>(loadBanks);
  const [showHelp, setShowHelp] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [idx, setIdx] = useState(0);
  /** 每题作答结果：true 对 / false 错 / undefined 未答 */
  const [results, setResults] = useState<(boolean | undefined)[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const docxRef = useRef<HTMLInputElement>(null);
  const xlsxRef = useRef<HTMLInputElement>(null);

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

  // Esc 快捷关闭
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, inProgress]);

  const q = session?.questions[idx];
  const correctCount = results.filter((r) => r === true).length;

  // ---------- 导入 ----------
  const importQuestions = (questions: QuizQuestion[], name: string) => {
    setBanks(addBank(name, questions));
    setPasteText('');
    toast(`已导入「${name}」：${questions.length} 题`, 'ok');
  };
  const doImport = (text: string, fallbackName: string) => {
    try {
      const raw: unknown = JSON.parse(text);
      const questions = normalizeQuestions(raw);
      const named = !Array.isArray(raw) && typeof raw === 'object' && raw !== null
        ? (raw as { name?: unknown }).name
        : undefined;
      const name = typeof named === 'string' && named.trim() ? named.trim() : fallbackName;
      importQuestions(questions, name);
    } catch (err) {
      toast(`导入失败：${(err as Error).message}`, 'err');
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
        toast('未能从 Word 中自动识别出题目。文档全文已填入下方输入框，请按「题目/选项/答案」格式整理后导入。', 'info', 6500);
        return;
      }
      importQuestions(questions, file.name.replace(/\.docx?$/i, ''));
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
      importQuestions(questions, file.name.replace(/\.(xlsx?|csv)$/i, ''));
    } catch (err) {
      toast(`Excel 导入失败：${(err as Error).message}（表头需含「题干/答案」，选项列可用 A/B/C/D 或 选项1..4）`, 'err');
    }
  };

  // ---------- 练习 ----------
  const start = (bank: QuizBank, pool?: QuizQuestion[]) => {
    const qs = pickQuestions({ ...bank, questions: pool ?? bank.questions });
    setSession({ bankName: bank.name, questions: qs });
    setIdx(0);
    setResults(new Array(qs.length).fill(undefined));
    setPicked(null);
    setRevealed(false);
  };

  /** 答错且关联笔记存在 → 记入错题本 */
  const judge = (correct: boolean) => {
    if (!q) return;
    markStudy(); // 打卡
    setResults((prev) => prev.map((r, i) => (i === idx ? correct : r)));
    if (!correct && q.note) {
      const path = resolveLink(q.note);
      if (path && docs.has(path)) recordMistake(path, docs.get(path)!);
    }
  };

  const next = () => {
    setPicked(null);
    setRevealed(false);
    setIdx((i) => i + 1);
  };

  // ---------- 渲染 ----------
  if (session && q) {
    const answered = results[idx] !== undefined;
    const notePath = q.note ? resolveLink(q.note) : null;
    return (
      <div className="panel-backdrop quiz-overlay" onClick={requestClose}>
        <div className="panel quiz-panel" onClick={(e) => e.stopPropagation()}>
          <div className="panel__head quiz-header">
            <span className="panel__title quiz-title">{session.bankName} · 第 {idx + 1} / {session.questions.length} 题</span>
            <span className="muted">已对 {correctCount}</span>
            <button className="btn-icon" onClick={requestClose} aria-label="关闭">✕</button>
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
                  return (
                    <button
                      key={i}
                      className={cls}
                      disabled={answered}
                      onClick={() => {
                        setPicked(i);
                        judge(i === q.answer);
                      }}
                    >
                      <b>{String.fromCharCode(65 + i)}</b> {opt}
                      {answered && isRight && <span className="opt-mark">✓</span>}
                      {answered && i === picked && !isRight && <span className="opt-mark">✗</span>}
                    </button>
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
              <div className="quiz-expl">
                <b>{results[idx] ? '✓ 答对了' : '✗ 答错了'}</b>
                <p>{q.explanation}</p>
              </div>
            )}
            {q.type === 'recall' && revealed && !answered && (
              <div className="quiz-actions">
                <button className="btn-small" onClick={() => judge(true)}>我答对了</button>
                <button className="btn-small danger" onClick={() => judge(false)}>我答错了</button>
              </div>
            )}
          </div>

          {answered && (
            <div className="quiz-footer">
              {notePath && (
                <button className="btn-small" onClick={() => { onClose(); onOpenPath(notePath); }}>
                  打开笔记「{q.note}」
                </button>
              )}
              {idx + 1 < session.questions.length ? (
                <button className="btn-primary quiz-next" onClick={next}>下一题 →</button>
              ) : (
                <button className="btn-primary quiz-next" onClick={next}>查看成绩 →</button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---------- 成绩页 ----------
  if (session) {
    const total = session.questions.length;
    const wrong = session.questions.filter((_, i) => results[i] === false);
    return (
      <div className="panel-backdrop quiz-overlay" onClick={requestClose}>
        <div className="panel quiz-panel" onClick={(e) => e.stopPropagation()}>
          <div className="panel__head quiz-header">
            <span className="panel__title quiz-title">练习成绩 · {session.bankName}</span>
            <button className="btn-icon" onClick={requestClose} aria-label="关闭">✕</button>
          </div>
          <div className="quiz-result">
            <div className="score">{total ? Math.round((correctCount / total) * 100) : 0}<small>分</small></div>
            <p className="muted">{correctCount} / {total} 题正确{wrong.length > 0 && '，答错的题目已关联错题本'}</p>
            {wrong.length > 0 && (
              <div className="quiz-wrong-list">
                {wrong.map((w) => {
                  const wp = w.note ? resolveLink(w.note) : null;
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
              <button className="btn-primary" onClick={() => start(loadBanks().find((b) => b.name === session.bankName)!)}>再练一轮</button>
              <button className="btn-small" onClick={() => setSession(null)}>返回题库列表</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------- 题库列表 ----------
  return (
    <div className="panel-backdrop quiz-overlay" onClick={requestClose}>
      <div className="panel quiz-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head quiz-header">
          <span className="panel__title quiz-title">题库练习</span>
          <button className="btn-icon" onClick={() => setShowHelp(!showHelp)} aria-label="格式说明" title="题库 JSON 格式说明">?</button>
          <button className="btn-icon" onClick={requestClose} aria-label="关闭">✕</button>
        </div>

        {showHelp && (
          <div className="quiz-help">
            <p className="muted">导入格式（保存为 .json 文件导入，或直接粘贴）：</p>
            <pre>{HELP_TEXT}</pre>
          </div>
        )}

        <div className="quiz-import">
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
              <p>还没有题库</p>
              <p className="muted">导入一份 JSON 题库开始练习；答错的题会自动收录进错题本</p>
            </div>
          )}
          {banks.map((b) => (
            <div key={b.name} className="bank-item">
              <div className="bank-info">
                <div className="bank-name">{b.name}</div>
                <div className="muted">{b.questions.length} 题 · {new Date(b.importedAt).toLocaleDateString()} 导入</div>
              </div>
              <button className="btn-small" onClick={() => start(b)}>开始练习</button>
              <button
                className="btn-small"
                title="导出本题库为 Anki 导入文件"
                onClick={() => downloadFile(`${b.name}-anki.txt`, bankToAnki(b))}
              >
                导 Anki
              </button>
              <button
                className="btn-icon"
                aria-label={`删除题库 ${b.name}`}
                onClick={() => {
                  void confirmBox({ title: `删除题库「${b.name}」？`, danger: true, okText: '删除' })
                    .then((ok) => { if (ok) setBanks(removeBank(b.name)); });
                }}
              >
                <IconTrash />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

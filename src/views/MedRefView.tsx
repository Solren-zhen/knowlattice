/**
 * 医学速查：症状 → 疾病 / 方剂口诀。
 *
 * 两个页签共用一条本地数据加载路径。内置数据、用户修改与隐藏清单三合一，
 * 用户条目同名时覆盖内置（自己改的不能被生成物盖回去）。
 *
 * 「新增/编辑」就地展开成表单，不弹二级对话框：医学速查是随手查的东西，
 * 弹窗会打断「边看书边补一条」的节奏。
 *
 * 内置数据由 `node tools/ingest-app-data.mjs` 生成到 public/app-data/medref/；
 * 没生成时给一条能照着做的提示，而不是空面板。
 */
import { useEffect, useMemo, useState } from 'react';
import { useEsc, escThenClose } from './useEsc';
import {
  countCats,
  inCat,
  loadMedRef,
  mergeSymptoms,
  searchMnemonics,
  searchSymptoms,
  type MedMnemonicLib,
  type MedRefData,
  type MedSymptom,
} from '../core/medRef';
import {
  MY_BOOK,
  loadHiddenMnemonics,
  loadHiddenSymptoms,
  loadUserMnemonics,
  loadUserSymptoms,
  mergeMnemonicBooks,
  removeUserMnemonic,
  removeUserSymptom,
  upsertUserMnemonic,
  upsertUserSymptom,
  type UserMnemonic,
} from '../core/medRefStore';
import { IconClose } from './icons';
import PanelOverlay from './PanelOverlay';

interface Props {
  onClose: () => void;
  onToast?: (msg: string, kind?: 'ok' | 'info' | 'err') => void;
}

type Tab = 'symptoms' | 'mnemonics';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'symptoms', label: '症状' },
  { id: 'mnemonics', label: '口诀' },
];

interface SymDraft {
  original: string;
  name: string;
  cat: string;
  diseases: string;
}

interface MneDraft {
  original: string;
  book: string;
  term: string;
  cat: string;
  body: string;
  tip: string;
}

const EMPTY_SYM: SymDraft = { original: '', name: '', cat: '', diseases: '' };
const EMPTY_MNE: MneDraft = { original: '', book: MY_BOOK, term: '', cat: '', body: '', tip: '' };

export default function MedRefView({ onClose, onToast }: Props) {
  useEsc(escThenClose(onClose));
  const [data, setData] = useState<MedRefData | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<Tab>('symptoms');
  const [q, setQ] = useState('');
  /** 分类筛选：'' = 全部。分类是新分类名写进条目后自动出现的，不需要预建 */
  const [catFilter, setCatFilter] = useState('');
  const [userSyms, setUserSyms] = useState<MedSymptom[]>(loadUserSymptoms);
  const [userMnes, setUserMnes] = useState<UserMnemonic[]>(loadUserMnemonics);
  const [hiddenSyms, setHiddenSyms] = useState<string[]>(loadHiddenSymptoms);
  const [hiddenMnes, setHiddenMnes] = useState(loadHiddenMnemonics);
  const [symDraft, setSymDraft] = useState<SymDraft | null>(null);
  const [mneDraft, setMneDraft] = useState<MneDraft | null>(null);

  useEffect(() => {
    let alive = true;
    loadMedRef()
      .then((d) => { if (alive) setData(d); })
      .catch((e: unknown) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, []);

  const allSymptoms = useMemo(
    () => mergeSymptoms(data?.symptoms ?? [], userSyms, hiddenSyms),
    [data, userSyms, hiddenSyms],
  );
  const allBooks = useMemo<MedMnemonicLib[]>(
    () => mergeMnemonicBooks(data?.books ?? [], userMnes, hiddenMnes),
    [data, userMnes, hiddenMnes],
  );

  const symptoms = useMemo(
    () => searchSymptoms(allSymptoms, q).filter((s) => inCat(s.cat, catFilter)),
    [allSymptoms, q, catFilter],
  );
  const books = useMemo(() => {
    const hit = searchMnemonics(allBooks, q);
    if (!catFilter) return hit;
    return hit
      .map((book) => ({ ...book, entries: book.entries.filter((e) => inCat(e.cat, catFilter)) }))
      .filter((book) => book.entries.length > 0);
  }, [allBooks, q, catFilter]);

  /** 两个页签各有一套分类：症状按证候分，口诀按用户自己的门类分 */
  const symCats = useMemo(() => countCats(allSymptoms.map((s) => s.cat)), [allSymptoms]);
  const mneCats = useMemo(
    () => countCats(allBooks.flatMap((book) => book.entries.map((e) => e.cat))),
    [allBooks],
  );
  const cats = tab === 'symptoms' ? symCats : mneCats;
  const total = tab === 'symptoms'
    ? allSymptoms.length
    : allBooks.reduce((n, book) => n + book.entries.length, 0);

  const saveSym = () => {
    if (!symDraft) return;
    const ok = upsertUserSymptom(
      {
        name: symDraft.name,
        cat: symDraft.cat,
        diseases: symDraft.diseases.split(/[、，,;；\s]+/).filter(Boolean),
      },
      symDraft.original || undefined,
    );
    setUserSyms(loadUserSymptoms());
    setHiddenSyms(loadHiddenSymptoms());
    setSymDraft(null);
    onToast?.(ok ? '症状已保存' : '没存上：本机存储已满或被禁用', ok ? 'ok' : 'err');
  };

  const saveMne = () => {
    if (!mneDraft) return;
    const ok = upsertUserMnemonic(
      {
        book: mneDraft.book,
        term: mneDraft.term,
        cat: mneDraft.cat,
        body: mneDraft.body,
        tip: mneDraft.tip,
      },
      mneDraft.original || undefined,
    );
    setUserMnes(loadUserMnemonics());
    setHiddenMnes(loadHiddenMnemonics());
    setMneDraft(null);
    onToast?.(ok ? '口诀已保存' : '没存上：本机存储已满或被禁用', ok ? 'ok' : 'err');
  };

  return (
    <PanelOverlay tone="plain" onClose={onClose}>
      <div className="panel panel--full medref-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel__head">
          <span className="panel__title">医学速查</span>
          {data && (
            <span className="muted">
              {allSymptoms.length} 条症状 · {allBooks.reduce((n, b) => n + b.entries.length, 0)} 条口诀
              {userSyms.length + userMnes.length > 0 && `（自建 ${userSyms.length + userMnes.length} 条）`}
            </span>
          )}
          <button className="btn-icon" onClick={onClose} aria-label="关闭"><IconClose /></button>
        </div>

        <div className="medref-bar">
          <div className="medref-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={`chip${tab === t.id ? ' on' : ''}`}
                onClick={() => { setTab(t.id); setQ(''); setCatFilter(''); }}
              >{t.label}</button>
            ))}
          </div>
          <input
            className="medref-search"
            placeholder={tab === 'symptoms' ? '输入症状、分类或疾病名' : '输入方名、门类或歌诀内容'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="速查搜索"
          />
          <button
            className="btn-small"
            onClick={() => (tab === 'symptoms' ? setSymDraft({ ...EMPTY_SYM }) : setMneDraft({ ...EMPTY_MNE }))}
          >＋ 新增</button>
        </div>

        {cats.length > 0 && (
          <div className="medref-cats" role="group" aria-label="按分类筛选">
            <button
              className={`chip${catFilter ? '' : ' on'}`}
              aria-pressed={!catFilter}
              onClick={() => setCatFilter('')}
            >全部 <span className="muted">{total}</span></button>
            {cats.map((c) => {
              // 选中的判定不能直接用 inCat：'' 空筛选会放行所有分类
              const on = catFilter !== '' && inCat(c.name, catFilter);
              return (
                <button
                  key={c.name}
                  className={`chip${on ? ' on' : ''}`}
                  aria-pressed={on}
                  onClick={() => setCatFilter(on ? '' : c.name)}
                >{c.name} <span className="muted">{c.count}</span></button>
              );
            })}
          </div>
        )}

        {err && (
          <div className="muted medref-tip">
            {err}
            <br />
            速查是本地数据：`node tools/ingest-app-data.mjs` 生成一次即可（自建条目不受影响）。
          </div>
        )}
        {!data && !err && <div className="muted medref-tip">加载中…</div>}

        {tab === 'symptoms' && symDraft && (
          <div className="medref-edit" aria-label="编辑症状">
            <input
              placeholder="症状名（必填）"
              aria-label="症状名"
              value={symDraft.name}
              onChange={(e) => setSymDraft({ ...symDraft, name: e.target.value })}
            />
            <input
              placeholder="分类，如 发热（选已有的或直接写新的）"
              aria-label="症状分类"
              list="medref-sym-cats"
              value={symDraft.cat}
              onChange={(e) => setSymDraft({ ...symDraft, cat: e.target.value })}
            />
            <datalist id="medref-sym-cats">
              {symCats.map((c) => <option key={c.name} value={c.name} />)}
            </datalist>
            <input
              placeholder="可能的疾病，用顿号或逗号分隔"
              aria-label="关联疾病"
              value={symDraft.diseases}
              onChange={(e) => setSymDraft({ ...symDraft, diseases: e.target.value })}
            />
            <div className="medref-edit__actions">
              <button className="btn-small btn-primary" onClick={saveSym} disabled={!symDraft.name.trim()}>保存</button>
              <button className="btn-small" onClick={() => setSymDraft(null)}>取消</button>
            </div>
          </div>
        )}

        {tab === 'symptoms' && (
          <div className="medref-list">
            {data && symptoms.length === 0 && (
              <div className="muted medref-tip">
                {catFilter ? `「${catFilter}」下没有` : '没有'}{q ? `匹配「${q}」的` : ''}症状。
              </div>
            )}
            {symptoms.map((s) => {
              return (
                <div key={s.name} className="medref-row medref-row--sym">
                  <div className="medref-row__main">
                    <b>{s.name}</b>
                    <span className="muted">{s.cat}</span>
                  </div>
                  <div className="medref-sym">
                    {s.diseases.map((d) => <span key={d} className="chip chip--static">{d}</span>)}
                  </div>
                  <button
                    className="btn-small"
                    onClick={() => setSymDraft({
                      original: s.name,
                      name: s.name,
                      cat: s.cat,
                      diseases: s.diseases.join('、'),
                    })}
                  >编辑</button>
                  <button
                    className="btn-small"
                    onClick={() => {
                      const ok = removeUserSymptom(s.name);
                      setUserSyms(loadUserSymptoms());
                      setHiddenSyms(loadHiddenSymptoms());
                      onToast?.(ok ? `已删除症状：${s.name}` : '没删掉：本机存储不可用', ok ? 'ok' : 'err');
                    }}
                  >删除</button>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'mnemonics' && mneDraft && (
          <div className="medref-edit" aria-label="编辑口诀">
            <input
              placeholder="方名（必填）"
              aria-label="方名"
              value={mneDraft.term}
              onChange={(e) => setMneDraft({ ...mneDraft, term: e.target.value })}
            />
            <input
              placeholder="分类（选已有的或直接写新的）"
              aria-label="口诀分类"
              list="medref-mne-cats"
              value={mneDraft.cat}
              onChange={(e) => setMneDraft({ ...mneDraft, cat: e.target.value })}
            />
            <datalist id="medref-mne-cats">
              {mneCats.map((c) => <option key={c.name} value={c.name} />)}
            </datalist>
            <textarea
              placeholder="歌诀正文"
              aria-label="歌诀正文"
              rows={3}
              value={mneDraft.body}
              onChange={(e) => setMneDraft({ ...mneDraft, body: e.target.value })}
            />
            <input
              placeholder="备注（可空）"
              aria-label="口诀备注"
              value={mneDraft.tip}
              onChange={(e) => setMneDraft({ ...mneDraft, tip: e.target.value })}
            />
            <div className="medref-edit__actions">
              <button className="btn-small btn-primary" onClick={saveMne} disabled={!mneDraft.term.trim() || !mneDraft.body.trim()}>保存</button>
              <button className="btn-small" onClick={() => setMneDraft(null)}>取消</button>
            </div>
          </div>
        )}

        {tab === 'mnemonics' && (
          <div className="medref-list">
            {data && books.length === 0 && (
              <div className="muted medref-tip">
                {q || catFilter ? `没有匹配${q ? `「${q}」` : ''}的口诀。` : '还没有口诀，点「＋ 新增」添加一条。'}
              </div>
            )}
            {books.map((book) => (
              <div key={book.book} className="medref-lib">
                <div className="medref-lib__head">
                  <b>{book.book}</b>
                  {book.note && <span className="muted">{book.note}</span>}
                </div>
                {book.entries.map((e) => {
                  return (
                    <div key={e.term} className="medref-row medref-row--mne">
                      <div className="medref-row__main">
                        <b>{e.term}</b>
                        <span className="muted">{e.cat}</span>
                        <span className="medref-detail">{e.body}</span>
                        {e.tip && <span className="medref-mne">备注：{e.tip}</span>}
                      </div>
                      <button
                        className="btn-small"
                        onClick={() => setMneDraft({
                          original: e.term,
                          book: book.book,
                          term: e.term,
                          cat: e.cat,
                          body: e.body,
                          tip: e.tip,
                        })}
                      >编辑</button>
                      <button
                        className="btn-small"
                        onClick={() => {
                          const ok = removeUserMnemonic(book.book, e.term);
                          setUserMnes(loadUserMnemonics());
                          setHiddenMnes(loadHiddenMnemonics());
                          onToast?.(ok ? `已删除口诀：${e.term}` : '没删掉：本机存储不可用', ok ? 'ok' : 'err');
                        }}
                      >删除</button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </PanelOverlay>
  );
}

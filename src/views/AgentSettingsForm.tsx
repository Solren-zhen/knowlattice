/**
 * AI 助手的「设置」表单：接口地址 / API Key / 模型名 / 本机教材库 / 等价词组。
 *
 * 从 AiAgentPanel.tsx 搬出来（那个文件 2300+ 行，改设置页要先读完整块对话逻辑）。
 * 这里只依赖 core 与 storage，不知道自己被谁渲染：面板负责在「设置」页签里挂上它。
 */
import { useEffect, useRef, useState } from 'react';
import { agentNetHint, isAbortError, isAllowedAgentBaseUrl, type AgentSettings } from '../core/aiAgent';
import { medBookRecords, medBookRemove, type MedBookMeta } from '../core/medBooks';
import { setMedBookPageOffset } from '../storage/medStore';
import { parseSynonymLines, setUserSynonymGroups, USER_SYNONYMS_KEY } from '../core/medSynonyms';
import { credentialStoreKind, saveSecureApiKey } from '../core/secureCredentials';
import { tauriErrorText } from '../storage/tauriError';
import { AI_AGENT_SETTINGS_KEY } from '../core/agentSettings';
import { toast } from '../core/feedback';

const PRESETS = [
  { name: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', model: '', hint: '每日有免费 token 额度；模型名以 mimo.mi.com 文档/控制台为准' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6', hint: '' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hint: '' },
  { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2', hint: '' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', hint: '可访问 Claude 等海外模型，模型名填 provider/model' },
  { name: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: '', hint: '无需 Key；需以 OLLAMA_ORIGINS=* 启动以放行跨域' },
  { name: '自定义中转', baseUrl: '', model: '', hint: '填中转站给的接口地址，通常以 /v1 结尾；粘贴后先点「测试连接」' },
];

/** 助手配置的存储键：定义在 core/agentSettings，这里只转出，避免出现第二份字面量 */
export { AI_AGENT_SETTINGS_KEY };

/* ------------------------------------------------------------ 设置表单 */

export default function SettingsForm({ initial, onSaved, onCancel }: {
  initial: AgentSettings | null;
  onSaved: (s: AgentSettings) => void;
  onCancel: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [hint, setHint] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  /** 是否把密钥写进本机存储（默认保存，关掉则只本次会话有效） */
  const [rememberKey, setRememberKey] = useState(true);
  const [saving, setSaving] = useState(false);
  const storeKind = credentialStoreKind();

  // 医学教材库：本机索引的管理（导入 / 清单 / 删除 / 页码偏移）
  const [medBooks, setMedBooks] = useState<MedBookMeta[]>([]);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const medFileRef = useRef<HTMLInputElement>(null);
  /** 文本层抽取失败的书（多为扫描版）：留着手柄供「OCR 重新导入」 */
  const failedFilesRef = useRef<File[]>([]);
  const [canOcr, setCanOcr] = useState(false);
  // 用户自定义等价词组：设置页编辑，blur 时生效并持久化
  const [synText, setSynText] = useState(() => {
    try { return localStorage.getItem(USER_SYNONYMS_KEY) ?? ''; } catch { return ''; }
  });

  const refreshMedBooks = async () => setMedBooks(await medBookRecords());
  useEffect(() => {
    let alive = true;
    void medBookRecords().then((rows) => { if (alive) setMedBooks(rows); });
    return () => { alive = false; };
  }, []);

  /** 导入教材 PDF：convert/pdf.js 体量大，动态引入；逐个解析并入库，扫描件在 ocr 开启时走 OCR 回退 */
  const importMedBooks = async (files: File[], ocr = false) => {
    if (!files.length || importing) return;
    setImporting(true);
    setImportMsg('');
    try {
      const { importMedPdfFiles } = await import('../core/medImport');
      const res = await importMedPdfFiles(files, (p) => setImportMsg(`${p.label}（${p.done}/${p.total}）`), { ocr });
      const failedFiles = res.failed
        .map((f) => files.find((x) => x.name === f.name))
        .filter((x): x is File => !!x);
      failedFilesRef.current = failedFiles;
      setCanOcr(failedFiles.length > 0);
      const parts = [`已导入 ${res.imported.length} 本`];
      if (res.overwritten.length) {
        parts.push(`覆盖同名 ${res.overwritten.length} 本：${res.overwritten.join('、')}`);
      }
      if (res.failed.length) {
        parts.push(`${res.failed.length} 本失败：${res.failed.map((f) => f.name).join('、')}`);
      }
      for (const w of res.warnings) parts.push(w);
      setImportMsg(parts.join('；'));
      await refreshMedBooks();
    } catch (e) {
      setImportMsg(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
    }
  };

  /** 页码偏移 = PDF 物理页 − 印刷页（前言/目录的页数）；留空按 0。检索结果据此直接报印刷页码 */
  const commitOffset = async (name: string, raw: string) => {
    const v = raw.trim();
    const n = v === '' ? 0 : Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0) return;
    try {
      await setMedBookPageOffset(name, n);
      await refreshMedBooks();
    } catch { /* 教材可能刚被删除 */ }
  };

  const deleteMedBook = async (name: string) => {
    if (!window.confirm(`删除教材「${name}」的本地索引？删除后需重新导入 PDF 才能恢复。`)) return;
    await medBookRemove(name);
    await refreshMedBooks();
  };

  const valid = isAllowedAgentBaseUrl(baseUrl) && !!model.trim();

  /** 连通性测试：真实发一条短请求；成功后顺手拉 /models 做模型名候选。
   *  中转站友好：404 且地址没带 /vN 版本段时自动补 /v1 重试一次并回填输入框。 */
  const test = async () => {
    const orig = baseUrl.trim().replace(/\/+$/, '');
    if (!isAllowedAgentBaseUrl(orig) || !model.trim()) {
      setResult({ ok: false, text: '先填好接口地址与模型名' });
      return;
    }
    setTesting(true);
    setResult(null);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const headers = {
      'Content-Type': 'application/json',
      ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
    };
    const body = JSON.stringify({ model: model.trim(), messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, stream: false });
    try {
      let base = orig;
      let res = await fetch(`${base}/chat/completions`, { method: 'POST', signal: ctrl.signal, headers, body });
      if (res.status === 404 && !/\/v\d+[a-z]*$/i.test(base)) {
        base = `${orig}/v1`;
        res = await fetch(`${base}/chat/completions`, { method: 'POST', signal: ctrl.signal, headers, body });
        if (res.ok) setBaseUrl(base);
      }
      if (res.ok) {
        try {
          const mres = await fetch(`${base}/models`, { signal: ctrl.signal, headers });
          if (mres.ok) {
            const data = await mres.json() as { data?: Array<{ id?: string }> };
            setModels((data.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean).slice(0, 100));
          }
        } catch { /* /models 可选，失败不影响连接结果 */ }
        setResult({ ok: true, text: base === orig ? '连接成功' : `连接成功（地址已自动补全为 ${base}）` });
      } else {
        const t = await res.text().catch(() => '');
        const hint = res.status === 404 ? '。404：确认地址是否要以 /v1 结尾，或查看中转站的接口路径说明' : '';
        setResult({ ok: false, text: `${res.status}：${t.slice(0, 160) || res.statusText}${hint}` });
      }
    } catch (e) {
      setResult({ ok: false, text: isAbortError(e) ? '连接超时' : agentNetHint(e) });
    } finally {
      clearTimeout(timer);
      setTesting(false);
    }
  };

  return (
    <div className="agent-settings">
      <div className="agent-settings-presets">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            className={`type-chip ${baseUrl === p.baseUrl ? 'on' : ''}`}
            onClick={() => {
              if (p.baseUrl) setBaseUrl(p.baseUrl);
              if (p.model) setModel(p.model);
              setHint(p.hint);
            }}
          >
            {p.name}
          </button>
        ))}
      </div>
      <label className="agent-field">
        <span>接口地址（OpenAI 兼容）</span>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.xiaomimimo.com/v1"
          spellCheck={false}
        />
      </label>
      {baseUrl.trim().startsWith('http://') && !isAllowedAgentBaseUrl(baseUrl) && (
        <p className="agent-settings-hint muted">
          远程地址必须使用 https://；HTTP 只允许 localhost、127.0.0.1 和 [::1]，避免 API Key 明文传输。
        </p>
      )}
      <label className="agent-field">
        <span>API Key{baseUrl.includes('localhost') ? '（本地服务可留空）' : ''}</span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
          autoComplete="off"
        />
      </label>
      {/* 共用设备 / 不想把密钥留在磁盘上的用户：关掉即只在本次会话内有效。 */}
      <label className="agent-field agent-remember-key">
        <span>
          <input
            type="checkbox"
            checked={rememberKey}
            onChange={(e) => setRememberKey(e.target.checked)}
          />
          {' '}把密钥保存在本机
        </span>
        <span className="muted">
          {storeKind === 'os'
            ? '桌面版会把密钥交给 Windows Credential Manager / macOS Keychain / Linux Secret Service；网页存储只保存空密钥。关掉后刷新或重开应用需要重新填写。'
            : '浏览器版会把密钥以明文存在本机浏览器存储里；关掉后密钥只在本次会话内有效。密钥不会随备份导出，共用设备建议关掉。'}
        </span>
      </label>
      <label className="agent-field">
        <span>模型名{models.length ? `（${models.length} 个候选，输入时下拉）` : ''}</span>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="如 deepseek-chat / glm-4.6 / kimi-k2"
          spellCheck={false}
          list="agent-model-candidates"
        />
        <datalist id="agent-model-candidates">
          {models.map((m) => <option key={m} value={m} />)}
        </datalist>
      </label>
      <div className="agent-field">
        <span>医学教材库（本机索引）</span>
        <div className="agent-medbooks-actions">
          <button
            className="btn-small"
            disabled={importing}
            onClick={() => medFileRef.current?.click()}
          >
            {importing ? '导入中…' : '导入教材 PDF'}
          </button>
          {canOcr && !importing && (
            <button
              className="btn-small"
              onClick={() => void importMedBooks(failedFilesRef.current, true)}
              title="扫描版 PDF 没有文字层，走本地 OCR（每页约 2~5 秒，单次上限 30 页）"
            >
              用 OCR 导入失败的书
            </button>
          )}
          <span className="muted">{medBooks.length ? `已导入 ${medBooks.length} 本` : '尚未导入'}</span>
          <input
            ref={medFileRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              void importMedBooks(files);
            }}
          />
        </div>
        {medBooks.length > 0 && (
          <ul className="agent-medbooks-list">
            {medBooks.map((b) => (
              <li key={b.name}>
                <span className="agent-medbooks-name" title={`${b.chars.toLocaleString()} 字`}>{b.name}</span>
                <span className="muted">{b.pages} 页</span>
                <label className="agent-medbooks-offset" title="页码偏移 = PDF 物理页 − 原书印刷页（即前言/目录的页数）。填好后检索结果直接报印刷页码，引用更准确。">
                  偏移
                  <input
                    type="number"
                    min={0}
                    step={1}
                    defaultValue={b.pageOffset ?? 0}
                    onBlur={(e) => void commitOffset(b.name, e.target.value)}
                  />
                </label>
                <button
                  className="agent-medbooks-del"
                  title="删除这本教材索引"
                  onClick={() => void deleteMedBook(b.name)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <label className="agent-field">
        <span>自定义等价词组（可选，每行一组、组内词用空格分隔，搜索与教材检索通用）</span>
        <textarea
          value={synText}
          rows={3}
          spellCheck={false}
          placeholder={'如：\n支扩 支气管扩张\nRTA 肾小管酸中毒'}
          onChange={(e) => setSynText(e.target.value)}
          onBlur={() => {
            const groups = parseSynonymLines(synText);
            setUserSynonymGroups(groups);
            try { localStorage.setItem(USER_SYNONYMS_KEY, JSON.stringify(groups)); } catch { /* 存储不可用忽略 */ }
          }}
        />
      </label>
      <p className="agent-settings-hint muted">
        导入的教材只存在本机（浏览器 IndexedDB），助手用 list_medical_books / search_medical_books / read_med_book_page 查阅。
        页码默认按 PDF 物理页计（从封面第 1 页数起），在上面的「偏移」里填前言/目录页数即可换成原书印刷页码。
        扫描版 PDF（无文字层）普通导入会失败，可用「用 OCR 导入失败的书」走本地识别（较慢）。
      </p>
      {importMsg && <p className="agent-settings-hint muted">{importMsg}</p>}
      {hint && <p className="agent-settings-hint muted">{hint}</p>}
      {/* 合规提示从对话区底部移到这里：它是「关于这个助手怎么工作」的说明，
          每次打开面板都占一行是白占地方，放在设置里按需查阅即可。 */}
      <p className="agent-settings-hint muted">
        写入默认需你确认（yolo 模式除外），自动存入历史版本；会话与配置只保存在本机。
        注意：对话内容、助手检索到的笔记正文与教材原文都会随请求发给你配置的模型服务商，
        请勿包含患者信息等敏感数据；不用时可在下方关闭密钥保存或直接清空密钥。
      </p>
      <div className="agent-settings-actions">
        <button className="btn-small" onClick={() => void test()} disabled={testing || !valid}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        <button
          className="btn-primary"
          disabled={!valid || saving}
          onClick={async () => {
            const s: AgentSettings = { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() };
            try {
              setSaving(true);
              if (storeKind === 'os') {
                await saveSecureApiKey(rememberKey ? s.apiKey : '');
                localStorage.setItem(AI_AGENT_SETTINGS_KEY, JSON.stringify({ ...s, apiKey: '' }));
              } else {
                localStorage.setItem(AI_AGENT_SETTINGS_KEY, JSON.stringify({ ...s, apiKey: rememberKey ? s.apiKey : '' }));
              }
              onSaved(s);
            } catch (error) {
              if (storeKind === 'os') {
                localStorage.setItem(AI_AGENT_SETTINGS_KEY, JSON.stringify({ ...s, apiKey: '' }));
                onSaved(s);
                toast(`系统凭据库不可用，密钥仅在本次会话有效：${tauriErrorText(error)}`, 'err', 9000);
              } else {
                setResult({ ok: false, text: `保存失败：${tauriErrorText(error)}` });
              }
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {initial && <button className="btn-small" onClick={onCancel}>取消</button>}
      </div>
      {result && <p className={`agent-test-result ${result.ok ? 'ok' : 'bad'}`}>{result.text}</p>}
    </div>
  );
}

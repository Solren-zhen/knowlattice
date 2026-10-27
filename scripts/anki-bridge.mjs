#!/usr/bin/env node
// AnkiConnect 兼容桥：把外部取词/背诵工具的 addNote 落成本库的 Markdown 笔记。
// 只绑 127.0.0.1（局域网与外部不可达）；vault 由命令行给出，不读任何全局配置。
// 用法：node scripts/anki-bridge.mjs --vault <库目录> [--port 8765]
//       node scripts/anki-bridge.mjs --selftest
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, unlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT_NAME = 'Anki收件箱';
const INDEX_NAME = '.anki-bridge.json';
const MODEL = 'KnowLattice 笔记';
const FIELDS = ['正面', '背面', '章节'];

let vault = null;
let index = new Map(); // id(string) -> { path, deck }
let seq = 0;

function deckDir(deck) {
  const safe = String(deck || '默认').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '默认';
  return join(vault, ROOT_NAME, safe);
}

function slug(s) {
  const t = String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, '').slice(0, 24);
  return t || 'card';
}

function yamlStr(s) {
  const t = String(s == null ? '' : s).replace(/\r?\n/g, ' ').trim();
  return /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 \-,.]*$/.test(t) ? t : JSON.stringify(t);
}

function renderNote(rec) {
  const tags = '[' + rec.tags.map(yamlStr).join(', ') + ']';
  return [
    '---',
    'title: ' + yamlStr(rec.fields['正面']),
    'chapter: ' + yamlStr(rec.fields['章节'] || ''),
    'tags: ' + tags,
    'source: anki-bridge',
    'anki_id: ' + rec.id,
    'deck: ' + yamlStr(rec.deck),
    'created: ' + rec.created,
    '---',
    '',
    '## 正面',
    '',
    String(rec.fields['正面'] || '').trim(),
    '',
    '## 背面',
    '',
    String(rec.fields['背面'] || '').trim(),
    '',
  ].join('\n');
}

function parseNote(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  const front = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      front[kv[1]] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
    } else if (v.startsWith('"') && v.endsWith('"')) {
      try { front[kv[1]] = JSON.parse(v); } catch { front[kv[1]] = v.slice(1, -1); }
    } else front[kv[1]] = v;
  }
  const body = text.slice(m[0].length);
  const pick = (name) => {
    const re = new RegExp('##\\s*' + name + '\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s|$)');
    const hit = re.exec(body);
    return hit ? hit[1].trim() : '';
  };
  return {
    id: String(front.anki_id || ''),
    deck: String(front.deck || '默认'),
    tags: Array.isArray(front.tags) ? front.tags : [],
    created: String(front.created || ''),
    fields: { '正面': pick('正面') || String(front.title || ''), '背面': pick('背面'), '章节': String(front.chapter || '') },
  };
}

async function walk(dir, out) {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

async function loadIndex() {
  index = new Map();
  const files = await walk(join(vault, ROOT_NAME), []);
  for (const f of files) {
    const rec = parseNote(await readFile(f, 'utf8'));
    if (rec && rec.id) index.set(rec.id, { path: f, deck: rec.deck });
  }
  await writeFile(join(vault, ROOT_NAME, INDEX_NAME), JSON.stringify([...index.keys()].map((k) => ({ id: k, path: index.get(k).path }))), 'utf8').catch(() => {});
  return index.size;
}

async function listDecks() {
  try {
    const ents = await readdir(join(vault, ROOT_NAME), { withFileTypes: true });
    return ents.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
}

// 重复卡判定：默认按全库正文字面比对（与 AnkiConnect 的 duplicateScope 语义对齐），
// 只比首字段——正面相同即视为同一张，背面补充内容不算新卡。
async function duplicateId(fields, deck, options) {
  const want = String(fields['正面'] || '').trim().toLowerCase();
  if (!want) return null;
  const scope = String((options && options.duplicateScope) || 'collection');
  for (const [id, hit] of index) {
    if (scope === 'deck' && hit.deck.toLowerCase() !== deck.toLowerCase()) continue;
    const rec = parseNote(await readFile(hit.path, 'utf8').catch(() => ''));
    if (rec && String(rec.fields['正面'] || '').trim().toLowerCase() === want) return id;
  }
  return null;
}

async function addNote(note) {
  if (!note || typeof note !== 'object') throw new Error('addNote: note required');
  const fields = {};
  for (const f of FIELDS) fields[f] = String((note.fields || {})[f] || '');
  if (!fields['正面'].trim()) throw new Error('addNote: 正面 不能为空');
  const deck = String(note.deckName || '默认');
  const options = note.options || {};
  if (!options.allowDuplicate) {
    const dup = await duplicateId(fields, deck, options);
    // 与 AnkiConnect 一致：重复时返回已存在的 id，调用方据此判定「已在库里」。
    if (dup) return dup;
  }
  const id = String(Date.now() * 1000 + (seq++ % 1000));
  const tags = Array.isArray(note.tags) ? note.tags.map(String) : [];
  const rec = { id, deck, tags, created: new Date().toISOString().slice(0, 10), fields };
  const dir = deckDir(deck);
  await mkdir(dir, { recursive: true });
  const path = join(dir, slug(fields['正面']) + '-' + id + '.md');
  await writeFile(path, renderNote(rec), 'utf8');
  index.set(id, { path, deck });
  return id;
}

async function updateFields(note) {
  const id = String((note && note.id) || '');
  const hit = index.get(id);
  if (!hit) return null;
  const old = parseNote(await readFile(hit.path, 'utf8'));
  if (!old) return null;
  for (const f of FIELDS) {
    if (note.fields && typeof note.fields[f] === 'string') old.fields[f] = note.fields[f];
  }
  await writeFile(hit.path, renderNote({ ...old, id, deck: old.deck }), 'utf8');
  return null;
}

async function deleteNotes(ids) {
  for (const raw of ids) {
    const hit = index.get(String(raw));
    if (!hit) continue;
    await unlink(hit.path).catch(() => {});
    index.delete(String(raw));
  }
  return null;
}

// 本库的卡片没有调度状态（没有 ivl/ease/到期时间），所以 Anki 的调度类运算符
// 只能保守处理：is:new / is:due 视为命中（新卡本来都待学），其余调度运算符直接不命中。
const SCHED_OPS = ['prop:', 'rated:', 'introduced:', 'edited:', 'resched:', 'flag:'];

function matches(rec, terms, now = Date.now()) {
  for (const t of terms) {
    const low = t.toLowerCase();
    if (!t) continue;
    if (low.startsWith('tag:')) {
      const want = low.slice(4);
      if (!rec.tags.some((x) => x.toLowerCase() === want)) return false;
    } else if (low.startsWith('deck:')) {
      if (rec.deck.toLowerCase() !== low.slice(5).toLowerCase()) return false;
    } else if (low.startsWith('nid:')) {
      if (rec.id !== t.slice(4)) return false;
    } else if (low === 'is:new' || low === 'is:due') {
      continue;
    } else if (low.startsWith('is:')) {
      return false;
    } else if (low.startsWith('added:')) {
      const days = Number(low.slice(6));
      const at = Date.parse(rec.created + 'T00:00:00Z');
      if (!Number.isFinite(days) || !Number.isFinite(at)) return false;
      if (now - at > days * 86400000) return false;
    } else if (SCHED_OPS.some((p) => low.startsWith(p))) {
      return false;
    } else if (t !== '*') {
      const hay = (rec.fields['正面'] + ' ' + rec.fields['背面'] + ' ' + rec.fields['章节']).toLowerCase();
      if (!hay.includes(low)) return false;
    }
  }
  return true;
}

async function findNotes(query) {
  const terms = String(query || '').split(/\s+/).filter(Boolean);
  const out = [];
  for (const [id, hit] of index) {
    const rec = parseNote(await readFile(hit.path, 'utf8').catch(() => ''));
    if (rec && matches(rec, terms)) out.push(id);
  }
  return out.sort();
}

async function notesInfo(ids) {
  const out = [];
  for (const raw of ids) {
    const id = String(raw);
    const hit = index.get(id);
    if (!hit) { out.push({ noteId: Number(id), modelName: MODEL, tags: [], fields: {}, cards: [] }); continue; }
    const rec = parseNote(await readFile(hit.path, 'utf8').catch(() => ''));
    out.push(rec
      ? { noteId: Number(id), modelName: MODEL, tags: rec.tags || [], fields: Object.fromEntries(Object.entries(rec.fields).map(([k, v]) => [k, { value: v, order: FIELDS.indexOf(k) }])), cards: [Number(id) + 1], deckName: rec.deck }
      : { noteId: Number(id), modelName: MODEL, tags: [], fields: {}, cards: [] });
  }
  return out;
}

async function storeMedia(params) {
  const dir = join(vault, ROOT_NAME, '_media');
  await mkdir(dir, { recursive: true });
  const name = slug(params.filename || 'media');
  const buf = Buffer.from(String(params.data || ''), 'base64');
  await writeFile(join(dir, name), buf);
  return name;
}

async function dispatch(action, params = {}) {
  switch (action) {
    case 'version': return 6;
    case 'deckNames': return ['默认', ...(await listDecks()).filter((d) => d !== '_media')];
    case 'createDeck': { await mkdir(deckDir(params.deck), { recursive: true }); return params.deck; }
    case 'modelNames': return [MODEL];
    case 'modelFieldNames': return FIELDS;
    case 'getTags': { const tags = new Set(); for (const hit of index.values()) { const rec = parseNote(await readFile(hit.path, 'utf8').catch(() => '')); if (rec) for (const t of rec.tags) tags.add(t); } return [...tags]; }
    case 'addNote': return await addNote(params.note);
    case 'addNotes': { const out = []; for (const n of params.notes || []) { try { out.push(await addNote(n)); } catch { out.push(null); } } return out; }
    // 取词器在真正写入前会批量预检，返 true 表示这张卡还能加（不含重复、正面非空）。
    case 'canAddNotes': {
      const out = [];
      for (const n of params.notes || []) {
        const fields = {};
        for (const f of FIELDS) fields[f] = String(((n && n.fields) || {})[f] || '');
        if (!fields['正面'].trim()) { out.push(false); continue; }
        const options = (n && n.options) || {};
        out.push(options.allowDuplicate ? true : !(await duplicateId(fields, String((n && n.deckName) || '默认'), options)));
      }
      return out;
    }
    // 批次分发：一条请求里跑多个动作，逐项返回 { result, error }，单项失败不影响其余。
    case 'multi': {
      const out = [];
      for (const a of params.actions || []) {
        try { out.push({ result: await dispatch(String(a && a.action), (a && a.params) || {}), error: null }); }
        catch (e) { out.push({ result: null, error: String((e && e.message) || e) }); }
      }
      return out;
    }
    case 'findNotes': return await findNotes(params.query);
    case 'notesInfo': return await notesInfo(params.notes || []);
    case 'updateNoteFields': return await updateFields(params.note);
    case 'deleteNotes': return await deleteNotes(params.notes || []);
    case 'storeMediaFile': return await storeMedia(params);
    case 'sync': case 'syncStatus': return null;
    default: throw new Error('unsupported action: ' + action);
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function start(port) {
  const server = createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') { send(204, {}); return; }
    if (req.method !== 'POST') { send(405, { result: null, error: 'POST only' }); return; }
    let payload;
    try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { send(400, { result: null, error: 'bad json' }); return; }
    const { action, params, version } = payload || {};
    if (version != null && version > 6) { send(200, { result: null, error: 'unsupported api version' }); return; }
    try { send(200, { result: await dispatch(action, params || {}), error: null }); }
    catch (e) { send(200, { result: null, error: String((e && e.message) || e) }); }
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok(server));
  });
}

async function rpc(port, action, params) {
  const r = await fetch('http://127.0.0.1:' + port, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params: params || {} }),
  });
  return await r.json();
}

async function selftest() {
  const dir = join(tmpdir(), 'kl-anki-' + Date.now());
  vault = dir;
  await mkdir(dir, { recursive: true });
  const server = await start(0);
  const port = server.address().port;
  try {
    const v = await rpc(port, 'version');
    if (v.result !== 6) throw new Error('version ' + JSON.stringify(v));
    const add = await rpc(port, 'addNote', { note: { deckName: '生理学', modelName: MODEL, fields: { '正面': '肾小球滤过率正常值', '背面': '约 125 mL/min', '章节': '生理学' }, tags: ['肾脏', '数值'] } });
    if (!add.result) throw new Error('addNote ' + JSON.stringify(add));
    const found = await rpc(port, 'findNotes', { query: 'tag:肾脏' });
    if (!found.result.includes(add.result)) throw new Error('findNotes ' + JSON.stringify(found));
    // 预检 / 重复 / 查询运算符 / 批次分发：取词器依赖这几条才不报错。
    const dupCheck = await rpc(port, 'canAddNotes', { notes: [
      { deckName: '生理学', fields: { '正面': '肾小球滤过率正常值' } },
      { deckName: '生理学', fields: { '正面': '全新的一张卡' } },
      { deckName: '生理学', fields: { '正面': '   ' } },
    ] });
    if (JSON.stringify(dupCheck.result) !== '[false,true,false]') throw new Error('canAddNotes ' + JSON.stringify(dupCheck));
    const dupAdd = await rpc(port, 'addNote', { note: { deckName: '生理学', fields: { '正面': '肾小球滤过率正常值' } } });
    if (dupAdd.result !== add.result) throw new Error('duplicate addNote ' + JSON.stringify(dupAdd));
    const dupAllow = await rpc(port, 'addNote', { note: { deckName: '生理学', fields: { '正面': '肾小球滤过率正常值' }, options: { allowDuplicate: true } } });
    if (!dupAllow.result || dupAllow.result === add.result) throw new Error('allowDuplicate ' + JSON.stringify(dupAllow));
    const isNew = await rpc(port, 'findNotes', { query: 'is:new' });
    if (!isNew.result.includes(add.result)) throw new Error('is:new ' + JSON.stringify(isNew));
    const added = await rpc(port, 'findNotes', { query: 'added:1' });
    if (added.result.length < 2) throw new Error('added:1 ' + JSON.stringify(added));
    const prop = await rpc(port, 'findNotes', { query: 'prop:ivl>=1' });
    if (prop.result.length !== 0) throw new Error('prop: ' + JSON.stringify(prop));
    const multi = await rpc(port, 'multi', { actions: [
      { action: 'version' },
      { action: 'nope' },
      { action: 'findNotes', params: { query: 'tag:肾脏' } },
    ] });
    if (multi.result[0].result !== 6 || !multi.result[1].error || !multi.result[2].result.length) throw new Error('multi ' + JSON.stringify(multi));
    const info = await rpc(port, 'notesInfo', { notes: [add.result] });
    if (info.result[0].fields['背面'].value !== '约 125 mL/min') throw new Error('notesInfo ' + JSON.stringify(info));
    await rpc(port, 'updateNoteFields', { note: { id: add.result, fields: { '背面': '约 125 mL/min（成年男性）' } } });
    const info2 = await rpc(port, 'notesInfo', { notes: [add.result] });
    if (info2.result[0].fields['背面'].value !== '约 125 mL/min（成年男性）') throw new Error('update ' + JSON.stringify(info2));
    await rpc(port, 'deleteNotes', { notes: [add.result] });
    const gone = await rpc(port, 'findNotes', { query: 'nid:' + add.result });
    if (gone.result.length !== 0) throw new Error('delete ' + JSON.stringify(gone));
    console.log('SELFTEST PASS');
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) { await selftest(); return; }
  let port = 8765;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--vault') vault = resolve(argv[++i]);
    else if (argv[i] === '--port') port = Number(argv[++i]);
  }
  if (!vault) { console.error('用法: node scripts/anki-bridge.mjs --vault <库目录> [--port 8765]'); process.exit(2); }
  await mkdir(join(vault, ROOT_NAME), { recursive: true });
  const n = await loadIndex();
  await start(port);
  console.log('anki-bridge 127.0.0.1:' + port + '  vault=' + vault + '  已索引 ' + n + ' 张');
}

main().catch((e) => { console.error(e); process.exit(1); });

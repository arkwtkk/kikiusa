// app.js — ききウサ（iPad 用オーディオブックプレーヤー）
import { AUDIO_EXT, IMAGE_EXT, SUB_EXT, extOf, baseName, mimeOf, parseAudioMeta, parseSubtitles, cueAt,
  isImagePack, imagePackBase, readZip, zipEntryBlob, parseImageManifest, imageAt, normDate } from './parse.js';
import * as db from './db.js';

const VERSION = '0.5';
const $ = (id) => document.getElementById(id);
const audio = $('audio');
const RATES = [0.75, 1, 1.1, 1.25, 1.5, 1.75, 2];
const SLEEPS = [5, 15, 30, 45, 60];
const SKIP_BACK = 15, SKIP_FWD = 30;
const COLORS = ['#2E4A7D', '#2F6B4F', '#8A3B45', '#3B3B3B', '#5B4A8A', '#7A5634'];

let books = [];
const coverUrls = new Map();     // coverId -> object URL
const P = {                       // 再生中の状態
  book: null, fi: 0, url: null, pendingSeek: null, chapterIdx: -1,
  lastSave: 0, pausedAt: 0, next: null, loadToken: 0, seekTries: 0, playAfterSeek: false,
};
let rate = Number(localStorage.getItem('kk.rate')) || 1;
let subsOn = localStorage.getItem('kk.subs') !== '0';
let imgsOn = localStorage.getItem('kk.imgs') !== '0';
let sleep = { mode: 'off', until: 0 };   // off | time | chapter
let seeking = false;

// ---------------- 小物 ----------------

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function byName(a, b) { return a.name.localeCompare(b.name, 'ja', { numeric: true, sensitivity: 'base' }); }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function hashColor(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) >>> 0; return COLORS[h % COLORS.length]; }

function clock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function jaDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h && m === 60) return `${h + 1}時間`;
  if (h) return m ? `${h}時間${m}分` : `${h}時間`;
  return m ? `${m}分` : `${sec}秒`;
}
function size(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + 'GB';
  if (bytes >= 1e6) return Math.round(bytes / 1e6) + 'MB';
  return Math.max(1, Math.round(bytes / 1e3)) + 'KB';
}

// ---------------- 期限（自動で消す） ----------------

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function md(s) { const [, m, d] = s.split('-'); return `${+m}/${+d}`; }
function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const CHOKAN = /^日経 朝刊 (\d{4})年(\d{1,2})月(\d{1,2})日付$/;
function paperDate(title) {
  const m = CHOKAN.exec(String(title || '').trim());
  return m ? normDate(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`) : null;
}
function shortTitle(t) { const m = CHOKAN.exec(String(t || '').trim()); return m ? `${+m[2]}/${+m[3]}付` : t; }
function autoExpireOn() { return localStorage.getItem('kk.expire') !== '0'; }

let toastTimer = 0;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function showBusy(text, ratio) {
  $('busy').hidden = false; $('busyText').textContent = text;
  const bar = $('busyBar');
  if (ratio == null) bar.removeAttribute('value'); else bar.value = ratio;
}
function hideBusy() { $('busy').hidden = true; }

function openSheet(build) {
  const body = $('sheetBody');
  body.replaceChildren();
  build(body);
  $('sheet').hidden = false;
}
function closeSheet() { $('sheet').hidden = true; $('sheetBody').replaceChildren(); }
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });

function actions(parent, list) {
  const row = el('div', 'sheet-actions');
  for (const [label, cls, fn] of list) {
    const b = el('button', cls, label);
    b.onclick = fn;
    row.append(b);
  }
  parent.append(row);
  return row;
}

// ---------------- 進み具合（localStorage：すぐ書ける） ----------------

function getProg(id) {
  try { return JSON.parse(localStorage.getItem('kk.p.' + id)) || null; } catch { return null; }
}
function setProg(id, f, t) {
  try { localStorage.setItem('kk.p.' + id, JSON.stringify({ f, t: Math.round(Math.max(0, t) * 10) / 10, at: Date.now() })); } catch { }
}
function fileOffset(book, fi) {
  let s = 0;
  for (let i = 0; i < fi && i < book.files.length; i++) s += book.files[i].duration || 0;
  return s;
}
function bookPos(book) {
  if (P.book === book && P.pendingSeek == null) return fileOffset(book, P.fi) + (audio.currentTime || 0);
  if (P.book === book && P.pendingSeek != null) return fileOffset(book, P.fi) + P.pendingSeek;
  const p = getProg(book.id);
  return p ? fileOffset(book, p.f) + p.t : 0;
}
function lastActivity(b) { const p = getProg(b.id); return Math.max(p ? p.at : 0, b.addedAt || 0); }

// ---------------- 表紙 ----------------

async function coverUrl(book) {
  if (!book.coverId) return null;
  if (coverUrls.has(book.coverId)) return coverUrls.get(book.coverId);
  const blob = await db.getBlob(book.coverId).catch(() => null);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  coverUrls.set(book.coverId, url);
  return url;
}
function fillCover(box, book) {
  box.replaceChildren();
  box.style.background = hashColor(book.title);
  box.append(el('div', 'ph', book.title));
  coverUrl(book).then(url => {
    if (!url) return;
    const img = new Image();
    img.alt = '';
    img.onload = () => { box.replaceChildren(img); box.style.background = 'transparent'; };
    img.src = url;
  });
}

// ---------------- 本棚 ----------------

async function refreshLibrary() {
  books = await db.allBooks();
  books.sort((a, b) => lastActivity(b) - lastActivity(a));
  renderLibrary();
}

function renderLibrary() {
  const grid = $('books');
  grid.replaceChildren();
  $('empty').hidden = books.length > 0;
  for (const b of books) {
    const card = el('div', 'card' + (P.book && P.book.id === b.id ? ' now' : ''));
    const cov = el('div', 'cover');
    fillCover(cov, b);
    const pos = bookPos(b);
    const dur = b.duration || 0;
    const pct = b.finished ? 100 : dur ? Math.min(100, pos / dur * 100) : 0;
    let meta;
    if (b.finished) meta = '聞き終わり';
    else if (pos < 5) meta = `未再生・${jaDur(dur)}`;
    else meta = `残り ${jaDur(Math.max(0, dur - pos))}`;
    const bar = el('div', 'card-bar'); const fill = el('i'); fill.style.width = pct + '%'; bar.append(fill);
    const more = el('button', 'card-more', '…');
    more.setAttribute('aria-label', '本のメニュー');
    more.onclick = (e) => { e.stopPropagation(); bookMenu(b); };
    card.append(cov, el('div', 'card-title', b.title), el('div', 'card-meta', meta), bar, more);
    if (b.expireAt && autoExpireOn()) card.insertBefore(el('div', 'card-exp', `${md(b.expireAt)} に消えます`), bar);
    card.onclick = () => openBook(b);
    grid.append(card);
  }
  renderMini();
  renderStorage();
}

async function renderStorage() {
  const used = books.reduce((s, b) => s + b.files.reduce((t, f) => t + (f.size || 0), 0), 0);
  let text = `${books.length}冊・${size(used)}`;
  try {
    const est = await navigator.storage?.estimate?.();
    if (est && est.quota) text += `（空きの目安 ${size(Math.max(0, est.quota - est.usage))}）`;
  } catch { }
  $('storage').textContent = text;
  $('version').textContent = 'ききウサ v' + VERSION;
}

function bookMenu(b) {
  openSheet(body => {
    body.append(el('h2', null, b.title));
    const info = el('p', 'muted', `${b.chapters.length}章・${jaDur(b.duration)}・${size(b.files.reduce((s, f) => s + (f.size || 0), 0))}`
      + (b.expireAt ? `・${md(b.expireAt)} に自動で消えます` : ''));
    const opts = el('div', 'opts');
    const add = (label, fn, cls) => { const x = el('button', cls, label); x.onclick = fn; opts.append(x); };
    add('名前を変える', () => renameBook(b));
    add('最初から聞く', async () => {
      closeSheet();
      b.finished = false; await db.putBook(b);
      setProg(b.id, 0, 0);
      if (P.book && P.book.id === b.id) { await loadFile(0, 0, false); renderPlayer(); }
      renderLibrary();
    });
    add(b.finished ? '「聞き終わり」を外す' : '聞き終わりにする', async () => {
      closeSheet(); b.finished = !b.finished; await db.putBook(b); renderLibrary();
    });
    add('字幕・写真を追加', () => {
      closeSheet(); subTarget = b;
      const i = $('subInput'); i.value = ''; i.click();
    });
    if (hasSubs(b)) add('字幕を外す', async () => {
      closeSheet();
      b.files.forEach(f => { delete f.cues; });
      await db.putBook(b);
      if (P.book && P.book.id === b.id) renderPlayer();
      toast('字幕を外しました');
    });
    if (hasImages(b)) add('写真を外す', async () => {
      closeSheet();
      const ids = b.images.map(x => x.blobId);
      delete b.images;
      await db.putBook(b);
      await db.deleteBlobs(ids).catch(() => { });
      if (P.book && P.book.id === b.id) renderPlayer();
      renderLibrary();
      toast('写真を外しました');
    });
    if (b.expireAt) add('自動で消さない', async () => {
      closeSheet();
      delete b.expireAt; b.noExpire = true;
      await db.putBook(b);
      renderLibrary();
      toast('この本は自動では消しません');
    });
    add('削除する', () => confirmDelete(b), 'danger');
    body.append(info, opts);
    actions(body, [['閉じる', 'cancel', closeSheet]]);
  });
}

function renameBook(b) {
  openSheet(body => {
    body.append(el('h2', null, '名前を変える'));
    const input = el('input', 'field'); input.type = 'text'; input.value = b.title;
    body.append(input);
    actions(body, [
      ['やめる', 'cancel', closeSheet],
      ['保存', 'go', async () => {
        const v = input.value.trim(); if (!v) return;
        b.title = v; await db.putBook(b); closeSheet();
        renderLibrary(); if (P.book === b) { renderPlayer(); updateMediaMetadata(); }
      }],
    ]);
    setTimeout(() => input.focus(), 50);
  });
}

function confirmDelete(b) {
  openSheet(body => {
    body.append(el('h2', null, '本を削除しますか？'));
    body.append(el('p', null, `「${b.title}」を本棚から消し、iPad の中の音声も消します。OneDrive のファイルは消えません。`));
    actions(body, [
      ['やめる', 'cancel', closeSheet],
      ['削除する', 'go danger', async () => {
        closeSheet();
        await removeBook(b);
        await refreshLibrary();
        toast('削除しました');
      }],
    ]);
  });
}

// 本・音声・表紙・写真・字幕・位置を消す（削除と自動で消すの共通）
async function removeBook(b) {
  if (P.book && P.book.id === b.id) unloadBook();
  await db.deleteBook(b);
  try {
    localStorage.removeItem('kk.p.' + b.id);
    if (localStorage.getItem('kk.last') === b.id) localStorage.removeItem('kk.last');
  } catch { }
  if (b.coverId && coverUrls.has(b.coverId)) { URL.revokeObjectURL(coverUrls.get(b.coverId)); coverUrls.delete(b.coverId); }
}

// 期限の来た本を消す。今開いている本・再生中の本は消さない（ほかの本を開いたとき・次に起動したときに消える）
let sweeping = false;
async function sweepExpired({ notify = true } = {}) {
  if (sweeping || !autoExpireOn()) return '';
  sweeping = true;
  try {
    const today = todayStr();
    const all = await db.allBooks().catch(() => books);
    const due = all.filter(b => b.expireAt && b.expireAt <= today && !(P.book && P.book.id === b.id));
    if (!due.length) return '';
    const gone = [];
    for (const b of due) {
      try { await removeBook(b); gone.push(b); } catch { }
    }
    await refreshLibrary();
    if (!gone.length) return '';
    gone.sort((x, y) => x.expireAt < y.expireAt ? -1 : x.expireAt > y.expireAt ? 1 : 0);
    const msg = `期限の来た本を${gone.length}冊消しました（${gone.map(b => shortTitle(b.title)).join('・')}）`;
    if (notify) toast(msg, 6000);
    return msg;
  } finally { sweeping = false; }
}

// v0.3.1 までに取り込んだ朝刊の本（期限のタグなし）を、1回だけ聞いて期限を付ける
function askLegacyOnce() {
  if (localStorage.getItem('kk.expireAsked')) return;
  localStorage.setItem('kk.expireAsked', '1');   // 聞くのは v0.4 を初めて開いたときの1回だけ
  const list = books.filter(b => !b.expireAt && !b.noExpire && paperDate(b.title));
  if (!list.length) return;
  const today = todayStr();
  const bytes = list.reduce((s, b) => s + b.files.reduce((t, f) => t + (f.size || 0), 0), 0);
  const past = list.filter(b => addDays(paperDate(b.title), 14) <= today).length;
  openSheet(body => {
    body.append(el('h2', null, '朝刊の本を自動で消しますか？'));
    body.append(el('p', null, `以前に取り込んだ朝刊の本が ${list.length}冊あります（合計 約 ${size(bytes)}）。新聞の日付から14日で自動で消すようにしますか？`
      + (past ? `（うち ${past}冊はもう14日を過ぎているので、すぐ消えます）` : '')));
    actions(body, [
      ['しない', 'cancel', closeSheet],
      ['そうする', 'go', async () => {
        closeSheet();
        for (const b of list) { b.expireAt = addDays(paperDate(b.title), 14); await db.putBook(b).catch(() => { }); }
        renderLibrary();
        if (!(await sweepExpired())) toast('朝刊の本は、新聞の日付から14日で自動で消えます');
      }],
    ]);
  });
}

// ---------------- 取り込み ----------------

$('btnImport').onclick = () => { const i = $('fileInput'); i.value = ''; i.click(); };
$('fileInput').onchange = (e) => { const files = [...e.target.files]; if (files.length) planImport(files); };
$('subInput').onchange = (e) => {
  const files = [...e.target.files];
  const b = subTarget; subTarget = null;
  if (b && files.length) addExtrasToBook(b, files);
};

// 音声ファイルと同じ名前の字幕を探す。1ファイルの本で字幕が1つだけなら名前が違っても使う
function matchSubs(audioFiles, subs) {
  const out = audioFiles.map(f => subs.find(x => baseName(x.name) === baseName(f.name)) || null);
  if (audioFiles.length === 1 && !out[0] && subs.length === 1) out[0] = subs[0];
  return out;
}
function hasSubs(book) { return !!book && book.files.some(f => f.cues && f.cues.length); }

function hasImages(book) { return !!book && Array.isArray(book.images) && book.images.length > 0; }

// 写真の包み（<本>.images.zip）を読み、本の音声ファイルに割り当てる（まだ保存しない）
async function readImagePack(zipFile, audioNames) {
  const entries = await readZip(zipFile);
  const man = entries.find(e => /(^|\/)images\.json$/i.test(e.name));
  if (!man) throw new Error('images.json がありません');
  const list = parseImageManifest(await (await zipEntryBlob(zipFile, man)).text());
  const items = [];
  for (const x of list) {
    let fi = -1;
    if (x.audio) fi = audioNames.findIndex(n => n === x.audio || baseName(n) === baseName(x.audio));
    else if (audioNames.length === 1) fi = 0;
    if (fi < 0) continue;
    const ent = entries.find(e => e.name === x.file) || entries.find(e => e.name.split('/').pop() === x.file);
    if (!ent || !IMAGE_EXT.includes(extOf(ent.name))) continue;
    items.push({ ...x, fi, entry: ent });
  }
  return { zipFile, items };
}
// 画像として開けるか（createImageBitmap、使えなければ Image）
function imageDecodes(blob) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    let done = false;
    const fin = (ok) => { if (done) return; done = true; URL.revokeObjectURL(url); resolve(ok); };
    img.onload = () => fin(img.naturalWidth > 0);
    img.onerror = () => fin(false);
    setTimeout(() => fin(false), 10000);
    img.src = url;
  });
}
async function canDecode(blob) {
  if (typeof createImageBitmap === 'function') {
    try { const bm = await createImageBitmap(blob); if (bm && bm.close) bm.close(); return true; } catch { }
  }
  return imageDecodes(blob);
}
// zip の中の写真を1枚、中身を読み切ってから確かめて返す（v0.3.1：ファイルの slice をそのまま保存しない）
async function readImageEntry(zipFile, entry) {
  const raw = await zipEntryBlob(zipFile, entry);
  const buf = await raw.arrayBuffer();
  if (!buf.byteLength) throw new Error('中身が空です');
  if (entry.method === 0 && (buf.byteLength !== entry.csize || buf.byteLength !== entry.usize)) throw new Error('大きさが合いません');
  if (entry.method === 8 && buf.byteLength !== entry.usize) throw new Error('大きさが合いません');
  const blob = new Blob([buf], { type: mimeOf(entry.name) });
  if (!(await canDecode(blob))) throw new Error('画像として開けません');
  return blob;
}
// 戻り値 { images, failed }。読めなかった写真は1回だけ読み直し、だめなら外す
async function saveImagePack(bookId, pack, saved) {
  const out = [];
  let failed = 0;
  const tag = Date.now().toString(36);
  for (const [k, x] of pack.items.entries()) {
    let blob = null;
    for (let attempt = 0; attempt < 2 && !blob; attempt++) {
      try { blob = await readImageEntry(pack.zipFile, x.entry); } catch { blob = null; }
    }
    if (!blob) { failed++; continue; }
    const blobId = `${bookId}.img${tag}_${k}`;
    await db.putBlob(blobId, blob);
    saved.push(blobId);
    out.push({ blobId, file: x.fi, s: x.s, e: x.e, caption: x.caption });
  }
  out.sort((a, b) => a.file - b.file || a.s - b.s);
  return { images: out, failed };
}
function imageResultMsg(n, failed) {
  if (!failed) return `写真 ${n}枚を取り込みました`;
  if (!n) return `写真は読めませんでした（${failed}枚）。もう一度「字幕・写真を追加」で選び直してください`;
  return `写真 ${n}枚を取り込みました（${failed}枚は読めませんでした。もう一度「字幕・写真を追加」で選び直してください）`;
}
// 保存した音声・表紙を読み戻して大きさを確かめる
async function checkSaved(blobId, size) {
  const back = await db.getBlob(blobId).catch(() => null);
  if (!back || back.size !== size) throw new Error('ファイルを読めませんでした。OneDrive でファイルを iPad にダウンロードしてから選び直してください');
}
function findPack(names, packs, allowSingle) {
  return packs.find(z => names.includes(imagePackBase(z.name))) || (allowSingle && packs.length === 1 ? packs[0] : null);
}

let subTarget = null;
async function addExtrasToBook(book, files) {
  const subs = files.filter(f => SUB_EXT.includes(extOf(f.name)));
  const packs = files.filter(f => isImagePack(f.name));
  if (!subs.length && !packs.length) { toast('字幕（.vtt・.srt）か写真の包み（.images.zip）を選んでください', 5000); return; }
  const msgs = [];
  if (subs.length) {
    const matched = matchSubs(book.files, subs);
    let cueCount = 0;
    for (const [i, sf] of matched.entries()) {
      if (!sf) continue;
      const cues = parseSubtitles(await sf.text().catch(() => ''));
      if (!cues.length) continue;
      book.files[i].cues = cues; cueCount += cues.length;
    }
    msgs.push(cueCount ? `字幕 ${cueCount}件` : '字幕は合う名前がありませんでした');
  }
  if (packs.length) {
    const z = findPack([book.title, ...book.files.map(f => baseName(f.name))], packs, true);
    const saved = [];
    try {
      showBusy('写真を取り込んでいます…');
      const pack = await readImagePack(z, book.files.map(f => f.name));
      if (!pack.items.length) throw new Error('この本の音声に合う写真がありません');
      const res = await saveImagePack(book.id, pack, saved);
      if (!res.images.length) throw new Error(`${res.failed}枚とも読めませんでした。もう一度選び直してください`);
      const old = (book.images || []).map(x => x.blobId);
      book.images = res.images;
      await db.putBook(book);
      await db.deleteBlobs(old).catch(() => { });
      badNotified = null;
      msgs.push(imageResultMsg(res.images.length, res.failed));
    } catch (e) {
      await db.deleteBlobs(saved).catch(() => { });
      msgs.push(`写真は取り込めませんでした（${e && e.message || e}）`);
    } finally { hideBusy(); }
  }
  await db.putBook(book);
  if (P.book && P.book.id === book.id) { P.book = book; renderPlayer(); }
  renderLibrary();
  toast(msgs.join('・'), 5000);
}

function stripNum(s) { return s.replace(/^\s*\d+\s*[_\-.\s]\s*/, '').trim() || s; }
function sameFiles(book, files) {
  if (book.files.length !== files.length) return false;
  const a = book.files.map(f => f.name + '/' + f.size).sort().join('|');
  const b = files.map(f => f.name + '/' + f.size).sort().join('|');
  return a === b;
}
function commonPrefix(names) {
  if (!names.length) return '';
  let p = names[0];
  for (const n of names) { while (!n.startsWith(p)) p = p.slice(0, -1); }
  return p.replace(/[\s_\-.(（\d]+$/, '').trim();
}
function groupTitle(files, metas) {
  const albums = files.map(f => metas.get(f).album).filter(Boolean);
  if (albums.length === files.length && albums.every(a => a === albums[0])) return albums[0];
  if (files.length === 1) return metas.get(files[0]).title || baseName(files[0].name);
  const pre = commonPrefix(files.map(f => baseName(f.name)));
  if (pre.length >= 2) return pre;
  return albums[0] || baseName(files[0].name);
}

async function planImport(files) {
  const audios = files.filter(f => AUDIO_EXT.includes(extOf(f.name)));
  const images = files.filter(f => IMAGE_EXT.includes(extOf(f.name)));
  const subs = files.filter(f => SUB_EXT.includes(extOf(f.name)));
  const packs = files.filter(f => isImagePack(f.name));
  if (!audios.length) {
    toast(subs.length || packs.length ? '字幕・写真だけを足すときは、本の「…」→「字幕・写真を追加」から選んでください' : '音声ファイル（.m4b・.mp3 など）が選ばれていません', 5000);
    return;
  }
  showBusy('ファイルを調べています…');
  const metas = new Map();
  for (const f of audios) metas.set(f, await parseAudioMeta(f, f.name).catch(() => ({})));
  hideBusy();

  const plans = [];
  for (const f of audios.filter(f => extOf(f.name) === 'm4b')) {
    const m = metas.get(f);
    plans.push({ files: [f], title: m.title || m.album || baseName(f.name), author: m.artist || '', expires: m.expires || null });
  }
  const rest = audios.filter(f => extOf(f.name) !== 'm4b').sort(byName);
  if (rest.length) {
    const artists = rest.map(f => metas.get(f).artist).filter(Boolean);
    plans.push({ files: rest, title: groupTitle(rest, metas), author: artists[0] || '' });
  }
  for (const p of plans) {
    p.coverFile = images.find(im => baseName(im.name) === baseName(p.files[0].name))
      || images.find(im => /^(cover|folder|front)$/i.test(baseName(im.name)))
      || (images.length === 1 ? images[0] : null);
    p.embedded = p.files.map(f => metas.get(f).cover).find(Boolean) || null;
    p.chapterCount = p.files.reduce((s, f) => s + Math.max(1, (metas.get(f).chapters || []).length), 0);
    p.duration = p.files.reduce((s, f) => s + (metas.get(f).duration || 0), 0);
    p.bytes = p.files.reduce((s, f) => s + f.size, 0);
    p.subs = matchSubs(p.files, subs);
    p.pack = null;
    const z = findPack([p.title, ...p.files.map(f => baseName(f.name))], packs, plans.length === 1);
    if (z) {
      try { p.pack = await readImagePack(z, p.files.map(f => f.name)); }
      catch (e) { p.packError = String(e && e.message || e); }
    }
    p.dup = books.some(b => sameFiles(b, p.files));
    p.include = !p.dup;
    if (p.expires) {
      p.expired = p.expires <= todayStr();
      p.autoExpire = !p.expired;
      if (p.expired) p.include = false;
    }
  }
  showImportSheet(plans, metas);
}

function showImportSheet(plans, metas) {
  openSheet(body => {
    body.append(el('h2', null, plans.length > 1 ? `${plans.length}冊を取り込みます` : '本を取り込みます'));
    for (const p of plans) {
      const row = el('div', 'plan');
      const cb = el('input', 'inc-cb'); cb.type = 'checkbox'; cb.checked = p.include;
      cb.onchange = () => { p.include = cb.checked; };
      const main = el('div', 'plan-main');
      const name = el('input'); name.type = 'text'; name.value = p.title;
      name.oninput = () => { p.title = name.value; };
      const parts = [p.files.length > 1 ? `${p.files.length}ファイル` : extOf(p.files[0].name).toUpperCase(), `${p.chapterCount}章`];
      if (p.duration) parts.push(jaDur(p.duration));
      parts.push(size(p.bytes));
      parts.push(p.coverFile || p.embedded ? '表紙あり' : '表紙なし');
      if (p.subs.some(Boolean)) parts.push('字幕あり');
      if (p.pack && p.pack.items.length) parts.push(`写真${p.pack.items.length}枚`);
      main.append(name, el('div', 'plan-meta', parts.join('・')));
      if (p.expires && !p.expired) {
        const lab = el('label', 'plan-exp');
        const ec = el('input', 'exp-cb'); ec.type = 'checkbox'; ec.checked = p.autoExpire;
        const txt = el('span', null, '');
        const show = () => { txt.textContent = ec.checked ? `${md(p.expires)} に自動で消します` : '自動で消す（今は消さない）'; };
        ec.onchange = () => { p.autoExpire = ec.checked; show(); };
        show();
        lab.append(ec, txt);
        main.append(lab);
      }
      if (p.expired) main.append(el('div', 'plan-warn', `期限（${md(p.expires)}）が${p.expires === todayStr() ? '来ています' : '過ぎています'}。取り込むときは自動では消しません`));
      if (p.dup) main.append(el('div', 'plan-warn', '同じ本がもう本棚にあります（取り込むと2冊になります）'));
      if (p.packError) main.append(el('div', 'plan-warn', `写真の包みを読めませんでした：${p.packError}`));
      row.append(cb, main);
      body.append(row);
    }
    actions(body, [
      ['やめる', 'cancel', closeSheet],
      ['取り込む', 'go', () => {
        const chosen = plans.filter(p => p.include && p.title.trim());
        closeSheet();
        if (chosen.length) doImport(chosen, metas);
      }],
    ]);
  });
}

function measureDuration(blob) {
  return new Promise(resolve => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    let done = false;
    const fin = (d) => {
      if (done) return; done = true;
      URL.revokeObjectURL(url); a.removeAttribute('src'); try { a.load(); } catch { }
      resolve(d);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => fin(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => fin(0);
    setTimeout(() => fin(0), 4000);
    a.src = url;
  });
}

function buildChapters(files, metas) {
  const ch = [];
  files.forEach((f, i) => {
    const m = metas[i] || {};
    const dur = f.duration || 0;
    const list = (m.chapters || []).filter(c => !dur || c.start < dur - 0.5);
    if (list.length) {
      if (list[0].start > 1) list.unshift({ start: 0, title: m.title || stripNum(baseName(f.name)) });
      list.forEach((c, j) => ch.push({
        title: c.title || `第${j + 1}章`, file: i, start: c.start,
        end: j + 1 < list.length ? list[j + 1].start : dur,
      }));
    } else {
      ch.push({ title: m.title || stripNum(baseName(f.name)), file: i, start: 0, end: dur });
    }
  });
  return ch;
}

async function doImport(plans, metas) {
  try { await navigator.storage?.persist?.(); } catch { }
  let made = 0;
  const imgMsgs = [];
  for (const [pi, p] of plans.entries()) {
    const id = uid();
    const saved = [];
    try {
      const files = [];
      for (const [j, f] of p.files.entries()) {
        showBusy(`取り込み中 ${pi + 1}/${plans.length}：${p.title}（${j + 1}/${p.files.length}）`, (j) / p.files.length);
        const m = metas.get(f) || {};
        const blob = new Blob([f], { type: mimeOf(f.name) });
        const blobId = `${id}.${j}`;
        await db.putBlob(blobId, blob);
        saved.push(blobId);
        await checkSaved(blobId, f.size);
        let dur = m.duration || 0;
        if (!dur) dur = await measureDuration(blob);
        const entry = { blobId, name: f.name, size: f.size, type: blob.type, duration: dur };
        if (p.subs && p.subs[j]) {
          const cues = parseSubtitles(await p.subs[j].text().catch(() => ''));
          if (cues.length) entry.cues = cues;
        }
        files.push(entry);
      }
      let coverId = null;
      const coverBlob = p.coverFile ? new Blob([p.coverFile], { type: mimeOf(p.coverFile.name) }) : p.embedded;
      if (coverBlob) {
        coverId = `${id}.cover`;
        await db.putBlob(coverId, coverBlob); saved.push(coverId);
        await checkSaved(coverId, coverBlob.size);
      }
      const book = {
        id, title: p.title.trim(), author: p.author || '', addedAt: Date.now(), finished: false,
        files, coverId,
        chapters: buildChapters(files, p.files.map(f => metas.get(f))),
        duration: files.reduce((s, f) => s + (f.duration || 0), 0),
      };
      if (p.expires) {
        if (p.autoExpire && !p.expired) book.expireAt = p.expires;
        else book.noExpire = true;
      }
      if (p.pack && p.pack.items.length) {
        showBusy(`取り込み中 ${pi + 1}/${plans.length}：${p.title}（写真）`, 1);
        const res = await saveImagePack(id, p.pack, saved);
        if (res.images.length) book.images = res.images;
        imgMsgs.push((plans.length > 1 ? `${p.title}：` : '') + imageResultMsg(res.images.length, res.failed));
      }
      await db.putBook(book);
      made++;
    } catch (e) {
      await db.deleteBlobs(saved).catch(() => { });
      hideBusy();
      const msg = db.isQuotaError(e) ? 'iPad の空き容量が足りません。いらない本を削除してから取り込んでください。'
        : `取り込めませんでした：${e && e.message || e}`;
      openSheet(body => { body.append(el('h2', null, p.title), el('p', null, msg)); actions(body, [['閉じる', 'go', closeSheet]]); });
      break;
    }
  }
  hideBusy();
  await refreshLibrary();
  const swept = await sweepExpired({ notify: !made });
  if (made) {
    const base = made > 1 ? `${made}冊を取り込みました` : '取り込みました';
    const msgs = [...imgMsgs]; if (swept) msgs.push(swept);
    toast(msgs.length ? `${base}・${msgs.join('・')}` : base, msgs.length ? 7000 : 3200);
  }
}

// ---------------- 再生 ----------------

function chapterIndexAt(fi, t) {
  const ch = P.book ? P.book.chapters : [];
  let idx = -1;
  for (let i = 0; i < ch.length; i++) {
    if (ch[i].file < fi || (ch[i].file === fi && ch[i].start <= t + 0.05)) idx = i;
    else break;
  }
  return Math.max(0, idx);
}
function chapterEnd(ch) {
  if (ch.end) return ch.end;
  const f = P.book.files[ch.file];
  if (ch.file === P.fi && isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  return f.duration || ch.start;
}
function curTime() { return P.pendingSeek != null ? P.pendingSeek : (audio.currentTime || 0); }

async function openBook(book) {
  showView('player');
  if (P.book && P.book.id === book.id) { renderPlayer(); return; }
  if (P.book) { saveNow(); audio.pause(); }
  P.book = book; P.chapterIdx = -1;
  clearNext();
  let fi = 0, t = 0;
  const pr = getProg(book.id);
  if (pr && !book.finished) { fi = Math.min(Math.max(0, pr.f | 0), book.files.length - 1); t = pr.t || 0; }
  P.fi = fi; P.pendingSeek = t;
  renderPlayer();
  sweepExpired();   // 前に開いていた本が期限切れなら、ここで消える
  await loadFile(fi, t, false);
}

function unloadBook() {
  audio.pause();
  audio.removeAttribute('src'); try { audio.load(); } catch { }
  if (P.url) URL.revokeObjectURL(P.url);
  clearNext();
  Object.assign(P, { book: null, fi: 0, url: null, pendingSeek: null, chapterIdx: -1 });
  clearSleep();
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  showView('library');
}

function clearNext() {
  if (P.next && P.next.url) URL.revokeObjectURL(P.next.url);
  P.next = null;
}

// 次のファイルを先に用意しておく（画面ロック中に IndexedDB を待たずに次へ進めるように）
async function prepareNext() {
  const b = P.book; if (!b) return;
  const fi = P.fi + 1;
  if (fi >= b.files.length || (P.next && P.next.fi === fi)) return;
  clearNext();
  const blob = await db.getBlob(b.files[fi].blobId).catch(() => null);
  if (!blob || P.book !== b || P.fi + 1 !== fi) return;
  P.next = { fi, url: URL.createObjectURL(blob) };
}

async function loadFile(fi, t, autoplay) {
  const b = P.book; if (!b) return;
  const token = ++P.loadToken;
  let url;
  if (P.next && P.next.fi === fi) { url = P.next.url; P.next = null; }
  else {
    const blob = await db.getBlob(b.files[fi].blobId).catch(() => null);
    if (P.book !== b || token !== P.loadToken) return;
    if (!blob) { toast('音声が見つかりません。本を取り込み直してください。'); return; }
    url = URL.createObjectURL(blob);
  }
  if (P.url) URL.revokeObjectURL(P.url);
  clearNext();
  P.url = url; P.fi = fi;
  P.pendingSeek = t > 0.3 ? t : null;
  P.seekTries = 0;
  P.playAfterSeek = !!autoplay && P.pendingSeek != null;   // 位置を合わせてから鳴らす
  P.chapterIdx = chapterIndexAt(fi, t);
  audio.src = url;
  audio.defaultPlaybackRate = rate; audio.playbackRate = rate;
  updateMediaMetadata();
  renderPlayer();
  if (autoplay && !P.playAfterSeek) doPlay();
}

function applyPendingSeek() {
  if (P.pendingSeek == null || audio.readyState < 1) return;
  let t = P.pendingSeek;
  if (isFinite(audio.duration) && audio.duration > 0) t = Math.min(t, Math.max(0, audio.duration - 1));
  if (Math.abs(audio.currentTime - t) < 0.5) {
    P.pendingSeek = null; P.seekTries = 0;
    if (P.playAfterSeek) { P.playAfterSeek = false; doPlay(); }
    return;
  }
  if (++P.seekTries > 30) {          // どうしても動かないときはあきらめて今の位置から
    P.pendingSeek = null; P.seekTries = 0;
    if (P.playAfterSeek) { P.playAfterSeek = false; doPlay(); }
    return;
  }
  try { audio.currentTime = t; } catch { }
}

function doPlay() {
  if (!P.book) return;
  bgmPrime();   // ▶ を押したとき（ユーザーの操作の中）に BGM の音の通り道を作る
  if (!audio.src) { toast('準備中です。もう一度押してください'); return; }
  if (P.book.finished) { P.book.finished = false; db.putBook(P.book); }
  if (P.pausedAt && Date.now() - P.pausedAt > 60000 && P.pendingSeek == null && audio.currentTime > 3) {
    audio.currentTime = Math.max(0, audio.currentTime - 3);   // しばらく止めていたら3秒もどる
  }
  audio.playbackRate = rate;
  if (P.pendingSeek != null && audio.readyState >= 1) applyPendingSeek();
  const pr = audio.play();
  if (pr) pr.catch(err => {
    if (err && err.name === 'AbortError') return;
    toast(err && err.name === 'NotAllowedError' ? 'もう一度 ▶ を押してください' : `再生できませんでした：${err && err.message || err}`);
  });
}
function togglePlay() { if (audio.paused) doPlay(); else audio.pause(); }

function saveNow() {
  if (!P.book || !audio.src) return;
  setProg(P.book.id, P.fi, curTime());
  P.lastSave = Date.now();
}

async function seekBook(fi, t, keepPlaying = !audio.paused) {
  const b = P.book; if (!b) return;
  fi = Math.max(0, Math.min(fi, b.files.length - 1));
  P.chapterIdx = chapterIndexAt(fi, t);
  if (fi === P.fi && audio.src) {
    if (P.pendingSeek != null) P.pendingSeek = t;
    else { try { audio.currentTime = Math.max(0, t); } catch { P.pendingSeek = t; } }
    saveNow(); renderPlayer(); updateMediaMetadata(); updatePositionState();
  } else {
    await loadFile(fi, t, keepPlaying);
    saveNow();
  }
}

function skip(sec) {
  const b = P.book; if (!b) return;
  let fi = P.fi, t = curTime() + sec;
  const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (b.files[fi].duration || 0);
  if (t > dur - 0.3) {
    if (fi + 1 < b.files.length) { t = Math.min(t - dur, (b.files[fi + 1].duration || 1) - 1); fi++; }
    else t = Math.max(0, dur - 0.5);
  } else if (t < 0) {
    if (fi > 0) { fi--; t = Math.max(0, (b.files[fi].duration || 0) + t); }
    else t = 0;
  }
  seekBook(fi, Math.max(0, t));
}

function gotoChapter(i) {
  const ch = P.book.chapters[i]; if (!ch) return;
  seekBook(ch.file, ch.start);
}
function prevChapter() {
  const i = chapterIndexAt(P.fi, curTime());
  const ch = P.book.chapters[i];
  if (curTime() - ch.start > 3 || i === 0) gotoChapter(i); else gotoChapter(i - 1);
}
function nextChapter() {
  const i = chapterIndexAt(P.fi, curTime());
  if (i + 1 < P.book.chapters.length) gotoChapter(i + 1);
  else toast('最後の章です');
}

// 音声の出来事
['loadedmetadata', 'canplay', 'playing', 'seeked', 'timeupdate'].forEach(ev => audio.addEventListener(ev, applyPendingSeek));
audio.addEventListener('loadedmetadata', () => {
  audio.playbackRate = rate;
  fixDuration();
  updatePositionState();
  renderPlayer();
});
audio.addEventListener('play', () => { renderPlayState(); updatePositionState(); });
audio.addEventListener('playing', () => { prepareNext(); renderPlayState(); });
audio.addEventListener('pause', () => { P.pausedAt = Date.now(); saveNow(); renderPlayState(); updatePositionState(); });
audio.addEventListener('ratechange', updatePositionState);
audio.addEventListener('seeked', updatePositionState);
audio.addEventListener('timeupdate', onTime);
audio.addEventListener('ended', onEnded);
audio.addEventListener('error', () => {
  if (!audio.src || !P.book) return;
  toast('この音声は再生できませんでした（形式に対応していない可能性があります）');
});

// 実際の長さが取り込み時の見積もりと違ったら直す
function fixDuration() {
  const b = P.book; if (!b) return;
  const d = audio.duration;
  if (!isFinite(d) || d <= 0) return;
  const f = b.files[P.fi];
  if (Math.abs((f.duration || 0) - d) < 1) return;
  const old = f.duration || 0;
  f.duration = d;
  for (const ch of b.chapters) if (ch.file === P.fi && (!ch.end || Math.abs(ch.end - old) < 1)) ch.end = d;
  b.duration = b.files.reduce((s, x) => s + (x.duration || 0), 0);
  db.putBook(b).catch(() => { });
}

function onTime() {
  if (!P.book) return;
  const t = curTime();
  const idx = chapterIndexAt(P.fi, t);
  if (idx !== P.chapterIdx) {
    const prev = P.chapterIdx;
    P.chapterIdx = idx;
    if (sleep.mode === 'chapter' && idx === prev + 1 && !audio.paused) {
      audio.pause();
      const ch = P.book.chapters[idx];
      if (ch.file === P.fi) { try { audio.currentTime = ch.start; } catch { } }
      clearSleep();
      toast('スリープ：章の終わりで止めました');
    }
    updateMediaMetadata();
  }
  if (sleep.mode === 'time' && Date.now() >= sleep.until && !audio.paused) {
    audio.pause(); clearSleep(); toast('スリープ：止めました');
  }
  if (P.pendingSeek == null && Date.now() - P.lastSave > 5000) saveNow();
  if (!$('player').hidden && !seeking) renderTimes();
  if (Date.now() - (onTime.ps || 0) > 4000) { onTime.ps = Date.now(); updatePositionState(); }
}

function onEnded() {
  const b = P.book; if (!b) return;
  if (P.fi + 1 < b.files.length) {
    if (sleep.mode === 'chapter') {
      clearSleep();
      loadFile(P.fi + 1, 0, false);
      toast('スリープ：章の終わりで止めました');
      return;
    }
    loadFile(P.fi + 1, 0, true);   // 用意してあれば IndexedDB を待たずにすぐ切り替わる
    return;
  }
  b.finished = true;
  db.putBook(b).catch(() => { });
  setProg(b.id, P.fi, b.files[P.fi].duration || audio.duration || 0);
  clearSleep();
  renderPlayer();
  toast('最後まで聞きました');
}

window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveNow();
  else { renderPlayer(); if (!$('library').hidden) renderLibrary(); sweepExpired(); bgmSync(); }
});

// ---------------- ロック画面・コントロールセンター ----------------

async function updateMediaMetadata() {
  if (!('mediaSession' in navigator) || !P.book) return;
  const b = P.book;
  const ch = b.chapters[chapterIndexAt(P.fi, curTime())];
  const art = await coverUrl(b);
  if (P.book !== b) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ch ? ch.title : b.title,
      artist: b.author || b.title,
      album: b.title,
      artwork: art ? [{ src: art, sizes: '600x600' }]
        : [{ src: new URL('icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }],
    });
  } catch { }
}
function updatePositionState() {
  const ms = navigator.mediaSession;
  if (!ms || !ms.setPositionState) return;
  const d = audio.duration;
  if (!isFinite(d) || d <= 0) return;
  try { ms.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: Math.min(Math.max(0, audio.currentTime), d) }); } catch { }
}
(function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { } };
  h('play', () => doPlay());
  h('pause', () => audio.pause());
  h('seekbackward', (d) => skip(-(d && d.seekOffset || SKIP_BACK)));
  h('seekforward', (d) => skip(d && d.seekOffset || SKIP_FWD));
  h('seekto', (d) => { if (d && d.seekTime != null) seekBook(P.fi, d.seekTime); });
})();

// ---------------- 再生画面 ----------------

function showView(name) {
  $('library').hidden = name !== 'library';
  $('player').hidden = name !== 'player';
  if (name === 'library') renderLibrary();
  window.scrollTo(0, 0);
}

function renderPlayer() {
  const b = P.book;
  if (!b || $('player').hidden) { renderMini(); return; }
  fillCoverOnce($('pCover'), b);
  $('pBook').textContent = b.title;
  renderTimes();
  renderPlayState();
  renderRate();
  renderSleep();
  renderSubsButton();
  renderImgsButton();
  renderBgmButton();
}
function fillCoverOnce(box, b) {
  if (box.dataset.book === b.id + '|' + b.title) return;
  box.dataset.book = b.id + '|' + b.title;
  fillCover(box, b);
}

function renderTimes() {
  const b = P.book; if (!b) return;
  const t = curTime();
  const i = chapterIndexAt(P.fi, t);
  const ch = b.chapters[i];
  const end = chapterEnd(ch);
  const len = Math.max(0.1, end - ch.start);
  const inCh = Math.min(len, Math.max(0, t - ch.start));
  $('pChapter').textContent = ch.title;
  const seek = $('seek');
  if (!seeking) seek.value = String(Math.round(inCh / len * 1000));
  seek.style.setProperty('--p', (seek.value / 10) + '%');
  $('tCur').textContent = clock(inCh);
  $('tLeft').textContent = '-' + clock(len - inCh);
  const left = Math.max(0, (b.duration || 0) - (fileOffset(b, P.fi) + t));
  const r = rate !== 1 ? `（${rate}倍で ${jaDur(left / rate)}）` : '';
  $('pBookLeft').textContent = b.chapters.length > 1
    ? `${i + 1} / ${b.chapters.length}章・本の残り ${jaDur(left)}${r}`
    : `本の残り ${jaDur(left)}${r}`;
  $('btnPrev').disabled = false;
  $('btnNext').disabled = i + 1 >= b.chapters.length;
  renderSubtitle();
  renderSlide();
}

function renderPlayState() {
  const playing = !audio.paused;
  const use = `<use href="#i-${playing ? 'pause' : 'play'}"/>`;
  $('btnPlay').querySelector('svg').innerHTML = use;
  $('btnPlay').setAttribute('aria-label', playing ? '一時停止' : '再生');
  $('miniPlay').querySelector('svg').innerHTML = use;
  renderMini();
}

function renderMini() {
  const b = P.book;
  const show = !!b && !$('library').hidden;
  $('mini').hidden = !show;
  if (!show) return;
  fillCoverOnce($('miniCover'), b);
  $('miniTitle').textContent = b.title;
  const ch = b.chapters[chapterIndexAt(P.fi, curTime())];
  $('miniSub').textContent = ch ? ch.title : '';
}

const seekEl = $('seek');
seekEl.addEventListener('input', () => {
  seeking = true;
  const b = P.book; if (!b) return;
  const ch = b.chapters[chapterIndexAt(P.fi, curTime())];
  const len = Math.max(0.1, chapterEnd(ch) - ch.start);
  const inCh = seekEl.value / 1000 * len;
  seekEl.style.setProperty('--p', (seekEl.value / 10) + '%');
  $('tCur').textContent = clock(inCh);
  $('tLeft').textContent = '-' + clock(len - inCh);
});
seekEl.addEventListener('change', () => {
  const b = P.book; if (!b) { seeking = false; return; }
  const ch = b.chapters[chapterIndexAt(P.fi, curTime())];
  const len = Math.max(0.1, chapterEnd(ch) - ch.start);
  const t = ch.start + Math.min(len - 0.5, seekEl.value / 1000 * len);
  seeking = false;
  seekBook(ch.file, Math.max(ch.start, t));
});

$('btnPlay').onclick = togglePlay;
$('miniPlay').onclick = (e) => { e.stopPropagation(); togglePlay(); };
$('mini').onclick = () => { showView('player'); renderPlayer(); };
$('btnBack').onclick = () => showView('library');
$('btnBack15').onclick = () => skip(-SKIP_BACK);
$('btnFwd30').onclick = () => skip(SKIP_FWD);
$('btnPrev').onclick = prevChapter;
$('btnNext').onclick = nextChapter;

$('btnChapters').onclick = () => {
  const b = P.book; if (!b) return;
  const cur = chapterIndexAt(P.fi, curTime());
  openSheet(body => {
    body.append(el('h2', null, `章の一覧（${b.chapters.length}章）`));
    const opts = el('div', 'opts');
    b.chapters.forEach((ch, i) => {
      const x = el('button', i === cur ? 'sel' : null);
      x.append(el('span', null, ch.title), el('span', 'sub', clock(fileOffset(b, ch.file) + ch.start)));
      x.onclick = () => { closeSheet(); gotoChapter(i); };
      opts.append(x);
    });
    body.append(opts);
    actions(body, [['閉じる', 'cancel', closeSheet]]);
    setTimeout(() => { const s = opts.querySelector('.sel'); if (s) s.scrollIntoView({ block: 'center' }); }, 30);
  });
};

// 字幕（映画の字幕のように表紙の下側に出す）
let subShown = null;
function renderSubtitle() {
  const box = $('subtitle');
  const f = P.book && P.book.files[P.fi];
  const c = subsOn && f && f.cues ? cueAt(f.cues, curTime()) : null;
  const text = c ? c[2] : '';
  if (text === subShown) return;
  subShown = text;
  box.textContent = text;
  box.hidden = !text;
}
function renderSubsButton() {
  const b = $('btnSubs');
  const has = hasSubs(P.book);
  b.hidden = !has;
  b.classList.toggle('on', has && subsOn);
  b.textContent = subsOn ? '字幕 あり' : '字幕 なし';
  subShown = null;
  renderSubtitle();
}
// ---------------- BGM（自分で用意した曲を、本の声の後ろで小さく流す） ----------------
// 本の声はいつもの audio 要素のまま。BGM は別の要素を Web Audio の GainNode に通して小さくする
// （iPad の Safari では audio.volume を変えられないため）。ロック中に BGM だけ止まっても、本の声は続く。
const BGM_VOL = { s: 0.07, m: 0.13, l: 0.22 };
const BGM_VOL_LABEL = { s: '小', m: '中', l: '大' };
const bgmAudio = new Audio();
bgmAudio.preload = 'auto';
let bgmList = loadBgmList();               // [{id, name, size, off?}]（off＝流さない曲）
let bgmOn = localStorage.getItem('kk.bgm') !== '0';
let bgmVol = BGM_VOL[localStorage.getItem('kk.bgmVol')] ? localStorage.getItem('kk.bgmVol') : 's';
let bgmShuffle = localStorage.getItem('kk.bgmMode') === 'shuffle';
let bgmCtx = null, bgmGain = null, bgmUrl = null, bgmLoadedId = null, bgmWanted = false, bgmStopTimer = 0;
let bgmCur = (() => { try { return JSON.parse(localStorage.getItem('kk.bgmPos') || 'null')?.id || null; } catch { return null; } })();
let bgmBag = [];   // シャッフルの残り（全部流し終わるまで同じ曲を繰り返さない）

const bgmActive = () => bgmList.filter(x => !x.off);
// 次に流す曲を決める
function bgmPickNext(afterId) {
  const act = bgmActive();
  if (!act.length) return null;
  if (bgmShuffle) {
    bgmBag = bgmBag.filter(id => act.some(x => x.id === id) && id !== afterId);
    if (!bgmBag.length) {
      bgmBag = act.map(x => x.id).filter(id => act.length === 1 || id !== afterId);
      for (let i = bgmBag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bgmBag[i], bgmBag[j]] = [bgmBag[j], bgmBag[i]]; }
    }
    return bgmBag.shift();
  }
  const i = bgmList.findIndex(x => x.id === afterId);
  for (let k = 1; k <= bgmList.length; k++) {
    const x = bgmList[(Math.max(i, -1) + k + bgmList.length) % bgmList.length];
    if (!x.off) return x.id;
  }
  return null;
}

function loadBgmList() {
  try { const a = JSON.parse(localStorage.getItem('kk.bgmList') || '[]'); return Array.isArray(a) ? a.filter(x => x && x.id) : []; } catch { return []; }
}
function saveBgmList() { localStorage.setItem('kk.bgmList', JSON.stringify(bgmList)); }
function saveBgmPos() {
  if (bgmLoadedId) try { localStorage.setItem('kk.bgmPos', JSON.stringify({ id: bgmLoadedId, t: bgmAudio.currentTime || 0 })); } catch { }
}
// 音の通り道（AudioContext → GainNode）。最初はユーザーの操作の中で作る必要がある
function bgmPrime() {
  if (!bgmActive().length) return;
  if (bgmCtx) { if (bgmCtx.state !== 'running') bgmCtx.resume().catch(() => { }); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    bgmCtx = new AC();
    bgmGain = bgmCtx.createGain();
    bgmGain.gain.value = 0;
    bgmCtx.createMediaElementSource(bgmAudio).connect(bgmGain);
    bgmGain.connect(bgmCtx.destination);
    if (bgmCtx.state !== 'running') bgmCtx.resume().catch(() => { });
  } catch { bgmCtx = null; bgmGain = null; }
}
// 音量を変えられるか（Web Audio が使えない iPad では BGM を流さない＝大きな音で鳴らさない）
function bgmCanQuiet() {
  if (bgmGain) return true;
  try { const v = bgmAudio.volume; bgmAudio.volume = 0.5; const ok = Math.abs(bgmAudio.volume - 0.5) < 0.01; bgmAudio.volume = v; return ok; } catch { return false; }
}
function bgmSetVolume(v, sec = 0) {
  if (bgmGain && bgmCtx) {
    const g = bgmGain.gain, now = bgmCtx.currentTime;
    try { g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); if (sec > 0) g.linearRampToValueAtTime(v, now + sec); else g.setValueAtTime(v, now); }
    catch { g.value = v; }
  } else {
    try { bgmAudio.volume = v; } catch { }
  }
}
async function bgmLoad() {
  const act = bgmActive();
  if (!act.length) return false;
  if (!act.some(x => x.id === bgmCur)) bgmCur = bgmPickNext(bgmCur);
  const item = bgmList.find(x => x.id === bgmCur);
  if (!item) return false;
  bgmAudio.loop = act.length === 1;
  if (bgmLoadedId === item.id && bgmAudio.src) return true;
  const b = await db.getBlob(item.id).catch(() => null);
  if (!b || !b.size) return false;
  if (bgmUrl) URL.revokeObjectURL(bgmUrl);
  bgmUrl = URL.createObjectURL(b);
  bgmAudio.src = bgmUrl;
  bgmLoadedId = item.id;
  const pos = (() => { try { return JSON.parse(localStorage.getItem('kk.bgmPos') || 'null'); } catch { return null; } })();
  if (pos && pos.id === item.id && pos.t > 0) {
    const t = pos.t;
    bgmAudio.addEventListener('loadedmetadata', () => { try { if (t < (bgmAudio.duration || 0) - 1) bgmAudio.currentTime = t; } catch { } }, { once: true });
  }
  return true;
}
function bgmUnload() {
  bgmAudio.pause();
  bgmAudio.removeAttribute('src'); try { bgmAudio.load(); } catch { }
  if (bgmUrl) URL.revokeObjectURL(bgmUrl);
  bgmUrl = null; bgmLoadedId = null;
}
// 本の再生に合わせて BGM を鳴らす・止める（ファイルの切り替えで一瞬止まるのは待ってから止める）
async function bgmSync() {
  const want = !!(bgmOn && bgmActive().length && P.book && !audio.paused);
  bgmWanted = want;
  if (!want) {
    if (bgmAudio.paused || bgmStopTimer) return;
    bgmStopTimer = setTimeout(() => {
      bgmStopTimer = 0;
      if (!bgmWanted && !bgmAudio.paused) { bgmAudio.pause(); saveBgmPos(); }
    }, 700);
    return;
  }
  clearTimeout(bgmStopTimer); bgmStopTimer = 0;
  if (bgmCtx && bgmCtx.state !== 'running') bgmCtx.resume().catch(() => { });
  if (bgmPlaying()) { bgmSetVolume(BGM_VOL[bgmVol], 0.3); return; }
  if (!bgmCanQuiet()) return;
  if (!(await bgmLoad()) || !bgmWanted) return;
  bgmSetVolume(0);
  try { await bgmAudio.play(); } catch { return; }
  if (!bgmWanted) { bgmAudio.pause(); return; }
  bgmSetVolume(BGM_VOL[bgmVol], 2);   // 2秒かけて大きくする
}
// 鳴っているか（読めなかった曲は paused が false のまま残ることがあるので、error も見る）
function bgmPlaying() { return !bgmAudio.paused && !!bgmLoadedId && !bgmAudio.error; }
bgmAudio.addEventListener('ended', () => {
  if (bgmAudio.loop) return;
  bgmCur = bgmPickNext(bgmCur);
  try { localStorage.removeItem('kk.bgmPos'); } catch { }
  bgmSync();
});
// 曲を選んで、今すぐその曲に替える（鳴っていなければ次に鳴らすときにその曲から）
function bgmPlayNow(id) {
  if (!bgmList.some(x => x.id === id && !x.off)) return;
  bgmCur = id;
  try { localStorage.removeItem('kk.bgmPos'); } catch { }
  const wasPlaying = bgmPlaying();
  bgmUnload();
  if (wasPlaying || bgmWanted) bgmSync();
}
function bgmSkip() { const n = bgmPickNext(bgmCur); if (n) bgmPlayNow(n); }
bgmAudio.addEventListener('error', () => {
  if (!bgmLoadedId) return;
  // 読めない曲は飛ばす（1回だけ知らせる）
  const bad = bgmList.find(x => x.id === bgmLoadedId);
  bgmLoadedId = null;
  try { bgmAudio.pause(); } catch { }
  if (bgmActive().length > 1) { bgmCur = bgmPickNext(bad && bad.id); bgmAudio.removeAttribute('src'); setTimeout(bgmSync, 300); }
  if (bad) toast(`BGM「${bad.name}」を再生できませんでした`);
});
setInterval(() => { if (!bgmAudio.paused) saveBgmPos(); }, 10000);

function renderBgmButton() {
  const b = $('btnBgm');
  b.hidden = !bgmActive().length;
  b.classList.toggle('on', bgmOn);
  b.textContent = bgmOn ? 'BGM あり' : 'BGM なし';
}
$('btnBgm').onclick = () => {
  bgmOn = !bgmOn;
  localStorage.setItem('kk.bgm', bgmOn ? '1' : '0');
  if (bgmOn) bgmPrime();
  renderBgmButton();
  bgmSync();
};

// 曲を足す（中身を最後まで読んでから保存し、読み戻して確かめる）
$('bgmInput').onchange = async (e) => {
  const files = [...e.target.files].filter(f => AUDIO_EXT.includes(extOf(f.name)));
  e.target.value = '';
  if (!files.length) { toast('音声ファイル（.mp3 .m4a など）を選んでください'); return; }
  showBusy('BGM の曲を保存しています…');
  let added = 0;
  const errs = [];
  for (const [i, f] of files.entries()) {
    const id = `bgm.${Date.now().toString(36)}${i}`;
    try {
      const buf = await f.arrayBuffer();
      if (!buf.byteLength) throw new Error('中身が空です');
      await db.putBlob(id, new Blob([buf], { type: mimeOf(f.name) }));
      await checkSaved(id, buf.byteLength);
      bgmList.push({ id, name: baseName(f.name), size: buf.byteLength });
      added++;
    } catch (err) {
      await db.deleteBlobs([id]).catch(() => { });
      errs.push(db.isQuotaError(err) ? 'iPad の空き容量が足りません' : (err && err.message || String(err)));
    }
  }
  saveBgmList();
  hideBusy();
  renderBgmButton();
  openSettings();
  toast(added ? `BGM の曲を${added}曲追加しました` + (errs.length ? `（${errs.length}曲は保存できませんでした：${errs[0]}）` : '') : `保存できませんでした：${errs[0]}`, 6000);
  bgmSync();
};
async function removeBgm(id) {
  if (bgmLoadedId === id) { bgmUnload(); }
  const i = bgmList.findIndex(x => x.id === id);
  if (i < 0) return;
  bgmList.splice(i, 1);
  if (bgmCur === id) bgmCur = null;
  saveBgmList();
  await db.deleteBlobs([id]).catch(() => { });
  try { const pos = JSON.parse(localStorage.getItem('kk.bgmPos') || 'null'); if (pos && pos.id === id) localStorage.removeItem('kk.bgmPos'); } catch { }
  renderBgmButton();
  bgmSync();
}
function bgmToggleUse(id) {
  const x = bgmList.find(y => y.id === id);
  if (!x) return;
  if (x.off) delete x.off; else x.off = true;
  saveBgmList();
  if (x.off && bgmLoadedId === id) { bgmCur = bgmPickNext(id); bgmUnload(); }
  renderBgmButton();
  bgmSync();
}
function bgmMoveUp(i) {
  if (i <= 0 || i >= bgmList.length) return;
  [bgmList[i - 1], bgmList[i]] = [bgmList[i], bgmList[i - 1]];
  saveBgmList();
}

$('btnSubs').onclick = () => {
  subsOn = !subsOn;
  localStorage.setItem('kk.subs', subsOn ? '1' : '0');
  renderSubsButton();
};

// 写真・図表（表紙の場所に出す。ゆっくりズーム、押すと全画面）
const imgUrls = new Map();   // blobId -> object URL（最近の数枚だけ）
let slideShown = null;
async function imageUrl(id) {
  if (imgUrls.has(id)) return imgUrls.get(id);
  const b = await db.getBlob(id).catch(() => null);
  if (!b || !b.size) return null;
  const u = URL.createObjectURL(b);
  imgUrls.set(id, u);
  for (const [k, v] of imgUrls) {
    if (imgUrls.size <= 6) break;
    if (k !== slideShown && k !== id) { URL.revokeObjectURL(v); imgUrls.delete(k); }
  }
  return u;
}
const badImages = new Set();   // 表示できなかった写真（この再生中は出さない）
let badNotified = null;         // 案内を出した本の id
function currentImage() {
  const b = P.book;
  if (!imgsOn || !hasImages(b)) return null;
  return imageAt(b.images.filter(x => x.file === P.fi && !badImages.has(x.blobId)), curTime());
}
function markBadImage(id) {
  badImages.add(id);
  $('slide').hidden = true;
  $('slideImg').removeAttribute('src');
  if (P.book && badNotified !== P.book.id) {
    badNotified = P.book.id;
    toast('写真を表示できませんでした。本の「…」→「字幕・写真を追加」で .images.zip を選び直してください', 7000);
  }
  slideShown = undefined;
  renderSlide();
}
$('slideImg').addEventListener('error', () => {
  if (slideShown && $('slideImg').getAttribute('src')) markBadImage(slideShown);
});
function renderSlide() {
  const x = currentImage();
  const id = x ? x.blobId : null;
  if (id === slideShown) return;
  slideShown = id;
  const box = $('slide');
  if (!x) { box.hidden = true; $('slideImg').removeAttribute('src'); return; }
  imageUrl(id).then(u => {
    if (slideShown !== id) return;
    if (!u) { markBadImage(id); return; }
    const img = $('slideImg');
    img.classList.remove('kb');
    img.onload = () => { if (slideShown === id) box.hidden = false; };   // 読めてから出す（「？」を出さない）
    img.src = u;
    void img.offsetWidth;
    img.classList.add('kb');
    $('slideCap').textContent = x.caption || '';
    $('slideCap').hidden = !x.caption;
  });
}
function renderImgsButton() {
  const b = $('btnImgs');
  const has = hasImages(P.book);
  b.hidden = !has;
  b.classList.toggle('on', has && imgsOn);
  b.textContent = imgsOn ? '写真 あり' : '写真 なし';
  slideShown = undefined;
  renderSlide();
}
$('btnImgs').onclick = () => {
  imgsOn = !imgsOn;
  localStorage.setItem('kk.imgs', imgsOn ? '1' : '0');
  renderImgsButton();
};
$('slide').onclick = () => {
  if (!slideShown || !$('slideImg').src) return;
  $('viewerImg').src = $('slideImg').src;
  $('viewerCap').textContent = $('slideCap').hidden ? '' : $('slideCap').textContent;
  $('viewer').hidden = false;
};
$('viewer').onclick = () => { $('viewer').hidden = true; };

function renderRate() { $('btnRate').textContent = `速さ ${rate % 1 ? rate : rate.toFixed(1)}×`; }
$('btnRate').onclick = () => {
  openSheet(body => {
    body.append(el('h2', null, '再生の速さ'));
    const opts = el('div', 'opts');
    for (const r of RATES) {
      const x = el('button', r === rate ? 'sel' : null);
      x.append(el('span', null, `${r % 1 ? r : r.toFixed(1)}×`), el('span', 'sub', r === 1 ? 'ふつう' : ''));
      x.onclick = () => {
        rate = r; localStorage.setItem('kk.rate', String(r));
        audio.defaultPlaybackRate = r; audio.playbackRate = r;
        closeSheet(); renderRate(); renderTimes();
      };
      opts.append(x);
    }
    body.append(opts);
    actions(body, [['閉じる', 'cancel', closeSheet]]);
  });
};

function clearSleep() { sleep = { mode: 'off', until: 0 }; renderSleep(); }
function renderSleep() {
  const b = $('btnSleep');
  b.classList.toggle('on', sleep.mode !== 'off');
  if (sleep.mode === 'time') b.textContent = `スリープ ${clock(Math.max(0, (sleep.until - Date.now()) / 1000))}`;
  else if (sleep.mode === 'chapter') b.textContent = 'スリープ 章の終わり';
  else b.textContent = 'スリープ';
}
$('btnSleep').onclick = () => {
  openSheet(body => {
    body.append(el('h2', null, 'スリープ（自動で止める）'));
    const opts = el('div', 'opts');
    const add = (label, sel, fn) => { const x = el('button', sel ? 'sel' : null, label); x.onclick = () => { fn(); closeSheet(); renderSleep(); }; opts.append(x); };
    add('オフ', sleep.mode === 'off', () => { sleep = { mode: 'off', until: 0 }; });
    for (const m of SLEEPS) add(`${m}分後`, false, () => { sleep = { mode: 'time', until: Date.now() + m * 60000 }; });
    add('この章の終わり', sleep.mode === 'chapter', () => { sleep = { mode: 'chapter', until: 0 }; P.chapterIdx = chapterIndexAt(P.fi, curTime()); });
    body.append(opts);
    actions(body, [['閉じる', 'cancel', closeSheet]]);
  });
};
setInterval(() => {
  if (sleep.mode === 'time') {
    if (Date.now() >= sleep.until && !audio.paused) { audio.pause(); clearSleep(); toast('スリープ：止めました'); }
    else if (!$('player').hidden) renderSleep();
  }
}, 1000);

// キーボード（iPad のキーボード用）
document.addEventListener('keydown', (e) => {
  if (!P.book || e.target.tagName === 'INPUT' || !$('sheet').hidden) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') skip(-SKIP_BACK);
  else if (e.key === 'ArrowRight') skip(SKIP_FWD);
});

// 本の声は「再生」の扱いにする（BGM の Web Audio があっても、ロック中に本が止まらないように）
try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { }

// ---------------- 設定 ----------------

$('btnSettings').onclick = () => openSettings();
async function openSettings() {
  let usage = null, free = null;
  try { const est = await navigator.storage?.estimate?.(); if (est) { usage = est.usage; if (est.quota) free = Math.max(0, est.quota - est.usage); } } catch { }
  openSheet(body => {
    body.append(el('h2', null, '設定'));
    const opts = el('div', 'opts');
    const tg = el('button', 'set-expire');
    const lab = el('span', null, '期限の来た本を自動で消す');
    const sub = el('span', 'sub', '');
    const show = () => { const on = autoExpireOn(); sub.textContent = on ? 'オン' : 'オフ'; tg.classList.toggle('sel', on); };
    tg.append(lab, sub);
    tg.onclick = async () => {
      localStorage.setItem('kk.expire', autoExpireOn() ? '0' : '1');
      show(); renderLibrary();
      if (autoExpireOn()) await sweepExpired();
    };
    show();
    opts.append(tg);
    body.append(opts);
    body.append(el('p', 'muted', '期限の付いた本（日経よみあげが毎朝作る朝刊の本）を、期限の日にこの iPad から消します。開いている本は、ほかの本を開いたときか次に起動したときに消えます。'));
    const n = books.filter(b => b.expireAt).length;
    if (n) body.append(el('p', 'muted', `期限の付いた本：${n}冊`));

    // BGM
    body.append(el('h3', 'set-h', 'BGM（本の声の後ろで小さく流す曲）'));
    if (bgmList.length) {
      const ul = el('div', 'bgm-list');
      bgmList.forEach((x, i) => {
        const row = el('div', 'bgm-row' + (x.off ? ' off' : '') + (x.id === bgmLoadedId && bgmPlaying() ? ' now' : ''));
        const use = el('input', 'bgm-use'); use.type = 'checkbox'; use.checked = !x.off;
        use.setAttribute('aria-label', '流す');
        use.onchange = () => { bgmToggleUse(x.id); openSettings(); };
        const name = el('button', 'bgm-name', (x.id === bgmLoadedId && bgmPlaying() ? '♪ ' : '') + x.name);
        name.onclick = () => {
          if (x.off) { toast('チェックを付けると流せます'); return; }
          bgmPlayNow(x.id); openSettings();
          toast(bgmWanted ? `「${x.name}」に替えました` : `次は「${x.name}」から流します`);
        };
        row.append(use, name, el('span', 'bgm-size', size(x.size || 0)));
        if (i > 0) { const up = el('button', 'bgm-up', '↑'); up.setAttribute('aria-label', '上へ'); up.onclick = () => { bgmMoveUp(i); openSettings(); }; row.append(up); }
        const del = el('button', 'bgm-del', '削除');
        del.onclick = async () => { await removeBgm(x.id); openSettings(); toast(`「${x.name}」を外しました`); };
        row.append(del);
        ul.append(row);
      });
      body.append(ul);
      const modeRow = el('div', 'bgm-vol bgm-mode');
      modeRow.append(el('span', null, '流し方'));
      for (const [k, label] of [['order', '順番'], ['shuffle', 'シャッフル']]) {
        const mb = el('button', 'pill bgm-mode-' + k + ((k === 'shuffle') === bgmShuffle ? ' on' : ''), label);
        mb.onclick = () => {
          bgmShuffle = k === 'shuffle'; bgmBag = [];
          localStorage.setItem('kk.bgmMode', k);
          modeRow.querySelectorAll('.pill').forEach(b => b.classList.toggle('on', b === mb));
        };
        modeRow.append(mb);
      }
      if (bgmActive().length > 1) {
        const sk = el('button', 'pill bgm-skip', '次の曲 ▶▶');
        sk.onclick = () => { bgmSkip(); openSettings(); };
        modeRow.append(sk);
      }
      body.append(modeRow);
    } else {
      body.append(el('p', 'muted', 'まだ曲がありません。「曲を追加」で、ファイル アプリから MP3・M4A などを選んでください（Apple Music の曲は使えません）。'));
    }
    const addBtn = el('button', 'bgm-add', '＋ 曲を追加');
    addBtn.onclick = () => { const i = $('bgmInput'); i.value = ''; i.click(); };
    body.append(addBtn);
    const volRow = el('div', 'bgm-vol');
    volRow.append(el('span', null, '音量'));
    for (const k of ['s', 'm', 'l']) {
      const vb = el('button', 'pill bgm-vol-' + k + (bgmVol === k ? ' on' : ''), BGM_VOL_LABEL[k]);
      vb.onclick = () => {
        bgmVol = k; localStorage.setItem('kk.bgmVol', k);
        volRow.querySelectorAll('.pill').forEach(b => b.classList.toggle('on', b === vb));
        if (!bgmAudio.paused) bgmSetVolume(BGM_VOL[k], 0.4);
      };
      volRow.append(vb);
    }
    body.append(volRow);
    body.append(el('p', 'muted', 'チェックを付けた曲を、順番かシャッフルで繰り返し流します。曲名を押すとその曲に替わります。本を止めると BGM も止まります。再生画面の［BGM］で、あり・なしを切り替えられます。画面をロックしている間は BGM が止まることがあります（本の声は続きます）。'));
    if (usage != null) body.append(el('p', 'set-usage', `ききウサが使っている容量 約 ${size(usage)}` + (free != null ? `（空きの目安 ${size(free)}）` : '')));
    actions(body, [['閉じる', 'go', closeSheet]]);
  });
}

// ---------------- はじめ ----------------

function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

async function start() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('installHint').hidden = !(ios && !isStandalone());
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  let libraryOk = false;
  try {
    await refreshLibrary();
    libraryOk = true;
  } catch (e) {
    $('empty').hidden = false;
    toast(`本棚を開けませんでした：${e && e.message || e}`, 8000);
  }
  // 期限の来た本を消す（前回開いていた本も、ここなら消せる）
  await sweepExpired().catch(() => { });
  if (libraryOk) askLegacyOnce();
  // 前回聞いていた本をすぐ再開できるように用意だけしておく（自動では鳴らさない）
  const last = localStorage.getItem('kk.last');
  const b = books.find(x => x.id === last);
  if (b && !b.finished) {
    P.book = b; P.chapterIdx = -1;
    const pr = getProg(b.id);
    const fi = pr ? Math.min(Math.max(0, pr.f | 0), b.files.length - 1) : 0;
    P.fi = fi; P.pendingSeek = pr ? pr.t : 0;
    renderMini();
    loadFile(fi, pr ? pr.t : 0, false);
  }
}
audio.addEventListener('play', () => { if (P.book) localStorage.setItem('kk.last', P.book.id); });
audio.addEventListener('playing', () => bgmSync());
audio.addEventListener('pause', () => bgmSync());

// テスト用（画面の外からの確認）
window.__kk = { P, audio, get books() { return books; }, refreshLibrary, planImport, openBook, seekBook, skip, gotoChapter, nextChapter, prevChapter, getProg, get sleep() { return sleep; }, get subText() { return $('subtitle').hidden ? '' : $('subtitle').textContent; }, sweepExpired, todayStr, bgmAudio, get bgm() { return { list: bgmList, on: bgmOn, vol: bgmVol, cur: bgmCur, shuffle: bgmShuffle, loadedId: bgmLoadedId, gain: bgmGain ? bgmGain.gain.value : null, ctx: bgmCtx ? bgmCtx.state : null }; }, get slide() { return $('slide').hidden ? null : { id: slideShown, cap: $('slideCap').hidden ? '' : $('slideCap').textContent }; }, badImages };

start();

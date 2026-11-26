// parse.js — 音声ファイルの中身（タグ・章・表紙・長さ）を読む。画面に依存しない。
// 対応：MP3（ID3v2.3/2.4・長さ）、MP4 系（.m4b/.m4a：iTunes タグ・Nero の章 chpl・mvhd の長さ）

export const AUDIO_EXT = ['mp3', 'm4b', 'm4a', 'aac', 'wav', 'flac'];
export const IMAGE_EXT = ['jpg', 'jpeg', 'png'];
export const SUB_EXT = ['vtt', 'srt'];

export function extOf(name) {
  const m = /\.([^.\/\\]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function baseName(name) {
  const n = String(name || '').split(/[\/\\]/).pop();
  return n.replace(/\.[^.]+$/, '');
}

export function mimeOf(name) {
  switch (extOf(name)) {
    case 'mp3': return 'audio/mpeg';
    case 'm4b': case 'm4a': return 'audio/mp4';
    case 'aac': return 'audio/aac';
    case 'wav': return 'audio/wav';
    case 'flac': return 'audio/flac';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
  }
  return 'application/octet-stream';
}

async function readSlice(blob, start, end) {
  const s = Math.max(0, start), e = Math.min(blob.size, end);
  if (e <= s) return new Uint8Array(0);
  return new Uint8Array(await blob.slice(s, e).arrayBuffer());
}

function u32(b, o) { return b[o] * 16777216 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
function u64(b, o) { return u32(b, o) * 4294967296 + u32(b, o + 4); }
function fourcc(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
function syncsafe(b, o) { return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f); }

const utf8 = new TextDecoder('utf-8');
function cleanText(s) { return s.replace(/\u0000+$/g, '').split('\u0000')[0].trim(); }

export async function parseAudioMeta(blob, name) {
  const ext = extOf(name || blob.name);
  try {
    if (ext === 'mp3') return await parseMp3(blob);
    if (ext === 'm4b' || ext === 'm4a') return await parseMp4(blob);
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
  return {};
}

// ---------------- MP4（.m4b / .m4a） ----------------

function* boxes(b, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let len = u32(b, o);
    const type = fourcc(b, o + 4);
    let hdr = 8;
    if (len === 1) { if (o + 16 > end) return; len = u64(b, o + 8); hdr = 16; }
    else if (len === 0) len = end - o;
    if (len < hdr || o + len > end) return;
    yield { type, start: o, body: o + hdr, end: o + len };
    o += len;
  }
}
function child(b, box, type) {
  for (const c of boxes(b, box.body, box.end)) if (c.type === type) return c;
  return null;
}
function children(b, box, type) {
  const out = [];
  for (const c of boxes(b, box.body, box.end)) if (c.type === type) out.push(c);
  return out;
}

async function findTopBox(blob, type) {
  let off = 0;
  for (let i = 0; i < 100000 && off + 8 <= blob.size; i++) {
    const h = await readSlice(blob, off, off + 16);
    let len = u32(h, 0);
    const t = fourcc(h, 4);
    let hdr = 8;
    if (len === 1) { if (h.length < 16) return null; len = u64(h, 8); hdr = 16; }
    else if (len === 0) len = blob.size - off;
    if (len < hdr) return null;
    if (t === type) return { start: off, size: len };
    off += len;
  }
  return null;
}

export async function parseMp4(blob) {
  const ft = await readSlice(blob, 4, 8);
  if (fourcc(ft, 0) !== 'ftyp') return {};
  const mv = await findTopBox(blob, 'moov');
  if (!mv || mv.size > 96 * 1024 * 1024) return {};
  const b = await readSlice(blob, mv.start, mv.start + mv.size);
  return parseMoov(b);
}

// moov の箱そのもの（先頭の長さ・型を含む）を受け取る
export function parseMoov(b) {
  const out = {};
  const root = boxes(b, 0, b.length).next().value;
  if (!root || root.type !== 'moov') return out;

  const mvhd = child(b, root, 'mvhd');
  if (mvhd) {
    const v = b[mvhd.body];
    const p = mvhd.body + 4;
    const scale = v === 1 ? u32(b, p + 16) : u32(b, p + 8);
    const dur = v === 1 ? u64(b, p + 20) : u32(b, p + 12);
    if (scale > 0) out.duration = dur / scale;
  }

  const udta = child(b, root, 'udta');
  if (udta) {
    const chpl = child(b, udta, 'chpl');
    if (chpl) out.chapters = parseChpl(b, chpl);
    const meta = child(b, udta, 'meta');
    if (meta) Object.assign(out, parseMeta(b, meta));
  }
  return out;
}

function parseChpl(b, box) {
  const list = [];
  const version = b[box.body];
  let p = box.body + 4;
  if (version >= 1) p += 4;
  if (p >= box.end) return list;
  const n = b[p]; p += 1;
  for (let i = 0; i < n && p + 9 <= box.end; i++) {
    const start = u64(b, p) / 1e7; p += 8;
    const len = b[p]; p += 1;
    const title = utf8.decode(b.subarray(p, Math.min(p + len, box.end))).trim();
    p += len;
    list.push({ start, title });
  }
  list.sort((x, y) => x.start - y.start);
  return list;
}

function parseMeta(b, meta) {
  const out = {};
  // iTunes 形式は full box（4バイトの version/flags）、QuickTime 形式は直後が hdlr
  const body = fourcc(b, meta.body + 4) === 'hdlr' ? meta.body : meta.body + 4;
  const metaBox = { body, end: meta.end };
  const ilst = child(b, metaBox, 'ilst');
  if (!ilst) return out;
  for (const item of boxes(b, ilst.body, ilst.end)) {
    const data = child(b, item, 'data');
    if (!data || data.body + 8 > data.end) continue;
    const kind = u32(b, data.body) & 0xffffff;
    const payload = b.subarray(data.body + 8, data.end);
    const text = () => cleanText(utf8.decode(payload));
    switch (item.type) {
      case '©nam': out.title = text(); break;
      case '©alb': out.album = text(); break;
      case '©ART': out.artist = text(); break;
      case 'aART': if (!out.artist) out.artist = text(); break;
      case 'covr':
        if (!out.cover && payload.length > 100) {
          const type = kind === 14 || (payload[0] === 0x89 && payload[1] === 0x50) ? 'image/png' : 'image/jpeg';
          out.cover = new Blob([payload.slice()], { type });
        }
        break;
    }
  }
  return out;
}

// ---------------- MP3 ----------------

const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export async function parseMp3(blob) {
  const out = {};
  let audioStart = 0;
  const h = await readSlice(blob, 0, 10);
  if (h.length === 10 && h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) {
    const size = syncsafe(h, 6);
    audioStart = 10 + size + ((h[5] & 0x10) ? 10 : 0);
    if (size <= 32 * 1024 * 1024) {
      const b = await readSlice(blob, 10, 10 + size);
      Object.assign(out, parseId3Frames(b, h[3], h[5]));
    }
  }
  const d = await mp3Duration(blob, audioStart);
  if (d > 0) out.duration = d;
  return out;
}

function decodeId3Text(enc, data) {
  if (!data.length) return '';
  if (enc === 0) return cleanText(new TextDecoder('iso-8859-1').decode(data));
  if (enc === 3) return cleanText(utf8.decode(data));
  if (enc === 1) {
    if (data[0] === 0xfe && data[1] === 0xff) return cleanText(new TextDecoder('utf-16be').decode(data.subarray(2)));
    if (data[0] === 0xff && data[1] === 0xfe) return cleanText(new TextDecoder('utf-16le').decode(data.subarray(2)));
    return cleanText(new TextDecoder('utf-16le').decode(data));
  }
  if (enc === 2) return cleanText(new TextDecoder('utf-16be').decode(data));
  return '';
}

function parseId3Frames(b, ver, flags) {
  const out = {};
  if (ver < 3) return out; // ID3v2.2 は読まない
  let p = 0;
  if (flags & 0x40) p = ver === 4 ? syncsafe(b, 0) : u32(b, 0) + 4;
  while (p + 10 <= b.length) {
    const id = fourcc(b, p);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fs = ver === 4 ? syncsafe(b, p + 4) : u32(b, p + 4);
    if (fs <= 0 || p + 10 + fs > b.length) break;
    const body = b.subarray(p + 10, p + 10 + fs);
    p += 10 + fs;
    switch (id) {
      case 'TIT2': out.title = decodeId3Text(body[0], body.subarray(1)); break;
      case 'TALB': out.album = decodeId3Text(body[0], body.subarray(1)); break;
      case 'TPE1': out.artist = decodeId3Text(body[0], body.subarray(1)); break;
      case 'TRCK': out.track = parseInt(decodeId3Text(body[0], body.subarray(1)), 10) || undefined; break;
      case 'APIC': if (!out.cover) out.cover = parseApic(body); break;
    }
  }
  return out;
}

function parseApic(body) {
  const enc = body[0];
  let p = 1;
  let mime = '';
  while (p < body.length && body[p] !== 0) mime += String.fromCharCode(body[p++]);
  p += 1; // 0
  p += 1; // 絵の種類
  if (enc === 1 || enc === 2) {
    while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < body.length && body[p] !== 0) p++;
    p += 1;
  }
  if (p >= body.length - 100) return null;
  const img = body.slice(p);
  const type = img[0] === 0x89 && img[1] === 0x50 ? 'image/png' : (mime.includes('png') ? 'image/png' : 'image/jpeg');
  return new Blob([img], { type });
}

async function mp3Duration(blob, start) {
  const b = await readSlice(blob, start, start + 65536);
  for (let i = 0; i + 4 <= b.length; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (b[i + 1] >> 3) & 3;      // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layer = (b[i + 1] >> 1) & 3;    // 1=Layer III
    const bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3;
    if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) continue;
    const kbps = (ver === 3 ? BR1 : BR2)[bri];
    const sr = SR[ver][sri];
    const spf = ver === 3 ? 1152 : 576;
    const mono = (b[i + 3] >> 6) === 3;
    const side = ver === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    const x = i + 4 + side;
    if (x + 12 <= b.length) {
      const tag = fourcc(b, x);
      if (tag === 'Xing' || tag === 'Info') {
        const fl = u32(b, x + 4);
        if (fl & 1) { const frames = u32(b, x + 8); if (frames > 0) return frames * spf / sr; }
      }
    }
    const v = i + 4 + 32;
    if (v + 18 <= b.length && fourcc(b, v) === 'VBRI') {
      const frames = u32(b, v + 14);
      if (frames > 0) return frames * spf / sr;
    }
    // 固定ビットレートとみなす
    return (blob.size - start - i) * 8 / (kbps * 1000);
  }
  return 0;
}

// ---------------- 字幕（WebVTT / SRT） ----------------

function subTime(s) {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(s || '');
  if (!m) return NaN;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
}

// [[開始秒, 終了秒, 文], ...]（開始の順）
export function parseSubtitles(text) {
  const out = [];
  const blocks = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->');
    const s = subTime(a), e = subTime(z);
    if (!isFinite(s) || !isFinite(e)) continue;
    const t = lines.slice(i + 1).join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .trim();
    if (t) out.push([Math.round(s * 1000) / 1000, Math.round(Math.max(e, s) * 1000) / 1000, t]);
  }
  out.sort((x, y) => x[0] - y[0]);
  return out;
}

// t 秒に出す字幕（なければ null）。少しの切れ目なら前の字幕を出したままにする
export function cueAt(cues, t, hold = 0.8) {
  if (!cues || !cues.length) return null;
  let lo = 0, hi = cues.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid][0] <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx < 0) return null;
  const c = cues[idx];
  return t < c[1] + hold ? c : null;
}

// ---------------- 写真・図表の包み（<本>.images.zip ＝ images.json ＋ 画像） ----------------

export function isImagePack(name) { return /\.images\.zip$/i.test(name || ''); }
export function imagePackBase(name) { return String(name || '').split(/[\/\\]/).pop().replace(/\.images\.zip$/i, ''); }

function le16(b, o) { return b[o] | (b[o + 1] << 8); }
function le32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216; }

// zip の中身の一覧（無圧縮・deflate。zip64 は扱わない）
export async function readZip(blob) {
  const tailLen = Math.min(blob.size, 65557);
  const tail = await readSlice(blob, blob.size - tailLen, blob.size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip ファイルではありません');
  const count = le16(tail, eocd + 10), cdSize = le32(tail, eocd + 12), cdOff = le32(tail, eocd + 16);
  const cd = await readSlice(blob, cdOff, cdOff + cdSize);
  const out = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (le32(cd, p) !== 0x02014b50) break;
    const method = le16(cd, p + 10), csize = le32(cd, p + 20), usize = le32(cd, p + 24);
    const nlen = le16(cd, p + 28), xlen = le16(cd, p + 30), clen = le16(cd, p + 32), loff = le32(cd, p + 42);
    const name = utf8.decode(cd.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const lh = await readSlice(blob, loff, loff + 30);
    if (lh.length < 30 || le32(lh, 0) !== 0x04034b50) continue;
    out.push({ name, method, csize, usize, start: loff + 30 + le16(lh, 26) + le16(lh, 28) });
  }
  return out;
}

export async function zipEntryBlob(blob, e, type = '') {
  const raw = blob.slice(e.start, e.start + e.csize);
  if (e.method === 0) return new Blob([raw], { type });
  if (e.method === 8) {
    const ab = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    return new Blob([ab], { type });
  }
  throw new Error('対応していない圧縮の形です（' + e.method + '）');
}

// images.json：{ version, items: [{ file, audio?, start, end?, caption? }] }
export function parseImageManifest(text) {
  const j = JSON.parse(text);
  const items = Array.isArray(j) ? j : (j && j.items) || [];
  return items
    .filter(x => x && typeof x.file === 'string' && x.file)
    .map(x => ({
      file: x.file,
      audio: typeof x.audio === 'string' ? x.audio : '',
      s: Math.max(0, Number(x.start) || 0),
      e: x.end == null || !isFinite(Number(x.end)) ? null : Number(x.end),
      caption: typeof x.caption === 'string' ? x.caption.trim() : '',
    }))
    .sort((a, b) => a.s - b.s);
}

// t 秒に出す画像（list は同じ音声ファイルの分・開始の順）
export function imageAt(list, t) {
  if (!list || !list.length) return null;
  let idx = -1;
  for (let i = 0; i < list.length; i++) { if (list[i].s <= t + 0.05) idx = i; else break; }
  if (idx < 0) return null;
  const x = list[idx];
  return x.e == null || t < x.e ? x : null;
}

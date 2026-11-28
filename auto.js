// ききウサ：本の中身（字幕・章・題名）から言葉を拾い、ウィキペディアの記事の写真を選ぶ（画面に依存しない）
// 写真は日本語版ウィキペディアの記事の代表画像（自由に使えるライセンスのものだけ）。

const API = 'https://ja.wikipedia.org/w/api.php';
// ウィキペディアの決まり：どのアプリからの問い合わせか分かるようにする。写真の幅は決まった幅（1280）だけを使う
const HDR = { headers: { 'Api-User-Agent': 'KikiUsa (https://arkwtkk.github.io/kikiusa/)' } };
export const THUMB = 1280;

// よく出るが写真にならない言葉
export const STOP = new Set((
  '自分 自身 今日 明日 昨日 今年 去年 来年 毎日 毎年 時間 時代 時期 当時 最近 最初 最後 最高 最大 最近 以上 以下 以外 以前 以後 ' +
  '一番 一緒 一人 一度 一方 一部 一般 一年 二人 三人 全部 全体 全員 大切 大事 大変 大学 本当 本人 本日 本書 本来 本気 ' +
  '問題 必要 関係 場合 結果 部分 社会 世界 人間 人生 気持 気持ち 理由 方法 状況 経験 意味 意識 意見 言葉 仕事 会社 ' +
  '子供 子ども 両親 家族 先生 生活 生徒 学生 学校 友人 友達 仲間 相手 自宅 家庭 年代 年齢 記憶 時点 現在 今回 前回 次回 ' +
  '日本 日本人 東京 国内 海外 地方 地域 全国 各地 場所 位置 周囲 周辺 中心 目的 目標 内容 情報 話題 記事 新聞 番組 ' +
  '可能 可能性 不安 安心 心配 興味 関心 感謝 努力 苦労 成功 失敗 挑戦 決断 判断 決定 選択 変化 影響 効果 結論 ' +
  '一つ 二つ 何度 何人 何年 何回 数年 数日 数人 多数 少数 大勢 様々 色々 特別 普通 当然 自然 確か 実際 実は ' +
  '開始 終了 発表 説明 紹介 報告 指摘 発言 質問 回答 対応 対策 検討 議論 調査 分析 研究 開発 作業 活動 行動 ' +
  '会議 会見 会長 社長 部長 課長 担当 責任 役割 立場 地位 能力 才能 実力 魅力 特徴 傾向 状態 条件 基準 原因 ' +
  '経営 経済 企業 事業 業界 市場 価格 売上 利益 費用 予算 資金 収入 給料 現場 組織 制度 政策 政府 国民 個人 ' +
  '昭和 平成 令和 戦前 戦後 戦中 前半 後半 中盤 終盤 上旬 中旬 下旬 午前 午後 夕方 夜中 半分 全然 結局 一応 ' +
  'ページ スタート ゴール イメージ ポイント テーマ ケース パターン タイプ レベル スタイル チーム メンバー グループ ' +
  'システム サービス プロジェクト チャンス アイデア ストーリー エピソード メッセージ コメント ニュース データ ' +
  '履歴書 舞台 物語 生涯 自伝 回想 半生 人物 作品 連載 第一 最終 序章 終章 前編 後編'
).split(/\s+/).filter(Boolean));

// 言葉の末尾がこれなら、ひとまとまりの名前ではないことが多い
const BAD_END = /(的|性|化|中|後|前|間|頃|際|等|達|用|感|度|年|月|日|時|分|秒|歳|回|円|人|者|目|点|側|面|上|下|内|外|方|毎|以|頃|程|件|割|倍|枚|個|本|冊|台|軒|杯)$/;
const TITLE_SUF = /(監督|選手|社長|会長|教授|先生|博士|夫人|議員|総理|首相|大臣|知事|市長|将軍|師匠|和尚|上人|親方|名誉教授)$/;
const NUMERIC = /^[一二三四五六七八九十百千万億兆〇零半数何毎各第両]+/;

// 文章から言葉（漢字のつながり・カタカナのつながり）を数える
export function termsIn(text, into = new Map(), weight = 1) {
  const s = String(text || '').normalize('NFKC');
  const add = (w) => {
    if (w.length < 2 || STOP.has(w)) return;
    into.set(w, (into.get(w) || 0) + weight);
  };
  for (const m of s.matchAll(/[\p{Script=Han}々〆ヶ]{2,10}/gu)) {
    let w = m[0];
    // 「市川崑監督」→「市川崑」（肩書きを外す）
    const b = w.replace(TITLE_SUF, '');
    if (b !== w && b.length >= 2) w = b;
    if (NUMERIC.test(w) || BAD_END.test(w)) continue;
    add(w);
  }
  for (const m of s.matchAll(/[\p{Script=Katakana}ー・]{3,30}/gu)) {
    const w = m[0].replace(/^[・ー]+|[・ー]+$/g, '');
    if (w.length < 3) continue;
    const parts = w.split('・').filter(x => x.length >= 2);
    if (parts.length > 1) {
      // 「メンバー・イメージ」のような並べただけのものは外し、名前（ニューヨーク・ヤンキース）は残す
      if (parts.some(x => STOP.has(x))) { parts.forEach(x => { if (x.length >= 3) add(x); }); continue; }
    }
    if (w.length <= 15) add(w);
  }
  return into;
}

// 本を W 秒ごとの区切りに分け、区切りごとの文章（字幕）と章の名前を集める
export function buildWindows(book, W) {
  const wins = [];
  (book.files || []).forEach((f, fi) => {
    const dur = f.duration || 0;
    const n = Math.max(1, Math.ceil(dur / W));
    const cues = f.cues || [];
    for (let k = 0; k < n; k++) {
      const s = k * W, e = Math.min(dur || Infinity, (k + 1) * W);
      const text = cues.filter(c => c[1] > s && c[0] < e).map(c => c[2]).join('\n');
      const chapters = (book.chapters || []).filter(c => c.file === fi && c.start >= s && c.start < e).map(c => c.title);
      wins.push({ file: fi, s, e, text, chapters });
    }
  });
  return wins;
}

// 区切りごとに、その区切りらしい言葉を点数の高い順に並べる
export function rankWindows(wins, top = 8) {
  const per = wins.map(w => {
    const m = termsIn(w.text);
    for (const t of w.chapters) termsIn(t, m, 2);   // 章の名前は少し重く見る
    return m;
  });
  const df = new Map();
  for (const m of per) for (const k of m.keys()) df.set(k, (df.get(k) || 0) + 1);
  const N = wins.length;
  wins.forEach((w, i) => {
    const m = per[i];
    w.terms = [...m.entries()]
      .map(([k, tf]) => [k, tf * (1 + 0.15 * Math.min(k.length, 8)) * Math.log(1 + N / (df.get(k) || 1)) * (tf >= 2 ? 1.3 : 1)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(x => x[0]);
  });
  return wins;
}

// 本全体でよく出る言葉（字幕のない本・区切りに写真がないときに使う）
export function bookTerms(book, n = 30) {
  const m = new Map();
  termsIn(book.title, m, 4);
  for (const c of book.chapters || []) termsIn(c.title, m, 2);
  for (const f of book.files || []) for (const c of f.cues || []) termsIn(c[2], m);
  return [...m.entries()].filter(([, v]) => v >= 2).sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]);
}

// 写真として出してよいか（地図・紋章・ロゴ・図などは外す）
export function goodImage(info) {
  if (!info || !info.thumb || !info.file) return false;
  const f = info.file;
  if (/\.(svg|gif|tif|tiff|pdf|djvu|webm|ogv)$/i.test(f)) return false;
  if (/(flag|map|logo|emblem|crest|locator|seal|coat[_ ]of[_ ]arms|signature|icon|symbol|diagram|chart|graph|地図|紋|旗|ロゴ|位置図|系図)/i.test(f)) return false;
  if ((info.w || 0) < 400 || (info.h || 0) < 250) return false;
  return true;
}

const pageInfo = (p) => p && !p.missing && !(p.pageprops && 'disambiguation' in p.pageprops) && p.thumbnail
  ? { title: p.title, file: p.pageimage, thumb: p.thumbnail.source, w: p.thumbnail.width, h: p.thumbnail.height }
  : null;

// 言葉（記事名）→ 記事の代表画像。50件ずつまとめて問い合わせる
export async function wikiLookup(titles, fetchFn = fetch, size = THUMB) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const part = titles.slice(i, i + 50);
    const u = `${API}?action=query&format=json&formatversion=2&origin=*&redirects=1&prop=pageimages|pageprops&piprop=thumbnail|name&pithumbsize=${size}&ppprop=disambiguation&titles=${encodeURIComponent(part.join('|'))}`;
    const j = await fetchFn(u, HDR).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    const q = j.query || {};
    const final = new Map();   // 元の言葉 → 最後にたどり着いた記事名
    for (const t of part) final.set(t, t);
    for (const n of q.normalized || []) for (const [k, v] of final) if (v === n.from) final.set(k, n.to);
    for (const r of q.redirects || []) for (const [k, v] of final) if (v === r.from) final.set(k, r.to);
    const byTitle = new Map((q.pages || []).map(p => [p.title, p]));
    for (const [k, v] of final) {
      const info = pageInfo(byTitle.get(v));
      // 別の意味の記事に転送された（「港町」→「港湾都市」）ものは、あとで後回しにする
      if (info) out.set(k, { ...info, moved: !v.includes(k) });
    }
  }
  return out;
}

// 検索で関係のありそうな記事を探す（題名・作者から）
export async function wikiSearch(q, fetchFn = fetch, limit = 8, size = THUMB) {
  if (!q || !q.trim()) return [];
  const u = `${API}?action=query&format=json&formatversion=2&origin=*&generator=search&gsrnamespace=0&gsrlimit=${limit}&gsrsearch=${encodeURIComponent(q)}&prop=pageimages|pageprops&piprop=thumbnail|name&pithumbsize=${size}&ppprop=disambiguation`;
  const j = await fetchFn(u, HDR).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  const pages = ((j.query || {}).pages || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  return pages.map(pageInfo).filter(Boolean);
}

export function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
}

// 画像ファイル → 撮影者・ライセンス（写真のすみに出す）
export async function wikiCredits(files, fetchFn = fetch) {
  const out = new Map();
  for (let i = 0; i < files.length; i += 50) {
    const part = files.slice(i, i + 50);
    const u = `${API}?action=query&format=json&formatversion=2&origin=*&prop=imageinfo&iiprop=extmetadata&iiextmetadatafilter=Artist|LicenseShortName&titles=${encodeURIComponent(part.map(f => 'File:' + f).join('|'))}`;
    let j;
    try { j = await fetchFn(u, HDR).then(r => r.json()); } catch { continue; }
    const q = j.query || {};
    const norm = new Map((q.normalized || []).map(n => [n.to, n.from]));
    for (const p of q.pages || []) {
      const md = p.imageinfo && p.imageinfo[0] && p.imageinfo[0].extmetadata;
      if (!md) continue;
      const from = (norm.get(p.title) || p.title).replace(/^(File|ファイル):/, '');
      let artist = stripHtml(md.Artist && md.Artist.value);
      if (artist.length > 40) artist = artist.slice(0, 39) + '…';
      out.set(from, { artist, license: stripHtml(md.LicenseShortName && md.LicenseShortName.value) });
    }
  }
  return out;
}

export function creditText(term, cr) {
  const who = cr && cr.artist ? cr.artist : '';
  const lic = cr && cr.license ? cr.license : '';
  const src = [who, lic].filter(Boolean).join('／');
  return `${term}　写真：${src ? src + '・' : ''}ウィキペディア`;
}

// 本に合う写真を選ぶ（まだダウンロードしない）。返すのは [{term, file(音声の番号)|null, t(秒)|null, thumb, fileName}]
export async function planAutoImages(book, { fetchFn = fetch, max = 30, ban = [] } = {}) {
  const total = (book.files || []).reduce((s, f) => s + (f.duration || 0), 0) || 60;
  const W = Math.min(1200, Math.max(60, total / Math.ceil(max / 2)));   // 区切りごとに2枚まで
  const wins = rankWindows(buildWindows(book, W));
  const banned = new Set(ban);
  const bterms = bookTerms(book);
  const cand = [];
  const seen = new Set();
  const push = (t) => { if (!seen.has(t) && !banned.has(t)) { seen.add(t); cand.push(t); } };
  for (const w of wins) w.terms.forEach(push);
  bterms.forEach(push);
  const lookup = await wikiLookup(cand.slice(0, 450), fetchFn);
  const usedFile = new Set();
  const usedTerm = new Set();
  const out = [];
  const take = (term, info, file, t) => {
    if (!goodImage(info) || usedFile.has(info.file) || usedTerm.has(info.title)) return false;
    usedFile.add(info.file); usedTerm.add(info.title);
    out.push({ term: info.title, file, t, thumb: info.thumb, fileName: info.file });
    return true;
  };
  for (const w of wins) {
    if (out.length >= max) break;
    // 点数の順に、別の意味に転送されていない記事を先に。区切りごとに2枚まで（2枚目は区切りの半ば）
    const order = [...w.terms.filter(t => lookup.get(t) && !lookup.get(t).moved), ...w.terms.filter(t => lookup.get(t) && lookup.get(t).moved)];
    let got = 0;
    for (const term of order) {
      if (got >= 2 || out.length >= max) break;
      if (take(term, lookup.get(term), w.file, got ? w.s + (w.e - w.s) / 2 : w.s)) got++;
    }
  }
  // 字幕のない本などで少ないときは、本全体の言葉で足す（時刻なし＝合間に出す）。
  // 題名や作者名での検索はしない（同じ名前の別人の写真が出るため）
  if (out.length < 4) {
    for (const term of bterms) {
      if (out.length >= 8) break;
      const info = lookup.get(term);
      if (info && !info.moved) take(term, info, null, null);
    }
  }
  return out;
}

// 集めた写真を「interval 秒ごとに切り替える」予定表にする。
// その区切りに合う写真（t が区切りの中）があればそれ、なければ前に出した写真から古い順に繰り返す。
export function autoSchedule(book, pool, interval = 60) {
  const items = [];
  if (!pool || !pool.length) return items;
  const anchored = pool.filter(x => x.file != null && x.t != null).slice().sort((a, b) => a.file - b.file || a.t - b.t);
  const fillers = pool.filter(x => x.file == null || x.t == null);
  const lastShown = new Map();   // blobId → 何番目に出したか
  let step = 0, prev = null;
  // まだ出していない「合間の写真」を先に、その後は出した順の古いものから
  const pickFiller = () => {
    const shownIds = [...lastShown.keys()];
    const fresh = fillers.find(x => !lastShown.has(x.blobId) && x.blobId !== prev);
    if (fresh) return fresh;
    let best = null, bestAt = Infinity;
    for (const id of shownIds) {
      if (id === prev) continue;
      const at = lastShown.get(id);
      if (at < bestAt) { bestAt = at; best = id; }
    }
    return best ? pool.find(x => x.blobId === best) : (pool.find(x => x.blobId !== prev) || pool[0]);
  };
  (book.files || []).forEach((f, fi) => {
    const dur = f.duration || 0;
    const mine = anchored.filter(x => x.file === fi);
    let ai = 0;
    const n = Math.max(1, Math.ceil(dur / interval));
    for (let k = 0; k < n; k++) {
      const s = k * interval, e = (k + 1) * interval;
      let x = null;
      // この区切りまでに来た「その場の写真」のうち、まだ出していないもの
      while (ai < mine.length && mine[ai].t < e) {
        if (!lastShown.has(mine[ai].blobId)) { x = mine[ai]; ai++; break; }
        ai++;
      }
      if (!x) x = pickFiller();
      if (!x) continue;
      if (x.blobId === prev && pool.length > 1) continue;
      items.push({ blobId: x.blobId, file: fi, s, caption: x.caption || x.term, auto: true });
      lastShown.set(x.blobId, step++);
      prev = x.blobId;
    }
  });
  return items;
}

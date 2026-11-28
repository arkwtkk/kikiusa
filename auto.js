// ききウサ：本の中身（字幕・章・題名）から言葉を拾い、写真を選ぶ（画面に依存しない）
// 集め先（v0.8）：日本語版ウィキペディアの記事の代表画像と記事の中の写真、ウィキメディア・コモンズ、
// Openverse（Flickr などの CC の写真）、Pexels・Pixabay（鍵を設定したときだけ）。

const API = 'https://ja.wikipedia.org/w/api.php';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const SPARQL = 'https://query.wikidata.org/sparql';
const OPENVERSE = 'https://api.openverse.org/v1/images/';
const enc = encodeURIComponent;
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

const pageInfo = (p) => p && !p.missing && !(p.pageprops && 'disambiguation' in p.pageprops)
  ? {
    title: p.title, file: p.thumbnail ? p.pageimage : null, thumb: p.thumbnail ? p.thumbnail.source : null,
    w: p.thumbnail ? p.thumbnail.width : 0, h: p.thumbnail ? p.thumbnail.height : 0,
    en: (p.langlinks && p.langlinks[0] && (p.langlinks[0].title || p.langlinks[0]['*'])) || null,
    qid: (p.pageprops && p.pageprops.wikibase_item) || null,
  }
  : null;

// 言葉（記事名）→ 記事の代表画像。50件ずつまとめて問い合わせる
export async function wikiLookup(titles, fetchFn = fetch, size = THUMB) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const part = titles.slice(i, i + 50);
    const u = `${API}?action=query&format=json&formatversion=2&origin=*&redirects=1&prop=pageimages|pageprops|langlinks&piprop=thumbnail|name&pithumbsize=${size}&pilimit=50&ppprop=disambiguation|wikibase_item&lllang=en&lllimit=max&titles=${encodeURIComponent(part.join('|'))}`;
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

export function creditText(term, cr, site = 'ウィキペディア') {
  let who = cr && cr.artist ? String(cr.artist) : '';
  if (who.length > 40) who = who.slice(0, 39) + '…';
  const lic = cr && cr.license ? cr.license : '';
  const src = [who, lic].filter(Boolean).join('／');
  return `${term}　写真：${src ? src + '・' : ''}${site}`;
}

// ---------------- 集め先（v0.8） ----------------
export const normFile = (f) => String(f || '').replace(/^(File|ファイル|Image|画像):/i, '').replace(/_/g, ' ').trim();

async function getJson(fetchFn, url, opt) {
  const r = await fetchFn(url, opt);
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  return r.json();
}

// imageinfo の付いたファイルのページ → 写真の候補
function fileCand(p, site, src) {
  const ii = p && p.imageinfo && p.imageinfo[0];
  if (!ii) return null;
  const file = normFile(p.title);
  const c = { file, thumb: ii.thumburl || ii.url, w: ii.width || 0, h: ii.height || 0, fileName: file, site, src, key: 'f:' + file };
  if (ii.mime && !/^image\/(jpeg|png|webp)$/.test(ii.mime)) return null;
  return goodImage(c) ? c : null;
}

// 記事の中の写真（代表画像のほかに、記事に載っている写真）
export async function wikiArticleImages(title, fetchFn = fetch) {
  const u = `${API}?action=query&format=json&formatversion=2&origin=*&titles=${enc(title)}&generator=images&gimlimit=50&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=${THUMB}`;
  const j = await getJson(fetchFn, u, HDR);
  return ((j.query || {}).pages || []).map(p => fileCand(p, 'ウィキペディア', 'wiki')).filter(Boolean);
}

// ウィキメディア・コモンズの検索
export async function commonsSearch(q, fetchFn = fetch, limit = 12) {
  const u = `${COMMONS}?action=query&format=json&formatversion=2&origin=*&generator=search&gsrnamespace=6&gsrlimit=${limit}&gsrsearch=${enc(q + ' filetype:bitmap')}&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=${THUMB}`;
  const j = await getJson(fetchFn, u, HDR);
  const pages = ((j.query || {}).pages || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  return pages.map(p => fileCand(p, 'ウィキメディア・コモンズ', 'commons')).filter(Boolean);
}

const OV_SITE = { flickr: 'Flickr', wikimedia: 'ウィキメディア', nappy: 'nappy', rawpixel: 'rawpixel', stocksnap: 'StockSnap' };
export function ovLicense(r) {
  const l = String(r.license || '').toLowerCase();
  if (l === 'cc0') return 'CC0';
  if (l === 'pdm') return 'パブリックドメイン';
  return l ? `CC ${l.toUpperCase()}${r.license_version ? ' ' + r.license_version : ''}` : '';
}
// Openverse（Flickr などのクリエイティブ・コモンズの写真）。英語の言葉で探す
export async function openverseSearch(q, fetchFn = fetch, n = 10) {
  const u = `${OPENVERSE}?q=${enc(q)}&page_size=${n}&mature=false`;
  const j = await getJson(fetchFn, u);
  return (j.results || []).filter(r => r.url && !(r.width && r.width < 400) && !(r.height && r.height < 250)
    && !/\.(svg|gif|tiff?)(\?|$)/i.test(r.url)).map(r => ({
    thumb: r.url, alt: `${OPENVERSE}${r.id}/thumb/?full_size=true`, w: r.width || 0, h: r.height || 0,
    key: 'ov:' + r.id, src: 'openverse', site: `${OV_SITE[r.source] || r.source || 'Openverse'}（Openverse）`,
    credit: { artist: r.creator || '', license: ovLicense(r) },
  }));
}

// Pexels（鍵が要る）
export async function pexelsSearch(q, key, fetchFn = fetch, n = 8, locale = '') {
  const u = `https://api.pexels.com/v1/search?query=${enc(q)}&per_page=${n}&orientation=landscape${locale ? '&locale=' + locale : ''}`;
  const j = await getJson(fetchFn, u, { headers: { Authorization: key } });
  return (j.photos || []).filter(p => p.src && p.src.large2x).map(p => ({
    thumb: p.src.large2x, w: p.width || 0, h: p.height || 0, key: 'px:' + p.id, src: 'pexels', site: 'Pexels',
    credit: { artist: p.photographer || '' },
  }));
}

// Pixabay（鍵が要る）
export async function pixabaySearch(q, key, fetchFn = fetch, n = 8, lang = '') {
  const u = `https://pixabay.com/api/?key=${enc(key)}&q=${enc(String(q).slice(0, 100))}&image_type=photo&safesearch=true&per_page=${Math.max(3, n)}${lang ? '&lang=' + lang : ''}`;
  const j = await getJson(fetchFn, u);
  return (j.hits || []).filter(h => h.largeImageURL).map(h => ({
    thumb: h.largeImageURL, w: h.imageWidth || 0, h: h.imageHeight || 0, key: 'pb:' + h.id, src: 'pixabay', site: 'Pixabay',
    credit: { artist: h.user || '' },
  }));
}

// 鍵が使えるか（設定で貼ったとき）
export async function testKey(kind, key, fetchFn = fetch) {
  try {
    if (kind === 'pexels') await pexelsSearch('nature', key, fetchFn, 1);
    else await pixabaySearch('nature', key, fetchFn, 3);
    return true;
  } catch (e) { if (e.status === 401 || e.status === 403 || e.status === 400) return false; throw e; }
}

// 人の名前か（ウィキデータで「人間」のもの）。人には似た別人の写真が出る集め先を使わない
export async function personSet(qids, fetchFn = fetch) {
  const out = new Set();
  const ids = [...new Set(qids.filter(q => /^Q\d+$/.test(q || '')))];
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const q = `SELECT ?item WHERE { VALUES ?item { ${part.map(x => 'wd:' + x).join(' ')} } ?item wdt:P31 wd:Q5 }`;
    const j = await getJson(fetchFn, `${SPARQL}?format=json&query=${enc(q)}`, { headers: { Accept: 'application/sparql-results+json', ...HDR.headers } });
    for (const b of ((j.results || {}).bindings || [])) out.add(String(b.item.value).split('/').pop());
  }
  return out;
}

// 本に合う写真を選ぶ（まだダウンロードしない）。
// 返すのは [{term, label, file(音声の番号)|null, t(秒)|null, thumb, alt?, fileName?, credit?, site, src, key}]
// 区切りごとに perWin 枚まで：1) 記事の代表画像 2) その言葉の、ほかの集め先の写真を順番に（記事の中の写真・Pexels・Pixabay・コモンズ・Openverse）
export async function planAutoImages(book, { fetchFn = fetch, max = 40, perWin = 3, ban = [], keys = {}, ovMax = 8, interval = 60 } = {}) {
  const total = (book.files || []).reduce((s, f) => s + (f.duration || 0), 0) || 60;
  // 区切りの長さ：本の長さ÷（最大枚数÷区切りの枚数）。ただし切り替えの間隔×区切りの枚数より短くしない（出せない写真を集めない）
  const W = Math.min(1200, Math.max(60, perWin * interval, total / Math.ceil(max / perWin)));
  const wins = rankWindows(buildWindows(book, W));
  const banned = new Set(ban);
  const bterms = bookTerms(book);
  const cand = [];
  const seen = new Set();
  const push = (t) => { if (!seen.has(t) && !banned.has(t)) { seen.add(t); cand.push(t); } };
  for (const w of wins) w.terms.forEach(push);
  bterms.forEach(push);
  const lookup = await wikiLookup(cand.slice(0, 450), fetchFn);
  for (const [k, v] of [...lookup]) if (banned.has(v.title)) lookup.delete(k);
  const notes = { bad: {}, errors: 0 };
  // 人の名前か（失敗したら、すべて人として扱い、別人の写真が出る集め先は使わない）
  let persons = null;
  try { persons = await personSet([...lookup.values()].map(v => v.qid), fetchFn); } catch { persons = null; }
  const isPerson = (info) => !persons || persons.has(info.qid);

  const usedKey = new Set();
  const usedLead = new Set();
  const out = [];
  let ovLeft = ovMax;
  const add = (c, info, label, file, t) => {
    if (!c || usedKey.has(c.key) || banned.has(c.key)) return false;
    usedKey.add(c.key);
    if (c.fileName) usedKey.add('f:' + normFile(c.fileName));
    out.push({ term: info.title, label, file, t, thumb: c.thumb, alt: c.alt, fileName: c.fileName, credit: c.credit, site: c.site, src: c.src, key: c.key });
    return true;
  };
  const takeLead = (info, file, t) => {
    if (!goodImage(info) || usedLead.has(info.title)) return false;
    const c = { thumb: info.thumb, fileName: info.file, site: 'ウィキペディア', src: 'wiki', key: 'f:' + normFile(info.file) };
    if (!add(c, info, info.title, file, t)) return false;
    usedLead.add(info.title);
    return true;
  };
  // 言葉ごとの、ほかの集め先の写真（はじめて使うときにまとめて問い合わせ、集め先を順番に混ぜる）
  const ext = new Map();
  const extFor = async (term) => {
    if (ext.has(term)) return ext.get(term);
    const info = lookup.get(term);
    const lists = [];
    const tryList = async (name, fn) => {
      try { lists.push(await fn()); }
      catch (e) {
        if ((name === 'pexels' || name === 'pixabay') && e && (e.status === 401 || e.status === 403 || e.status === 400)) notes.bad[name] = true;
        if (name === 'openverse' && e && e.status === 429) ovLeft = 0;
        notes.errors++;
      }
    };
    const person = isPerson(info);
    // 英語の名前があれば写真サイトは英語で探す（なければ日本語で）
    const q = info.moved ? term : (info.en || info.title);
    const jaQ = info.moved || !info.en;
    // 混ぜる順：写真サイト（鍵があるとき）→ 記事の中の写真 → コモンズ → Openverse
    const jobs = [];
    if (!person) {
      if (keys.pexels && !notes.bad.pexels) jobs.push(['pexels', () => pexelsSearch(q, keys.pexels, fetchFn, 8, jaQ ? 'ja-JP' : '')]);
      if (keys.pixabay && !notes.bad.pixabay) jobs.push(['pixabay', () => pixabaySearch(q, keys.pixabay, fetchFn, 8, jaQ ? 'ja' : '')]);
    }
    if (!info.moved) jobs.push(['wiki', () => wikiArticleImages(info.title, fetchFn)]);
    if (!person) {
      if (!info.moved) jobs.push(['commons', () => commonsSearch(info.en || info.title, fetchFn)]);
      if (!info.moved && info.en && ovLeft > 0) { ovLeft--; jobs.push(['openverse', () => openverseSearch(info.en, fetchFn)]); }
    }
    for (const [name, fn] of jobs) await tryList(name, fn);
    // 集め先を順番に1枚ずつ混ぜる
    const merged = [];
    for (let k = 0; lists.some(l => l.length > k); k++) for (const l of lists) if (l[k]) merged.push(l[k]);
    const st = { list: merged, i: 0 };
    ext.set(term, st);
    return st;
  };
  const nextExt = async (term) => {
    const st = await extFor(term);
    while (st.i < st.list.length) {
      const c = st.list[st.i++];
      if (!usedKey.has(c.key) && !banned.has(c.key) && !(c.fileName && usedKey.has('f:' + normFile(c.fileName)))) return c;
    }
    return null;
  };

  // ひとつの区切り（または本全体）を埋める
  const fill = async (terms, file, tAt, limit) => {
    const infos = terms.map(t => [t, lookup.get(t)]).filter(([, v]) => v);
    const order = [...infos.filter(([, v]) => !v.moved), ...infos.filter(([, v]) => v.moved)];
    let got = 0;
    // 1) 記事の代表画像（別の意味に転送された言葉は使わない）。1枠はほかの集め先のために空けておく
    const leadMax = limit > 1 ? limit - 1 : limit;
    for (const [, info] of order) {
      if (got >= leadMax || out.length >= max) break;
      if (!info.moved && takeLead(info, file, tAt(got))) got++;
    }
    if (got >= limit || out.length >= max) return got;
    // 2) 上位の言葉から、ほかの集め先の写真
    const top = order.slice(0, 3);
    let progress = true;
    while (got < limit && out.length < max && progress) {
      progress = false;
      for (const [term, info] of top) {
        if (got >= limit || out.length >= max) break;
        const c = await nextExt(term);
        if (c && add(c, info, c.src === 'wiki' ? `${info.title}（記事の写真）` : (info.moved ? term : info.title), file, tAt(got))) { got++; progress = true; }
      }
    }
    // 3) ほかの集め先がなければ、残りの枠も代表画像で
    for (const [, info] of order) {
      if (got >= limit || out.length >= max) return got;
      if (!info.moved && takeLead(info, file, tAt(got))) got++;
    }
    // 4) それでも空いていれば、転送された記事の代表画像（前の版と同じ後回し）
    for (const [, info] of order) {
      if (got >= limit || out.length >= max) return got;
      if (info.moved && takeLead(info, file, tAt(got))) got++;
    }
    return got;
  };

  for (const w of wins) {
    if (out.length >= max) break;
    await fill(w.terms, w.file, (k) => w.s + (w.e - w.s) * k / perWin, perWin);
  }
  // 字幕のない本などで少ないときは、本全体の言葉で足す（時刻なし＝合間に出す）。
  // 題名や作者名での検索はしない（同じ名前の別人の写真が出るため）
  if (out.length < 4) {
    const nonMoved = bterms.filter(t => lookup.get(t) && !lookup.get(t).moved);
    await fill(nonMoved, null, () => null, Math.min(max, 8) - out.length);
  }
  out.notes = notes;
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
  let curFile = 0, curS = 0;
  const pickFiller = () => {
    const shownIds = [...lastShown.keys()];
    const fresh = fillers.find(x => !lastShown.has(x.blobId) && x.blobId !== prev);
    if (fresh) return fresh;
    // まだ出していない「その場の写真」のうち、もう過ぎた場所のもの（新しい順）を合間に
    const stale = anchored.filter(x => !lastShown.has(x.blobId) && x.blobId !== prev && (x.file < curFile || (x.file === curFile && x.t < curS)));
    if (stale.length) return stale[stale.length - 1];
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
    const n = Math.max(1, Math.ceil(dur / interval));
    for (let k = 0; k < n; k++) {
      const s = k * interval, e = (k + 1) * interval;
      curFile = fi; curS = s;
      // 今の場所（s〜e）の写真で、まだ出していないもの。なければ1つ前の間隔のもの（遅れて出さない）
      let x = mine.find(y => !lastShown.has(y.blobId) && y.t >= s && y.t < e && y.blobId !== prev)
        || mine.find(y => !lastShown.has(y.blobId) && y.t >= s - interval && y.t < s && y.blobId !== prev) || null;
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

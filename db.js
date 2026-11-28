// db.js — iPad の中（IndexedDB）に本と音声を保存する
const DB_NAME = 'kikiusa';
const DB_VER = 1;
let dbp = null;

function open() {
  if (!dbp) {
    const p = dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
      };
      r.onsuccess = () => {
        const d = r.result;
        // iPad はアプリを裏に回したあと、つなぎ目を切ることがある。切れたら次に開き直す
        d.onclose = () => { if (dbp === p) dbp = null; };
        d.onversionchange = () => { try { d.close(); } catch { } if (dbp === p) dbp = null; };
        resolve(d);
      };
      r.onerror = () => { dbp = null; reject(r.error); };
      r.onblocked = () => { dbp = null; reject(new Error('データベースを開けません（ほかの画面で開いていませんか）')); };
    });
  }
  return dbp;
}

// つなぎ目を捨てて、次の読み書きで開き直す（画面に戻ったとき・読み書きが固まったとき）
export function reset() {
  const old = dbp; dbp = null;
  if (old) old.then(d => { try { d.close(); } catch { } }, () => { });
}

function run(store, mode, fn, retried = false) {
  return open().then(d => new Promise((resolve, reject) => {
    let t;
    try { t = d.transaction(store, mode); }
    catch (e) {   // つなぎ目が切れていた（InvalidStateError）→ 1回だけ開き直す
      dbp = null;
      if (!retried) { run(store, mode, fn, true).then(resolve, reject); return; }
      reject(e); return;
    }
    const s = t.objectStore(store);
    let out;
    const req = fn(s);
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('保存を取り消しました'));
  }));
}

export function isQuotaError(e) {
  return !!e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message || '')));
}

export async function allBooks() {
  return (await run('books', 'readonly', s => s.getAll())) || [];
}

export function putBook(book) {
  return run('books', 'readwrite', s => s.put(book));
}

export async function putBlob(id, blob) {
  try {
    await run('blobs', 'readwrite', s => s.put({ id, blob }));
  } catch (e) {
    if (isQuotaError(e)) throw e;
    // Blob のまま保存できない環境の予備
    const buf = await blob.arrayBuffer();
    await run('blobs', 'readwrite', s => s.put({ id, buf, type: blob.type }));
  }
}

export async function getBlob(id) {
  const r = await run('blobs', 'readonly', s => s.get(id));
  if (!r) return null;
  if (r.blob) return r.blob;
  if (r.buf) return new Blob([r.buf], { type: r.type || '' });
  return null;
}

export function deleteBlobs(ids) {
  const list = ids.filter(Boolean);
  if (!list.length) return Promise.resolve();
  return run('blobs', 'readwrite', s => { list.forEach(id => s.delete(id)); return null; });
}

export async function deleteBook(book) {
  await deleteBlobs([...(book.files || []).map(f => f.blobId), book.coverId, ...(book.images || []).map(x => x.blobId), ...((book.auto && book.auto.pool) || []).map(x => x.blobId)]);
  await run('books', 'readwrite', s => s.delete(book.id));
}

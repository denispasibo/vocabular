/* Vocabular Reader — books with tap-to-translate and "why is it said this way" */
'use strict';

const API_KEY_STORE = 'vocabular.claude.key';
const READER_FS_KEY = 'vocabular.reader.fs';
const EXPLAIN_MODEL = 'claude-haiku-4-5';

const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const TESSERACT_URL = 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js';

let pendingOcrFile = null; // scanned PDF waiting for the user to start OCR

const readRoot = document.getElementById('read-root');
let currentBook = null;
let currentChapter = 0;
let popupWordCtx = null; // { word, sentence } for the sentence sheet

/* ---------- IndexedDB (books are too big for localStorage) ---------- */

function booksDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('vocabular-books', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      // scanned page images, keyed "bookId:pageIndex"
      if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function storeTx(store, mode, fn) {
  return booksDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const out = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(out.result !== undefined ? out.result : undefined);
    tx.onerror = () => reject(tx.error);
  }));
}

const booksTx = (mode, fn) => storeTx('books', mode, fn);
const dbAllBooks = () => booksTx('readonly', (s) => s.getAll());
const dbGetBook = (id) => booksTx('readonly', (s) => s.get(id));
const dbPutBook = (book) => booksTx('readwrite', (s) => s.put(book));
const dbDeleteBook = (id) => booksTx('readwrite', (s) => s.delete(id));

const dbPutPage = (bookId, idx, blob) =>
  storeTx('pages', 'readwrite', (s) => s.put(blob, bookId + ':' + idx));
const dbGetPage = (bookId, idx) =>
  storeTx('pages', 'readonly', (s) => s.get(bookId + ':' + idx));
async function dbDeletePages(bookId, count) {
  for (let i = 0; i < count; i++) {
    await storeTx('pages', 'readwrite', (s) => s.delete(bookId + ':' + i)).catch(() => {});
  }
}

const posKey = (id) => 'vocabular.bookpos.' + id;

function savePos(id, ch, ratio) {
  try { localStorage.setItem(posKey(id), JSON.stringify({ ch, ratio })); } catch {}
}

function loadPos(id) {
  try { return JSON.parse(localStorage.getItem(posKey(id))) || { ch: 0, ratio: 0 }; }
  catch { return { ch: 0, ratio: 0 }; }
}

/* ---------- Lazy script loading (parsers are only needed on import) ---------- */

const loadedScripts = {};
function loadScript(url) {
  if (!loadedScripts[url]) {
    loadedScripts[url] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load ' + url));
      document.head.appendChild(s);
    });
  }
  return loadedScripts[url];
}

/* ---------- Book parsing ---------- */

function textToChapters(raw) {
  const paras = raw.split(/\n\s*\n/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const headingRe = /^(chapter|part|book|capítulo|parte|глава)\s+([\divxlc]+|\w+)\b.{0,40}$/i;
  const marks = [];
  paras.forEach((p, i) => { if (headingRe.test(p)) marks.push(i); });
  const chapters = [];
  if (marks.length >= 2) {
    if (marks[0] > 0) chapters.push({ title: 'Beginning', paras: paras.slice(0, marks[0]) });
    marks.forEach((m, k) => {
      const end = k + 1 < marks.length ? marks[k + 1] : paras.length;
      chapters.push({ title: paras[m], paras: paras.slice(m + 1, end) });
    });
  } else {
    for (let i = 0; i < paras.length; i += 120) {
      chapters.push({
        title: paras.length > 120 ? `Part ${chapters.length + 1}` : 'Text',
        paras: paras.slice(i, i + 120),
      });
    }
  }
  return chapters.filter((c) => c.paras.length);
}

async function parseEpub(file, onProgress) {
  onProgress?.('Unpacking EPUB…');
  await loadScript(JSZIP_URL);
  const zip = await JSZip.loadAsync(file);
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('Not a valid EPUB (no container.xml inside)');
  const containerXml = await containerFile.async('string');
  const container = new DOMParser().parseFromString(containerXml, 'application/xml');
  const opfPath = container.getElementsByTagName('rootfile')[0].getAttribute('full-path');
  const opfDir = opfPath.split('/').slice(0, -1).join('/');
  const opf = new DOMParser().parseFromString(await zip.file(opfPath).async('string'), 'application/xml');

  const manifest = {};
  for (const item of opf.getElementsByTagName('item')) {
    manifest[item.getAttribute('id')] = item.getAttribute('href');
  }
  const title = opf.getElementsByTagNameNS('*', 'title')[0]?.textContent.trim() ||
    file.name.replace(/\.epub$/i, '');

  const chapters = [];
  const itemrefs = [...opf.getElementsByTagName('itemref')];
  for (let i = 0; i < itemrefs.length; i++) {
    onProgress?.(`Reading chapter ${i + 1} / ${itemrefs.length}…`);
    const href = manifest[itemrefs[i].getAttribute('idref')];
    if (!href) continue;
    const path = decodeURIComponent((opfDir ? opfDir + '/' : '') + href.split('#')[0]);
    const entry = zip.file(path);
    if (!entry) continue;
    const doc = new DOMParser().parseFromString(await entry.async('string'), 'text/html');
    const heading = doc.querySelector('h1,h2,h3')?.textContent.replace(/\s+/g, ' ').trim();
    const paras = [...doc.querySelectorAll('p')]
      .map((p) => p.textContent.replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 1);
    if (!paras.length) continue;
    chapters.push({ title: heading || `Chapter ${chapters.length + 1}`, paras });
  }
  if (!chapters.length) {
    if (zip.file('META-INF/encryption.xml')) {
      throw new Error('This EPUB is DRM-protected (encrypted) — the text can’t be read. Use a DRM-free copy.');
    }
    throw new Error('No readable text found in this EPUB');
  }
  return { title, chapters };
}

let pdfWorkerReady = false;

async function ensurePdfjs() {
  await loadScript(PDFJS_URL);
  if (!pdfWorkerReady) {
    // A cross-origin worker URL can't be used directly — load the worker
    // code through a same-origin blob so parsing runs off the main thread
    try {
      const src = await (await fetch(PDFJS_WORKER_URL)).text();
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    } catch {
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    }
    pdfWorkerReady = true;
  }
}

async function parsePdf(file, onProgress) {
  onProgress?.('Loading PDF engine…');
  await ensurePdfjs();
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;

  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    if (p === 1 || p % 5 === 0) onProgress?.(`Reading page ${p} / ${pdf.numPages}…`);
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let text = '';
    for (const it of content.items) {
      text += it.str;
      text += it.hasEOL ? '\n' : ' ';
    }
    pages.push(text);
  }

  const chs = pagesToChapters(pages);
  if (!chs.length) {
    const err = new Error('No text layer found in this PDF (scanned image?)');
    err.code = 'NO_TEXT_LAYER';
    throw err;
  }
  return { title: file.name.replace(/\.pdf$/i, ''), chapters: chs };
}

// Reassemble page texts into paragraphs: unhyphenate, then break where a
// line ends a sentence
function pagesToChapters(pages) {
  const PAGES_PER_CH = 10;
  const chapters = [];
  for (let i = 0; i < pages.length; i += PAGES_PER_CH) {
    let chunk = pages.slice(i, i + PAGES_PER_CH).join('\n');
    chunk = chunk.replace(/([a-zà-úá-ü])-\s*\n\s*([a-zà-úá-ü])/gi, '$1$2');
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    const paras = [];
    let cur = '';
    for (const line of lines) {
      cur = cur ? cur + ' ' + line : line;
      if (/[.!?…]["'”’)]*$/.test(line)) {
        paras.push(cur);
        cur = '';
      }
    }
    if (cur) paras.push(cur);
    const last = Math.min(i + PAGES_PER_CH, pages.length);
    chapters.push({ title: `Pages ${i + 1}–${last}`, paras: paras.filter((s) => s.length > 2) });
  }
  return chapters.filter((c) => c.paras.length);
}

/* ---------- OCR for scanned PDFs (runs fully in the browser) ---------- */

async function ocrPdf(file, onProgress) {
  onProgress?.('Loading OCR engine…');
  await ensurePdfjs();
  await loadScript(TESSERACT_URL);

  let ocrPage = 0;
  let ocrTotal = 0;
  const langCode = currentLang === 'es' ? 'spa' : 'eng';
  const worker = await Tesseract.createWorker(langCode, 1, {
    logger: (m) => {
      if (m.status === 'recognizing text' && ocrTotal) {
        onProgress?.(`Recognizing page ${ocrPage} / ${ocrTotal} — ${Math.round((m.progress || 0) * 100)}%`);
      }
    },
  });

  try {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    ocrTotal = pdf.numPages;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const pages = [];
    const scanPages = []; // per-page word boxes for the original-layout view
    const pageBlobs = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      ocrPage = p;
      onProgress?.(`Rendering page ${p} / ${pdf.numPages}…`);
      const page = await pdf.getPage(p);
      let viewport = page.getViewport({ scale: 2 });
      if (viewport.width > 1800) {
        viewport = page.getViewport({ scale: (2 * 1800) / viewport.width });
      }
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: ctx, viewport }).promise;
      const { data } = await worker.recognize(canvas);
      pages.push(data.text || '');

      // Words with boxes + a joined text where each word knows its offset,
      // so a tap in Book view can reconstruct the surrounding sentence
      const words = [];
      let joined = '';
      for (const w of data.words || []) {
        const t = (w.text || '').trim();
        if (!t) continue;
        const off = joined ? joined.length + 1 : 0;
        words.push({
          t,
          i: off,
          x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1,
        });
        joined += (joined ? ' ' : '') + t;
      }
      scanPages.push({ w: canvas.width, h: canvas.height, text: joined, words });
      pageBlobs.push(await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.8)));
    }
    const chapters = pagesToChapters(pages);
    if (!chapters.length) throw new Error('OCR finished but found no readable text');
    return {
      title: file.name.replace(/\.pdf$/i, ''),
      chapters,
      scan: { pages: scanPages, blobs: pageBlobs },
    };
  } finally {
    worker.terminate();
  }
}

async function importBookFile(file, onProgress) {
  const name = file.name.toLowerCase();
  let parsed;
  if (name.endsWith('.epub')) parsed = await parseEpub(file, onProgress);
  else if (name.endsWith('.pdf')) parsed = await parsePdf(file, onProgress);
  else parsed = { title: file.name.replace(/\.[^.]+$/, ''), chapters: textToChapters(await file.text()) };
  onProgress?.('Saving…');
  return addBook(parsed.title, parsed.chapters);
}

async function addBook(title, chapters, scan = null, extra = {}) {
  if (!chapters.length) throw new Error('Empty book');
  const book = {
    id: Date.now().toString(36),
    title: title.slice(0, 120),
    lang: currentLang,
    addedAt: Date.now(),
    chapters,
    ...extra,
  };
  if (scan) {
    try {
      for (let i = 0; i < scan.blobs.length; i++) {
        await dbPutPage(book.id, i, scan.blobs[i]);
      }
      book.scan = { pages: scan.pages };
    } catch (e) {
      // Not enough storage for page images — keep the text-only book
      console.error('Failed to store page images:', e);
      await dbDeletePages(book.id, scan.blobs.length);
    }
  }
  await dbPutBook(book);
  return book;
}

/* ---------- Songs (lyrics from LRCLIB) ---------- */

async function searchSongs(query) {
  const opts = AbortSignal?.timeout ? { signal: AbortSignal.timeout(10000) } : {};
  const res = await fetch('https://lrclib.net/api/search?q=' + encodeURIComponent(query), opts);
  if (!res.ok) throw new Error('Lyrics search failed (' + res.status + ')');
  const data = await res.json();
  const seen = new Set();
  const out = [];
  for (const x of data) {
    if (!x.plainLyrics) continue; // instrumental or empty
    const key = (x.artistName + '|' + x.trackName).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x);
    if (out.length >= 8) break;
  }
  return out;
}

async function importSong(item) {
  const rawLines = item.plainLyrics.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  // keep single blank lines as stanza separators
  const lines = [];
  for (const l of rawLines) {
    if (l === '' && (lines.length === 0 || lines[lines.length - 1] === '')) continue;
    lines.push(l);
  }
  while (lines[lines.length - 1] === '') lines.pop();
  if (!lines.filter(Boolean).length) throw new Error('This entry has no usable lyrics');

  const title = `${item.artistName} — ${item.trackName}`;
  return addBook(title, [{ title: 'Lyrics', paras: lines }], null, {
    kind: 'song',
    artist: item.artistName,
    track: item.trackName,
  });
}

/* ---------- Library screen ---------- */

function showImportStatus(msg) {
  const el = document.getElementById('import-status');
  if (el) el.textContent = msg;
}

async function renderRead(errorMsg = '', { offerOcr = false } = {}) {
  if (currentBook) {
    if (currentBook.scan && localStorage.getItem('vocabular.scanview.' + currentBook.id) === '1') {
      renderBookView(+localStorage.getItem('vocabular.scanpos.' + currentBook.id) || 0);
    } else {
      renderReader();
    }
    return;
  }
  const books = await dbAllBooks().catch(() => []);
  books.sort((a, b) => b.addedAt - a.addedAt);
  const hasKey = !!localStorage.getItem(API_KEY_STORE);

  readRoot.innerHTML = `
    ${errorMsg ? `<div class="import-error">⚠️ ${esc(errorMsg)}
      ${offerOcr ? `<p style="margin-top:8px;color:var(--text)">This looks like a scanned book.
        I can recognize the text right here in the app — roughly 3–10 seconds per page,
        done once and saved.</p>
        <button class="btn btn-primary btn-block" id="ocr-btn">🔍 Recognize text (OCR)</button>` : ''}
    </div>` : ''}
    <div class="lib-toolbar">
      <button class="btn btn-primary" id="add-book-btn">📂 Add book</button>
      <button class="btn btn-ghost" id="add-song-btn">🎵 Add song</button>
      <button class="btn btn-ghost" id="paste-text-btn">📋 Paste text</button>
      <button class="btn btn-ghost" id="ai-settings-btn" title="AI settings">${hasKey ? '🤖 AI ✓' : '🤖 AI'}</button>
      <input type="file" id="book-file" accept=".epub,.pdf,.txt" hidden>
    </div>
    <div id="song-form" class="ai-settings" hidden>
      <form id="song-search-form" class="typing-row" style="margin-top:0">
        <input type="text" id="song-query" class="paste-input" style="flex:1;min-width:0"
               placeholder="Artist and song title…" autocomplete="off">
        <button class="btn btn-primary" type="submit">Search</button>
      </form>
      <div id="song-results" style="margin-top:10px"></div>
    </div>
    <div id="ai-settings" class="ai-settings" hidden>
      <p style="font-size:14px;margin-bottom:8px">Claude API key enables the full “Why is it said this way?”
        analysis of sentences (idioms, phrasal verbs, tone). Get one at
        <strong>console.anthropic.com</strong>. The key is stored only on this device.</p>
      <div class="typing-row">
        <input type="password" id="api-key-input" placeholder="${hasKey ? 'Key saved — paste a new one to replace' : 'sk-ant-…'}" autocomplete="off">
        <button class="btn btn-primary" id="api-key-save">Save</button>
      </div>
      ${hasKey ? '<button class="btn btn-danger" id="api-key-clear" style="margin-top:6px;padding:6px 0">Remove key</button>' : ''}
    </div>
    <div id="paste-form" class="ai-settings" hidden>
      <input type="text" id="paste-title" placeholder="Title" style="width:100%;margin-bottom:8px" class="paste-input">
      <textarea id="paste-body" class="note-field" style="min-height:120px" placeholder="Paste the text here…"></textarea>
      <button class="btn btn-primary btn-block" id="paste-add">Add to library</button>
    </div>
    <ul class="dict-list" id="book-list">
      ${books.map((b) => {
        const pos = loadPos(b.id);
        const pct = Math.round(((pos.ch + pos.ratio) / b.chapters.length) * 100);
        return `<li class="dict-item" data-id="${b.id}">
          <div class="dict-item-main">
            <div class="dict-item-word">${b.kind === 'song' ? '🎵' : (b.lang === 'es' ? '🇪🇸' : '🇬🇧')} ${esc(b.title)}</div>
            <div class="dict-item-sub">${b.kind === 'song' ? 'song lyrics' : `${b.chapters.length} ${b.chapters.length === 1 ? 'chapter' : 'chapters'} · ${pct}% read`}</div>
          </div>
          <button class="book-del" data-del="${b.id}" aria-label="Delete book">✕</button>
        </li>`;
      }).join('')}
    </ul>
    ${!books.length ? `<div class="empty-state"><div class="empty-icon">📚</div>
      <p>No books yet.<br>Add an EPUB, PDF or TXT — then tap any word<br>while reading to translate and save it.</p></div>` : ''}
  `;

  const fileInput = document.getElementById('book-file');
  document.getElementById('add-book-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    readRoot.innerHTML = `<div class="empty-state">
      <div class="spinner" role="status"></div>
      <p><strong>${esc(file.name)}</strong></p>
      <p id="import-status" class="muted">Importing…</p>
    </div>`;
    try {
      const book = await importBookFile(file, showImportStatus);
      showToast(`Added: ${book.title}`);
      openBook(book.id);
    } catch (err) {
      console.error('Book import failed:', err);
      if (err.code === 'NO_TEXT_LAYER') {
        pendingOcrFile = file;
        renderRead(err.message, { offerOcr: true });
      } else {
        renderRead(err.message || 'Could not import this file');
      }
    }
    e.target.value = '';
  });

  document.getElementById('ocr-btn')?.addEventListener('click', async () => {
    const file = pendingOcrFile;
    if (!file) { renderRead(); return; }
    readRoot.innerHTML = `<div class="empty-state">
      <div class="spinner" role="status"></div>
      <p><strong>${esc(file.name)}</strong></p>
      <p id="import-status" class="muted">Starting OCR…</p>
      <p class="muted" style="font-size:12.5px;margin-top:10px">Keep this tab open — recognition runs on your device.</p>
    </div>`;
    try {
      const parsed = await ocrPdf(file, showImportStatus);
      showImportStatus('Saving pages…');
      const book = await addBook(parsed.title, parsed.chapters, parsed.scan);
      pendingOcrFile = null;
      showToast('Text recognized ✓');
      openBook(book.id);
    } catch (err) {
      console.error('OCR failed:', err);
      renderRead(err.message || 'OCR failed');
    }
  });

  document.getElementById('paste-text-btn').addEventListener('click', () => {
    const f = document.getElementById('paste-form');
    f.hidden = !f.hidden;
    document.getElementById('ai-settings').hidden = true;
    document.getElementById('song-form').hidden = true;
  });

  // Songs
  document.getElementById('add-song-btn').addEventListener('click', () => {
    const f = document.getElementById('song-form');
    f.hidden = !f.hidden;
    document.getElementById('ai-settings').hidden = true;
    document.getElementById('paste-form').hidden = true;
    if (!f.hidden) document.getElementById('song-query').focus();
  });
  document.getElementById('song-search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = document.getElementById('song-query').value.trim();
    if (!q) return;
    const box = document.getElementById('song-results');
    box.innerHTML = '<div class="spinner" role="status"></div>';
    try {
      const results = await searchSongs(q);
      if (!results.length) {
        box.innerHTML = '<p class="muted">Nothing found — try “artist song title”.</p>';
        return;
      }
      box.innerHTML = results.map((r, i) => {
        const dur = r.duration ? `${Math.floor(r.duration / 60)}:${String(Math.round(r.duration % 60)).padStart(2, '0')}` : '';
        return `<div class="dict-item song-result" data-i="${i}" style="margin-bottom:8px">
          <div class="dict-item-main">
            <div class="dict-item-word">${esc(r.trackName)}</div>
            <div class="dict-item-sub">${esc(r.artistName)}${dur ? ' · ' + dur : ''}</div>
          </div>
        </div>`;
      }).join('');
      box.querySelectorAll('.song-result').forEach((el) => {
        el.addEventListener('click', async () => {
          try {
            const book = await importSong(results[+el.dataset.i]);
            showToast('Song added ✓');
            openBook(book.id);
          } catch (err) {
            showToast(err.message || 'Could not import lyrics');
          }
        });
      });
    } catch (err) {
      box.innerHTML = `<p class="result-bad">${esc(err.message || 'Search failed')}</p>`;
    }
  });
  document.getElementById('paste-add').addEventListener('click', async () => {
    const title = document.getElementById('paste-title').value.trim() || 'Pasted text';
    const body = document.getElementById('paste-body').value.trim();
    if (!body) { showToast('Paste some text first'); return; }
    const book = await addBook(title, textToChapters(body));
    showToast('Added ✓');
    openBook(book.id);
  });

  document.getElementById('ai-settings-btn').addEventListener('click', () => {
    const f = document.getElementById('ai-settings');
    f.hidden = !f.hidden;
    document.getElementById('paste-form').hidden = true;
  });
  document.getElementById('api-key-save').addEventListener('click', () => {
    const v = document.getElementById('api-key-input').value.trim();
    if (!v.startsWith('sk-ant-')) { showToast('That doesn’t look like a Claude API key'); return; }
    localStorage.setItem(API_KEY_STORE, v);
    showToast('AI analysis enabled ✓');
    renderRead();
  });
  document.getElementById('api-key-clear')?.addEventListener('click', () => {
    localStorage.removeItem(API_KEY_STORE);
    showToast('Key removed');
    renderRead();
  });

  document.querySelectorAll('#book-list .dict-item').forEach((li) => {
    li.addEventListener('click', (e) => {
      if (e.target.closest('.book-del')) return;
      openBook(li.dataset.id);
    });
  });
  document.querySelectorAll('.book-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.del;
      const book = await dbGetBook(id);
      if (!confirm(`Delete “${book?.title}” from the library?`)) return;
      await dbDeleteBook(id);
      if (book?.scan) await dbDeletePages(id, book.scan.pages.length);
      localStorage.removeItem(posKey(id));
      localStorage.removeItem('vocabular.scanpos.' + id);
      renderRead();
    });
  });
}

/* ---------- Reader screen ---------- */

async function openBook(id) {
  currentBook = await dbGetBook(id);
  if (!currentBook) { renderRead(); return; }
  currentChapter = Math.min(loadPos(id).ch, currentBook.chapters.length - 1);
  if (currentBook.scan && localStorage.getItem('vocabular.scanview.' + id) === '1') {
    renderBookView(+localStorage.getItem('vocabular.scanpos.' + id) || 0);
  } else {
    renderReader(loadPos(id).ratio);
  }
}

function readerFontSize() {
  return parseInt(localStorage.getItem(READER_FS_KEY), 10) || 17;
}

function renderReader(restoreRatio = 0) {
  const book = currentBook;
  const ch = book.chapters[currentChapter];
  const fs = readerFontSize();

  localStorage.setItem('vocabular.scanview.' + book.id, '0');

  readRoot.innerHTML = `
    <div class="reader-bar">
      <button class="btn btn-ghost btn-small" id="reader-back">‹ Library</button>
      ${book.scan ? `<button class="btn btn-ghost btn-small" id="view-book" title="Original pages">📄 Book</button>` : ''}
      <select id="chapter-select" class="chapter-select" aria-label="Chapter">
        ${book.chapters.map((c, i) =>
          `<option value="${i}" ${i === currentChapter ? 'selected' : ''}>${esc(c.title.slice(0, 48))}</option>`
        ).join('')}
      </select>
      <button class="btn btn-ghost btn-small" id="fs-minus" aria-label="Smaller text">A−</button>
      <button class="btn btn-ghost btn-small" id="fs-plus" aria-label="Larger text">A+</button>
    </div>
    <div class="reader-hint muted">Tap any word to translate it. Select a phrase to analyze it.${
      book.kind === 'song'
        ? ` <a class="ext-link" style="margin:0;font-size:12.5px" target="_blank" rel="noopener"
             href="https://www.youtube.com/results?search_query=${encodeURIComponent(book.artist + ' ' + book.track)}">▶️ YouTube</a>`
        : ''}</div>
    <div id="reader-text" class="reader-text${book.kind === 'song' ? ' song-text' : ''}" style="font-size:${fs}px">
      ${ch.paras.map((p) => p === ''
        ? '<div class="stanza-gap"></div>'
        : `<p>${esc(p)}</p>`).join('')}
    </div>
    <div class="reader-nav">
      <button class="btn btn-ghost" id="ch-prev" ${currentChapter === 0 ? 'disabled' : ''}>‹ Prev</button>
      <span class="muted" style="align-self:center;font-size:13.5px">${currentChapter + 1} / ${book.chapters.length}</span>
      <button class="btn btn-ghost" id="ch-next" ${currentChapter >= book.chapters.length - 1 ? 'disabled' : ''}>Next ›</button>
    </div>
  `;

  document.getElementById('reader-back').addEventListener('click', () => {
    currentBook = null;
    hideWordPop();
    hideSheet();
    renderRead();
  });
  document.getElementById('view-book')?.addEventListener('click', () => {
    renderBookView(+localStorage.getItem('vocabular.scanpos.' + book.id) || 0);
  });
  document.getElementById('chapter-select').addEventListener('change', (e) => {
    currentChapter = +e.target.value;
    savePos(book.id, currentChapter, 0);
    renderReader();
    window.scrollTo(0, 0);
  });
  document.getElementById('ch-prev').addEventListener('click', () => {
    if (currentChapter > 0) { currentChapter--; savePos(book.id, currentChapter, 0); renderReader(); window.scrollTo(0, 0); }
  });
  document.getElementById('ch-next').addEventListener('click', () => {
    if (currentChapter < book.chapters.length - 1) { currentChapter++; savePos(book.id, currentChapter, 0); renderReader(); window.scrollTo(0, 0); }
  });
  const setFs = (d) => {
    const v = Math.max(14, Math.min(24, readerFontSize() + d));
    localStorage.setItem(READER_FS_KEY, v);
    document.getElementById('reader-text').style.fontSize = v + 'px';
  };
  document.getElementById('fs-minus').addEventListener('click', () => setFs(-1));
  document.getElementById('fs-plus').addEventListener('click', () => setFs(1));

  const textEl = document.getElementById('reader-text');
  textEl.addEventListener('click', onReaderTap);

  // Restore and track reading position
  requestAnimationFrame(() => {
    if (restoreRatio > 0) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, max * restoreRatio);
    }
  });
  let scrollT;
  window.onscroll = () => {
    if (!currentBook) return;
    clearTimeout(scrollT);
    scrollT = setTimeout(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      savePos(book.id, currentChapter, max > 0 ? window.scrollY / max : 0);
    }, 400);
  };
}

/* ---------- Book view: original scanned pages with tappable words ---------- */

let scanImgUrl = null;

async function renderBookView(pageIdx = 0) {
  const book = currentBook;
  if (!book?.scan) { renderReader(); return; }
  const total = book.scan.pages.length;
  pageIdx = Math.max(0, Math.min(pageIdx, total - 1));
  localStorage.setItem('vocabular.scanview.' + book.id, '1');
  localStorage.setItem('vocabular.scanpos.' + book.id, pageIdx);
  hideWordPop();
  hideSheet();
  if (scanImgUrl) { URL.revokeObjectURL(scanImgUrl); scanImgUrl = null; }

  const pg = book.scan.pages[pageIdx];
  const blob = await dbGetPage(book.id, pageIdx).catch(() => null);

  readRoot.innerHTML = `
    <div class="reader-bar">
      <button class="btn btn-ghost btn-small" id="reader-back">‹ Library</button>
      <button class="btn btn-ghost btn-small" id="view-text" title="Text view">📖 Text</button>
      <span class="muted" style="flex:1;text-align:center;font-size:13.5px">${pageIdx + 1} / ${total}</span>
      <button class="btn btn-ghost btn-small" id="pg-prev" ${pageIdx === 0 ? 'disabled' : ''}>‹</button>
      <button class="btn btn-ghost btn-small" id="pg-next" ${pageIdx >= total - 1 ? 'disabled' : ''}>›</button>
    </div>
    <div class="reader-hint muted">Original page — tap any word to translate it.</div>
    <div class="scan-wrap">
      ${blob ? `<img id="scan-img" alt="Book page ${pageIdx + 1}">` : '<p class="muted" style="padding:30px;text-align:center">Page image not available on this device</p>'}
      <div class="scan-overlay" id="scan-overlay"></div>
    </div>`;

  document.getElementById('reader-back').addEventListener('click', () => {
    currentBook = null;
    hideWordPop();
    hideSheet();
    renderRead();
  });
  document.getElementById('view-text').addEventListener('click', () => renderReader());
  document.getElementById('pg-prev').addEventListener('click', () => renderBookView(pageIdx - 1));
  document.getElementById('pg-next').addEventListener('click', () => renderBookView(pageIdx + 1));

  if (blob) {
    scanImgUrl = URL.createObjectURL(blob);
    document.getElementById('scan-img').src = scanImgUrl;
  }

  // Invisible word hotspots, positioned in percent of the page size
  const overlay = document.getElementById('scan-overlay');
  overlay.innerHTML = pg.words.map((w, k) =>
    `<span data-k="${k}" style="left:${((w.x0 / pg.w) * 100).toFixed(2)}%;top:${((w.y0 / pg.h) * 100).toFixed(2)}%;width:${(((w.x1 - w.x0) / pg.w) * 100).toFixed(2)}%;height:${(((w.y1 - w.y0) / pg.h) * 100).toFixed(2)}%"></span>`
  ).join('');
  overlay.addEventListener('click', (e) => {
    const span = e.target.closest('span[data-k]');
    if (!span) { hideWordPop(); return; }
    const w = pg.words[+span.dataset.k];
    const word = w.t.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    if (!word) return;
    showWordPop({ word, paraText: pg.text, wordStart: w.i }, e.clientX, e.clientY);
  });
  window.scrollTo(0, 0);
}

/* ---------- Tap handling: word popup ---------- */

function wordAtPoint(x, y) {
  let node, offset;
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (!r) return null;
    node = r.startContainer;
    offset = r.startOffset;
  } else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (!p) return null;
    node = p.offsetNode;
    offset = p.offset;
  } else return null;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.textContent;
  const isW = (c) => c && /[\p{L}\p{M}'’]/u.test(c);
  let s = offset, e = offset;
  while (s > 0 && isW(text[s - 1])) s--;
  while (e < text.length && isW(text[e])) e++;
  const word = text.slice(s, e).replace(/^['’]+|['’]+$/g, '');
  if (!word || !/\p{L}/u.test(word)) return null;
  return { word, paraText: text, wordStart: s };
}

function sentenceAround(text, index) {
  const re = /[.!?…]+["'”’)]*\s+/g;
  let start = 0, m;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (index < end) return text.slice(start, end).trim();
    start = end;
  }
  return text.slice(start).trim();
}

function onReaderTap(e) {
  const sel = window.getSelection()?.toString().trim();
  if (sel && sel.length > 2 && /\s/.test(sel)) {
    // A selected phrase — straight to the sentence sheet
    hideWordPop();
    openSheet(sel.replace(/\s+/g, ' ').slice(0, 400), null);
    return;
  }
  const hit = wordAtPoint(e.clientX, e.clientY);
  if (!hit) { hideWordPop(); return; }
  showWordPop(hit, e.clientX, e.clientY);
}

let wordPopEl = null;

function hideWordPop() {
  wordPopEl?.remove();
  wordPopEl = null;
}

async function showWordPop(hit, x, y) {
  hideWordPop();
  const { word, paraText, wordStart } = hit;
  const sentence = sentenceAround(paraText, wordStart);
  const lang = currentBook.lang;
  popupWordCtx = { word, sentence };

  const pop = document.createElement('div');
  pop.className = 'word-pop';
  pop.innerHTML = `
    <div class="word-pop-head">
      <strong>${esc(word)}</strong>
      <span class="word-pop-tr muted">…</span>
    </div>
    <div class="word-pop-actions">
      <button data-act="speak">🔊</button>
      <button data-act="save">💾 Save</button>
      <button data-act="full">📚 Study</button>
      <button data-act="sentence">💬 Sentence</button>
    </div>`;
  document.body.appendChild(pop);
  wordPopEl = pop;
  const rect = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(x - rect.width / 2, window.innerWidth - rect.width - 8)) + 'px';
  pop.style.top = (y + 24 + rect.height > window.innerHeight ? y - rect.height - 12 : y + 24) + 'px';

  let translation = '';
  translateTexts([word], lang)
    .then((tr) => {
      translation = tr?.[0] && tr[0].toLowerCase() !== word.toLowerCase() ? tr[0] : '';
      const el = pop.querySelector('.word-pop-tr');
      if (el) el.textContent = translation || '—';
    })
    .catch(() => { const el = pop.querySelector('.word-pop-tr'); if (el) el.textContent = '—'; });

  pop.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'speak') speak(word, 0.92, lang);
    if (act === 'save') {
      quickSaveFromBook(word, translation, sentence, lang);
      hideWordPop();
    }
    if (act === 'full') {
      quickSaveFromBook(word, translation, sentence, lang, { silent: true });
      hideWordPop();
      if (currentLang !== lang) setLang(lang);
      searchInput.value = word;
      lookupWord(word);
    }
    if (act === 'sentence') {
      hideWordPop();
      openSheet(sentence, word);
    }
  });

  setTimeout(() => document.addEventListener('click', dismissPopOnce), 0);
}

function dismissPopOnce(e) {
  if (wordPopEl && !wordPopEl.contains(e.target)) hideWordPop();
  document.removeEventListener('click', dismissPopOnce);
}

function quickSaveFromBook(word, translation, sentence, lang, { silent = false } = {}) {
  const words = loadWords();
  const id = word.toLowerCase();
  if (words.some((x) => x.id === id && langOf(x) === lang)) {
    if (!silent) showToast('Already in dictionary');
    return;
  }
  const ctx = sentence.length > 200 ? sentence.slice(0, 200) + '…' : sentence;
  words.unshift({
    id, lang, word,
    phonetic: '', audio: '',
    translation: translation || '',
    meanings: [], synonyms: [], antonyms: [], etymology: '',
    note: `“${ctx}” — ${currentBook.title}`,
    addedAt: Date.now(),
    srs: newSrs(),
  });
  saveWords(words);
  if (!silent) showToast('Saved with context ✓');
}

/* ---------- Sentence sheet: translation + explanation ---------- */

let sheetEl = null;

function hideSheet() {
  sheetEl?.remove();
  sheetEl = null;
}

async function openSheet(sentence, focusWord) {
  hideSheet();
  const lang = currentBook.lang;
  const sheet = document.createElement('div');
  sheet.className = 'sent-sheet';
  sheet.innerHTML = `
    <button class="sheet-close" aria-label="Close">✕</button>
    <p class="sent-orig">${esc(sentence)}</p>
    <p class="sent-ru">…</p>
    <button class="btn btn-ghost btn-block" id="explain-btn" style="margin-top:10px">🤔 Why is it said this way?</button>
    <div id="explain-out" class="explain-out" hidden></div>`;
  document.body.appendChild(sheet);
  sheetEl = sheet;

  sheet.querySelector('.sheet-close').addEventListener('click', hideSheet);

  translateTexts([sentence], lang)
    .then((tr) => { const el = sheet.querySelector('.sent-ru'); if (el) el.textContent = tr?.[0] || '—'; })
    .catch(() => { const el = sheet.querySelector('.sent-ru'); if (el) el.textContent = 'Translation failed'; });

  sheet.querySelector('#explain-btn').addEventListener('click', async () => {
    const btn = sheet.querySelector('#explain-btn');
    const out = sheet.querySelector('#explain-out');
    btn.disabled = true;
    btn.textContent = 'Analyzing…';
    out.hidden = false;
    out.textContent = '';
    try {
      const key = localStorage.getItem(API_KEY_STORE);
      const result = key
        ? await explainWithClaude(key, sentence, focusWord, lang)
        : await explainFree(sentence, focusWord, lang);
      out.innerHTML = result;
    } catch (err) {
      out.innerHTML = `<p class="result-bad">${esc(err.message || 'Analysis failed')}</p>`;
    }
    btn.hidden = true;
  });
}

/* ---------- Explanation: free tier (Wiktionary idiom lookup) ---------- */

async function explainFree(sentence, focusWord, lang) {
  const tokens = sentence.toLowerCase().replace(/[^\p{L}\p{M}'’\s-]/gu, ' ')
    .split(/\s+/).filter(Boolean);
  const candidates = new Set();
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const gram = tokens.slice(i, i + n);
      if (!focusWord || gram.includes(focusWord.toLowerCase())) {
        candidates.add(gram.join(' '));
      }
    }
  }
  const list = [...candidates].slice(0, 12);
  const found = [];
  await Promise.all(list.map(async (phrase) => {
    const defs = await fetchWiktionaryDefs(phrase, lang).catch(() => null);
    if (defs) {
      found.push({ phrase, def: defs[0].definitions[0].definition });
    }
  }));

  let html = '';
  if (found.length) {
    html += '<p><strong>Set phrases found in this sentence:</strong></p>';
    for (const f of found) {
      html += `<div class="def-item"><strong>${esc(f.phrase)}</strong> — ${esc(f.def)}</div>`;
    }
  } else {
    html += '<p class="muted">No known idioms found in the dictionary for this sentence.</p>';
  }
  html += `<p class="muted" style="margin-top:10px;font-size:13px">💡 For a full analysis
    (idioms, tone, why the author phrased it this way), add a Claude API key in
    Library → 🤖 AI.</p>`;
  return html;
}

/* ---------- Explanation: Claude API ---------- */

async function explainWithClaude(key, sentence, focusWord, lang) {
  const langName = lang === 'es' ? 'Spanish' : 'English';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: EXPLAIN_MODEL,
      max_tokens: 1000,
      system: `You help a Russian speaker who is reading ${langName} books understand what they read. Answer in Russian, concisely (до 180 слов), without markdown headers. Разбери предложение: 1) идиомы, фразовые глаголы, разговорные или культурно-специфичные обороты — что они значат буквально и по смыслу, почему автор их употребил (тон, стиль, ирония); 2) грамматические конструкции, которые могут сбить с толку; 3) если предложение простое и буквальное — коротко скажи это и дай точный смысл. Не пересказывай перевод предложения целиком, фокусируйся на объяснении неочевидного.`,
      messages: [{
        role: 'user',
        content: `Книга: «${currentBook.title}»\nПредложение: "${sentence}"${focusWord ? `\nМеня особенно интересует: "${focusWord}"` : ''}`,
      }],
    }),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error('Invalid API key — check it in Library → 🤖 AI');
    if (res.status === 429) throw new Error('Rate limit reached — try again in a minute');
    throw new Error('Claude API error ' + res.status);
  }
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('The model declined to analyze this text');
  const text = (data.content || []).map((b) => b.text || '').join('').trim();
  if (!text) throw new Error('Empty response from the model');
  return `<div style="white-space:pre-wrap">${esc(text)}</div>`;
}

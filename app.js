/* Vocabular — checklist-based word study, everything inline */
'use strict';

const STORAGE_KEY = 'vocabular.words.v1';
const LANG_KEY = 'vocabular.lang.v1';

const LANGS = {
  en: { speech: 'en-US', youglish: 'english', wikiKey: 'en', wikiSection: 'English', datamuseExtra: '' },
  es: { speech: 'es-ES', youglish: 'spanish', wikiKey: 'es', wikiSection: 'Spanish', datamuseExtra: '&v=es' },
};

let currentLang = localStorage.getItem(LANG_KEY) === 'es' ? 'es' : 'en';

function langOf(x) {
  return x.lang || 'en';
}

const $ = (sel) => document.querySelector(sel);
const studyArea = $('#study-area');
const studyEmpty = $('#study-empty');
const searchForm = $('#search-form');
const searchInput = $('#search-input');
const dictList = $('#dict-list');
const dictEmpty = $('#dict-empty');
const dictSearch = $('#dict-search');
const dictCount = $('#dict-count');
const reviewArea = $('#review-area');
const reviewCount = $('#review-count');

let currentEntry = null; // word currently being studied

/* ---------- Spaced repetition ---------- */

const SRS_INTERVALS = [1, 3, 7, 21, 60]; // days until next review, per stage
const DAY = 86400000;

function newSrs() {
  return { stage: 0, due: Date.now() + DAY };
}

function dueWords(words) {
  return (words || loadWords()).filter(
    (x) => x.srs && x.srs.due <= Date.now() && langOf(x) === currentLang
  );
}

/* ---------- Storage ---------- */

function loadWords() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveWords(words) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(words));
  updateCounts();
}

function updateCounts() {
  const words = loadWords().filter((x) => langOf(x) === currentLang);
  dictCount.hidden = words.length === 0;
  dictCount.textContent = words.length;
  const due = dueWords().length;
  reviewCount.hidden = due === 0;
  reviewCount.textContent = due;
}

/* ---------- Helpers ---------- */

function esc(s) {
  const div = document.createElement('div');
  div.textContent = s ?? '';
  return div.innerHTML;
}

function stripHtml(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  return doc.body.textContent.replace(/\s+/g, ' ').trim();
}

function showToast(msg) {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.hidden = true; }, 2200);
}

function playphraseLink(word) {
  return 'https://www.playphrase.me/#/search?q=' + encodeURIComponent(word);
}

/* ---------- Speech (works offline, for any word or phrase) ---------- */

function speak(text, rate = 0.92, lang = 'en') {
  if (!('speechSynthesis' in window)) {
    showToast('Speech is not supported in this browser');
    return;
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const speech = LANGS[lang]?.speech || 'en-US';
  u.lang = speech;
  u.rate = rate;
  const prefix = speech.slice(0, 2);
  const voice = speechSynthesis.getVoices()
    .find((v) => v.lang.startsWith(prefix) && v.localService) ||
    speechSynthesis.getVoices().find((v) => v.lang.startsWith(prefix));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}
// Some browsers load voices asynchronously — warm them up
if ('speechSynthesis' in window) speechSynthesis.getVoices();

/* ---------- Russian practical transcription (“how to read it”) ---------- */

// English IPA → Russian letters, longest symbols first
const IPA_RU = [
  ['dʒ', 'дж'], ['tʃ', 'ч'], ['aɪə', 'айэ'], ['aʊə', 'ауэ'], ['aɪ', 'ай'], ['aʊ', 'ау'],
  ['eɪ', 'эй'], ['ɔɪ', 'ой'], ['oʊ', 'оу'], ['əʊ', 'оу'], ['ɪə', 'иэ'], ['eə', 'эа'],
  ['ɛə', 'эа'], ['ʊə', 'уэ'], ['juː', 'ю'], ['ju', 'ю'], ['iː', 'и'], ['uː', 'у'],
  ['ɑː', 'а'], ['ɔː', 'о'], ['ɜː', 'ёр'], ['ɝ', 'эр'], ['ɚ', 'эр'], ['ɜ', 'ёр'],
  ['θ', 'т'], ['ð', 'з'], ['ʃ', 'ш'], ['ʒ', 'ж'], ['ŋ', 'нг'], ['ɹ', 'р'], ['ɾ', 'р'],
  ['æ', 'э'], ['ʌ', 'а'], ['ɑ', 'а'], ['ɒ', 'о'], ['ɔ', 'о'], ['ʊ', 'у'], ['ɪ', 'и'],
  ['ɛ', 'э'], ['ə', 'э'], ['ɡ', 'г'],
  ['r', 'р'], ['j', 'й'], ['w', 'у'], ['i', 'и'], ['e', 'э'], ['u', 'у'], ['a', 'а'],
  ['o', 'о'], ['p', 'п'], ['b', 'б'], ['t', 'т'], ['d', 'д'], ['k', 'к'], ['g', 'г'],
  ['f', 'ф'], ['v', 'в'], ['s', 'с'], ['z', 'з'], ['h', 'х'], ['m', 'м'], ['n', 'н'],
  ['l', 'л'],
].sort((a, b) => b[0].length - a[0].length);

function ipaEnToRu(ipa) {
  const cleaned = (ipa || '').replace(/[/[\]()ˑʲʰ̬̥̩̯͡]/g, '');
  // split into syllables; ˈ marks the stressed one
  const parts = cleaned.split(/([ˈˌ.\s]+)/).filter(Boolean);
  const sylls = [];
  let stressNext = false;
  for (const p of parts) {
    if (/^[ˈˌ.\s]+$/.test(p)) {
      stressNext = p.includes('ˈ');
      continue;
    }
    let out = '';
    let i = 0;
    outer: while (i < p.length) {
      for (const [k, v] of IPA_RU) {
        if (p.startsWith(k, i)) { out += v; i += k.length; continue outer; }
      }
      i++; // unknown symbol — skip
    }
    if (out) sylls.push({ out, stressed: stressNext });
    stressNext = false;
  }
  if (!sylls.length) return '';
  return sylls
    .map((s) => (s.stressed && sylls.length > 1 ? s.out.toUpperCase() : s.out))
    .join(sylls.length > 1 ? '-' : '');
}

// Spanish spelling → Russian letters (reading rules are regular);
// a written accent marks the stressed vowel in uppercase
function esToRu(word) {
  const w = word.toLowerCase();
  const iot = { a: 'я', e: 'е', i: 'и', o: 'о', u: 'ю', á: 'Я', é: 'Е', í: 'И', ó: 'О', ú: 'Ю' };
  const plain = { a: 'а', e: 'э', i: 'и', o: 'о', u: 'у', á: 'А', é: 'Э', í: 'И', ó: 'О', ú: 'У' };
  const cons = {
    c: 'к', d: 'д', f: 'ф', g: 'г', k: 'к', l: 'л', m: 'м', n: 'н',
    p: 'п', r: 'р', s: 'с', t: 'т', w: 'в', ' ': ' ', '-': '-',
  };
  let out = '';
  let i = 0;
  while (i < w.length) {
    const c = w[i];
    const n = w[i + 1] || '';
    const soft = 'eiéí';
    if (c === 'c' && n === 'h') { out += 'ч'; i += 2; continue; }
    if (c === 'l' && n === 'l') {
      out += 'ль'; i += 2;
      if (iot[w[i]]) { out += iot[w[i]]; i++; }
      continue;
    }
    if (c === 'ñ') {
      out += 'нь'; i++;
      if (iot[w[i]]) { out += iot[w[i]]; i++; }
      continue;
    }
    if (c === 'r' && n === 'r') { out += 'рр'; i += 2; continue; }
    if (c === 'q' && n === 'u') { out += 'к'; i += 2; continue; }
    if (c === 'g' && n === 'ü') { out += 'гу'; i += 2; continue; }
    if (c === 'g' && n === 'u' && soft.includes(w[i + 2] || '')) { out += 'г'; i += 2; continue; }
    if (c === 'g' && soft.includes(n)) { out += 'х'; i++; continue; }
    if (c === 'c' && soft.includes(n)) { out += 'с'; i++; continue; }
    if (c === 'h') { i++; continue; } // silent
    if (c === 'j') { out += 'х'; i++; continue; }
    if (c === 'y') { out += (plain[n] ? 'й' : 'и'); i++; continue; }
    if (c === 'x') { out += 'кс'; i++; continue; }
    if (c === 'z') { out += 'с'; i++; continue; }
    if (c === 'v' || c === 'b') { out += 'б'; i++; continue; }
    if (plain[c]) { out += plain[c]; i++; continue; }
    if (cons[c] !== undefined) { out += cons[c]; i++; continue; }
    i++;
  }
  return out;
}

function ruTranscription(entry) {
  if (langOf(entry) === 'es') return esToRu(entry.word);
  return entry.phonetic ? ipaEnToRu(entry.phonetic) : '';
}

/* ---------- API requests (with retries and fallbacks) ---------- */

// Every request gets a timeout — a hanging API must never freeze the app
async function fetchJson(url, tries = 2, timeoutMs = 6000) {
  for (let i = 0; i < tries; i++) {
    try {
      const opts = AbortSignal?.timeout ? { signal: AbortSignal.timeout(timeoutMs) } : {};
      const res = await fetch(url, opts);
      if (res.ok) return await res.json();
    } catch { /* retry */ }
  }
  return null;
}

async function fetchDictionary(word) {
  // this API hangs regularly — one short attempt, Wiktionary covers the rest
  const data = await fetchJson(
    'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word), 1, 5000
  );
  return Array.isArray(data) && data.length ? data : null;
}

// Wiktionary REST — stable, supports phrases ("piece of cake") and Spanish words
async function fetchWiktionaryDefs(word, lang = 'en') {
  const page = word.trim().replace(/\s+/g, '_');
  const data = await fetchJson(
    'https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(page)
  );
  const groups = data?.[LANGS[lang].wikiKey];
  if (!groups?.length) return null;

  const meanings = groups.map((g) => ({
    partOfSpeech: (g.partOfSpeech || '').toLowerCase(),
    definitions: (g.definitions || [])
      .map((d) => ({
        definition: stripHtml(d.definition),
        example: stripHtml((d.parsedExamples?.[0]?.example) || d.examples?.[0] || ''),
      }))
      .filter((d) => d.definition)
      .slice(0, 4),
  })).filter((m) => m.definitions.length);

  return meanings.length ? meanings : null;
}

async function fetchDatamuseSynonyms(word, lang = 'en') {
  const extra = LANGS[lang].datamuseExtra;
  // Spanish vocabulary only supports similar-meaning search, not strict synonyms
  const syn = lang === 'en'
    ? await fetchJson(
        'https://api.datamuse.com/words?rel_syn=' + encodeURIComponent(word) + '&max=14'
      ) || []
    : [];
  if (syn.length >= 4) return syn.map((x) => x.word);
  const similar = await fetchJson(
    'https://api.datamuse.com/words?ml=' + encodeURIComponent(word) + '&max=14' + extra
  ) || [];
  const merged = [...syn.map((x) => x.word)];
  for (const x of similar) {
    if (!merged.includes(x.word) && x.word !== word.toLowerCase()) merged.push(x.word);
  }
  return merged.slice(0, 14);
}

// Batch-translate an array of strings to Russian in one request.
// Strings are joined with newlines; the response preserves them.
async function translateTexts(texts, from = 'en') {
  const clean = texts.map((t) => (t || '').replace(/\s+/g, ' ').trim());
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + from + '&tl=ru&dt=t&q=' +
    encodeURIComponent(clean.join('\n'));
  const data = await fetchJson(url);
  const segs = data?.[0];
  if (!segs) return null;
  const full = segs.map((s) => s[0] || '').join('');
  const lines = full.split('\n').map((s) => s.trim());
  return lines.length === clean.length ? lines : null;
}

// Attach Russian translations to the word and all its definitions.
// The word is translated from its own language; definitions are always
// in English (Wiktionary explains Spanish words in English too).
async function addTranslations(entry) {
  const wordTr = await translateTexts([entry.word], entry.lang).catch(() => null);
  if (wordTr?.[0] && wordTr[0].toLowerCase() !== entry.word.toLowerCase()) {
    entry.translation = wordTr[0];
  }
  const texts = [];
  const refs = [];
  for (const m of entry.meanings) {
    for (const d of m.definitions) {
      texts.push(d.definition);
      refs.push(d);
    }
  }
  if (!texts.length) return;
  const tr = await translateTexts(texts, 'en').catch(() => null);
  if (!tr) return;
  refs.forEach((d, i) => { d.definitionRu = tr[i] || ''; });
}

async function fetchEtymology(word, lang = 'en') {
  const base = 'https://en.wiktionary.org/w/api.php?format=json&origin=*&action=parse&page=' +
    encodeURIComponent(word);
  const secData = await fetchJson(base + '&prop=sections');
  const sections = secData?.parse?.sections || [];
  // Wiktionary pages cover many languages — find Etymology inside ours
  const target = LANGS[lang].wikiSection;
  let inTarget = false;
  let etySec = null;
  for (const s of sections) {
    if (s.toclevel === 1) {
      inTarget = s.line === target;
    } else if (inTarget && /^Etymology/.test(s.line)) {
      etySec = s;
      break;
    }
  }
  if (!etySec) return null;

  const txtData = await fetchJson(base + '&prop=text&section=' + etySec.index);
  const html = txtData?.parse?.text?.['*'];
  if (!html) return null;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const paras = [...doc.querySelectorAll('p')]
    .map((p) => p.textContent.replace(/\[\d+\]/g, '').trim())
    .filter((t) => t.length > 20);
  if (!paras.length) return null;
  return paras.slice(0, 2).join('\n\n');
}

/* ---------- Building the word entry ---------- */

function extractEntry(word, lang, apiData, wikiMeanings, datamuseSyns, etymology) {
  const entry = {
    id: word.toLowerCase(),
    lang,
    word,
    phonetic: '',
    audio: '',
    translation: '',
    meanings: [],
    synonyms: [],
    antonyms: [],
    etymology: etymology || '',
    note: '',
    addedAt: null,
  };

  if (apiData) {
    for (const item of apiData) {
      if (!entry.phonetic && item.phonetic) entry.phonetic = item.phonetic;
      for (const ph of item.phonetics || []) {
        if (!entry.phonetic && ph.text) entry.phonetic = ph.text;
        if (!entry.audio && ph.audio) entry.audio = ph.audio;
      }
      for (const m of item.meanings || []) {
        entry.meanings.push({
          partOfSpeech: m.partOfSpeech,
          // keep synonyms attached to their sense — mixing them is confusing
          synonyms: (m.synonyms || []).slice(0, 10),
          definitions: (m.definitions || []).slice(0, 4).map((d) => ({
            definition: d.definition,
            example: d.example || '',
          })),
        });
        for (const s of m.synonyms || []) {
          if (!entry.synonyms.includes(s)) entry.synonyms.push(s);
        }
        for (const a of m.antonyms || []) {
          if (!entry.antonyms.includes(a)) entry.antonyms.push(a);
        }
      }
    }
  }

  // Fallback definitions from Wiktionary if the main API gave nothing
  if (!entry.meanings.length && wikiMeanings) {
    entry.meanings = wikiMeanings;
  }

  // Datamuse is a fallback only — it can't tell word senses apart
  if (!entry.synonyms.length && datamuseSyns) {
    entry.synonyms = datamuseSyns;
  }

  return entry;
}

/* ---------- YouGlish widget (inline "word in action") ---------- */

let ygPending = null;
let ygScriptRequested = false;
let ygWidget = null;
let ygShownFor = '';

window.onYouglishAPIReady = () => {
  if (ygPending) {
    const w = ygPending;
    ygPending = null;
    mountYouglish(w.word, w.lang);
  }
};

function mountYouglish(word, lang = 'en') {
  const container = document.getElementById('yg-widget');
  if (!container) return;
  container.innerHTML = '';
  const holder = document.createElement('div');
  holder.id = 'yg-widget-inner';
  container.appendChild(holder);
  ygWidget = new YG.Widget('yg-widget-inner', {
    width: Math.min(600, container.clientWidth || 600),
    autoStart: 0,
  });
  ygWidget.fetch(word, LANGS[lang].youglish);
  ygShownFor = lang + ':' + word;
}

function initYouglish(word, lang = 'en') {
  if (ygShownFor === lang + ':' + word && document.getElementById('yg-widget-inner')) return;
  if (window.YG) {
    mountYouglish(word, lang);
    return;
  }
  ygPending = { word, lang };
  if (!ygScriptRequested) {
    ygScriptRequested = true;
    const s = document.createElement('script');
    s.src = 'https://youglish.com/public/emb/widget.js';
    s.async = true;
    document.head.appendChild(s);
  }
}

/* ---------- Rendering the checklist ---------- */

function stepHtml(num, title, bodyHtml, open = false) {
  return `
    <div class="step${open ? ' open done' : ''}" data-step="${num}">
      <button class="step-header" type="button">
        <span class="step-num">${num}</span>
        <span>${title}</span>
        <span class="step-chevron">›</span>
      </button>
      <div class="step-body">${bodyHtml}</div>
    </div>`;
}

function renderStudy(entry, { saved = false } = {}) {
  currentEntry = entry;
  ygShownFor = '';
  studyEmpty.hidden = true;
  studyArea.hidden = false;

  const w = entry.word;
  const hasData = entry.meanings.length > 0;

  // English definition + Russian translation + example, as one block
  const defBlock = (d) => `<div class="def-item">${esc(d.definition)}
    ${d.definitionRu ? `<div class="def-ru">🇷🇺 <span class="ru-blur" title="Tap to reveal">${esc(d.definitionRu)}</span></div>` : ''}
    ${d.example ? `<div class="def-example">“${esc(d.example)}”</div>` : ''}</div>`;

  // 1. Meaning
  const firstDef = hasData ? entry.meanings[0].definitions[0] : null;
  const step1 = `
    ${entry.translation ? `<p class="word-translation">🇷🇺 <span class="ru-blur" title="Tap to reveal">${esc(entry.translation)}</span></p>` : ''}
    ${firstDef
      ? defBlock(firstDef)
      : (entry.translation
          ? ''
          : `<p class="muted">No dictionary definition found. Check the spelling, or use your note below to write the meaning down yourself.</p>`)}`;

  // 2. Pronunciation — always available inline (audio file or browser speech)
  const phonRu = ruTranscription(entry);
  const step2 = `
    ${entry.phonetic ? `<p class="word-phonetic">${esc(entry.phonetic)}</p>` : ''}
    ${phonRu ? `<p class="phonetic-ru">🗣 ${esc(phonRu)} <span class="muted" style="font-size:12.5px">(approx.)</span></p>` : ''}
    <div class="chip-row">
      <button class="btn btn-ghost" type="button" id="play-audio">🔊 Listen</button>
      <button class="btn btn-ghost" type="button" id="play-slow">🐢 Slow</button>
    </div>
    ${!entry.audio ? '<p class="muted" style="margin-top:8px;font-size:13.5px">Using browser voice.</p>' : ''}`;

  // 3. Explanation & example
  let step3 = '';
  if (hasData) {
    const m = entry.meanings[0];
    if (m.partOfSpeech) step3 += `<span class="pos-label">${esc(m.partOfSpeech)}</span>`;
    for (const d of m.definitions) {
      step3 += defBlock(d);
    }
  } else {
    step3 = `<p class="muted">No explanation available — watch real usage in step 7.</p>`;
  }

  // 4. Similar words — grouped by sense when the dictionary provides that
  const chipRow = (words) => `<div class="chip-row">${words
    .map((s) => `<button class="chip" type="button" data-lookup="${esc(s)}">${esc(s)}</button>`)
    .join('')}</div>`;

  let step4 = '';
  const sensesWithSyns = entry.meanings.filter((m) => m.synonyms?.length);
  if (sensesWithSyns.length) {
    for (const m of sensesWithSyns) {
      const senseHint = m.definitions[0]?.definition || '';
      step4 += `<div style="margin-bottom:6px">
        ${m.partOfSpeech ? `<span class="pos-label">${esc(m.partOfSpeech)}</span>` : ''}
        ${senseHint ? `<span class="muted" style="font-size:13px"> — ${esc(senseHint.length > 70 ? senseHint.slice(0, 70) + '…' : senseHint)}</span>` : ''}
      </div>${chipRow(m.synonyms.slice(0, 10))}<div style="height:10px"></div>`;
    }
  } else if (entry.synonyms.length) {
    step4 = chipRow(entry.synonyms.slice(0, 14)) +
      `<p class="muted" style="margin-top:10px;font-size:13px">Related words across all senses of “${esc(w)}”.</p>`;
  } else {
    step4 = `<p class="muted">No similar words found.</p>`;
  }
  if (step4 && (sensesWithSyns.length || entry.synonyms.length)) {
    if (entry.antonyms.length) {
      step4 += `<p style="margin-top:6px"><strong>Antonyms:</strong> <span class="muted">${entry.antonyms.slice(0, 8).map(esc).join(', ')}</span></p>`;
    }
    step4 += `<p class="muted" style="margin-top:8px;font-size:13.5px">Tap a word to study it.</p>`;
  }

  // 5. Other meanings
  let step5 = '';
  if (entry.meanings.length > 1) {
    for (const m of entry.meanings.slice(1)) {
      if (m.partOfSpeech) step5 += `<span class="pos-label">${esc(m.partOfSpeech)}</span>`;
      for (const d of m.definitions.slice(0, 2)) {
        step5 += defBlock(d);
      }
    }
  } else {
    step5 = `<p class="muted">No other meanings in the dictionary.</p>`;
  }

  // 6. History & origin
  const step6 = entry.etymology
    ? `<p style="white-space:pre-line">${esc(entry.etymology)}</p>`
    : `<p class="muted">No etymology found for this entry.</p>`;

  // 7. See it in action — YouGlish player inline, Playphrase as a backup link
  const step7 = `
    <div id="yg-widget"><p class="muted">Loading videos…</p></div>
    <p class="muted" style="margin-top:10px;font-size:13.5px">
      Real YouTube clips with “${esc(w)}”.${entry.lang === 'en' ? ` Also try
      <a class="ext-link" style="margin:0;font-size:13.5px" href="${playphraseLink(w)}" target="_blank" rel="noopener">Playphrase.me ↗</a>
      (movie scenes — it can’t be embedded, opens in a new tab).` : ''}
    </p>`;

  studyArea.innerHTML = `
    <div class="word-head">
      <div>
        <div class="word-title">${esc(w)}</div>
        ${entry.phonetic ? `<div class="word-phonetic">${esc(entry.phonetic)}</div>` : ''}
      </div>
      <button class="audio-btn" type="button" id="play-audio-head" aria-label="Pronunciation">🔊</button>
    </div>
    ${stepHtml(1, 'Meaning', step1, true)}
    ${stepHtml(2, 'Pronunciation', step2)}
    ${stepHtml(3, 'Explanation & example', step3)}
    ${stepHtml(4, 'Similar words', step4)}
    ${stepHtml(5, 'Other meanings', step5)}
    ${stepHtml(6, 'History & origin', step6)}
    ${stepHtml(7, 'See it in action', step7)}
    <div class="step open" style="padding:14px 16px">
      <label style="font-weight:600;font-size:15px">📝 My note</label>
      <textarea class="note-field" id="note-field" placeholder="Translation, association, where you came across it…">${esc(entry.note)}</textarea>
    </div>
    <button class="btn btn-primary btn-block" id="save-btn">
      ${saved ? '💾 Update in dictionary' : '💾 Save to dictionary'}
    </button>
    ${saved ? `<button class="btn btn-danger btn-block" id="delete-btn">Remove from dictionary</button>` : ''}
  `;

  bindStudyEvents(entry, saved);
  window.scrollTo({ top: 0 });
}

function bindStudyEvents(entry, saved) {
  // Russian translations are blurred until tapped (so English gets read first)
  studyArea.querySelectorAll('.ru-blur').forEach((el) => {
    el.addEventListener('click', () => el.classList.toggle('revealed'));
  });

  // Expand/collapse steps; lazy-load the video widget when step 7 opens
  studyArea.querySelectorAll('.step-header').forEach((btn) => {
    btn.addEventListener('click', () => {
      const step = btn.closest('.step');
      step.classList.toggle('open');
      step.classList.add('done');
      if (step.dataset.step === '7' && step.classList.contains('open')) {
        initYouglish(entry.word, entry.lang || 'en');
      }
    });
  });

  // Pronunciation: audio file if we have one, browser speech otherwise
  const playAudio = () => {
    if (entry.audio) {
      new Audio(entry.audio).play().catch(() => speak(entry.word, 0.92, entry.lang));
    } else {
      speak(entry.word, 0.92, entry.lang);
    }
  };
  $('#play-audio')?.addEventListener('click', playAudio);
  $('#play-audio-head')?.addEventListener('click', playAudio);
  $('#play-slow')?.addEventListener('click', () => speak(entry.word, 0.55, entry.lang));

  // Tap a synonym to study it
  studyArea.querySelectorAll('[data-lookup]').forEach((chip) => {
    chip.addEventListener('click', () => {
      searchInput.value = chip.dataset.lookup;
      lookupWord(chip.dataset.lookup);
    });
  });

  // Save
  $('#save-btn').addEventListener('click', () => {
    entry.note = $('#note-field').value.trim();
    const words = loadWords();
    const idx = words.findIndex((x) => x.id === entry.id && langOf(x) === entry.lang);
    if (idx >= 0) {
      entry.addedAt = words[idx].addedAt;
      entry.srs = words[idx].srs || newSrs();
      words[idx] = entry;
    } else {
      entry.addedAt = Date.now();
      entry.srs = newSrs();
      words.unshift(entry);
    }
    saveWords(words);
    showToast(idx >= 0 ? 'Updated ✓' : 'Saved to dictionary ✓');
    renderStudy(entry, { saved: true });
  });

  // Delete
  $('#delete-btn')?.addEventListener('click', () => {
    if (!confirm(`Remove “${entry.word}” from your dictionary?`)) return;
    saveWords(loadWords().filter((x) => !(x.id === entry.id && langOf(x) === entry.lang)));
    showToast('Removed');
    studyArea.hidden = true;
    studyEmpty.hidden = false;
    searchInput.value = '';
    renderDict();
  });
}

/* ---------- Word lookup ---------- */

async function lookupWord(word) {
  word = word.trim();
  if (!word) return;
  const lang = currentLang;

  showScreen('study');
  studyEmpty.hidden = true;
  studyArea.hidden = false;
  studyArea.innerHTML = '<div class="spinner" role="status" aria-label="Loading"></div>';

  // If the word is already saved, keep its note and date
  const existing = loadWords().find((x) => x.id === word.toLowerCase() && langOf(x) === lang);

  const [apiData, wikiMeanings, datamuseSyns, etymology] = await Promise.all([
    // dictionaryapi.dev is English-only; Spanish relies on Wiktionary
    lang === 'en' ? fetchDictionary(word).catch(() => null) : Promise.resolve(null),
    fetchWiktionaryDefs(word, lang).catch(() => null),
    fetchDatamuseSynonyms(word, lang).catch(() => null),
    fetchEtymology(word, lang).catch(() => null),
  ]);

  const gotAnything = apiData || wikiMeanings || (datamuseSyns && datamuseSyns.length) || etymology;
  if (!gotAnything && !navigator.onLine) {
    if (existing) {
      renderStudy(existing, { saved: true });
    } else {
      studyArea.innerHTML = `<div class="empty-state">
        <div class="empty-icon">📡</div>
        <p>Couldn’t load the data.<br>Check your internet connection.</p>
      </div>`;
    }
    return;
  }

  const entry = extractEntry(word, lang, apiData, wikiMeanings, datamuseSyns, etymology);
  await addTranslations(entry).catch(() => {});
  if (existing) {
    entry.note = existing.note;
    entry.addedAt = existing.addedAt;
    entry.srs = existing.srs;
  }
  renderStudy(entry, { saved: !!existing });
}

/* ---------- Dictionary ---------- */

function renderDict(filter = '') {
  const words = loadWords().filter((x) =>
    langOf(x) === currentLang &&
    (x.word.toLowerCase().includes(filter.toLowerCase()) ||
     (x.note || '').toLowerCase().includes(filter.toLowerCase()))
  );

  dictEmpty.hidden = words.length > 0 || filter !== '';
  dictList.innerHTML = words.map((x) => {
    const sub = x.note || x.meanings[0]?.definitions[0]?.definition || '';
    const date = x.addedAt
      ? new Date(x.addedAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })
      : '';
    return `<li class="dict-item" data-id="${esc(x.id)}">
      <div class="dict-item-main">
        <div class="dict-item-word">${esc(x.word)}</div>
        ${sub ? `<div class="dict-item-sub">${esc(sub)}</div>` : ''}
      </div>
      <span class="dict-item-date">${date}</span>
    </li>`;
  }).join('');

  dictList.querySelectorAll('.dict-item').forEach((li) => {
    li.addEventListener('click', () => {
      const entry = loadWords().find((x) => x.id === li.dataset.id && langOf(x) === currentLang);
      if (!entry) return;
      searchInput.value = entry.word;
      showScreen('study');
      renderStudy(entry, { saved: true });
    });
  });
}

/* ---------- Review (spaced repetition) ---------- */

let reviewQueue = [];
let reviewDone = 0;

function startReview() {
  reviewQueue = dueWords().sort(() => Math.random() - 0.5);
  reviewDone = 0;
  renderReviewCard();
}

// Edit distance for typo tolerance in typing cards (bounded to 0/1/many)
function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

function normalizeAnswer(s) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// The prompt shown instead of the word on reverse cards
function reviewCue(entry) {
  if (entry.translation) return `🇷🇺 ${esc(entry.translation)}`;
  const d = entry.meanings[0]?.definitions[0];
  if (d?.definitionRu) return `🇷🇺 ${esc(d.definitionRu)}`;
  if (d?.definition) return esc(d.definition);
  return null;
}

// Recognition first; later stages mix in reverse and typing cards
function pickCardType(entry) {
  if (!reviewCue(entry) || (entry.srs?.stage ?? 0) === 0) return 'recognition';
  const r = Math.random();
  if (r < 0.25) return 'recognition';
  if (r < 0.65) return 'production';
  return 'typing';
}

function renderReviewCard() {
  if (!reviewQueue.length) {
    const withSrs = loadWords().filter((x) => x.srs);
    const next = withSrs.sort((a, b) => a.srs.due - b.srs.due)[0];
    const nextStr = next
      ? `Next review: <strong>${esc(next.word)}</strong> on ${new Date(next.srs.due).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}.`
      : 'Save some words first — they’ll show up here for review.';
    reviewArea.innerHTML = `<div class="empty-state">
      <div class="empty-icon">${reviewDone ? '🎉' : '✅'}</div>
      <p>${reviewDone
        ? `Done! You reviewed ${reviewDone} ${reviewDone === 1 ? 'word' : 'words'}.`
        : 'Nothing to review right now.'}<br>${nextStr}</p>
    </div>`;
    return;
  }

  const entry = reviewQueue[0];
  const type = pickCardType(entry);
  const progress = `<p class="review-progress muted">${reviewDone + 1} / ${reviewDone + reviewQueue.length}</p>`;
  const playWord = () => {
    if (entry.audio) new Audio(entry.audio).play().catch(() => speak(entry.word, 0.92, langOf(entry)));
    else speak(entry.word, 0.92, langOf(entry));
  };
  const verdictButtons = `
    <div id="review-verdict" class="review-verdict" hidden>
      <button class="btn btn-ghost btn-forgot" id="review-forgot">❌ Forgot</button>
      <button class="btn btn-primary" id="review-knew">✅ Got it</button>
    </div>`;
  const bindVerdict = () => {
    $('#review-forgot').addEventListener('click', () => answerReview(entry, false));
    $('#review-knew').addEventListener('click', () => answerReview(entry, true));
  };

  if (type === 'recognition') {
    // EN word shown → recall the meaning
    const def = entry.meanings[0]?.definitions[0];
    reviewArea.innerHTML = `${progress}
      <div class="word-head">
        <div>
          <div class="word-title">${esc(entry.word)}</div>
          ${entry.phonetic ? `<div class="word-phonetic">${esc(entry.phonetic)}</div>` : ''}
        </div>
        <button class="audio-btn" type="button" id="review-audio" aria-label="Pronunciation">🔊</button>
      </div>
      <div class="step open" style="padding:16px">
        <p class="muted" style="margin-bottom:12px">Can you recall what it means?</p>
        <div id="review-answer" hidden>
          ${def ? `<div class="def-item">${esc(def.definition)}
            ${def.definitionRu ? `<div class="def-ru">🇷🇺 ${esc(def.definitionRu)}</div>` : ''}
            ${def.example ? `<div class="def-example">“${esc(def.example)}”</div>` : ''}</div>` : ''}
          ${!def && entry.translation ? `<p>🇷🇺 ${esc(entry.translation)}</p>` : ''}
          ${entry.note ? `<p style="margin-top:8px">📝 <span class="muted">${esc(entry.note)}</span></p>` : ''}
        </div>
        <button class="btn btn-ghost btn-block" id="review-show" style="margin-top:4px">👁 Show meaning</button>
        ${verdictButtons}
      </div>`;
    $('#review-audio').addEventListener('click', playWord);
    $('#review-show').addEventListener('click', () => {
      $('#review-answer').hidden = false;
      $('#review-show').hidden = true;
      $('#review-verdict').hidden = false;
    });
    bindVerdict();
    return;
  }

  if (type === 'production') {
    // Cue shown → recall the EN word out loud, then check yourself
    reviewArea.innerHTML = `${progress}
      <div class="step open" style="padding:16px">
        <p class="muted">What’s the English word for:</p>
        <p class="review-cue">${reviewCue(entry)}</p>
        <div id="review-answer" hidden>
          <div class="word-title" style="font-size:22px">${esc(entry.word)}
            <button class="audio-btn" type="button" id="review-audio" style="width:38px;height:38px;font-size:16px;vertical-align:middle" aria-label="Pronunciation">🔊</button>
          </div>
          ${entry.phonetic ? `<div class="word-phonetic">${esc(entry.phonetic)}</div>` : ''}
        </div>
        <button class="btn btn-ghost btn-block" id="review-show" style="margin-top:4px">👁 Show answer</button>
        ${verdictButtons}
      </div>`;
    $('#review-audio').addEventListener('click', playWord);
    $('#review-show').addEventListener('click', () => {
      $('#review-answer').hidden = false;
      $('#review-show').hidden = true;
      $('#review-verdict').hidden = false;
    });
    bindVerdict();
    return;
  }

  // Typing card: cue shown → type the EN word from memory
  reviewArea.innerHTML = `${progress}
    <div class="step open" style="padding:16px">
      <p class="muted">Type the English word for:</p>
      <p class="review-cue">${reviewCue(entry)}</p>
      <form id="typing-form" class="typing-row" autocomplete="off">
        <input id="typing-input" type="text" inputmode="latin" autocapitalize="off"
               autocorrect="off" spellcheck="false" placeholder="Type it…" aria-label="Your answer">
        <button class="btn btn-primary" type="submit">Check</button>
      </form>
      <div id="typing-result" hidden></div>
    </div>`;
  const input = $('#typing-input');
  input.focus();
  $('#typing-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const given = normalizeAnswer(input.value);
    if (!given) return;
    const target = normalizeAnswer(entry.word);
    const dist = levenshtein(given, target);
    const correct = dist === 0;
    const close = !correct && dist === 1 && target.length >= 5;
    const result = $('#typing-result');
    $('#typing-form').hidden = true;
    result.hidden = false;
    result.innerHTML = `
      <p class="${correct || close ? 'result-ok' : 'result-bad'}" style="font-size:19px;font-weight:700;margin-top:10px">
        ${correct ? '✅' : close ? '🟡' : '❌'} ${esc(entry.word)}
        <button class="audio-btn" type="button" id="review-audio" style="width:38px;height:38px;font-size:16px;vertical-align:middle" aria-label="Pronunciation">🔊</button>
      </p>
      ${entry.phonetic ? `<div class="word-phonetic">${esc(entry.phonetic)}</div>` : ''}
      ${close ? `<p class="muted" style="margin-top:6px">Almost — you wrote “${esc(input.value.trim())}”. Watch the spelling.</p>` : ''}
      ${!correct && !close ? `<p class="muted" style="margin-top:6px">You wrote “${esc(input.value.trim())}”.</p>` : ''}
      <button class="btn ${correct || close ? 'btn-primary' : 'btn-ghost'} btn-block" id="typing-continue">Continue</button>`;
    $('#review-audio').addEventListener('click', playWord);
    playWord();
    $('#typing-continue').addEventListener('click', () => answerReview(entry, correct || close));
  });
}

function answerReview(entry, knew) {
  const words = loadWords();
  const stored = words.find((x) => x.id === entry.id);
  if (stored) {
    const stage = knew ? Math.min((stored.srs?.stage ?? 0) + 1, SRS_INTERVALS.length - 1) : 0;
    stored.srs = { stage, due: Date.now() + SRS_INTERVALS[stage] * DAY };
    saveWords(words);
  }
  reviewQueue.shift();
  reviewDone++;
  renderReviewCard();
}

/* ---------- Navigation ---------- */

function showScreen(name) {
  for (const key of ['study', 'read', 'review', 'dict']) {
    $('#screen-' + key).hidden = key !== name;
    const tab = $('#tab-' + key);
    tab.classList.toggle('active', key === name);
    tab.setAttribute('aria-selected', key === name);
  }
  if (name === 'dict') renderDict(dictSearch.value.trim());
  if (name === 'review') startReview();
  if (name === 'read' && typeof renderRead === 'function') renderRead();
}

/* ---------- Export / import ---------- */

$('#export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(loadWords(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'vocabular-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Dictionary exported');
});

$('#import-btn').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error('not an array');
    const words = loadWords();
    let added = 0;
    for (const w of data) {
      if (!w || !w.id || !w.word) continue;
      w.lang = w.lang || 'en';
      if (!words.some((x) => x.id === w.id && langOf(x) === w.lang)) {
        words.push(w);
        added++;
      }
    }
    saveWords(words);
    renderDict(dictSearch.value.trim());
    showToast(added ? `Imported ${added} ${added === 1 ? 'word' : 'words'}` : 'Nothing new to import');
  } catch {
    showToast('Invalid backup file');
  }
  e.target.value = '';
});

/* ---------- Init ---------- */

searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  lookupWord(searchInput.value);
  searchInput.blur();
});

$('#tab-study').addEventListener('click', () => showScreen('study'));
$('#tab-read').addEventListener('click', () => showScreen('read'));
$('#tab-review').addEventListener('click', () => showScreen('review'));
$('#tab-dict').addEventListener('click', () => showScreen('dict'));
dictSearch.addEventListener('input', () => renderDict(dictSearch.value.trim()));

// Language switch
function setLang(lang) {
  currentLang = lang;
  localStorage.setItem(LANG_KEY, lang);
  $('#lang-en').classList.toggle('active', lang === 'en');
  $('#lang-es').classList.toggle('active', lang === 'es');
  updateCounts();
  // Reset the study card — it belongs to the previous language
  studyArea.hidden = true;
  studyArea.innerHTML = '';
  studyEmpty.hidden = false;
  searchInput.value = '';
  const active = ['study', 'review', 'dict'].find((k) => !$('#screen-' + k).hidden);
  if (active === 'dict') renderDict(dictSearch.value.trim());
  if (active === 'review') startReview();
}
$('#lang-en').addEventListener('click', () => setLang('en'));
$('#lang-es').addEventListener('click', () => setLang('es'));
$('#lang-en').classList.toggle('active', currentLang === 'en');
$('#lang-es').classList.toggle('active', currentLang === 'es');

// One-time migration: add srs to pre-SRS words and lang to pre-Spanish words
(() => {
  const words = loadWords();
  let changed = false;
  for (const w of words) {
    if (!w.srs) {
      w.srs = { stage: 0, due: Date.now() };
      changed = true;
    }
    if (!w.lang) {
      w.lang = 'en';
      changed = true;
    }
  }
  if (changed) saveWords(words);
})();

updateCounts();

// Support ?q=word&lang=es links (e.g. from an iOS Shortcut)
const urlParams = new URLSearchParams(location.search);
const urlLang = urlParams.get('lang');
if (urlLang && LANGS[urlLang]) setLang(urlLang);
const initialQuery = urlParams.get('q');
if (initialQuery) {
  searchInput.value = initialQuery;
  lookupWord(initialQuery);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

'use strict';

/** Place poem cards on heard words. A lyric uses only its own words.
 *  Music before the first word, between lines, and after the last word
 *  stays on the previous screen, or on the next screen when nothing is
 *  before it. An instrumental does not bring its own picture.
 */

function indicKey(text) {
  let s = String(text || '');
  if (!/[\u0900-\u097F]/.test(s)) return '';
  s = s.replace(/\u091C\u094D\u091E/g, '\u0926\u094D\u092F');
  s = s.replace(/[\u093E-\u094C\u0951-\u0957\u0962\u0963]/g, '');
  s = s.replace(/\u094D/g, '');
  s = s.replace(/\u0923/g, '\u0928').replace(/\u0920/g, '\u0921').replace(/\u0933/g, '\u0932');
  return s.replace(/[^\u0900-\u097F]/g, '');
}

function tokensOf(text) {
  return String(text || '').match(/[\u0900-\u097F]+|[A-Za-z]{2,}/g) || [];
}

function isInstrumental(scene) {
  const vo = String(scene && scene.voiceover_text || '').trim().toLowerCase();
  if (vo.startsWith('instrumental')) return true;
  const raw = String(scene && scene.voiceover_raw || '').toLowerCase();
  if (raw.includes('instrumental')) return true;
  const sec = String(scene && scene.section || '').toLowerCase();
  return sec.includes('instrumental') || sec.includes('song intro');
}

function rawLetters(text) {
  return String(text || '').replace(/[^\u0900-\u097F]/g, '');
}

function latinKey(text) {
  const s = String(text || '');
  if (/[\u0900-\u097F]/.test(s)) return '';
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

function wordHit(heard, script) {
  const hasDev = /[\u0900-\u097F]/.test(String(heard || '')) || /[\u0900-\u097F]/.test(String(script || ''));
  if (!hasDev) {
    const lh = latinKey(heard);
    const lw = latinKey(script);
    if (lh && lw && lw.length >= 2) {
      if (lh === lw) return 'whole';
      if (lh.startsWith(lw) && lw.length >= 3) return 'prefix';
      if (lw.startsWith(lh) && lh.length >= 3) return 'whole';
      if (lh.length >= 5 && lw.length >= 5 && (lh.endsWith(lw) || lw.endsWith(lh))) return 'fuzzy';
    }
    return '';
  }
  const H = rawLetters(heard);
  const W = rawLetters(script);
  if (H.length >= 2 && W.length >= 2) {
    if (H === W) return 'whole';
    if (H.startsWith(W)) return 'prefix';
    if (W.startsWith(H) && H.length >= 3) return 'whole';
  }
  if (H.length >= 4 && W.length >= 4 && (H.endsWith(W) || W.endsWith(H) || H.slice(-4) === W.slice(-4))) return 'fuzzy';
  const h = indicKey(heard);
  const w = indicKey(script);
  if (!h || !w || w.length < 2) return '';
  if (h === w) return 'whole';
  if (h.startsWith(w)) return 'prefix';
  if (w.startsWith(h) && h.length >= 3) return 'whole';
  if (w.length >= 3 && (h.includes(w) || w.includes(h))) return 'inner';
  if (h.endsWith(w) || (w.endsWith(h) && h.length >= 2)) return 'fuzzy';
  const share = [...h].findIndex((ch, i) => ch !== w[i]);
  const prefix = share < 0 ? Math.min(h.length, w.length) : share;
  if (prefix >= 3 && h.length >= 4 && w.length >= 4 && Math.abs(h.length - w.length) <= 2) return 'prefix';
  const tail = (key) => (key.startsWith('\u0926\u092F') && key.length > 3 ? key.slice(2) : key.slice(1));
  if (tail(h).length >= 2 && tail(h) === tail(w)) return 'fuzzy';
  return '';
}

function heardList(words) {
  return (words || []).map((w) => {
    const raw = String(w && (w.word != null ? w.word : w.text) || '');
    const start = Number(w && w.start);
    const end = Number(w && w.end);
    return { raw, start, end: Number.isFinite(end) && end > start ? end : start + 0.08 };
  }).filter((w) => (indicKey(w.raw) || latinKey(w.raw).length >= 2) && Number.isFinite(w.start)).sort((a, b) => a.start - b.start);
}

function matchLyrics(lyrics, words) {
  const script = [];
  for (const sc of lyrics) {
    for (const tok of tokensOf(sc.voiceover_text)) script.push({ screen: sc.screen, tok });
  }
  const heard = heardList(words);
  const hits = new Map();
  let hi = 0;
  let used = 0;
  for (const sw of script) {
    let found = -1;
    let kind = '';
    const from = used > 0.05 ? hi : hi;
    for (let j = from; j < Math.min(heard.length, from + 6); j++) {
      kind = wordHit(heard[j].raw, sw.tok);
      if (kind) { found = j; break; }
    }
    if (found < 0) continue;
    if (found > hi) { hi = found; used = 0; }
    const h = heard[hi];
    const span = Math.max(0.06, h.end - h.start);
    const keyH = indicKey(h.raw) || latinKey(h.raw);
    const keyW = indicKey(sw.tok) || latinKey(sw.tok);
    let take = 1 - used;
    if (kind === 'prefix' || kind === 'inner') {
      take = Math.min(take, Math.max(0.28, keyW.length / Math.max(keyH.length, keyW.length)));
    }
    const a = h.start + span * used;
    const b = h.start + span * Math.min(1, used + take);
    if (!hits.has(sw.screen)) hits.set(sw.screen, []);
    hits.get(sw.screen).push({ start: a, end: Math.max(a + 0.04, b) });
    used += take;
    if (used >= 0.92) { hi += 1; used = 0; }
  }
  return hits;
}

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

function pushRow(out, screen, start, end, engine) {
  const a = round3(Math.max(0, start));
  const b = round3(Math.max(a + 0.12, end));
  out.push({
    screen,
    start: a,
    end: b,
    narration_in: a,
    narration_out: b,
    engine,
  });
}

function fillGap(out, scenes, from, to) {
  if (!scenes.length) return round3(from);
  const start = Math.max(0, from);
  const end = Math.max(start + 0.12 * scenes.length, to);
  const weights = scenes.map((sc) => Math.max(0.35, Number(sc._dur) || 0.8));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let cur = start;
  scenes.forEach((sc, i) => {
    const nxt = i === scenes.length - 1 ? end : cur + (end - start) * (weights[i] / total);
    const engine = isInstrumental(sc) ? 'poem_word' : 'estimate';
    pushRow(out, sc.screen, cur, nxt, engine);
    cur = nxt;
  });
  return round3(end);
}

/**
 * @returns {Array|null} rows in scene order, or null when too few lines were heard
 */
function placePoemScenes(scenes, words, duration, durOf) {
  const fileEnd = Number(duration) || 0;
  if (!Array.isArray(scenes) || !scenes.length || fileEnd < 0.4) return null;
  const tagged = scenes.map((sc) => ({ ...sc, _dur: Math.max(0.35, Number(durOf ? durOf(sc) : sc.duration) || 0.8) }));
  const lyrics = tagged.filter((sc) => !isInstrumental(sc));
  const hits = matchLyrics(lyrics, words);
  const LEAD = 0.18;
  const matched = new Map();
  for (const sc of lyrics) {
    const hs = hits.get(sc.screen) || [];
    if (!hs.length) continue;
    matched.set(sc.screen, {
      wordStart: Math.min(...hs.map((h) => h.start)),
      wordEnd: Math.max(...hs.map((h) => h.end)),
    });
  }
  if (matched.size < Math.min(4, Math.ceil(lyrics.length * 0.45))) return null;

  const out = [];
  let cursor = 0;
  let i = 0;
  while (i < tagged.length) {
    const gap = [];
    while (i < tagged.length && !matched.has(tagged[i].screen)) {
      gap.push(tagged[i]);
      i += 1;
    }
    if (i >= tagged.length) {
      fillGap(out, gap, cursor, fileEnd);
      break;
    }
    const sc = tagged[i];
    const m = matched.get(sc.screen);
    let nextStart = fileEnd;
    for (let k = i + 1; k < tagged.length; k++) {
      if (matched.has(tagged[k].screen)) {
        nextStart = matched.get(tagged[k].screen).wordStart;
        break;
      }
    }
    const lyricStart = Math.max(cursor, Math.min(m.wordStart, Math.max(0, m.wordStart - LEAD)));
    if (gap.length) cursor = fillGap(out, gap, cursor, lyricStart);
    else cursor = lyricStart;
    let lyricEnd = Math.max(m.wordEnd, cursor + 0.35);
    const follows = i + 1 < tagged.length ? tagged[i + 1] : null;
    if (follows && matched.has(follows.screen)) {
      lyricEnd = Math.max(m.wordEnd, Math.min(nextStart - 0.05, nextStart - LEAD));
    } else {
      lyricEnd = m.wordEnd;
    }
    lyricEnd = Math.min(lyricEnd, nextStart - 0.05);
    lyricEnd = Math.max(lyricEnd, cursor + 0.35);
    pushRow(out, sc.screen, cursor, lyricEnd, 'poem_word');
    cursor = round3(Math.max(cursor + 0.12, lyricEnd));
    i += 1;
  }
  if (out.length) {
    out[out.length - 1].end = round3(Math.max(out[out.length - 1].end, fileEnd));
    out[out.length - 1].narration_out = out[out.length - 1].end;
  }
  const folded = foldInstrumentalRows(tagged, out);
  const lyricRows = folded.filter((row) => lyrics.some((sc) => sc.screen === row.screen));
  const locked = lyricRows.filter((row) => row.engine === 'poem_word').length;
  if (locked < Math.min(4, Math.ceil(lyrics.length * 0.45))) return null;
  return folded;
}

/** An instrumental keeps the picture already on screen, or the next one. */
function foldInstrumentalRows(tagged, rows) {
  const by = new Map(tagged.map((sc) => [sc.screen, sc]));
  const inst = (row) => {
    const sc = by.get(row.screen);
    return Boolean(sc && isInstrumental(sc));
  };
  const out = [];
  let lead = null;
  for (const row of rows) {
    if (inst(row)) {
      if (out.length && !lead) {
        const prev = out[out.length - 1];
        prev.end = row.end;
        prev.narration_out = row.end;
      } else {
        lead = lead || { ...row };
        lead.end = row.end;
        lead.narration_out = row.end;
      }
      continue;
    }
    const next = { ...row };
    if (lead) {
      next.start = lead.start;
      next.narration_in = lead.start;
      lead = null;
    }
    out.push(next);
  }
  if (lead && out.length) {
    out[out.length - 1].end = lead.end;
    out[out.length - 1].narration_out = lead.end;
  } else if (lead) {
    out.push(lead);
  }
  return out;
}

function openingToken(text) {
  const m = String(text || '').match(/[\u0900-\u097F]+|[A-Za-z']+/);
  return m ? m[0] : '';
}

/** The first sung card starts on its first word. That time comes off the intro. */
function keepFirstPoemWord(rows, scenes, words, origin) {
  if (!rows || rows.length < 2) return rows;
  const by = new Map((scenes || []).map((sc) => [sc.screen, sc]));
  let lyric = -1;
  for (let i = 0; i < rows.length; i++) {
    if (openingToken(by.get(rows[i].screen) && by.get(rows[i].screen).voiceover_text)) {
      lyric = i;
      break;
    }
  }
  if (lyric <= 0) return rows;
  const base = Number(origin) || 0;
  const fileCut = rows[lyric].start - base;
  const tok = openingToken(by.get(rows[lyric].screen).voiceover_text);
  let heardAt = null;
  for (const w of words || []) {
    const start = Number(w && (w.start));
    const raw = String(w && (w.word != null ? w.word : w.text) || '');
    if (!Number.isFinite(start) || start >= fileCut - 0.04 || start < fileCut - 1.2) continue;
    if (!wordHit(raw, tok)) continue;
    if (heardAt == null || start < heardAt) heardAt = start;
  }
  let target = heardAt == null ? null : heardAt - 0.08;
  if (target == null && !openingToken(by.get(rows[lyric - 1].screen) && by.get(rows[lyric - 1].screen).voiceover_text)) {
    target = fileCut - 0.28;
  }
  if (target == null) return rows;
  const earliest = (rows[lyric - 1].start - base) + 0.35;
  const fileTarget = Math.max(earliest, Math.min(fileCut - 0.05, target));
  const next = round3(base + fileTarget);
  if (!(next < rows[lyric].start - 0.04)) return rows;
  rows[lyric - 1].end = next;
  rows[lyric - 1].narration_out = next;
  rows[lyric].start = next;
  rows[lyric].narration_in = next;
  return rows;
}

/** Workbook in/out times for a whole song. Null when any card has no clock. */
function placePoemOnSheetClock(scenes, origin, words) {
  const base = Number(origin) || 0;
  if (!Array.isArray(scenes) || scenes.length < 2) return null;
  const rows = [];
  for (const sc of scenes) {
    const a = Number(sc && sc.audio_start);
    const b = Number(sc && sc.audio_end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !(b > a + 0.04)) return null;
    const start = round3(base + a);
    const end = round3(base + b);
    rows.push({
      screen: sc.screen,
      start,
      end,
      narration_in: start,
      narration_out: end,
      engine: 'poem_sheet',
    });
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].start + 0.02 < rows[i - 1].start) return null;
  }
  if (rows[rows.length - 1].end - rows[0].start < 0.8) return null;
  return keepFirstPoemWord(rows, scenes, words, base);
}

module.exports = { placePoemScenes, placePoemOnSheetClock, matchLyrics, wordHit, indicKey };

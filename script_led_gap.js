/**
 * Between two script lines the voice may repeat the line just heard, or say
 * something the script never wrote. Preference goes to the card that owns
 * the line. An orphan repeat left under the previous card is NOT forced onto
 * that picture — it is listed for the voice cut to silence. A real sentence
 * that matches neither line becomes a placeholder card. A single leftover
 * word, or an expression-tag word, does not.
 */

function wordOnScript(word, script, sameWord) {
  for (let i = 0; i < script.length; i++) {
    if (sameWord(word, script[i])) return true;
    const glue = i + 1 < script.length ? script[i] + script[i + 1] : '';
    if (glue && glue !== script[i] && sameWord(word, glue)) return true;
  }
  return false;
}

function cover(heard, script, sameWord) {
  if (!script.length || !heard.length) return 0;
  const used = new Set();
  let hit = 0;
  for (let i = 0; i < script.length; i++) {
    const glue = i + 1 < script.length ? script[i] + script[i + 1] : '';
    let matched = false;
    for (let j = 0; j < heard.length; j++) {
      if (used.has(j)) continue;
      if (sameWord(heard[j], script[i])) {
        used.add(j);
        hit += 1;
        matched = true;
        break;
      }
      if (glue && glue !== script[i] && sameWord(heard[j], glue)) {
        used.add(j);
        hit += 2;
        i += 1;
        matched = true;
        break;
      }
    }
    if (!matched) continue;
  }
  return Math.min(1, hit / script.length);
}

function distinctive(tok) {
  return String(tok || '').replace(/[^\u0900-\u097Fa-z0-9]/gi, '').length >= 4;
}

function sameLine(heard, script, sameWord) {
  const score = cover(heard, script, sameWord);
  if (score < 0.6) return false;
  const marks = heard.filter(distinctive);
  if (!marks.length) return score >= 0.8;
  return marks.every((w) => wordOnScript(w, script, sameWord));
}

function orderedPrefix(heard, script, sameWord) {
  if (heard.length < 2 || !script.length || heard.length > script.length) return false;
  if (!heard.some(distinctive)) return false;
  let si = 0;
  for (const w of heard) {
    if (si >= script.length) return false;
    if (sameWord(w, script[si])) { si += 1; continue; }
    if (si + 1 < script.length && sameWord(w, script[si] + script[si + 1])) { si += 2; continue; }
    return false;
  }
  return true;
}

function classifyUtterance(toks, prevToks, nextToks, sameWord) {
  const asPrev = sameLine(toks, prevToks, sameWord);
  const asNext = sameLine(toks, nextToks, sameWord) || orderedPrefix(toks, nextToks, sameWord);
  if (asPrev && !asNext) return 'prev';
  if (asNext && !asPrev) return 'next';
  if (asPrev && asNext) {
    // Preference: the card that owns this line (the next card) keeps the VO.
    // An orphan repeat left under the previous card is silenced later.
    return 'next';
  }
  return 'other';
}

/**
 * Previous span still holds the next card's first hearing (e.g. S1 holding
 * "निरीक्षण करा" that belongs to S2). Walk the end of prevWords back while
 * the trailing utterance is the next line, and hand that start to next.
 * Does not silence unrelated phrases — settleGap handles those.
 * Returns { prevEi, nextSi } using absolute word idx values.
 */
function peelStolenTail(prevWords, prevToks, nextToks, sameWord) {
  if (!prevWords.length) return { prevEi: null, nextSi: null };
  const utts = splitUtterances(prevWords);
  let cut = utts.length;
  while (cut > 0) {
    const utt = utts[cut - 1];
    const kind = classifyUtterance(utt.map((w) => w.tok), prevToks, nextToks, sameWord);
    if (kind !== 'next') break;
    cut -= 1;
  }
  if (cut >= utts.length) return { prevEi: null, nextSi: null, nextEi: null };
  const prevEi = cut > 0 ? utts[cut - 1][utts[cut - 1].length - 1].idx : null;
  const nextUtt = utts[cut];
  const nextSi = nextUtt ? nextUtt[0].idx : null;
  const nextEi = nextUtt ? nextUtt[nextUtt.length - 1].idx : null;
  return { prevEi, nextSi, nextEi };
}

function orphanSpan(utt) {
  return {
    start: Number(utt[0].start),
    end: Number(utt[utt.length - 1].end),
    text: utt.map((w) => w.text).join(' '),
  };
}

function realPhrase(utt) {
  if (!utt.length) return false;
  const dur = utt[utt.length - 1].end - utt[0].start;
  if (utt.length >= 4) return true;
  return utt.length >= 3 && dur >= 0.8;
}

function splitUtterances(words, pause = 0.5) {
  const out = [];
  let cur = [];
  for (const w of words) {
    if (cur.length && Number(w.start) - Number(cur[cur.length - 1].end) >= pause) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * gapWords are the heard words strictly between two locked script lines,
 * in time order. Each word is { idx, tok, text, start, end }.
 * Returns { prevEnd, nextStart, placeholders, orphans }.
 * prevEnd stays null (no forced image). Orphan repeats of the previous
 * line are listed so the voice cut can silence them. A line that also
 * matches the next card is given to that card.
 */
function settleGap(gapWords, prevToks, nextToks, sameWord) {
  const utts = splitUtterances(gapWords);
  const kindOf = (utt) => {
    const kind = classifyUtterance(utt.map((w) => w.tok), prevToks, nextToks, sameWord);
    if (kind === 'prev' || kind === 'next') return kind;
    return realPhrase(utt) ? 'placeholder' : 'skip';
  };
  const orphans = [];
  let i = 0;
  // Orphan repeat under the previous card: do not pin the picture; silence later.
  while (i < utts.length && kindOf(utts[i]) === 'prev') {
    orphans.push(orphanSpan(utts[i]));
    i += 1;
  }
  const prevEnd = null;
  let j = utts.length - 1;
  let nextStart = null;
  while (j >= i && kindOf(utts[j]) === 'next') {
    nextStart = utts[j][0];
    j -= 1;
  }
  const placeholders = [];
  for (let k = i; k <= j; k++) {
    const utt = utts[k];
    if (kindOf(utt) !== 'placeholder') continue;
    placeholders.push(orphanSpan(utt));
  }
  return { prevEnd, nextStart, placeholders, orphans };
}

/**
 * Words already claimed by the next card. A leading orphan repeat of the
 * previous line is peeled off the next card, not forced onto the previous
 * picture, and listed in orphans to silence. Preference goes to the next
 * card when the same VO matches both. A leading sentence that matches
 * neither line is a placeholder.
 * Returns { prevEnd, placeholders, orphans, cutIdx }.
 */
function peelHead(words, prevToks, nextToks, sameWord) {
  const utts = splitUtterances(words);
  const prevEnd = null;
  const placeholders = [];
  const orphans = [];
  let cutIdx = null;
  for (let n = 0; n < utts.length; n++) {
    const utt = utts[n];
    const toks = utt.map((w) => w.tok);
    const named = classifyUtterance(toks, prevToks, nextToks, sameWord);
    let kind = named === 'other' ? (realPhrase(utt) ? 'placeholder' : 'skip') : named;
    if (kind === 'next' || kind === 'skip') break;
    const last = utt[utt.length - 1];
    const rest = utts.slice(n + 1);
    const restWords = rest.reduce((acc, u) => acc + u.length, 0);
    if (restWords < 2) break;
    // kind === 'prev': peel from next only; silence the orphan. Do not set prevEnd.
    if (kind === 'prev') orphans.push(orphanSpan(utt));
    else placeholders.push(orphanSpan(utt));
    cutIdx = last.idx;
  }
  return { prevEnd, placeholders, orphans, cutIdx };
}

function contentWord(tok) {
  return String(tok || '').replace(/[^\u0900-\u097Fa-z0-9]/gi, '').length >= 3;
}

function sameSentence(a, b, sameWord) {
  const ma = a.filter(contentWord);
  const mb = b.filter(contentWord);
  if (ma.length < 2 || ma.length !== mb.length) return false;
  return ma.every((w, i) => sameWord(w, mb[i]));
}

/** Question ending सांगा and answer ending आहे, when every other word matches. */
function sameRepeatSentence(a, b, sameWord) {
  if (sameSentence(a, b, sameWord)) return true;
  const ma = a.filter(contentWord);
  const mb = b.filter(contentWord);
  if (ma.length < 3 || ma.length !== mb.length) return false;
  const lastA = ma[ma.length - 1];
  const lastB = mb[mb.length - 1];
  const ending = new Set(['सांगा', 'आहे']);
  if (!ending.has(lastA) || !ending.has(lastB) || lastA === lastB) return false;
  return ma.slice(0, -1).every((w, i) => sameWord(w, mb[i]));
}

function orderedIn(heard, script, sameWord) {
  let i = 0;
  for (const w of heard) {
    if (!contentWord(w)) continue;
    while (i < script.length && !sameWord(w, script[i])) i += 1;
    if (i >= script.length) return false;
    i += 1;
  }
  return heard.some(contentWord);
}

/**
 * Extra hearings of one sentence. A later copy of a sentence that has a
 * single script card is the part to cut from the voice. The same ending on
 * several different cards is left alone. A sentence with no card is reported.
 */
function repeatedHearings(utterances, lines, sameWord) {
  const rows = [];
  for (const utt of utterances) {
    const toks = utt.toks || [];
    if (toks.filter(contentWord).length < 2) continue;
    rows.push(utt);
  }
  const parent = rows.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (sameRepeatSentence(rows[i].toks, rows[j].toks, sameWord)) parent[find(j)] = find(i);
    }
  }
  const clusters = new Map();
  rows.forEach((row, i) => {
    const id = find(i);
    const list = clusters.get(id) || [];
    list.push(row);
    clusters.set(id, list);
  });
  const groups = [];
  for (const list of clusters.values()) {
    if (list.length < 2) continue;
    const ranked = [...list].sort((a, b) => a.start - b.start);
    let exact = [];
    let matchedRow = null;
    for (const row of ranked) {
      const hit = lines.filter((line) => sameSentence(row.toks, line.toks, sameWord));
      if (hit.length === 1) {
        exact = hit;
        matchedRow = row;
        break;
      }
      if (hit.length > 1 && !exact.length) exact = hit;
    }
    const keepRow = matchedRow || ranked[0];
    const keep = { start: keepRow.start, end: keepRow.end, text: keepRow.text };
    const rest = ranked.filter((r) => r !== keepRow).map((r) => ({ start: r.start, end: r.end, text: r.text }));
    if (exact.length === 1) {
      groups.push({ kind: 'card', card: exact[0].id, script: exact[0].text, keep, drop: rest });
    } else if (exact.length > 1) {
      groups.push({
        kind: 'shared',
        card: exact.map((line) => line.id),
        script: exact.map((line) => line.text).join(' | '),
        keep,
        drop: [],
        also: rest,
      });
    } else {
      const hosts = lines.filter((line) => orderedIn(ranked[0].toks, line.toks, sameWord));
      if (hosts.length >= 2) {
        groups.push({
          kind: 'shared',
          card: hosts.map((line) => line.id),
          script: hosts.map((line) => line.text).join(' | '),
          keep,
          drop: [],
          also: rest,
        });
      } else {
        groups.push({ kind: 'no_card', card: null, script: '', keep, drop: rest });
      }
    }
  }
  groups.sort((a, b) => a.keep.start - b.keep.start);
  return groups;
}

function indicKey(text) {
  let s = String(text || '');
  if (!/[\u0900-\u097F]/.test(s)) return '';
  s = s.replace(/[\u093E-\u094C\u0951-\u0957\u0962\u0963]/g, '');
  s = s.replace(/[\u0901\u0902]/g, '');
  s = s.replace(/\u094D/g, '');
  s = s.replace(/\u0923/g, '\u0928').replace(/\u0920/g, '\u0921').replace(/\u0933/g, '\u0932');
  return s.replace(/[^\u0900-\u097F]/g, '');
}

/** Word match for repeat detection. One word against one word. No glued pair. */
function hearingSameWord(h, w) {
  if (!h || !w) return false;
  if (h === w) return true;
  const ih = indicKey(h);
  const iw = indicKey(w);
  if (ih && iw && ih.length >= 2 && iw.length >= 2) {
    if (ih === iw) return true;
    if (Math.min(ih.length, iw.length) >= 3 && Math.abs(ih.length - iw.length) <= 1 && (ih.startsWith(iw) || iw.startsWith(ih) || ih.includes(iw) || iw.includes(ih))) return true;
  }
  return false;
}

function lineTokens(line) {
  return String(line || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .split(/[^\u0900-\u097Fa-z]+/i)
    .map((t) => t.replace(/[^\u0900-\u097Fa-z]/gi, '').toLowerCase())
    .filter(Boolean);
}

function consonants(word) {
  const map = {
    '\u0915': 'k', '\u0916': 'k', '\u0917': 'g', '\u0918': 'g', '\u0919': 'n',
    '\u091A': 'c', '\u091B': 'c', '\u091C': 'j', '\u091D': 'j', '\u091E': 'n',
    '\u091F': 't', '\u0920': 't', '\u0921': 'd', '\u0922': 'd', '\u0923': 'n',
    '\u0924': 't', '\u0925': 't', '\u0926': 'd', '\u0927': 'd', '\u0928': 'n',
    '\u092A': 'p', '\u092B': 'p', '\u092C': 'b', '\u092D': 'b', '\u092E': 'm',
    '\u092F': 'y', '\u0930': 'r', '\u0932': 'l', '\u0935': 'v',     '\u0936': 's',
    '\u0937': 's', '\u0938': 's', '\u0939': 'h', '\u0933': 'l',
    '\u0902': 'n', '\u0901': 'n',
  };
  const s = String(word || '');
  if (/[\u0900-\u097F]/.test(s)) {
    let out = '';
    for (const ch of s) if (map[ch]) out += map[ch];
    return out;
  }
  return s.toLowerCase().replace(/[^a-z]/g, '').replace(/[aeiou]/g, '');
}

function tagSoundsLike(heard, tag) {
  const h = consonants(heard);
  const t = consonants(tag);
  if (!h || !t || t.length < 3 || h.length > t.length + 2) return false;
  let i = 0;
  for (const ch of h) {
    if (ch === t[i]) i += 1;
    if (i === t.length) return true;
  }
  return false;
}

/**
 * A direction word the voice leaked from a bracket tag, said on its own.
 * "Inviting" / इनव्हाईटिंग is one of these. A real script word is not.
 */
function expressionLeaks(words, lines) {
  const spoken = new Set();
  const tags = new Set();
  for (const line of lines || []) {
    for (const w of lineTokens(line.voiceover_text || line.text || '')) spoken.add(w);
    const raw = String(line.voiceover_raw || line.raw || '');
    for (const bracket of raw.match(/\[[^\]]*\]/g) || []) {
      for (const w of lineTokens(bracket.slice(1, -1))) {
        if (w.length >= 4 && !spoken.has(w)) tags.add(w);
      }
    }
  }
  if (!tags.size) return [];
  const packed = (words || [])
    .map((w, i) => ({
      idx: i,
      tok: String(w.text || w.word || '').replace(/[^\u0900-\u097Fa-z]/gi, '').toLowerCase(),
      text: String(w.text || w.word || ''),
      start: Number(w.start),
      end: Number(w.end),
    }))
    .filter((w) => w.tok && Number.isFinite(w.start) && Number.isFinite(w.end));
  const drops = [];
  for (const utt of splitUtterances(packed)) {
    if (utt.length > 2) continue;
    const toks = utt.map((w) => w.tok);
    if (toks.some((t) => spoken.has(t))) continue;
    const leaked = toks.every((t) => [...tags].some((tag) => t === tag || tagSoundsLike(t, tag)));
    if (!leaked) continue;
    drops.push({
      start: utt[0].start,
      end: utt[utt.length - 1].end,
      text: utt.map((w) => w.text).join(' '),
    });
  }
  return drops;
}

/**
 * Heard words plus script lines. Returns the repeatedHearings groups.
 * lines: { id, text } or a script scene { screen, voiceover_text }.
 */
/** Spoken line only — never the composite ``text`` (onscreen + section titles).
 *  Those extra tokens made true VO duplicates look ``shared`` across many cards
 *  so ``drop`` stayed empty and the later hearing was never silenced. */
function lineVoiceText(line) {
  if (!line || typeof line !== 'object') return String(line || '');
  return String(
    line.voiceover_text || line.voiceover_raw || line.vo_text || line.text || '',
  );
}

/**
 * Split pause-utterances again on sentence end marks so a glued block like
 * "Activities. The teacher… bag. It contains…" becomes separate rows that
 * can match short script lines and catch restatements.
 */
function splitSentenceUtterances(words, pause = 0.5) {
  const out = [];
  for (const utt of splitUtterances(words, pause)) {
    let cur = [];
    for (const w of utt) {
      cur.push(w);
      if (/[.!?।]["')\]]*$/.test(String(w.text || '').trim())) {
        out.push(cur);
        cur = [];
      }
    }
    if (cur.length) out.push(cur);
  }
  return out;
}

const PHRASE_GLUE = new Set([
  'and', 'the', 'for', 'with', 'from', 'that', 'this', 'they', 'them', 'then',
  'than', 'into', 'onto', 'over', 'under', 'your', 'our', 'are', 'was', 'were',
  'have', 'has', 'had', 'will', 'can', 'you', 'who', 'what', 'when', 'which',
  'how', 'why', 'does', 'did', 'dont', "don't", 'its',
]);

function phraseWords(toks) {
  return (toks || []).filter(
    (t) => contentWord(t) && String(t).length >= 4 && !PHRASE_GLUE.has(String(t)),
  );
}

/**
 * Contiguous distinctive phrase (≥4) heard twice, when that phrase IS a
 * script line (or the line without a leading presentative like "it contains").
 * Example: Scene 111 already said "items used in different seasons"; Scene 115
 * repeats that phrase as its whole line — drop the later hearing only.
 * Skips generic templates ("which season… like", "use… umbrella… raincoat").
 */
function phraseRestatementHearings(utts, lines, sameWord) {
  const groups = [];
  const presentative = new Set(['it', 'this', 'that', 'there', 'here', 'these', 'those']);
  const leads = new Set(['contains', 'contain', 'includes', 'include', 'holds', 'hold']);
  for (const line of lines || []) {
    let raw = (line.toks || []).filter(contentWord);
    if (raw.length > 10 || raw.length < 4) continue;
    if (raw.length >= 5 && presentative.has(raw[0]) && leads.has(raw[1])) {
      raw = raw.slice(2);
    } else if (raw.length >= 4 && leads.has(raw[0])) {
      raw = raw.slice(1);
    }
    const toks = phraseWords(raw);
    if (toks.length < 4) continue;
    const hits = [];
    for (const utt of utts) {
      const heard = phraseWords(utt.toks || []);
      for (let i = 0; i <= heard.length - toks.length; i++) {
        let ok = true;
        for (let k = 0; k < toks.length; k++) {
          if (!sameWord(heard[i + k], toks[k])) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        hits.push(utt);
        break;
      }
    }
    if (hits.length < 2) continue;
    hits.sort((a, b) => a.start - b.start);
    const keep = hits[0];
    // Only drop a later hearing that is this short line (not another long host).
    const drops = hits.slice(1).filter((u) => phraseWords(u.toks || []).length <= toks.length + 3);
    if (!drops.length) continue;
    groups.push({
      kind: 'card',
      card: line.id,
      script: line.text,
      keep: { start: keep.start, end: keep.end, text: keep.text },
      drop: drops.map((u) => ({ start: u.start, end: u.end, text: u.text })),
    });
  }
  return groups;
}

function findRepeatedHearings(words, lines) {
  const packed = (words || [])
    .map((w, i) => ({
      idx: i,
      tok: String(w.text || w.word || '').replace(/[^\u0900-\u097Fa-z]/gi, '').toLowerCase(),
      text: String(w.text || w.word || ''),
      start: Number(w.start),
      end: Number(w.end),
    }))
    .filter((w) => w.tok && Number.isFinite(w.start) && Number.isFinite(w.end));
  const utts = splitSentenceUtterances(packed).map((u) => ({
    toks: u.map((w) => w.tok),
    text: u.map((w) => w.text).join(' '),
    start: u[0].start,
    end: u[u.length - 1].end,
  }));
  const scripted = (lines || [])
    .map((line) => {
      const text = lineVoiceText(line);
      return {
        id: line.id || line.screen,
        text,
        toks: lineTokens(text),
      };
    })
    .filter((line) => line.toks.length);
  const exact = repeatedHearings(utts, scripted, hearingSameWord);
  const restated = phraseRestatementHearings(utts, scripted, hearingSameWord);
  const covered = (span) =>
    exact.some((g) =>
      (g.drop || []).some(
        (d) => Number(d.start) < Number(span.end) - 0.1 && Number(d.end) > Number(span.start) + 0.1,
      ),
    );
  for (const g of restated) {
    const drops = (g.drop || []).filter((d) => !covered(d));
    if (!drops.length) continue;
    exact.push({ ...g, drop: drops });
  }
  exact.sort((a, b) => a.keep.start - b.keep.start);
  return exact;
}

module.exports = {
  cover, sameLine, settleGap, splitUtterances, peelHead, peelStolenTail,
  repeatedHearings, findRepeatedHearings, hearingSameWord, expressionLeaks,
};

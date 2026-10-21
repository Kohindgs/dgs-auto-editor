const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');

const execFileAsync = promisify(execFile);

let FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
let FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe';
try {
  const ffStatic = require('ffmpeg-static');
  if (ffStatic && fs.existsSync(ffStatic)) {
    try { fs.chmodSync(ffStatic, 0o755); } catch {}
    FFMPEG_BIN = ffStatic;
  }
} catch {}
try {
  const fpStatic = require('@ffprobe-installer/ffprobe');
  if (fpStatic && fpStatic.path && fs.existsSync(fpStatic.path)) {
    try { fs.chmodSync(fpStatic.path, 0o755); } catch {}
    FFPROBE_BIN = fpStatic.path;
  }
} catch {}

const ROOT = __dirname;
// Store project data outside hbuilds/versions/<uuid> on Hostinger so redeployments never wipe projects
function resolvePersistentDataDir() {
  if (process.env.DGS_DATA_DIR) return process.env.DGS_DATA_DIR;
  const norm = ROOT.replace(/\\/g, '/');
  const hbuildsIdx = norm.indexOf('/hbuilds/');
  if (hbuildsIdx > 0) {
    return path.join(norm.slice(0, hbuildsIdx), 'dgs_data');
  }
  return path.join(ROOT, 'data');
}
const DATA_DIR = resolvePersistentDataDir();
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
const PRESETS_FILE = path.join(DATA_DIR, 'presets.json');
const UPLOAD_TMP = path.join(DATA_DIR, 'tmp_uploads');

for (const d of [DATA_DIR, PROJECTS_DIR, EXPORTS_DIR, UPLOAD_TMP]) {
  fs.mkdirSync(d, { recursive: true });
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.svg', '.avif', '.jfif', '.heic']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.3gp', '.ts', '.mts', '.flv', '.wmv', '.mpeg', '.mpg']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus', '.wma', '.webm', '.mp4']);
const TICKS_PER_SEC = 10000000;
const IMAGE_BASE_OFFSET_TICKS = 36000000000;
const EXEC_OPTS = { timeout: 180000, maxBuffer: 50 * 1024 * 1024 };

const SUNDHARAM_BR = {
  format: 'mp4',
  resolution: '1920x1080',
  fps: 30,
  encoder: 'h264',
  quality_preset: 'high',
  bitrate_mode: 'vbr',
  video_bitrate_kbps: 20000,
  compression_mode: 'by_quality',
  compression_quality: 70,
  audio_encoder: 'aac',
  audio_bitrate_kbps: 320,
  audio_sample_rate: 44100,
  audio_channels: 'stereo',
  color_space: 'bt709',
  advanced_compression: false,
  export_multitrack: false,
  export_video_only: false,
  backup_to_cloud: false,
  auto_highlight: false,
  export_srt_sidecar: false,
  preset_name: 'Sundharam BR',
};

const exportStatus = {};
const collectStatus = {};

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

const upload = multer({
  dest: UPLOAD_TMP,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
});

function projectRoot(pid) {
  return path.join(PROJECTS_DIR, pid);
}
function metaPath(pid, name) {
  const m = path.join(projectRoot(pid), 'meta');
  fs.mkdirSync(m, { recursive: true });
  return path.join(m, name);
}
function saveJson(pid, name, data) {
  fs.writeFileSync(metaPath(pid, name), JSON.stringify(data, null, 2), 'utf-8');
}
function loadJson(pid, name) {
  const p = metaPath(pid, name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}
function createProject() {
  const pid = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const root = projectRoot(pid);
  for (const sub of ['media/images', 'media/videos', 'script', 'voiceover', 'logo', 'meta']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  return pid;
}

function naturalKey(str) {
  return String(str || '')
    .toLowerCase()
    .split(/(\d+)/)
    .map((part) => (/\d+/.test(part) ? Number(part) : part));
}
function naturalCompare(a, b) {
  const ka = naturalKey(a);
  const kb = naturalKey(b);
  const len = Math.min(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    if (ka[i] !== kb[i]) {
      return ka[i] < kb[i] ? -1 : 1;
    }
  }
  return ka.length - kb.length;
}

function numbersToScreens(blob) {
  const nums = [...String(blob || '').matchAll(/\d+/g)]
    .map((m) => parseInt(m[0], 10))
    .filter((n) => n >= 1 && n <= 500);
  const seen = new Set();
  const out = [];
  for (const n of nums) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(`screen_${n}`);
  }
  return out;
}

function detectScreens(filename, parentName = '') {
  for (const candidate of [filename, parentName]) {
    if (!candidate) continue;
    const stem = path.parse(String(candidate)).name;
    const trimmed = stem.trim();
    if (/^\d{1,3}$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      if (n >= 1 && n <= 500) return [`screen_${n}`];
    }
    // Supports "Scene 15 & 16", "Screen 15 + 16", "Scene 15 and 16"
    const labelMulti = stem.match(/(?:screen|scene)[_\s-]*(\d+(?:\s*(?:[&+,/]|and)\s*\d+)+)/i);
    if (labelMulti) {
      const sc = numbersToScreens(labelMulti[1]);
      if (sc.length) return sc;
    }
    // Bare "15 & 16.png", "15 + 16.mp4", "15 and 16.png"
    const bareMulti = trimmed.match(/^(\d+(?:\s*(?:[&+,/]|and)\s*\d+)+)$/);
    if (bareMulti) {
      const sc = numbersToScreens(bareMulti[1]);
      if (sc.length) return sc;
    }
    // Range "Scene 15 to 17", "15-17"
    const rangeMatch = stem.match(/(?:screen|scene|sc|slide|shot|img|vid|clip)?[\s_-]*(\d{1,3})\s*(?:to|-|–)\s*(\d{1,3})/i);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10);
      const b = parseInt(rangeMatch[2], 10);
      if (a >= 1 && b >= a && b - a <= 30) {
        const out = [];
        for (let i = a; i <= b; i++) out.push(`screen_${i}`);
        return out;
      }
    }
    const tagMatches = [...stem.matchAll(/(?:screen|scene|sc|slide|shot|img|vid|clip)[\s_-]*(\d{1,3})/gi)];
    if (tagMatches.length) {
      return [...new Set(tagMatches.map((m) => `screen_${parseInt(m[1], 10)}`))];
    }
    const lead = trimmed.match(/^(\d{1,3})(?:\b|[_-])/);
    if (lead) {
      return [`screen_${parseInt(lead[1], 10)}`];
    }
    const anyNums = [...stem.matchAll(/\b(\d{1,3})\b/g)]
      .map((m) => parseInt(m[1], 10))
      .filter((n) => n >= 1 && n <= 500);
    if (anyNums.length) {
      return [...new Set(anyNums.map((n) => `screen_${n}`))];
    }
  }
  return [];
}

async function probeDuration(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const { stdout } = await execFileAsync(FFPROBE_BIN, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeout: 25000, maxBuffer: 20 * 1024 * 1024 });
    const v = parseFloat(String(stdout).trim());
    if (Number.isFinite(v) && v > 0) return Math.round(v * 1000) / 1000;
  } catch {}
  // Fallback: parse Duration from ffmpeg -i stderr
  try {
    await execFileAsync(FFMPEG_BIN, ['-hide_banner', '-i', filePath], {
      timeout: 20000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = String((err && err.stderr) || (err && err.message) || '');
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
    if (m) {
      const sec = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
      if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000) / 1000;
    }
  }
  return null;
}

async function reindexMedia(pid) {
  const root = projectRoot(pid);
  const mediaDir = path.join(root, 'media');
  const existing = loadJson(pid, 'media.json') || [];
  const byPath = new Map(existing.map((m) => [m.path, m]));
  const files = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) files.push(full);
    }
  }
  walk(mediaDir);

  files.sort((a, b) => {
    const sa = detectScreens(path.basename(a), path.basename(path.dirname(a)));
    const sb = detectScreens(path.basename(b), path.basename(path.dirname(b)));
    const na = sa.length ? parseInt(sa[0].replace('screen_', ''), 10) : 999999;
    const nb = sb.length ? parseInt(sb[0].replace('screen_', ''), 10) : 999999;
    if (na !== nb) return na - nb;
    return naturalCompare(path.basename(a), path.basename(b));
  });

  const items = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext)) continue;
    const kind = IMAGE_EXT.has(ext) ? 'image' : 'video';
    const prev = byPath.get(f);
    const screens = detectScreens(path.basename(f), path.basename(path.dirname(f)));
    const dur = kind === 'video' ? (prev?.duration ?? (await probeDuration(f))) : null;
    items.push({
      id: prev?.id || crypto.randomUUID(),
      filename: path.basename(f),
      path: f,
      kind,
      screen: screens[0] || null,
      screens,
      duration: dur,
    });
  }
  saveJson(pid, 'media.json', items);
  return items;
}

function cleanVoText(raw, onscreenText = '') {
  if (!raw) return '';
  let text = String(raw).replace(/\r\n/g, '\n');
  const voBlocks = [];
  const tagRegex = /\[\s*(?:VO|Voiceover|Narration|Audio)\s*(?:\([^)]*\))?\s*\]\s*:?\s*([\s\S]*?)(?=\[\s*(?:VO|Voiceover|Narration|Audio|On[- ]?screen[^[\]]*|Visual[^[\]]*|SFX[^[\]]*|Music[^[\]]*|Pause[^[\]]*|Note[^[\]]*)\s*\]|$)/gi;
  let m;
  while ((m = tagRegex.exec(text)) !== null) {
    if (m[1] && m[1].trim()) voBlocks.push(m[1].trim());
  }
  if (voBlocks.length) {
    text = voBlocks.join(' ');
  }
  text = text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/(?:narrator|teacher|child|kid|speaker|voice|audio)\s*(?:\([^)]*\))?\s*:\s*/gi, ' ')
    .replace(/\([^)]*(?:pause|beat|sfx|music|laughter|excited|warm|soft|tone|voice|whisper|sound|chuckle|sigh|gasp)[^)]*\)/gi, ' ')
    .replace(/^[A-Za-z][A-Za-z\s]{0,18}:\s*/gm, '')
    .replace(/^["“”'\s]+|["“”'\s]+$/g, '')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const low = text.toLowerCase();
  if (low.startsWith('read exact') || low === 'read on-screen text' || low === 'read onscreen text') {
    const ost = String(onscreenText || '').replace(/\r\n/g, '\n').replace(/[•●▪▸]/g, ' ').replace(/\s+/g, ' ').trim();
    if (ost) return ost;
  }
  return text;
}

function extractOnscreenText(raw) {
  if (!raw) return '';
  const m = String(raw).match(/\[\s*On[- ]?screen[^\]]*\]\s*:?\s*([\s\S]*?)(?=\[|$)/i);
  if (m && m[1]) return m[1].replace(/\s+/g, ' ').trim();
  return '';
}

function parseSunoRange(raw) {
  if (!raw) return [null, null, false];
  const m = String(raw).match(/(?:suno\s*)?(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/i);
  if (!m) return [null, null, false];
  const start = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const end = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
  return [start, end, /suno/i.test(String(raw))];
}

function parseDurationCell(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number' && val > 0 && val < 600) return val;
  const s = String(val).trim();
  const [sStart, sEnd] = parseSunoRange(s);
  if (sStart != null && sEnd != null && sEnd > sStart) return sEnd - sStart;
  const secMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)\b/i);
  if (secMatch) return parseFloat(secMatch[1]);
  const colon = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (colon) {
    if (colon[3] != null) return parseInt(colon[1], 10) * 3600 + parseInt(colon[2], 10) * 60 + parseInt(colon[3], 10);
    return parseInt(colon[1], 10) * 60 + parseInt(colon[2], 10);
  }
  const num = parseFloat(s);
  return Number.isFinite(num) && num > 0 && num < 600 ? num : null;
}

function loadRevisedDurationsFromWb(wb) {
  const out = new Map();
  if (!wb || !Array.isArray(wb.SheetNames) || wb.SheetNames.length < 2) return out;
  for (const name of wb.SheetNames.slice(1)) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    for (const row of rows) {
      if (!row || row.length < 2) continue;
      const mScene = String(row[0] ?? '').trim().match(/^(\d+)$/);
      if (!mScene) continue;
      const scNo = parseInt(mScene[1], 10);
      const dur = parseDurationCell(row[1]);
      if (dur != null && dur > 0) out.set(scNo, dur);
    }
  }
  return out;
}

function parseProductionXlsx(filePath) {
  const wb = XLSX.readFile(filePath);
  const revisedDurations = loadRevisedDurationsFromWb(wb);
  const scenes = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    let headerIdx = -1;
    let colMap = {};
    for (let r = 0; r < Math.min(rows.length, 25); r++) {
      const row = rows[r].map((c) => String(c || '').trim().toLowerCase());
      const hasScene = row.some((c) => c.includes('scene') || c.includes('screen') || c === 'sr. no' || c === 's.no');
      const hasAudioOrText = row.some((c) => c.includes('audio') || c.includes('voice') || c.includes('narration') || c.includes('script') || c.includes('vo') || c.includes('on-screen'));
      if (hasScene && hasAudioOrText) {
        headerIdx = r;
        row.forEach((c, idx) => {
          if (c.includes('scene') || c.includes('screen') || c === 'no' || c.includes('sr')) colMap.scene = colMap.scene ?? idx;
          if (c.includes('section') || c.includes('timestamp')) colMap.section = colMap.section ?? idx;
          if (c.includes('duration') || c.includes('time') || c.includes('sec')) colMap.duration = colMap.duration ?? idx;
          if (c.includes('on-screen') || c.includes('onscreen') || c.includes('text on screen') || c.includes('ost')) colMap.onscreen = colMap.onscreen ?? idx;
          if (c.includes('voice') || c.includes('audio') || c.includes('narration') || c === 'vo' || c.includes('script')) colMap.vo = colMap.vo ?? idx;
          if (c.includes('visual') && c.includes('type')) colMap.vtype = colMap.vtype ?? idx;
          else if (c.includes('visual') || c.includes('animation') || c.includes('image') || c.includes('action')) colMap.visual = colMap.visual ?? idx;
          if (c.includes('type') || c.includes('asset') || c.includes('media')) colMap.vtype = colMap.vtype ?? idx;
        });
        break;
      }
    }
    if (headerIdx < 0) continue;

    let currentSection = '';
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || !row.length) continue;
      const rawScene = String(row[colMap.scene ?? 0] || '').trim();
      const rawSecCell = colMap.section != null ? String(row[colMap.section] || '').trim() : '';
      if (rawSecCell) currentSection = rawSecCell;

      const rawVoCell = colMap.vo != null ? String(row[colMap.vo] || '').trim() : '';
      const rawOstCell = colMap.onscreen != null ? String(row[colMap.onscreen] || '').trim() : '';
      const rawVisCell = colMap.visual != null ? String(row[colMap.visual] || '').trim() : '';
      const rawTypeCell = colMap.vtype != null ? String(row[colMap.vtype] || '').trim() : '';
      const rawDurCell = colMap.duration != null ? row[colMap.duration] : null;

      const numMatch = rawScene.match(/(\d{1,3})/);
      // Continuation row (empty Scene No.): append extra on-screen text or Suno timestamps to last scene
      if (!numMatch) {
        if (scenes.length > 0) {
          const last = scenes[scenes.length - 1];
          const extraOst = rawOstCell || extractOnscreenText(rawVoCell);
          if (extraOst && !last.onscreen_text.includes(extraOst)) {
            last.onscreen_text = last.onscreen_text ? `${last.onscreen_text}\n${extraOst}` : extraOst;
            const refreshedVo = cleanVoText(last.voiceover_raw, last.onscreen_text);
            if (refreshedVo) last.voiceover_text = refreshedVo;
            last.text = [last.voiceover_text, last.onscreen_text, last.section].filter(Boolean).join('\n');
          }
          const [cStart, cEnd] = parseSunoRange(`${rawVoCell} ${rawDurCell || ''}`);
          if (cStart != null && last.audio_start == null) {
            last.audio_start = cStart;
            last.audio_end = cEnd;
            last.is_poem = true;
          }
        }
        continue;
      }

      const sceneNo = parseInt(numMatch[1], 10);
      if (sceneNo < 1 || sceneNo > 500) continue;
      const screen = `screen_${sceneNo}`;

      let [audioStart, audioEnd, isSuno] = parseSunoRange(rawVoCell);
      if (audioStart == null && rawDurCell != null) {
        const [dStart, dEnd, dSuno] = parseSunoRange(String(rawDurCell));
        audioStart = dStart;
        audioEnd = dEnd;
        isSuno = isSuno || dSuno;
      }

      const sheet1Dur = rawDurCell != null ? parseDurationCell(rawDurCell) : null;
      const durVal = revisedDurations.has(sceneNo) ? revisedDurations.get(sceneNo) : sheet1Dur;

      const ostClean = rawOstCell || extractOnscreenText(rawVoCell);
      const voClean = cleanVoText(rawVoCell, ostClean);
      const combined = `${rawScene} ${currentSection} ${rawVoCell} ${rawVisCell} ${rawTypeCell}`.toLowerCase();
      const isPoem =
        isSuno ||
        audioStart != null ||
        combined.includes('poem recitation') ||
        combined.includes('suno') ||
        combined.includes('full poem song') ||
        combined.includes('attached poem track') ||
        currentSection.toLowerCase().startsWith('poem') ||
        currentSection.toLowerCase().includes('song intro');
      const vType = /video|mp4|anim/i.test(rawTypeCell || rawVisCell) ? 'Video' : 'Image';

      scenes.push({
        screen,
        index: scenes.length,
        scene_no: sceneNo,
        section: currentSection || (isPoem ? 'poem' : 'story'),
        duration: durVal,
        audio_start: audioStart,
        audio_end: audioEnd,
        onscreen_text: ostClean,
        voiceover_text: voClean,
        voiceover_raw: rawVoCell,
        visual_type: vType,
        visual_direction: rawVisCell,
        text: [voClean, ostClean, currentSection].filter(Boolean).join('\n') || `Scene ${sceneNo}`,
        is_poem: isPoem,
        source: 'production_xlsx',
      });
    }
    if (scenes.length) break;
  }
  return scenes;
}

function parsePlainScript(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const scenes = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(?:screen|scene)[\s_-]*(\d{1,3})\s*[:\-–]\s*(.*)$/i);
    if (m) {
      const no = parseInt(m[1], 10);
      const vo = cleanVoText(m[2]);
      scenes.push({
        screen: `screen_${no}`,
        index: scenes.length,
        scene_no: no,
        section: 'story',
        duration: null,
        onscreen_text: m[2],
        voiceover_text: vo,
        voiceover_raw: m[2],
        visual_type: 'Image',
        visual_direction: '',
        text: vo || m[2],
        is_poem: /poem|suno/i.test(m[2]),
        source: 'text',
      });
    }
  }
  return scenes;
}

function questionPauseSeconds(scene) {
  if (!scene || scene.is_poem) return 0;
  const raw = String(scene.voiceover_raw || '');
  const tagMatch = raw.match(/\[[^\]]*?(\d+(?:\.\d+)?)\s*-\s*second\s+pause[^\]]*\]/i);
  if (tagMatch) {
    const afterIdx = (tagMatch.index || 0) + tagMatch[0].length;
    const after = raw.slice(afterIdx).replace(/\[[^\]]*\]/g, ' ').replace(/[^\w\u0900-\u097F]+/g, '').trim();
    if (after.length > 0) return 0;
    return parseFloat(tagMatch[1]) || 0;
  }
  const m = raw.match(/(\d+(?:\.\d+)?)\s*-\s*second\s+pause/i);
  return m ? (parseFloat(m[1]) || 0) : 0;
}

function isInstrumentalScene(scene) {
  const vo = String(scene?.voiceover_text || '').trim().toLowerCase();
  if (vo.startsWith('instrumental')) return true;
  const raw = String(scene?.voiceover_raw || '').toLowerCase();
  if (raw.includes('instrumental')) return true;
  const sec = String(scene?.section || '').toLowerCase();
  if (sec.includes('instrumental') || sec.includes('song intro')) return true;
  return false;
}

function onPoemTrack(scene) {
  if (!scene) return false;
  if (!scene.is_poem && scene.audio_start == null) return false;
  const text = String(scene.voiceover_text || '').trim().toLowerCase();
  const raw = String(scene.voiceover_raw || '');
  const sec = String(scene.section || '').trim().toLowerCase();
  if (text.startsWith('instrumental') || isInstrumentalScene(scene)) return true;
  if (scene.audio_start != null) return true;
  if (/suno\s*master|attached\s+poem\s+track/i.test(raw)) return true;
  if (sec.startsWith('poem') || sec.includes('song intro')) return true;
  return Boolean(scene.is_poem);
}

function isSpokenVo(scene) {
  if (!scene || isInstrumentalScene(scene)) return false;
  const text = String(scene.voiceover_text || '').trim();
  if (!text || text === '—' || text === '-' || text === '–') return false;
  const low = text.toLowerCase();
  if (low.startsWith('instrumental')) return false;
  if (/suno\s*master|attached\s+poem\s+track/i.test(String(scene.voiceover_raw || ''))) return false;
  return true;
}

async function detectSilences(audioPath) {
  if (!audioPath || !fs.existsSync(audioPath)) return [];
  try {
    const { stderr } = await execFileAsync(FFMPEG_BIN, [
      '-hide_banner', '-nostats',
      '-i', audioPath,
      '-af', 'silencedetect=noise=-34dB:d=0.18',
      '-f', 'null', '-',
    ], { timeout: 90000, maxBuffer: 50 * 1024 * 1024 });
    const silences = [];
    let curStart = null;
    for (const line of String(stderr).split(/\r?\n/)) {
      const ms = line.match(/silence_start:\s*([0-9.]+)/);
      if (ms) curStart = parseFloat(ms[1]);
      const me = line.match(/silence_end:\s*([0-9.]+)/);
      if (me && curStart != null) {
        const end = parseFloat(me[1]);
        if (end > curStart) silences.push([curStart, end]);
        curStart = null;
      }
    }
    return silences;
  } catch {
    return [];
  }
}

function normScreenId(screen) {
  if (!screen) return '';
  const m = String(screen).trim().match(/^screen_0*(\d+)$/i);
  return m ? `screen_${parseInt(m[1], 10)}` : String(screen).trim().toLowerCase();
}

function coversScreen(item, screen) {
  const want = normScreenId(screen);
  if (!want) return false;
  if (normScreenId(item.screen) === want) return true;
  if (Array.isArray(item.screens) && item.screens.some((s) => normScreenId(s) === want)) return true;
  return false;
}

function isExactScreen(item, screen) {
  const want = normScreenId(screen);
  const list = (Array.isArray(item.screens) && item.screens.length ? item.screens : (item.screen ? [item.screen] : [])).map(normScreenId);
  return list.length === 1 && list[0] === want;
}

function pickMediaForScreen(screen, mediaItems, visualDirection = '') {
  const matching = mediaItems.filter((m) => (m.kind === 'video' || m.kind === 'image') && coversScreen(m, screen));
  matching.sort((a, b) => {
    const exA = isExactScreen(a, screen) ? 1 : 0;
    const exB = isExactScreen(b, screen) ? 1 : 0;
    return exB - exA;
  });
  let vid = matching.find((m) => m.kind === 'video') || null;
  let img = matching.find((m) => m.kind === 'image') || null;
  if (!vid && !img && visualDirection) {
    const wantFn = String(visualDirection).trim().toLowerCase();
    const byFn = mediaItems.find((m) => (m.kind === 'video' || m.kind === 'image') && String(m.filename || '').toLowerCase() === wantFn);
    if (byFn) {
      if (byFn.kind === 'video') vid = byFn;
      else img = byFn;
    }
  }
  return { video: vid, image: img };
}

function mergeAdjacentSameMedia(clips) {
  if (!Array.isArray(clips) || clips.length < 2) return clips || [];
  const merged = [{ ...clips[0] }];
  for (let i = 1; i < clips.length; i++) {
    const clip = clips[i];
    const prev = merged[merged.length - 1];
    const sameMedia = Boolean(clip.media_id && clip.media_id === prev.media_id);
    const contiguous = Math.abs(Number(clip.start) - Number(prev.end)) < 0.05;
    const pauseHold = !(clip.vo_text || clip.script_text) && Boolean(prev.vo_text || prev.script_text);
    if (sameMedia && contiguous && !pauseHold) {
      prev.end = clip.end;
      prev.duration = Math.max(0.2, Math.round((Number(prev.end) - Number(prev.start)) * 1000) / 1000);
      if (prev.script_text && clip.script_text && !prev.script_text.includes(clip.script_text)) {
        prev.script_text = `${prev.script_text}\n${clip.script_text}`.trim();
      } else if (clip.script_text && !prev.script_text) {
        prev.script_text = clip.script_text;
      }
      if (prev.vo_text && clip.vo_text && !prev.vo_text.includes(clip.vo_text)) {
        prev.vo_text = `${prev.vo_text} ${clip.vo_text}`.trim();
      } else if (clip.vo_text && !prev.vo_text) {
        prev.vo_text = clip.vo_text;
      }
      if (clip.narration_out != null) prev.narration_out = clip.narration_out;
      if (prev.narration_in == null) prev.narration_in = clip.narration_in;
      if (prev.kind === 'image') {
        prev.fit = 'hold';
        prev.source_in = 0;
        prev.source_out = prev.duration;
      } else if (prev.source_out != null && prev.fit === 'trim') {
        prev.source_out = prev.duration;
      }
      continue;
    }
    merged.push({ ...clip });
  }
  return merged;
}

function voTimeToTimeline(voT, clips) {
  const spoken = (clips || []).filter(
    (c) => c.narration_in != null && c.narration_out != null && (Number(c.narration_out) - Number(c.narration_in)) > 0.3,
  );
  if (!spoken.length) return Math.max(0, voT);
  if (voT <= Number(spoken[0].narration_in || 0)) return Number(spoken[0].start || 0);
  for (let i = 0; i < spoken.length; i++) {
    const c = spoken[i];
    const inn = Number(c.narration_in);
    const out = Number(c.narration_out);
    if (inn - 0.08 <= voT && voT <= out + 0.08) {
      const span = Math.max(0.001, out - inn);
      const vis = Math.max(0.001, Number(c.end) - Number(c.start));
      return Number(c.start) + ((voT - inn) / span) * vis;
    }
    const nxt = i + 1 < spoken.length ? spoken[i + 1] : null;
    if (nxt && out < voT && voT < Number(nxt.narration_in || 0)) {
      return Number(c.end);
    }
  }
  const last = spoken[spoken.length - 1];
  return Number(last.end) + Math.max(0, voT - Number(last.narration_out || last.end));
}

function placeVoiceoverSlots(rawSlots, clips) {
  const sorted = [...(rawSlots || [])].sort((a, b) => Number(a.slot || 1) - Number(b.slot || 1));
  return sorted.map((item) => {
    const startOff = Number(item.start_offset || 0);
    const endOff = Number(item.end_offset || (startOff + Number(item.duration || 0)));
    const start = Math.round(voTimeToTimeline(startOff, clips) * 1000) / 1000;
    let end = Math.round(voTimeToTimeline(endOff, clips) * 1000) / 1000;
    if (end <= start + 0.05) {
      end = Math.round((start + Math.max(0.4, Number(item.duration || 0.4))) * 1000) / 1000;
    }
    return {
      slot: Number(item.slot || 1),
      filename: String(item.filename || `VO ${item.slot || 1}`),
      duration: Number(item.duration || Math.max(0, endOff - startOff)),
      start_offset: startOff,
      end_offset: endOff,
      start,
      end,
      path: item.path,
    };
  });
}

function cleanCaptionText(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').replace(/^["“”'\s]+|["“”'\s]+$/g, '').trim();
  const low = text.toLowerCase().replace(/^[.!?: ]+|[.!?: ]+$/g, '');
  if (!text || low.startsWith('instrumental') || low.startsWith('read exact')) return '';
  if (text === '—' || text === '-' || text === '–') return '';
  return text;
}

function wrapTwoLines(text, width = 44) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const full = words.join(' ');
  if (full.length <= width) return full;
  const target = Math.max(width, Math.floor(full.length / 2) + 4);
  const line1 = [];
  const line2 = [];
  let len1 = 0;
  for (const w of words) {
    if (line2.length === 0 && (len1 === 0 || len1 + 1 + w.length <= target)) {
      line1.push(w);
      len1 += (len1 ? 1 : 0) + w.length;
    } else {
      line2.push(w);
    }
  }
  return line2.length ? `${line1.join(' ')}\n${line2.join(' ')}` : line1.join(' ');
}

function buildSrtCues(clips, planOpts = {}) {
  const cues = [];
  const poemOk = Boolean(planOpts.poem_voiceover_path);
  const hasPoem = Boolean(planOpts.has_poem);
  const poemStart = Number(planOpts.poem_start_time || 0);
  const poemEnd = Number(planOpts.poem_end_time || 0);
  const lyricStart = Number(planOpts.poem_lyric_start || 0);

  for (const c of clips || []) {
    const txt = cleanCaptionText(c.caption_text || c.vo_text || '');
    if (!txt) continue;
    let start = Number(c.start || 0);
    let end = Number(c.end || 0);
    const spoken =
      c.narration_in != null &&
      c.narration_out != null &&
      Number(c.narration_out) - Number(c.narration_in) >= 0.2;
    const inPoem =
      poemOk &&
      hasPoem &&
      start + 0.05 >= poemStart &&
      start < poemEnd + 0.05;

    if (c.caption_in != null && c.caption_out != null && Number(c.caption_out) > Number(c.caption_in) + 0.2) {
      start = Number(c.caption_in);
      end = Number(c.caption_out);
    } else if (spoken) {
      end = Math.min(end, start + (Number(c.narration_out) - Number(c.narration_in)));
    } else if (inPoem) {
      if (lyricStart > start + 0.05) start = lyricStart;
    } else if (!c.vo_text) {
      continue;
    }
    if (end <= start + 0.2) continue;

    const sentences = txt.split(/(?<=[.!?।])\s+/).map((s) => s.trim()).filter(Boolean);
    if (sentences.length > 1 && txt.length > 72 && (end - start) / sentences.length >= 0.85) {
      const totalChars = Math.max(1, sentences.reduce((a, s) => a + s.length, 0));
      const spanS = end - start;
      let cursor = start;
      for (let idx = 0; idx < sentences.length; idx++) {
        const sent = sentences[idx];
        const segEnd = idx === sentences.length - 1 ? end : cursor + spanS * (sent.length / totalChars);
        if (segEnd > cursor + 0.12) {
          cues.push({
            index: cues.length + 1,
            screen: c.screen,
            start: Math.round(cursor * 1000) / 1000,
            end: Math.round(segEnd * 1000) / 1000,
            text: wrapTwoLines(sent),
          });
        }
        cursor = segEnd;
      }
    } else {
      cues.push({
        index: cues.length + 1,
        screen: c.screen,
        start: Math.round(start * 1000) / 1000,
        end: Math.round(end * 1000) / 1000,
        text: wrapTwoLines(txt),
      });
    }
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) {
      cues[i].end = Math.round(cues[i + 1].start * 1000) / 1000;
    }
  }
  return cues.filter((c) => c.end > c.start + 0.08).map((c, i) => ({ ...c, index: i + 1 }));
}

function formatSrtTime(sec) {
  const msTotal = Math.max(0, Math.round(sec * 1000));
  const ms = msTotal % 1000;
  const sTotal = Math.floor(msTotal / 1000);
  const s = sTotal % 60;
  const mTotal = Math.floor(sTotal / 60);
  const m = mTotal % 60;
  const h = Math.floor(mTotal / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function formatSrt(cues) {
  return cues
    .map((c, idx) => `${idx + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${c.text}\n`)
    .join('\n');
}

// Routes
app.get('/api/presets', (req, res) => {
  let custom = [];
  if (fs.existsSync(PRESETS_FILE)) {
    try { custom = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf-8')); } catch {}
  }
  res.json({
    presets: [{ name: 'Sundharam BR', settings: SUNDHARAM_BR }, ...custom],
    default_save_to: '',
  });
});

app.post('/api/presets', (req, res) => {
  const { name, settings } = req.body || {};
  if (!name || !settings) return res.status(400).json({ detail: 'Missing name or settings' });
  let custom = [];
  if (fs.existsSync(PRESETS_FILE)) {
    try { custom = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf-8')); } catch {}
  }
  custom = custom.filter((p) => p.name !== name);
  custom.push({ name, settings });
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(custom, null, 2), 'utf-8');
  res.json({
    ok: true,
    name,
    presets: [{ name: 'Sundharam BR', settings: SUNDHARAM_BR }, ...custom],
  });
});

// Cloud-safe stubs for desktop folder pickers / revealers so UI buttons never 404
app.post('/api/projects/:id/pick-folder/:kind', (req, res) => {
  res.json({ cancelled: true, cloud: true });
});
app.post('/api/pick-export-dir', (req, res) => {
  res.json({ cancelled: true, path: '' });
});
app.post('/api/projects/:id/reveal-export', (req, res) => {
  res.json({ ok: true });
});
app.post('/api/projects/:id/reveal-collect', (req, res) => {
  res.json({ ok: true });
});
app.post('/api/projects/:id/import-recent', async (req, res) => {
  const items = await reindexMedia(req.params.id);
  res.json({ saved: 0, count: items.length, media: items });
});

app.get('/api/projects/recent', (req, res) => {
  const projects = [];
  if (fs.existsSync(PROJECTS_DIR)) {
    for (const ent of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const pid = ent.name;
      const metaDir = path.join(PROJECTS_DIR, pid, 'meta');
      if (!fs.existsSync(metaDir)) continue;
      const scriptMeta = loadJson(pid, 'script_meta.json') || {};
      const voMeta = loadJson(pid, 'voiceover.json') || {};
      const lastExp = loadJson(pid, 'last_export.json') || {};
      const tlRaw = loadJson(pid, 'timeline.json') || {};
      const mediaRaw = loadJson(pid, 'media.json') || [];
      const scenesRaw = loadJson(pid, 'script.json') || [];
      if (!scenesRaw.length && !mediaRaw.length && !voMeta.path && !(tlRaw.clips && tlRaw.clips.length)) continue;
      let mtime = fs.statSync(path.join(PROJECTS_DIR, pid)).mtimeMs;
      for (const f of fs.readdirSync(metaDir)) {
        try { mtime = Math.max(mtime, fs.statSync(path.join(metaDir, f)).mtimeMs); } catch {}
      }
      const title = lastExp.title || (scriptMeta.filename ? path.parse(scriptMeta.filename).name : `Project ${pid}`);
      projects.push({
        project_id: pid,
        title,
        script_filename: scriptMeta.filename || '',
        vo_filename: voMeta.filename || '',
        media_count: Array.isArray(mediaRaw) ? mediaRaw.length : 0,
        scene_count: Array.isArray(scenesRaw) ? scenesRaw.length : 0,
        clip_count: Array.isArray(tlRaw.clips) ? tlRaw.clips.length : 0,
        total_duration: Number(tlRaw.total_duration || voMeta.duration || 0),
        mtime: mtime / 1000,
        updated_at: new Date(mtime).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
      });
    }
  }
  projects.sort((a, b) => b.mtime - a.mtime);
  res.json({ projects: projects.slice(0, 20), recent_paths: [] });
});

app.post('/api/projects', (req, res) => {
  const pid = createProject();
  res.json({ project_id: pid });
});

app.get('/api/projects/:id/load', (req, res) => {
  const pid = req.params.id;
  if (!fs.existsSync(projectRoot(pid))) return res.status(404).json({ detail: 'Project not found' });
  const scriptMeta = loadJson(pid, 'script_meta.json') || {};
  const lastExp = loadJson(pid, 'last_export.json') || {};
  const title = lastExp.title || (scriptMeta.filename ? path.parse(scriptMeta.filename).name : `Project ${pid}`);
  res.json({
    project_id: pid,
    title,
    scenes: loadJson(pid, 'script.json') || [],
    poem: scriptMeta.poem || null,
    media: loadJson(pid, 'media.json') || [],
    voiceover: loadJson(pid, 'voiceover.json'),
    poem_voiceover: loadJson(pid, 'poem_voiceover.json'),
    logo: loadJson(pid, 'logo.json'),
    timeline: loadJson(pid, 'timeline.json'),
  });
});

app.post('/api/projects/:id/media/:kind', upload.array('files', 500), async (req, res) => {
  try {
    const pid = req.params.id;
    const kind = req.params.kind === 'videos' ? 'videos' : 'images';
    const root = projectRoot(pid);
    if (!fs.existsSync(root)) return res.status(404).json({ detail: 'Project not found' });
    const allowed = kind === 'images' ? IMAGE_EXT : VIDEO_EXT;
    const destDir = path.join(root, 'media', kind);
    fs.mkdirSync(destDir, { recursive: true });
    let saved = 0;
    let skipped = 0;
    for (const f of req.files || []) {
      const origName = path.basename(f.originalname || 'file.bin');
      const ext = path.extname(origName).toLowerCase();
      if (!allowed.has(ext)) {
        skipped++;
        try { fs.unlinkSync(f.path); } catch {}
        continue;
      }
      fs.copyFileSync(f.path, path.join(destDir, origName));
      try { fs.unlinkSync(f.path); } catch {}
      saved++;
    }
    const items = await reindexMedia(pid);
    res.json({ count: items.length, saved, skipped, folder: kind, media: items });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

app.get('/api/projects/:id/media-file/:mediaId', (req, res) => {
  const { id, mediaId } = req.params;
  const items = loadJson(id, 'media.json') || [];
  const item = items.find((m) => m.id === mediaId);
  if (!item || !item.path || !fs.existsSync(item.path)) {
    return res.status(404).json({ detail: 'Media file not found' });
  }
  res.sendFile(path.resolve(item.path));
});

app.get('/api/projects/:id/media-thumb/:mediaId', async (req, res) => {
  const { id, mediaId } = req.params;
  const items = loadJson(id, 'media.json') || [];
  const item = items.find((m) => m.id === mediaId);
  if (!item || !item.path || !fs.existsSync(item.path)) {
    return res.status(404).json({ detail: 'Media not found' });
  }
  if (item.kind === 'image') {
    return res.sendFile(path.resolve(item.path));
  }
  const thumbDir = path.join(projectRoot(id), 'meta', 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });
  const thumbFile = path.join(thumbDir, `${mediaId}.jpg`);
  if (!fs.existsSync(thumbFile)) {
    try {
      await execFileAsync(FFMPEG_BIN, [
        '-y', '-ss', '0.1', '-i', item.path,
        '-frames:v', '1', '-vf', 'scale=320:-1',
        thumbFile,
      ], { timeout: 15000 });
    } catch {}
  }
  if (fs.existsSync(thumbFile)) return res.sendFile(path.resolve(thumbFile));
  res.status(404).end();
});

function handleScriptFile(pid, tempPath, origName) {
  const root = projectRoot(pid);
  const ext = path.extname(origName).toLowerCase();
  const scriptDir = path.join(root, 'script');
  fs.mkdirSync(scriptDir, { recursive: true });
  const dest = path.join(scriptDir, origName);
  fs.copyFileSync(tempPath, dest);
  try { fs.unlinkSync(tempPath); } catch {}

  let scenes = [];
  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.xls') {
    scenes = parseProductionXlsx(dest);
  } else {
    scenes = parsePlainScript(fs.readFileSync(dest, 'utf-8'));
  }
  const poemScenes = scenes.filter((s) => s.is_poem);
  const poem = poemScenes.length
    ? {
        has_poem: true,
        scene_count: poemScenes.length,
        first_screen: poemScenes[0].screen,
        last_screen: poemScenes[poemScenes.length - 1].screen,
      }
    : { has_poem: false };

  saveJson(pid, 'script.json', scenes);
  saveJson(pid, 'script_meta.json', {
    format: ext.includes('xls') ? 'production_xlsx' : 'text',
    filename: origName,
    scene_count: scenes.length,
    poem,
  });
  return { format: 'production_xlsx', scenes, poem };
}

app.post('/api/projects/:id/script', upload.single('file'), (req, res) => {
  try {
    const pid = req.params.id;
    const root = projectRoot(pid);
    if (!fs.existsSync(root) || !req.file) return res.status(400).json({ detail: 'Missing script file' });
    const origName = path.basename(req.file.originalname || 'script.xlsx');
    const result = handleScriptFile(pid, req.file.path, origName);
    res.json(result);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

async function normalizeVoSlotFile(srcPath, normPath) {
  try {
    await execFileAsync(FFMPEG_BIN, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', srcPath,
      '-vn', '-ar', '44100', '-ac', '2',
      '-c:a', 'libmp3lame', '-b:a', '192k',
      normPath,
    ], EXEC_OPTS);
    if (fs.existsSync(normPath) && fs.statSync(normPath).size > 256) {
      return normPath;
    }
  } catch {}
  return srcPath;
}

async function ensureSilenceGapMp3(voDir) {
  const gapPath = path.join(voDir, 'silence_gap_500ms.mp3');
  if (fs.existsSync(gapPath) && fs.statSync(gapPath).size > 256) return gapPath;
  try {
    await execFileAsync(FFMPEG_BIN, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', '0.5',
      '-c:a', 'libmp3lame', '-b:a', '192k',
      gapPath,
    ], EXEC_OPTS);
    if (fs.existsSync(gapPath)) return gapPath;
  } catch {}
  return null;
}

async function rebuildMergedVo(pid, slots) {
  const root = projectRoot(pid);
  const voDir = path.join(root, 'voiceover');
  fs.mkdirSync(voDir, { recursive: true });
  const active = slots
    .filter((s) => s && s.path && fs.existsSync(s.path))
    .sort((a, b) => Number(a.slot) - Number(b.slot));

  if (!active.length) {
    const empty = { path: null, filename: '', duration: 0, kind: 'narration', slots: [] };
    saveJson(pid, 'voiceover.json', empty);
    return empty;
  }
  if (active.length === 1) {
    const only = active[0];
    const dur = only.duration || (await probeDuration(only.path)) || 0;
    only.duration = dur;
    only.start_offset = 0;
    only.end_offset = dur;
    const meta = { path: only.path, filename: only.filename, duration: dur, kind: 'narration', slots: active };
    saveJson(pid, 'voiceover.json', meta);
    return meta;
  }

  const mergedPath = path.join(voDir, 'merged_narration.mp3');
  let offset = 0;
  const gapSec = 0.5;
  const normFiles = [];

  for (let i = 0; i < active.length; i++) {
    const s = active[i];
    const normCandidate = path.join(voDir, `slot_${s.slot}_norm.mp3`);
    const readyPath = (s.norm_path && fs.existsSync(s.norm_path))
      ? s.norm_path
      : await normalizeVoSlotFile(s.path, normCandidate);
    s.norm_path = readyPath;
    normFiles.push(readyPath);

    const dur = s.duration || (await probeDuration(readyPath)) || (await probeDuration(s.path)) || 0;
    s.duration = dur;
    s.start_offset = Math.round(offset * 1000) / 1000;
    s.end_offset = Math.round((offset + dur) * 1000) / 1000;
    offset += dur;
    if (i < active.length - 1) offset += gapSec;
  }

  let mergedOk = false;
  // Strategy 1: Ultra-fast stream-copy concat of normalized 44.1kHz stereo MP3 slots
  const gapMp3 = await ensureSilenceGapMp3(voDir);
  if (gapMp3 && normFiles.every((f) => f.toLowerCase().endsWith('.mp3') && fs.existsSync(f))) {
    try {
      const concatListPath = path.join(voDir, 'concat_vo_list.txt');
      const lines = [];
      for (let i = 0; i < normFiles.length; i++) {
        lines.push(`file '${normFiles[i].replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
        if (i < normFiles.length - 1) {
          lines.push(`file '${gapMp3.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
        }
      }
      fs.writeFileSync(concatListPath, lines.join('\n'), 'utf-8');
      await execFileAsync(FFMPEG_BIN, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'concat', '-safe', '0',
        '-i', concatListPath,
        '-c', 'copy',
        mergedPath,
      ], EXEC_OPTS);
      if (fs.existsSync(mergedPath) && fs.statSync(mergedPath).size > 256) {
        mergedOk = true;
      }
    } catch {}
  }

  // Strategy 2: Filter-complex re-encode with -vn -loglevel error and 50MB maxBuffer
  if (!mergedOk) {
    try {
      const inputs = [];
      const filterParts = [];
      const concatLabels = [];
      for (let i = 0; i < active.length; i++) {
        inputs.push('-i', normFiles[i] || active[i].path);
        filterParts.push(`[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`);
        concatLabels.push(`[a${i}]`);
        if (i < active.length - 1) {
          filterParts.push(`anullsrc=r=44100:cl=stereo,atrim=0:${gapSec},asetpts=PTS-STARTPTS[g${i}]`);
          concatLabels.push(`[g${i}]`);
        }
      }
      filterParts.push(`${concatLabels.join('')}concat=n=${concatLabels.length}:v=0:a=1[aout]`);
      await execFileAsync(FFMPEG_BIN, [
        '-y', '-hide_banner', '-loglevel', 'error',
        ...inputs,
        '-filter_complex', filterParts.join(';'),
        '-map', '[aout]',
        '-vn', '-c:a', 'libmp3lame', '-b:a', '192k',
        mergedPath,
      ], EXEC_OPTS);
      if (fs.existsSync(mergedPath) && fs.statSync(mergedPath).size > 256) {
        mergedOk = true;
      }
    } catch (err) {
      console.error('VO merge filter_complex fallback error:', err);
    }
  }

  // Strategy 3: Never fail the HTTP upload — fall back to the first/latest available audio file
  if (!mergedOk) {
    const fallbackSrc = normFiles[normFiles.length - 1] || active[active.length - 1].path;
    try { fs.copyFileSync(fallbackSrc, mergedPath); } catch {}
  }

  const probedMerged = await probeDuration(mergedPath);
  const totalDur = probedMerged && probedMerged >= offset * 0.8 ? probedMerged : Math.round(offset * 1000) / 1000;
  const label = active.map((s) => `VO${s.slot} (${s.filename})`).join(' + ');
  const meta = { path: mergedPath, filename: label, duration: totalDur, kind: 'narration', slots: active };
  saveJson(pid, 'voiceover.json', meta);
  return meta;
}

async function handleVoiceoverFile(pid, slot, tempPath, origName) {
  const root = projectRoot(pid);
  const voDir = path.join(root, 'voiceover');
  fs.mkdirSync(voDir, { recursive: true });
  const safeOrig = origName.replace(/[^a-zA-Z0-9._ ()-]/g, '_') || `vo_${slot}.mp3`;
  const dest = path.join(voDir, `slot_${slot}_${safeOrig}`);
  fs.copyFileSync(tempPath, dest);
  try { fs.unlinkSync(tempPath); } catch {}

  const normPath = await normalizeVoSlotFile(dest, path.join(voDir, `slot_${slot}_norm.mp3`));
  const duration = (await probeDuration(normPath)) || (await probeDuration(dest)) || 0;

  const existing = loadJson(pid, 'voiceover.json') || {};
  let slots = Array.isArray(existing.slots) ? [...existing.slots] : [];
  // Backfill slot 1 if a single voiceover existed without slots array
  if (!slots.length && existing.path && fs.existsSync(existing.path) && slot !== 1) {
    const dur1 = existing.duration || (await probeDuration(existing.path)) || 0;
    slots.push({
      slot: 1,
      filename: existing.filename || path.basename(existing.path),
      path: existing.path,
      duration: dur1,
    });
  }
  slots = slots.filter((s) => Number(s.slot) !== slot);
  slots.push({ slot, filename: origName, path: dest, norm_path: normPath, duration });
  return await rebuildMergedVo(pid, slots);
}

app.post('/api/projects/:id/voiceover', upload.single('file'), async (req, res) => {
  try {
    const pid = req.params.id;
    const slot = Math.max(1, Math.min(10, parseInt(req.query.slot || req.body?.slot || '1', 10)));
    const root = projectRoot(pid);
    if (!fs.existsSync(root) || !req.file) return res.status(400).json({ detail: 'Missing VO file' });
    const origName = path.basename(req.file.originalname || `vo_${slot}.mp3`);
    const meta = await handleVoiceoverFile(pid, slot, req.file.path, origName);
    res.json(meta);
  } catch (e) {
    console.error('Voiceover upload error:', e);
    res.status(500).json({ detail: String(e) });
  }
});

app.delete('/api/projects/:id/voiceover/:slot', async (req, res) => {
  try {
    const pid = req.params.id;
    const slot = parseInt(req.params.slot, 10);
    const existing = loadJson(pid, 'voiceover.json') || {};
    const slots = (existing.slots || []).filter((s) => Number(s.slot) !== slot);
    const meta = await rebuildMergedVo(pid, slots);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

async function handlePoemVoFile(pid, tempPath, origName) {
  const root = projectRoot(pid);
  const voDir = path.join(root, 'voiceover');
  fs.mkdirSync(voDir, { recursive: true });
  const dest = path.join(voDir, `poem_${origName}`);
  fs.copyFileSync(tempPath, dest);
  try { fs.unlinkSync(tempPath); } catch {}
  const duration = (await probeDuration(dest)) || 0;
  const meta = { path: dest, filename: origName, duration, kind: 'poem' };
  saveJson(pid, 'poem_voiceover.json', meta);
  return meta;
}

app.post('/api/projects/:id/poem-voiceover', upload.single('file'), async (req, res) => {
  try {
    const pid = req.params.id;
    const root = projectRoot(pid);
    if (!fs.existsSync(root) || !req.file) return res.status(400).json({ detail: 'Missing poem VO file' });
    const origName = path.basename(req.file.originalname || 'poem.mp3');
    const meta = await handlePoemVoFile(pid, req.file.path, origName);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

app.get('/api/projects/:id/audio/:kind', (req, res) => {
  const { id, kind } = req.params;
  const meta = loadJson(id, kind === 'poem' ? 'poem_voiceover.json' : 'voiceover.json');
  if (!meta || !meta.path || !fs.existsSync(meta.path)) return res.status(404).end();
  res.sendFile(path.resolve(meta.path));
});

function handleLogoFile(pid, tempPath, origName) {
  const root = projectRoot(pid);
  const logoDir = path.join(root, 'logo');
  fs.mkdirSync(logoDir, { recursive: true });
  const dest = path.join(logoDir, origName);
  fs.copyFileSync(tempPath, dest);
  try { fs.unlinkSync(tempPath); } catch {}
  const meta = { path: dest, filename: origName, enabled: true };
  saveJson(pid, 'logo.json', meta);
  const tl = loadJson(pid, 'timeline.json');
  if (tl) {
    tl.logo_path = dest;
    tl.logo_enabled = true;
    saveJson(pid, 'timeline.json', tl);
  }
  return meta;
}

app.post('/api/projects/:id/logo', upload.single('file'), (req, res) => {
  try {
    const pid = req.params.id;
    const root = projectRoot(pid);
    if (!fs.existsSync(root) || !req.file) return res.status(400).json({ detail: 'Missing logo file' });
    const origName = path.basename(req.file.originalname || 'logo.png');
    const meta = handleLogoFile(pid, req.file.path, origName);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

app.post('/api/projects/:id/logo/toggle', (req, res) => {
  const pid = req.params.id;
  const enabled = String(req.query.enabled) !== 'false';
  const meta = loadJson(pid, 'logo.json') || {};
  meta.enabled = enabled;
  saveJson(pid, 'logo.json', meta);
  const tl = loadJson(pid, 'timeline.json');
  if (tl) {
    tl.logo_enabled = enabled;
    saveJson(pid, 'timeline.json', tl);
  }
  res.json(meta);
});

app.get('/api/projects/:id/logo-file', (req, res) => {
  const meta = loadJson(req.params.id, 'logo.json');
  if (!meta || !meta.path || !fs.existsSync(meta.path)) return res.status(404).end();
  res.sendFile(path.resolve(meta.path));
});

app.post('/api/projects/:id/build', async (req, res) => {
  try {
    const pid = req.params.id;
    const scenes = loadJson(pid, 'script.json') || [];
    // Refresh cleanVoText for production_xlsx scenes (e.g., "Read exact on-screen text")
    let changedVo = false;
    for (const s of scenes) {
      if (s.voiceover_raw) {
        const freshVo = cleanVoText(s.voiceover_raw, s.onscreen_text);
        if (freshVo && freshVo !== s.voiceover_text) {
          s.voiceover_text = freshVo;
          s.text = [freshVo, s.onscreen_text, s.section].filter(Boolean).join('\n');
          changedVo = true;
        }
      }
    }
    if (changedVo) saveJson(pid, 'script.json', scenes);

    const media = await reindexMedia(pid);
    const voMeta = loadJson(pid, 'voiceover.json') || {};
    const poemVoMeta = loadJson(pid, 'poem_voiceover.json') || {};
    const logoMeta = loadJson(pid, 'logo.json') || {};

    const voDur = Number(voMeta.duration || 0);
    const poemVoDur = Number(poemVoMeta.duration || 0);
    const hasPoemVo = Boolean(poemVoMeta.path && fs.existsSync(poemVoMeta.path));
    const silences = voMeta.path && fs.existsSync(voMeta.path) ? await detectSilences(voMeta.path) : [];

    // Separate scenes into spoken narration vs poem/instrumental so poem scenes do not eat narration VO
    const speechScenes = scenes.filter((s) => {
      if (hasPoemVo && onPoemTrack(s)) return false;
      if (s.audio_start != null && s.audio_end != null && onPoemTrack(s)) return false;
      return isSpokenVo(s);
    });

    const speechWeights = new Map();
    let totalSpeechWeight = 0;
    for (const s of speechScenes) {
      const txt = String(s.voiceover_text || s.onscreen_text || '');
      const words = txt.split(/\s+/).filter(Boolean).length;
      const isDevanagari = /[\u0900-\u097F]/.test(txt);
      const wordEst = words > 0 ? Math.max(1.2, words * (isDevanagari ? 0.55 : 0.38) + 0.25) : (Number(s.duration) || 2.0);
      const w = s.duration && Number(s.duration) > 0 ? 0.55 * wordEst + 0.45 * Number(s.duration) : wordEst;
      speechWeights.set(s.screen, w);
      totalSpeechWeight += w;
    }
    const scale = voDur > 1 && totalSpeechWeight > 0 ? voDur / totalSpeechWeight : 1;

    const rawClips = [];
    let tlCursor = 0;
    let narrCursor = 0;
    let poemStartTime = 0;
    let poemEndTime = 0;
    let inPoemBlock = false;
    const anyPoemScene = scenes.some((s) => s.is_poem || onPoemTrack(s));

    // Group scenes into runs of 'poem' vs 'speech' when poem clock is active
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      const isPoemScene = (hasPoemVo || (s.audio_start != null && s.audio_end != null)) && onPoemTrack(s);
      const spoken = !isPoemScene && speechWeights.has(s.screen);

      let clipDur = 2.5;
      let narrIn = null;
      let narrOut = null;

      if (isPoemScene) {
        if (!inPoemBlock) {
          poemStartTime = tlCursor;
          inPoemBlock = true;
        }
        if (s.audio_start != null && s.audio_end != null && Number(s.audio_end) > Number(s.audio_start)) {
          clipDur = Math.max(0.4, Number(s.audio_end) - Number(s.audio_start));
        } else if (s.duration && Number(s.duration) > 0) {
          clipDur = Math.max(0.4, Number(s.duration));
        } else if (poemVoDur > 0) {
          const poemCount = Math.max(1, scenes.filter((x) => onPoemTrack(x)).length);
          clipDur = Math.max(1.5, poemVoDur / poemCount);
        }
        poemEndTime = Math.max(poemEndTime, tlCursor + clipDur);
      } else if (spoken) {
        const w = speechWeights.get(s.screen) || 2.0;
        let spokenDur = Math.max(0.6, w * scale);
        let narrEnd = narrCursor + spokenDur;

        const isLastSpoken = s.screen === speechScenes[speechScenes.length - 1]?.screen;
        if (silences.length && !isLastSpoken) {
          let bestSilCut = null;
          let bestDist = 1.25;
          for (const [ss, se] of silences) {
            const mid = 0.5 * (ss + se);
            const dist = Math.abs(mid - narrEnd);
            if (dist < bestDist && ss > narrCursor + 0.45) {
              bestDist = dist;
              // Cut ~0.14s before the next line's voice onset so no word is ever clipped or rushed
              const hasPauseBreak = questionPauseSeconds(s) > 0;
              bestSilCut = hasPauseBreak
                ? Math.max(ss + 0.14, Math.min(se - 0.18, ss + Math.min(0.40, 0.48 * (se - ss))))
                : Math.max(ss + 0.14, se - 0.14);
            }
          }
          if (bestSilCut != null && bestSilCut > narrCursor + 0.35) {
            narrEnd = bestSilCut;
            spokenDur = narrEnd - narrCursor;
          }
        } else if (isLastSpoken && voDur > narrCursor + 0.2) {
          narrEnd = voDur;
          spokenDur = Math.max(0.5, narrEnd - narrCursor);
        }

        narrIn = Math.round(narrCursor * 1000) / 1000;
        narrOut = Math.round(narrEnd * 1000) / 1000;
        clipDur = Math.max(0.4, narrOut - narrIn);
        narrCursor = narrEnd;
      } else {
        // Silent title / instrumental card: use script duration without advancing narrCursor
        clipDur = Math.max(0.4, Number(s.duration) || 2.0);
      }

      const dur = Math.round(clipDur * 1000) / 1000;
      const { video, image } = pickMediaForScreen(s.screen, media, s.visual_direction || s.visual_type);
      const primary = video && image ? image : (image || video);
      const extraVid = video && image ? video : null;

      if (!primary) {
        rawClips.push({
          screen: s.screen,
          media_id: null,
          media_path: '',
          kind: 'image',
          start: Math.round(tlCursor * 1000) / 1000,
          end: Math.round((tlCursor + dur) * 1000) / 1000,
          duration: dur,
          source_in: 0,
          source_out: dur,
          script_text: s.text || s.voiceover_text || s.onscreen_text || s.screen,
          vo_text: s.voiceover_text || '',
          caption_text: s.voiceover_text || s.onscreen_text || '',
          narration_in: narrIn,
          narration_out: narrOut,
          fit: 'missing',
        });
        tlCursor += dur;
      } else {
        const srcDur = primary.kind === 'video' ? Number(primary.duration || dur) : dur;
        const fitMode =
          primary.kind === 'image'
            ? 'hold'
            : srcDur >= dur - 0.05
              ? 'trim'
              : 'passthrough';
        rawClips.push({
          screen: s.screen,
          media_id: primary.id,
          media_path: primary.path,
          kind: primary.kind,
          start: Math.round(tlCursor * 1000) / 1000,
          end: Math.round((tlCursor + dur) * 1000) / 1000,
          duration: dur,
          source_in: 0,
          source_out: primary.kind === 'video' ? Math.min(dur, srcDur) : dur,
          script_text: s.text || s.voiceover_text || s.onscreen_text || s.screen,
          vo_text: s.voiceover_text || '',
          caption_text: s.voiceover_text || s.onscreen_text || '',
          narration_in: narrIn,
          narration_out: narrOut,
          fit: fitMode,
        });
        tlCursor += dur;

        if (extraVid) {
          const vdur = Math.round((Number(extraVid.duration) || 4.0) * 1000) / 1000;
          rawClips.push({
            screen: s.screen,
            media_id: extraVid.id,
            media_path: extraVid.path,
            kind: 'video',
            start: Math.round(tlCursor * 1000) / 1000,
            end: Math.round((tlCursor + vdur) * 1000) / 1000,
            duration: vdur,
            source_in: 0,
            source_out: vdur,
            script_text: `${s.screen} (Action Video)`,
            vo_text: '',
            caption_text: '',
            narration_in: null,
            narration_out: null,
            fit: 'trim',
          });
          tlCursor += vdur;
        }
      }

      // End-of-line question pause hold (e.g. "[4-Second Pause]") — holds visual without advancing narrCursor
      const qPause = questionPauseSeconds(s);
      if (qPause > 0) {
        const pDur = Math.round(qPause * 1000) / 1000;
        rawClips.push({
          screen: s.screen,
          media_id: primary ? primary.id : null,
          media_path: primary ? primary.path : '',
          kind: primary ? primary.kind : 'image',
          start: Math.round(tlCursor * 1000) / 1000,
          end: Math.round((tlCursor + pDur) * 1000) / 1000,
          duration: pDur,
          source_in: 0,
          source_out: pDur,
          script_text: '',
          vo_text: '',
          caption_text: '',
          narration_in: null,
          narration_out: null,
          fit: primary ? 'hold' : 'missing',
        });
        tlCursor += pDur;
      }
    }

    const clips = mergeAdjacentSameMedia(rawClips);
    if (clips.length) {
      tlCursor = clips[clips.length - 1].end;
    }

    const placedSlots = placeVoiceoverSlots(voMeta.slots || [], clips);
    if (placedSlots.length) {
      tlCursor = Math.max(tlCursor, ...placedSlots.map((s) => Number(s.end || 0)));
    }

    const planOpts = {
      poem_voiceover_path: poemVoMeta.path || null,
      has_poem: anyPoemScene || hasPoemVo,
      poem_start_time: Math.round(poemStartTime * 1000) / 1000,
      poem_end_time: Math.round(poemEndTime * 1000) / 1000,
      poem_lyric_start: 0,
    };
    const srtCues = buildSrtCues(clips, planOpts);
    saveJson(pid, 'subtitles.srt', formatSrt(srtCues));

    // Scan timeline for missing cards / QA issues
    const qaIssues = [];
    for (const c of clips) {
      if (c.fit === 'missing' || !c.media_path) {
        const mNum = String(c.screen || '').match(/(\d+)$/);
        const imgNo = mNum ? parseInt(mNum[1], 10) : null;
        const sSec = Math.max(0, Math.floor(Number(c.start || 0)));
        const eSec = Math.max(0, Math.floor(Number(c.end || 0)));
        const tc = `${String(Math.floor(sSec / 60)).padStart(2, '0')}:${String(sSec % 60).padStart(2, '0')}–${String(Math.floor(eSec / 60)).padStart(2, '0')}:${String(eSec % 60).padStart(2, '0')}`;
        qaIssues.push({
          kind: 'missing_card',
          severity: 'error',
          screen: c.screen,
          image_no: imgNo,
          time: Number(c.start || 0),
          end: Number(c.end || 0),
          timecode: tc,
          message: `Image ${imgNo || c.screen}: blank on Video 1 · no card/video at ${tc}. Drop ${imgNo || c.screen}.png or Scene ${imgNo || c.screen}.mp4 in the media folder.`,
        });
      }
    }
    const errCount = qaIssues.filter((i) => i.severity === 'error').length;
    const warnCount = qaIssues.filter((i) => i.severity === 'warning').length;
    const qaSummary = qaIssues.length
      ? `Align scan: ${errCount} missing · ${warnCount} warnings · ${clips.length} pictures on the timeline`
      : `Align scan: no issues · ${clips.length} pictures checked`;

    const headClips = clips.filter((c) => c.narration_in != null && (!planOpts.has_poem || c.start < planOpts.poem_start_time - 0.02));
    const tailClips = planOpts.has_poem
      ? clips.filter((c) => c.narration_in != null && c.start >= planOpts.poem_end_time - 0.05)
      : [];

    const plan = {
      project_id: pid,
      total_duration: Math.round(tlCursor * 1000) / 1000,
      clips,
      voiceover_path: voMeta.path || null,
      voiceover_slots: placedSlots,
      poem_voiceover_path: poemVoMeta.path || null,
      poem_start_time: planOpts.poem_start_time,
      poem_end_time: planOpts.poem_end_time,
      poem_lyric_start: 0,
      has_poem: planOpts.has_poem,
      narration_head_in: headClips.length ? Math.min(...headClips.map((c) => Number(c.narration_in || 0))) : null,
      narration_head_out: headClips.length ? Math.max(...headClips.map((c) => Number(c.narration_out || 0))) : null,
      narration_tail_in: tailClips.length ? Math.min(...tailClips.map((c) => Number(c.narration_in || 0))) : null,
      narration_tail_out: tailClips.length ? Math.max(...tailClips.map((c) => Number(c.narration_out || 0))) : null,
      logo_path: logoMeta.path || null,
      logo_enabled: logoMeta.enabled !== false && Boolean(logoMeta.path),
      language: (req.body && req.body.language) || 'en+mr',
      srt_cues: srtCues,
      qa_issues: qaIssues,
      qa_summary: qaSummary,
      poem: {
        has_poem: planOpts.has_poem,
        poem_start_time: planOpts.poem_start_time,
        poem_uploaded: Boolean(poemVoMeta.path),
      },
    };
    saveJson(pid, 'timeline.json', plan);
    saveJson(pid, 'qa.json', { summary: qaSummary, issues: qaIssues });
    res.json(plan);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

app.put('/api/projects/:id/timeline', (req, res) => {
  const pid = req.params.id;
  const plan = req.body || {};
  if (Array.isArray(plan.clips)) {
    for (const c of plan.clips) {
      c.duration = Math.max(0.2, Math.round((Number(c.end || 0) - Number(c.start || 0)) * 1000) / 1000);
    }
    if (plan.clips.length) {
      plan.total_duration = Math.max(
        Number(plan.total_duration || 0),
        ...plan.clips.map((c) => Number(c.end || 0)),
      );
    }
  }
  saveJson(pid, 'timeline.json', plan);
  res.json(plan);
});

app.get('/api/projects/:id/srt/download', (req, res) => {
  const pid = req.params.id;
  const plan = loadJson(pid, 'timeline.json');
  if (!plan) return res.status(404).send('No timeline');
  const cues = plan.srt_cues && plan.srt_cues.length ? plan.srt_cues : buildSrtCues(plan.clips || [], plan);
  const srt = formatSrt(cues);
  const title = String(req.query.title || 'Subtitles').replace(/[^a-zA-Z0-9._ -]/g, '_');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="SRT_Only_${title}.srt"`);
  res.send(srt);
});

app.get('/api/projects/:id/export/status', (req, res) => {
  res.json(exportStatus[req.params.id] || { running: false, percent: 0, message: '' });
});

function buildVideoRateArgs(settings) {
  const encMap = { h264: 'libx264', h265: 'libx265', mpeg4: 'mpeg4' };
  const vcodec = encMap[settings.encoder] || 'libx264';
  const presetMap = { low: 'veryfast', medium: 'fast', high: 'medium' };
  const x264Preset = presetMap[settings.quality_preset] || 'fast';
  const colorSpace = settings.color_space === 'bt601'
    ? ['-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m']
    : ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];

  let base = ['-c:v', vcodec];
  if (vcodec === 'libx264' || vcodec === 'libx265') {
    base.push('-preset', x264Preset);
  }
  base.push('-pix_fmt', 'yuv420p', ...colorSpace);

  const q = Math.max(10, Math.min(90, Number(settings.compression_quality) || 70));
  const keepRatio = (100 - q) / 100.0;
  let effectiveKbps = Math.max(500, Number(settings.video_bitrate_kbps) || 20000);

  if (settings.advanced_compression && settings.compression_mode === 'by_quality') {
    const crf = Math.max(18, Math.min(36, Math.round(18 + (q / 100.0) * 18)));
    const capKbps = Math.max(400, Math.round(effectiveKbps * keepRatio));
    if (vcodec === 'libx264' || vcodec === 'libx265') {
      return [...base, '-crf', String(crf), '-maxrate', `${capKbps}k`, '-bufsize', `${capKbps * 2}k`];
    }
    effectiveKbps = capKbps;
  } else if (settings.advanced_compression && settings.compression_mode === 'by_bitrate') {
    effectiveKbps = Math.max(300, Math.round(effectiveKbps * keepRatio));
  }

  const br = `${effectiveKbps}k`;
  const buf = `${effectiveKbps * 2}k`;
  if (settings.bitrate_mode === 'cbr') {
    return [...base, '-b:v', br, '-minrate', br, '-maxrate', br, '-bufsize', buf];
  }
  return [...base, '-b:v', br, '-maxrate', `${Math.round(effectiveKbps * 1.35)}k`, '-bufsize', buf];
}

function buildAudioEncodeArgs(settings) {
  const aencMap = { aac: 'aac', mp3: 'libmp3lame', pcm: 'pcm_s16le' };
  const acodec = aencMap[settings.audio_encoder] || 'aac';
  const ch = settings.audio_channels === 'mono' ? '1' : '2';
  const sr = String(settings.audio_sample_rate || 44100);
  const args = ['-c:a', acodec, '-ar', sr, '-ac', ch];
  if (acodec !== 'pcm_s16le') {
    args.push('-b:a', `${settings.audio_bitrate_kbps || 320}k`);
  }
  return args;
}

app.post('/api/projects/:id/export', async (req, res) => {
  const pid = req.params.id;
  const plan = loadJson(pid, 'timeline.json');
  if (!plan || !plan.clips || !plan.clips.length) {
    return res.status(400).json({ detail: 'Build timeline before export' });
  }
  const settings = { ...SUNDHARAM_BR, ...(req.body?.settings || {}) };
  const rawTitle = String(req.body?.title || 'Export').trim();
  const safeTitle = rawTitle.replace(/[^a-zA-Z0-9._ ()-]/g, '_') || `Project_${pid}`;

  exportStatus[pid] = { running: true, percent: 4, message: 'Preparing server FFmpeg render…' };
  try {
    const [wStr, hStr] = String(settings.resolution || '1920x1080').toLowerCase().replace('*', 'x').split('x');
    const width = parseInt(wStr, 10) || 1920;
    const height = parseInt(hStr, 10) || 1080;
    const fps = Number(settings.fps) || 30;

    const jobDir = path.join(EXPORTS_DIR, pid, `job_${Date.now()}`);
    const partsDir = path.join(jobDir, 'parts');
    fs.mkdirSync(partsDir, { recursive: true });

    const partFiles = [];
    for (let i = 0; i < plan.clips.length; i++) {
      const c = plan.clips[i];
      const clipDur = Math.max(0.2, Number(c.duration) || (Number(c.end || 0) - Number(c.start || 0)) || 2.0);
      exportStatus[pid] = {
        running: true,
        percent: 5 + Math.round((i / plan.clips.length) * 68),
        message: `Rendering scene ${i + 1}/${plan.clips.length} (${c.screen})…`,
      };
      const outPart = path.join(partsDir, `part_${String(i).padStart(4, '0')}.mp4`);
      const vfBase = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},format=yuv420p`;

      if (!c.media_path || !fs.existsSync(c.media_path) || c.fit === 'missing') {
        await execFileAsync(FFMPEG_BIN, [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=${clipDur}:r=${fps}`,
          '-t', String(clipDur), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', outPart,
        ], EXEC_OPTS);
      } else if (c.kind === 'image') {
        await execFileAsync(FFMPEG_BIN, [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-loop', '1', '-i', c.media_path,
          '-t', String(clipDur), '-vf', vfBase,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', outPart,
        ], EXEC_OPTS);
      } else {
        // Video clip: if source video is shorter than slot duration, freeze last frame with tpad
        const srcIn = Number(c.source_in || 0);
        const rawSrcDur = (c.source_out && Number(c.source_out) > srcIn)
          ? (Number(c.source_out) - srcIn)
          : ((await probeDuration(c.media_path)) || clipDur);
        const playDur = Math.min(clipDur, Math.max(0.1, rawSrcDur));
        const freeze = Math.max(0, clipDur - playDur);
        const vfVideo = freeze > 0.05
          ? `${vfBase},tpad=stop_mode=clone:stop_duration=${freeze.toFixed(3)}`
          : vfBase;
        await execFileAsync(FFMPEG_BIN, [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-ss', String(srcIn), '-i', c.media_path,
          '-t', String(clipDur), '-vf', vfVideo,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', outPart,
        ], EXEC_OPTS);
      }
      partFiles.push(outPart);
    }

    exportStatus[pid] = { running: true, percent: 76, message: 'Stitching video scenes…' };
    const concatTxt = path.join(jobDir, 'concat.txt');
    fs.writeFileSync(concatTxt, partFiles.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf-8');
    const silentMp4 = path.join(jobDir, 'silent.mp4');
    await execFileAsync(FFMPEG_BIN, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', concatTxt, '-c', 'copy', silentMp4,
    ], EXEC_OPTS);

    let videoSource = silentMp4;
    if (plan.logo_path && plan.logo_enabled !== false && fs.existsSync(plan.logo_path)) {
      exportStatus[pid] = { running: true, percent: 82, message: 'Applying client logo overlay…' };
      const logoMp4 = path.join(jobDir, 'logo.mp4');
      const logoW = Math.max(90, Math.round(width * 0.1));
      const padX = Math.max(8, Math.round(width * 0.0078));
      const padY = Math.max(10, Math.round(height * 0.0176));
      await execFileAsync(FFMPEG_BIN, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', silentMp4, '-i', plan.logo_path,
        '-filter_complex', `[1:v]scale=${logoW}:-1[lg];[0:v][lg]overlay=W-w-${padX}:${padY}:format=auto,format=yuv420p[vout]`,
        '-map', '[vout]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-an', logoMp4,
      ], EXEC_OPTS);
      videoSource = logoMp4;
    }

    exportStatus[pid] = { running: true, percent: 88, message: 'Encoding & syncing audio tracks…' };
    const vRateArgs = buildVideoRateArgs(settings);
    const aEncArgs = buildAudioEncodeArgs(settings);
    const ext = ['mp4', 'mov', 'mkv', 'avi', 'mp3', 'wav'].includes(String(settings.format || '').toLowerCase())
      ? String(settings.format).toLowerCase()
      : 'mp4';
    const outPath = path.join(EXPORTS_DIR, pid, `${safeTitle}.${ext}`);
    const movFlags = ext === 'mp4' || ext === 'mov' ? ['-movflags', '+faststart'] : [];

    const hasVo = Boolean(plan.voiceover_path && fs.existsSync(plan.voiceover_path) && !settings.export_video_only);
    const hasPoem = Boolean(
      plan.poem_voiceover_path &&
      fs.existsSync(plan.poem_voiceover_path) &&
      plan.has_poem &&
      !settings.export_video_only,
    );

    if (ext === 'mp3' || ext === 'wav') {
      const srcAudio = plan.voiceover_path || plan.poem_voiceover_path;
      if (srcAudio && fs.existsSync(srcAudio)) {
        await execFileAsync(FFMPEG_BIN, ['-y', '-hide_banner', '-loglevel', 'error', '-i', srcAudio, ...aEncArgs, outPath], { timeout: 600000, maxBuffer: 50 * 1024 * 1024 });
      }
    } else if (hasVo || hasPoem) {
      // Build narr_runs from (clip.start, clip.narration_in, clip.narration_out) so silent holds,
      // action videos, and poem blocks never cause narration drift!
      const narrRuns = [];
      for (const c of plan.clips) {
        if (c.narration_in == null || c.narration_out == null) continue;
        const ni = Number(c.narration_in);
        const no = Number(c.narration_out);
        if (no <= ni + 0.05) continue;
        const cs = Number(c.start || 0);
        if (narrRuns.length) {
          const prev = narrRuns[narrRuns.length - 1];
          const prevTlEnd = prev[0] + (prev[2] - prev[1]);
          if (Math.abs(cs - prevTlEnd) < 0.15 && Math.abs(ni - prev[2]) < 0.15) {
            prev[2] = no;
            continue;
          }
        }
        narrRuns.push([cs, ni, no]);
      }

      const audioInputs = [];
      const filterParts = [];
      const mixLabels = [];
      let nextInputIdx = 1; // 0 is videoSource

      if (hasVo) {
        const voIdx = nextInputIdx++;
        audioInputs.push('-i', plan.voiceover_path);
        if (narrRuns.length) {
          for (let rIdx = 0; rIdx < narrRuns.length; rIdx++) {
            const [tlStart, voIn, voOut] = narrRuns[rIdx];
            const delayMs = Math.max(0, Math.round(tlStart * 1000));
            const lbl = `nr${rIdx}`;
            filterParts.push(
              `[${voIdx}:a]atrim=${voIn.toFixed(3)}:${voOut.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[${lbl}]`,
            );
            mixLabels.push(`[${lbl}]`);
          }
        } else {
          filterParts.push(`[${voIdx}:a]asetpts=PTS-STARTPTS[nr0]`);
          mixLabels.push('[nr0]');
        }
      }

      if (hasPoem) {
        const poemIdx = nextInputIdx++;
        audioInputs.push('-i', plan.poem_voiceover_path);
        const pStart = Number(plan.poem_start_time || 0);
        const pEnd = Number(plan.poem_end_time || 0);
        const pDur = Math.max(0.5, pEnd - pStart);
        const pDelayMs = Math.max(0, Math.round(pStart * 1000));
        filterParts.push(
          `[${poemIdx}:a]atrim=0:${pDur.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${pDelayMs}|${pDelayMs}[poem]`,
        );
        mixLabels.push('[poem]');
      }

      const totalTlDur = Math.max(1, Number(plan.total_duration || 10));
      let filterComplex = '';
      if (mixLabels.length === 1) {
        filterComplex = `${filterParts.join(';')};${mixLabels[0]}apad=whole_dur=${totalTlDur.toFixed(3)}[aout]`;
      } else {
        filterComplex = `${filterParts.join(';')};${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0,volume=${mixLabels.length},apad=whole_dur=${totalTlDur.toFixed(3)}[aout]`;
      }

      await execFileAsync(FFMPEG_BIN, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', videoSource,
        ...audioInputs,
        '-filter_complex', filterComplex,
        '-map', '0:v:0', '-map', '[aout]',
        ...vRateArgs,
        ...aEncArgs,
        ...movFlags,
        '-t', totalTlDur.toFixed(3),
        outPath,
      ], { timeout: 600000, maxBuffer: 50 * 1024 * 1024 });
    } else {
      await execFileAsync(FFMPEG_BIN, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', videoSource,
        ...vRateArgs,
        '-an',
        ...movFlags,
        outPath,
      ], { timeout: 600000, maxBuffer: 50 * 1024 * 1024 });
    }

    // Write sidecar SRT alongside export if requested
    if (settings.export_srt_sidecar) {
      const cues = plan.srt_cues && plan.srt_cues.length ? plan.srt_cues : buildSrtCues(plan.clips || [], plan);
      const srtSidecarPath = path.join(EXPORTS_DIR, pid, `${safeTitle}.srt`);
      fs.writeFileSync(srtSidecarPath, formatSrt(cues), 'utf-8');
    }

    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}

    const sizeMb = Math.round((fs.statSync(outPath).size / (1024 * 1024)) * 100) / 100;
    const payload = {
      path: outPath,
      saved_to: '',
      filename: path.basename(outPath),
      size_mb: sizeMb,
      settings,
      title: rawTitle,
      download: `/api/projects/${pid}/download`,
      srt_download: `/api/projects/${pid}/srt/download?title=${encodeURIComponent(rawTitle)}`,
    };
    saveJson(pid, 'last_export.json', payload);
    exportStatus[pid] = { running: false, percent: 100, message: 'Export completed!', ...payload };
    res.json(payload);
  } catch (e) {
    exportStatus[pid] = { running: false, percent: 0, message: String(e) };
    res.status(500).json({ detail: String(e) });
  }
});

app.get('/api/projects/:id/download', (req, res) => {
  const meta = loadJson(req.params.id, 'last_export.json');
  if (!meta || !meta.path || !fs.existsSync(meta.path)) return res.status(404).send('No export yet');
  res.download(path.resolve(meta.path), meta.filename);
});

// Scene edit & custom scene voiceover
app.put('/api/projects/:id/scenes/:screen', (req, res) => {
  const { id, screen } = req.params;
  const scenes = loadJson(id, 'script.json') || [];
  let updated = null;
  for (const s of scenes) {
    if (s.screen === screen) {
      if (req.body.voiceover_text !== undefined) {
        s.voiceover_text = String(req.body.voiceover_text);
        s.text = String(req.body.voiceover_text) || s.onscreen_text || s.screen;
      }
      if (req.body.visual_description !== undefined) s.visual_description = String(req.body.visual_description);
      if (req.body.onscreen_text !== undefined) s.onscreen_text = String(req.body.onscreen_text);
      if (req.body.duration !== undefined) s.duration = Number(req.body.duration) || s.duration;
      updated = s;
    }
  }
  saveJson(id, 'script.json', scenes);
  const tl = loadJson(id, 'timeline.json');
  if (tl && Array.isArray(tl.clips)) {
    for (const c of tl.clips) {
      if (c.screen === screen && req.body.voiceover_text !== undefined) {
        c.vo_text = String(req.body.voiceover_text);
        c.script_text = String(req.body.voiceover_text);
      }
    }
    tl.srt_cues = buildSrtCues(tl.clips);
    saveJson(id, 'timeline.json', tl);
  }
  const voMeta = loadJson(id, 'voiceover.json');
  res.json({ ok: true, scene: updated, scenes, voiceover: voMeta, timeline: tl });
});

async function handleSceneVoFile(id, screen, tempPath, origName, queryParams = {}) {
  const root = projectRoot(id);
  const voDir = path.join(root, 'voiceover', 'scenes');
  fs.mkdirSync(voDir, { recursive: true });
  const safeName = origName.replace(/[^a-zA-Z0-9._ ()-]/g, '_') || `${screen}.mp3`;
  const dest = path.join(voDir, `section_${screen}_${Date.now()}_${safeName}`);
  fs.copyFileSync(tempPath, dest);
  try { fs.unlinkSync(tempPath); } catch {}
  const newDur = Math.round(((await probeDuration(dest)) || 2.0) * 1000) / 1000;

  const scenes = loadJson(id, 'script.json') || [];
  let spokenText = String(queryParams.voiceover_text || '').trim();
  for (const s of scenes) {
    if (s.screen === screen) {
      if (spokenText) {
        s.voiceover_text = spokenText;
        s.voiceover_raw = spokenText;
      }
      if (queryParams.onscreen_text && String(queryParams.onscreen_text).trim()) {
        s.onscreen_text = String(queryParams.onscreen_text).trim();
      }
      const combined = [s.onscreen_text, s.voiceover_text].filter(Boolean).join(' — ').trim();
      if (combined) s.text = combined;
      s.duration = newDur;
      if (!spokenText) spokenText = s.voiceover_text || s.text || '';
    }
  }
  saveJson(id, 'script.json', scenes);

  const tl = loadJson(id, 'timeline.json');
  const voMeta = loadJson(id, 'voiceover.json') || {};
  if (tl && Array.isArray(tl.clips) && tl.clips.length) {
    let clipIdx = tl.clips.findIndex((c) => c.screen === screen && c.narration_in != null && c.narration_out != null);
    if (clipIdx < 0) clipIdx = tl.clips.findIndex((c) => c.screen === screen);
    if (clipIdx >= 0) {
      const clip = tl.clips[clipIdx];
      const oldIn = clip.narration_in != null ? Number(clip.narration_in) : Number(clip.start || 0);
      const oldOut = clip.narration_out != null ? Number(clip.narration_out) : (Number(clip.start || 0) + Number(clip.duration || 2.0));
      const oldSpokenDur = Math.max(0.1, oldOut - oldIn);
      const deltaNarr = Math.round((newDur - oldSpokenDur) * 1000) / 1000;

      // Splice new scene audio into master narration file so both preview player and export hear the new recording
      const masterVo = tl.voiceover_path || voMeta.path;
      if (masterVo && fs.existsSync(masterVo)) {
        try {
          const totalVoDur = Number((await probeDuration(masterVo)) || voMeta.duration || oldOut);
          const splicedPath = path.join(root, 'voiceover', `narration_spliced_${Date.now()}.mp3`);
          const filterParts = [];
          const concatLbls = [];
          if (oldIn > 0.05) {
            filterParts.push(`[0:a]atrim=0:${oldIn.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[head]`);
            concatLbls.push('[head]');
          }
          filterParts.push(`[1:a]asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[mid]`);
          concatLbls.push('[mid]');
          if (oldOut < totalVoDur - 0.05) {
            filterParts.push(`[0:a]atrim=${oldOut.toFixed(3)}:${totalVoDur.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[tail]`);
            concatLbls.push('[tail]');
          }
          filterParts.push(`${concatLbls.join('')}concat=n=${concatLbls.length}:v=0:a=1[aout]`);
          await execFileAsync(FFMPEG_BIN, [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', masterVo, '-i', dest,
            '-filter_complex', filterParts.join(';'),
            '-map', '[aout]', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k',
            splicedPath,
          ], EXEC_OPTS);
          if (fs.existsSync(splicedPath) && fs.statSync(splicedPath).size > 256) {
            const newTotalVo = Number((await probeDuration(splicedPath)) || (totalVoDur + deltaNarr));
            tl.voiceover_path = splicedPath;
            voMeta.path = splicedPath;
            voMeta.duration = Math.round(newTotalVo * 1000) / 1000;
            saveJson(id, 'voiceover.json', voMeta);
          }
        } catch (err) {
          console.error('Scene VO splice error:', err);
        }
      }

      const oldClipDur = Number(clip.end || 0) - Number(clip.start || 0);
      const extraHold = Math.max(0, oldClipDur - oldSpokenDur);
      const newClipDur = Math.max(0.4, Math.round((newDur + extraHold) * 1000) / 1000);
      const deltaTl = Math.round((newClipDur - oldClipDur) * 1000) / 1000;

      clip.narration_in = Math.round(oldIn * 1000) / 1000;
      clip.narration_out = Math.round((oldIn + newDur) * 1000) / 1000;
      clip.end = Math.round((Number(clip.start || 0) + newClipDur) * 1000) / 1000;
      clip.duration = newClipDur;
      clip.custom_vo_path = dest;
      clip.custom_vo_filename = origName;
      clip.custom_vo_duration = newDur;
      if (spokenText) {
        clip.vo_text = spokenText;
        clip.caption_text = spokenText;
        clip.script_text = spokenText;
      }

      for (let j = clipIdx + 1; j < tl.clips.length; j++) {
        const nxt = tl.clips[j];
        nxt.start = Math.round((Number(nxt.start || 0) + deltaTl) * 1000) / 1000;
        nxt.end = Math.round((Number(nxt.end || 0) + deltaTl) * 1000) / 1000;
        if (nxt.narration_in != null && Number(nxt.narration_in) >= oldOut - 0.08) {
          nxt.narration_in = Math.round((Number(nxt.narration_in) + deltaNarr) * 1000) / 1000;
        }
        if (nxt.narration_out != null && Number(nxt.narration_out) >= oldOut - 0.08) {
          nxt.narration_out = Math.round((Number(nxt.narration_out) + deltaNarr) * 1000) / 1000;
        }
        if (nxt.caption_in != null) nxt.caption_in = Math.round((Number(nxt.caption_in) + deltaTl) * 1000) / 1000;
        if (nxt.caption_out != null) nxt.caption_out = Math.round((Number(nxt.caption_out) + deltaTl) * 1000) / 1000;
      }

      if (tl.has_poem && Number(tl.poem_start_time || 0) >= Number(clip.start || 0)) {
        tl.poem_start_time = Math.round((Number(tl.poem_start_time || 0) + deltaTl) * 1000) / 1000;
        tl.poem_end_time = Math.round((Number(tl.poem_end_time || 0) + deltaTl) * 1000) / 1000;
      }
      tl.total_duration = Math.round(Math.max(...tl.clips.map((c) => Number(c.end || 0))) * 1000) / 1000;
      tl.srt_cues = buildSrtCues(tl.clips, tl);
      saveJson(id, 'timeline.json', tl);
    }
  }
  return {
    ok: true,
    screen,
    filename: origName,
    duration: newDur,
    new_duration: newDur,
    spoken_text: spokenText,
    scenes,
    voiceover: voMeta,
    timeline: tl,
  };
}

app.post('/api/projects/:id/scenes/:screen/voiceover', upload.single('file'), async (req, res) => {
  try {
    const { id, screen } = req.params;
    const root = projectRoot(id);
    if (!fs.existsSync(root) || !req.file) return res.status(400).json({ detail: 'Missing scene VO file' });
    const origName = path.basename(req.file.originalname || `${screen}.mp3`);
    const payload = await handleSceneVoFile(id, screen, req.file.path, origName, req.query || {});
    res.json(payload);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// Filmora 15.6.4 .wfp & .wfpbundle builder & parser
function wfpGuid() {
  return `{${crypto.randomUUID().toUpperCase()}}`;
}
function secToTicks(sec) {
  return Math.max(0, Math.round((Number(sec) || 0) * TICKS_PER_SEC));
}
function deflateRawJson(obj) {
  const raw = Buffer.from(JSON.stringify(obj), 'utf-8');
  return zlib.deflateRawSync(raw, { level: 6 });
}
function inflateRawJson(buf) {
  try {
    return JSON.parse(zlib.inflateRawSync(buf).toString('utf-8'));
  } catch {
    try {
      return JSON.parse(zlib.inflateSync(buf).toString('utf-8'));
    } catch {
      return JSON.parse(buf.toString('utf-8'));
    }
  }
}
function fileSha1Prefix(p) {
  const h = crypto.createHash('sha1');
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
    h.update(buf.subarray(0, bytesRead));
  } catch {
    h.update(String(p));
  }
  return h.digest('hex');
}

function buildFilmoraWfpBuffer(plan, title, pathMap = {}) {
  const mapPath = (orig) => (orig && pathMap[orig]) ? pathMap[orig] : (orig || '').replace(/\\/g, '/');
  const fpsVal = 30.0;
  const totalTicks = secToTicks(plan.total_duration || 10);
  const tlUuid = wfpGuid();
  const rootFolderId = wfpGuid();
  const mainFolderId = wfpGuid();

  const mediaItems = [];
  const seenPaths = new Map();
  const registerMedia = (filePath, kind, durSec) => {
    if (!filePath) return null;
    const mapped = mapPath(filePath);
    if (seenPaths.has(mapped)) return seenPaths.get(mapped);
    const mid = wfpGuid();
    const mtype = kind === 'video' ? 1 : kind === 'image' ? 2 : 3;
    const ticks = secToTicks(Math.max(1, durSec || 5));
    const entry = {
      id: mid,
      type: mtype,
      path: mapped,
      title: path.basename(filePath),
      parent_id: rootFolderId,
      media_source_info: {
        type: mtype,
        file_path: mapped,
        duration: ticks,
        video_info: mtype !== 3 ? { width: 1920, height: 1080, frame_rate: fpsVal, duration: ticks } : undefined,
        audio_info: mtype !== 2 ? { sample_rate: 44100, channels: 2, duration: ticks } : undefined,
      },
      extra: JSON.stringify({ dgs_path: mapped, dgs_kind: kind }),
    };
    mediaItems.push(entry);
    seenPaths.set(mapped, entry);
    return entry;
  };

  const videoClips = [];
  for (const c of plan.clips || []) {
    if (!c.media_path) continue;
    const m = registerMedia(c.media_path, c.kind, c.duration);
    const startTicks = secToTicks(c.start);
    const durTicks = Math.max(TICKS_PER_SEC / 10, secToTicks(c.duration));
    const trimStart = c.kind === 'image' ? IMAGE_BASE_OFFSET_TICKS : secToTicks(c.source_in || 0);
    videoClips.push({
      id: wfpGuid(),
      title: path.basename(c.media_path),
      type: c.kind === 'video' ? 1 : 2,
      media_id: m ? m.id : '',
      source_file: mapPath(c.media_path),
      timeline_range: { start: startTicks, duration: durTicks },
      trim_range: { start: trimStart, duration: durTicks },
      enable: true,
      speed: 10000,
      extra: JSON.stringify({
        screen: c.screen,
        vo_text: c.vo_text || '',
        script_text: c.script_text || '',
        narration_in: c.narration_in,
        narration_out: c.narration_out,
      }),
    });
  }

  const audioClips = [];
  if (plan.voiceover_path) {
    const voM = registerMedia(plan.voiceover_path, 'audio', plan.total_duration);
    const voTicks = secToTicks(plan.total_duration || 10);
    audioClips.push({
      id: wfpGuid(),
      title: path.basename(plan.voiceover_path),
      type: 3,
      media_id: voM ? voM.id : '',
      source_file: mapPath(plan.voiceover_path),
      timeline_range: { start: 0, duration: voTicks },
      trim_range: { start: 0, duration: voTicks },
      enable: true,
      speed: 10000,
    });
  }

  const timelineObj = {
    version: '15.6.4',
    title: title || 'DGS Auto Editor Project',
    duration: totalTicks,
    frame_rate: fpsVal,
    ratio: { width: 1920, height: 1080 },
    tracks: [
      { id: wfpGuid(), type: 1, index: 0, clips: videoClips },
      { id: wfpGuid(), type: 2, index: 0, clips: audioClips },
    ],
    dgs_plan_snapshot: {
      total_duration: plan.total_duration,
      clips: (plan.clips || []).map((c) => ({
        ...c,
        media_path: mapPath(c.media_path),
      })),
      voiceover_path: mapPath(plan.voiceover_path),
      logo_path: mapPath(plan.logo_path),
      logo_enabled: plan.logo_enabled,
      srt_cues: plan.srt_cues || [],
    },
  };

  const projectMediaObj = {
    version: '15.6.4',
    folders: [
      { id: rootFolderId, title: 'Root', parent_id: '' },
      { id: mainFolderId, title: 'Project Media', parent_id: rootFolderId },
    ],
    medias: mediaItems,
    timelines: [{ id: tlUuid, path: 'Timelines/timeline.json', title: title || 'Main Timeline' }],
  };

  const projectInfoObj = {
    version: '15.6.4',
    product: 'Wondershare Filmora',
    product_version: '15.6.4.16958',
    project_id: plan.project_id,
    title: title || 'DGS Project',
    ratio: '16:9',
    resolution: { width: 1920, height: 1080 },
    frame_rate: fpsVal,
    duration: totalTicks,
  };

  const zip = new AdmZip();
  zip.addFile('PROJECTINFO', Buffer.from('Wondershare Filmora Project File\nVersion=15.6.4\n', 'utf-8'));
  zip.addFile('project_info.json', deflateRawJson(projectInfoObj));
  zip.addFile('Medias/project_media.json', deflateRawJson(projectMediaObj));
  zip.addFile('Timelines/timeline.json', deflateRawJson(timelineObj));
  return zip.toBuffer();
}

function generateProjectFileOnDisk(pid, rawTitle, fmt) {
  const plan = loadJson(pid, 'timeline.json') || {
    project_id: pid,
    total_duration: 10,
    clips: [],
  };
  const safeTitle = String(rawTitle || `Project_${pid}`).trim().replace(/[^a-zA-Z0-9._ ()-]/g, '_') || `Project_${pid}`;
  const outDir = path.join(EXPORTS_DIR, pid);
  fs.mkdirSync(outDir, { recursive: true });

  let filename = `${safeTitle}.${fmt}`;
  let outPath = path.join(outDir, filename);

  if (fmt === 'wfp') {
    const buf = buildFilmoraWfpBuffer(plan, rawTitle, {});
    fs.writeFileSync(outPath, buf);
  } else if (fmt === 'wfpbundle') {
    const bundleZip = new AdmZip();
    const pathMap = {};
    const resourceItems = [];
    const allPaths = new Set();
    for (const c of plan.clips || []) {
      if (c.media_path && fs.existsSync(c.media_path)) allPaths.add(c.media_path);
    }
    if (plan.voiceover_path && fs.existsSync(plan.voiceover_path)) allPaths.add(plan.voiceover_path);
    if (plan.logo_path && fs.existsSync(plan.logo_path)) allPaths.add(plan.logo_path);

    for (const orig of allPaths) {
      const ext = path.extname(orig);
      const sha = fileSha1Prefix(orig);
      const guidFolder = wfpGuid();
      const baseName = path.basename(orig);
      const rel = `Medias/${guidFolder}/${baseName}`;
      pathMap[orig] = rel;
      bundleZip.addLocalFile(orig, `Medias/${guidFolder}`, baseName);
      bundleZip.addLocalFile(orig, 'Resources', `${sha}_1${ext}`);
      resourceItems.push({ original_path: orig.replace(/\\/g, '/'), bundle_path: rel, sha1: sha });
    }
    const innerWfp = buildFilmoraWfpBuffer(plan, rawTitle, pathMap);
    bundleZip.addFile(`${safeTitle}.wfp`, innerWfp);
    bundleZip.addFile('project.wfp', innerWfp);
    bundleZip.addFile('resource.json', deflateRawJson({ version: '15.6.4', resources: resourceItems }));
    bundleZip.writeZip(outPath);
  } else if (fmt === 'fcpxml') {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.9"><project name="${safeTitle}"/></fcpxml>\n`;
    fs.writeFileSync(outPath, xml, 'utf-8');
  } else if (fmt === 'edl') {
    const edl = `TITLE: ${safeTitle}\nFCM: NON-DROP FRAME\n`;
    fs.writeFileSync(outPath, edl, 'utf-8');
  } else {
    filename = `${safeTitle}.json`;
    outPath = path.join(outDir, filename);
    fs.writeFileSync(outPath, JSON.stringify(plan, null, 2), 'utf-8');
  }

  saveJson(pid, 'last_project_file.json', { path: outPath, filename, format: fmt });
  return { outPath, filename, fmt };
}

app.get('/api/projects/:id/project-file', (req, res) => {
  try {
    const pid = req.params.id;
    if (!fs.existsSync(projectRoot(pid))) return res.status(404).json({ detail: 'Project not found' });
    const fmt = String(req.query.ext || req.query.format || 'wfp').toLowerCase();
    const rawTitle = String(req.query.title || `Project_${pid}`).trim();
    const { outPath, filename } = generateProjectFileOnDisk(pid, rawTitle, fmt);
    res.download(path.resolve(outPath), filename);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

app.post('/api/projects/:id/project-file', (req, res) => {
  try {
    const pid = req.params.id;
    if (!fs.existsSync(projectRoot(pid))) return res.status(404).json({ detail: 'Project not found' });
    const fmt = String(req.body?.format || req.query?.ext || 'wfp').toLowerCase();
    const rawTitle = String(req.body?.title || req.query?.title || `Project_${pid}`).trim();
    const { outPath, filename } = generateProjectFileOnDisk(pid, rawTitle, fmt);
    res.json({
      filename,
      path: outPath,
      saved_to: outPath,
      download: `/api/projects/${pid}/project-file/download`,
    });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

app.post('/api/projects/:id/save-wfp-to', (req, res) => {
  try {
    const pid = req.params.id;
    if (!fs.existsSync(projectRoot(pid))) return res.status(404).json({ detail: 'Project not found' });
    const rawTitle = String(req.query.title || req.body?.title || `Project_${pid}`).trim();
    const { outPath, filename } = generateProjectFileOnDisk(pid, rawTitle, 'wfp');
    res.json({
      ok: true,
      cancelled: false,
      filename,
      saved_to: outPath,
      download_url: `/api/projects/${pid}/project-file?title=${encodeURIComponent(rawTitle)}&ext=wfp`,
    });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

app.get('/api/projects/:id/project-file/download', (req, res) => {
  const meta = loadJson(req.params.id, 'last_project_file.json');
  if (!meta || !meta.path || !fs.existsSync(meta.path)) return res.status(404).send('Project file not found');
  res.download(path.resolve(meta.path), meta.filename);
});

// Collect & Pack portable ZIP + .wfpbundle
app.get('/api/projects/:id/collect/status', (req, res) => {
  res.json(collectStatus[req.params.id] || { running: false, percent: 0, message: '' });
});

app.post('/api/projects/:id/collect', async (req, res) => {
  const pid = req.params.id;
  const plan = loadJson(pid, 'timeline.json') || {
    project_id: pid,
    total_duration: 10,
    clips: [],
  };
  const mode = String(req.body?.mode || req.query?.mode || 'wfpbundle').toLowerCase();
  const rawTitle = String(req.body?.title || req.query?.title || `Project_${pid}`).trim();
  const safeTitle = rawTitle.replace(/[^a-zA-Z0-9._ ()-]/g, '_') || `Project_${pid}`;

  collectStatus[pid] = { running: true, percent: 15, message: 'Packing Filmora 15 .wfpbundle & media…' };
  try {
    const outDir = path.join(EXPORTS_DIR, pid);
    fs.mkdirSync(outDir, { recursive: true });
    const extSuffix = mode === 'wfpbundle' ? 'wfpbundle' : 'zip';
    const bundleFilename = mode === 'wfpbundle' ? `${safeTitle}.wfpbundle` : `${safeTitle}_Collected.zip`;
    const bundlePath = path.join(outDir, bundleFilename);
    const standaloneWfpPath = path.join(outDir, `${safeTitle}.wfp`);

    const bundleZip = new AdmZip();
    const pathMap = {};
    const resourceItems = [];
    const allPaths = new Set();
    for (const c of plan.clips || []) {
      if (c.media_path && fs.existsSync(c.media_path)) allPaths.add(c.media_path);
    }
    const mediaList = loadJson(pid, 'media.json') || [];
    for (const m of mediaList) {
      if (m.path && fs.existsSync(m.path)) allPaths.add(m.path);
    }
    if (plan.voiceover_path && fs.existsSync(plan.voiceover_path)) allPaths.add(plan.voiceover_path);
    if (plan.logo_path && fs.existsSync(plan.logo_path)) allPaths.add(plan.logo_path);

    let idx = 0;
    const total = Math.max(1, allPaths.size);
    for (const orig of allPaths) {
      idx++;
      collectStatus[pid] = {
        running: true,
        percent: 15 + Math.round((idx / total) * 70),
        message: `Archiving ${path.basename(orig)} (${idx}/${total})…`,
      };
      const ext = path.extname(orig);
      const sha = fileSha1Prefix(orig);
      const guidFolder = wfpGuid();
      const baseName = path.basename(orig);
      const rel = `Medias/${guidFolder}/${baseName}`;
      pathMap[orig] = rel;
      bundleZip.addLocalFile(orig, `Medias/${guidFolder}`, baseName);
      bundleZip.addLocalFile(orig, 'Resources', `${sha}_1${ext}`);
      resourceItems.push({ original_path: orig.replace(/\\/g, '/'), bundle_path: rel, sha1: sha });
    }
    const innerWfp = buildFilmoraWfpBuffer(plan, rawTitle, pathMap);
    fs.writeFileSync(standaloneWfpPath, innerWfp);
    bundleZip.addFile(`${safeTitle}.wfp`, innerWfp);
    bundleZip.addFile('project.wfp', innerWfp);
    bundleZip.addFile('resource.json', deflateRawJson({ version: '15.6.4', resources: resourceItems }));
    bundleZip.writeZip(bundlePath);

    const sizeMb = Math.round((fs.statSync(bundlePath).size / (1024 * 1024)) * 100) / 100;
    const dlEndpoint = `/api/projects/${pid}/collect/download?kind=${extSuffix}`;
    const payload = {
      ok: true,
      mode,
      filename: bundleFilename,
      path: bundlePath,
      bundle_path: bundlePath,
      zip_path: bundlePath,
      folder_path: outDir,
      wfp_path: standaloneWfpPath,
      file_count: allPaths.size + 1,
      saved_to: bundlePath,
      wfpbundle_saved_to: bundlePath,
      size_mb: sizeMb,
      download: dlEndpoint,
      download_url: dlEndpoint,
      wfpbundle_download: dlEndpoint,
    };
    saveJson(pid, 'last_collect.json', payload);
    collectStatus[pid] = { running: false, percent: 100, message: 'Bundle ready!', ...payload };
    res.json(payload);
  } catch (e) {
    collectStatus[pid] = { running: false, percent: 0, message: String(e) };
    res.status(500).json({ detail: String(e) });
  }
});

app.get('/api/projects/:id/collect/download', (req, res) => {
  const meta = loadJson(req.params.id, 'last_collect.json');
  if (!meta || !meta.path || !fs.existsSync(meta.path)) return res.status(404).send('Bundle not found');
  res.download(path.resolve(meta.path), meta.filename);
});

async function handleOpenProjectFile(tempPath, origName) {
  const ext = path.extname(origName).toLowerCase();
  const pid = createProject();
  const root = projectRoot(pid);
  const projTitle = path.parse(origName).name.replace(/\.(wfpbundle|wfp|dgsproj)$/i, '') || `Project ${pid}`;

  if (ext === '.json' || ext === '.dgsproj') {
    const plan = JSON.parse(fs.readFileSync(tempPath, 'utf-8'));
    try { fs.unlinkSync(tempPath); } catch {}
    plan.project_id = pid;
    saveJson(pid, 'timeline.json', plan);
    saveJson(pid, 'last_export.json', { title: projTitle });
    return {
      project_id: pid,
      title: projTitle,
      scenes: [],
      poem: { has_poem: false },
      media: [],
      voiceover: null,
      poem_voiceover: null,
      logo: null,
      timeline: plan,
    };
  }

  // Extract .wfpbundle, .wfp, or .zip
  const outerZip = new AdmZip(tempPath);
  try { fs.unlinkSync(tempPath); } catch {}
  const entries = outerZip.getEntries();
  const entryMap = new Map(entries.map((e) => [e.entryName.replace(/\\/g, '/'), e]));

  // Extract both Medias/{GUID}/* and Resources/* into project media folders
  const extractedMap = {};
  const extractedByBase = {};
  for (const e of entries) {
    if (e.isDirectory) continue;
    const norm = e.entryName.replace(/\\/g, '/');
    if (
      (norm.startsWith('Resources/') || norm.startsWith('Medias/')) &&
      norm !== 'Medias/project_media.json'
    ) {
      const base = path.basename(norm);
      const fext = path.extname(base).toLowerCase();
      if (!IMAGE_EXT.has(fext) && !VIDEO_EXT.has(fext) && !AUDIO_EXT.has(fext)) continue;
      let targetDir = path.join(root, 'media', 'images');
      if (VIDEO_EXT.has(fext)) targetDir = path.join(root, 'media', 'videos');
      else if (AUDIO_EXT.has(fext)) targetDir = path.join(root, 'voiceover');
      fs.mkdirSync(targetDir, { recursive: true });
      const destFile = path.join(targetDir, base);
      fs.writeFileSync(destFile, e.getData());
      extractedMap[norm] = destFile;
      extractedByBase[base] = destFile;
    }
  }

  let wfpZip = outerZip;
  const innerWfpEntry = entries.find((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.wfp'));
  if (innerWfpEntry) {
    wfpZip = new AdmZip(innerWfpEntry.getData());
  }
  const tlEntry = wfpZip.getEntry('Timelines/timeline.json');
  if (!tlEntry) {
    throw new Error('Invalid .wfp/.wfpbundle: missing Timelines/timeline.json');
  }
  const tlObj = inflateRawJson(tlEntry.getData());

  const mediaItems = await reindexMedia(pid);
  const mediaByPath = new Map(mediaItems.map((m) => [path.resolve(m.path), m]));
  const mediaByName = new Map(mediaItems.map((m) => [m.filename.toLowerCase(), m]));

  let clips = [];
  if (tlObj.dgs_plan_snapshot && Array.isArray(tlObj.dgs_plan_snapshot.clips)) {
    clips = tlObj.dgs_plan_snapshot.clips.map((c, idx) => {
      const normRef = String(c.media_path || '').replace(/\\/g, '/');
      const localPath = extractedMap[normRef] || extractedByBase[path.basename(normRef)] || c.media_path || '';
      const found =
        (localPath && mediaByPath.get(path.resolve(localPath))) ||
        mediaByName.get(path.basename(normRef).toLowerCase());
      return {
        ...c,
        media_id: found ? found.id : c.media_id,
        media_path: found ? found.path : localPath,
        screen: c.screen || `screen_${idx + 1}`,
      };
    });
  } else if (Array.isArray(tlObj.tracks)) {
    const vTrack = tlObj.tracks.find((t) => t.type === 1) || tlObj.tracks[0];
    let cursor = 0;
    for (let i = 0; i < (vTrack?.clips || []).length; i++) {
      const vc = vTrack.clips[i];
      const dur = (vc.timeline_range?.duration || TICKS_PER_SEC * 3) / TICKS_PER_SEC;
      const srcRel = String(vc.source_file || '').replace(/\\/g, '/');
      const localPath = extractedMap[srcRel] || extractedByBase[path.basename(srcRel)] || srcRel;
      const found =
        (localPath && mediaByPath.get(path.resolve(localPath))) ||
        mediaByName.get(path.basename(srcRel).toLowerCase());
      let extra = {};
      try { if (vc.extra) extra = JSON.parse(vc.extra); } catch {}
      clips.push({
        screen: extra.screen || `screen_${i + 1}`,
        media_id: found ? found.id : null,
        media_path: found ? found.path : localPath,
        kind: found ? found.kind : (vc.type === 1 ? 'video' : 'image'),
        start: Math.round(cursor * 1000) / 1000,
        end: Math.round((cursor + dur) * 1000) / 1000,
        duration: Math.round(dur * 1000) / 1000,
        source_in: 0,
        source_out: Math.round(dur * 1000) / 1000,
        script_text: extra.script_text || vc.title || `screen_${i + 1}`,
        vo_text: extra.vo_text || '',
        narration_in: extra.narration_in ?? null,
        narration_out: extra.narration_out ?? null,
        fit: 'hold',
      });
      cursor += dur;
    }
  }

  // Check extracted voiceover
  const voDir = path.join(root, 'voiceover');
  let voPath = null;
  let voMeta = null;
  if (fs.existsSync(voDir)) {
    const voFiles = fs.readdirSync(voDir).filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()));
    if (voFiles.length) {
      voPath = path.join(voDir, voFiles[0]);
      const voDur = (await probeDuration(voPath)) || 0;
      voMeta = {
        path: voPath,
        filename: voFiles[0],
        duration: voDur,
        kind: 'narration',
        slots: [{ slot: 1, filename: voFiles[0], path: voPath, duration: voDur, start_offset: 0, end_offset: voDur }],
      };
      saveJson(pid, 'voiceover.json', voMeta);
    }
  }

  const scenes = clips.map((c, idx) => ({
    screen: c.screen || `screen_${idx + 1}`,
    index: idx + 1,
    scene_no: idx + 1,
    section: 'story',
    visual_type: c.kind === 'video' ? 'Video' : 'Image',
    visual_direction: c.script_text || '',
    onscreen_text: '',
    voiceover_text: c.vo_text || c.script_text || '',
    text: c.vo_text || c.script_text || c.screen,
    duration: c.duration,
    is_poem: false,
  }));
  saveJson(pid, 'script.json', scenes);
  saveJson(pid, 'script_meta.json', {
    format: 'imported_wfp',
    filename: origName,
    scene_count: scenes.length,
    poem: { has_poem: false },
  });
  saveJson(pid, 'last_export.json', { title: projTitle });

  const totalDur = clips.reduce((acc, c) => Math.max(acc, c.end || 0), 0) || (voMeta?.duration || 10);
  const plan = {
    project_id: pid,
    total_duration: totalDur,
    clips,
    voiceover_path: voPath,
    voiceover_slots: voMeta?.slots || [],
    srt_cues: buildSrtCues(clips),
    qa_issues: [],
    qa_summary: `Imported ${clips.length} clips from ${origName}`,
  };
  saveJson(pid, 'timeline.json', plan);
  return {
    project_id: pid,
    title: projTitle,
    scenes,
    poem: { has_poem: false },
    media: mediaItems,
    voiceover: voMeta,
    poem_voiceover: null,
    logo: null,
    timeline: plan,
  };
}

// Open Project File (.wfpbundle, .wfp, .json)
app.post('/api/projects/open-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ detail: 'Missing project file' });
    const origName = path.basename(req.file.originalname || 'project.wfpbundle');
    const result = await handleOpenProjectFile(req.file.path, origName);
    res.json(result);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// Universal Chunked Upload Endpoint (bypasses CDN/proxy 413 payload limits & timeouts for large WAV/MP3 VO, Video & Bundle files)
async function processChunkUpload(req, res) {
  try {
    const pid = req.params.id || req.body?.project_id || req.query?.project_id || '';
    const uploadId = String(req.body?.upload_id || req.query?.upload_id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const chunkIndex = parseInt(req.body?.chunk_index ?? req.query?.chunk_index ?? '0', 10);
    const totalChunks = parseInt(req.body?.total_chunks ?? req.query?.total_chunks ?? '1', 10);
    const target = String(req.body?.target || req.query?.target || 'voiceover');
    const origName = path.basename(req.body?.filename || req.query?.filename || req.file?.originalname || 'upload.bin');

    if (!uploadId || !req.file) {
      return res.status(400).json({ detail: 'Missing upload_id or chunk file' });
    }

    const partPath = path.join(UPLOAD_TMP, `chunk_${uploadId}_${origName}`);
    const chunkData = fs.readFileSync(req.file.path);
    try { fs.unlinkSync(req.file.path); } catch {}

    if (chunkIndex === 0 && fs.existsSync(partPath)) {
      try { fs.unlinkSync(partPath); } catch {}
    }
    fs.appendFileSync(partPath, chunkData);

    if (chunkIndex < totalChunks - 1) {
      return res.json({
        ok: true,
        partial: true,
        chunk_index: chunkIndex,
        total_chunks: totalChunks,
      });
    }

    // Final chunk assembled — dispatch to target handler
    if (target === 'voiceover') {
      const slot = Math.max(1, Math.min(10, parseInt(req.body?.slot || req.query?.slot || '1', 10)));
      const meta = await handleVoiceoverFile(pid, slot, partPath, origName);
      return res.json(meta);
    }
    if (target === 'poem_voiceover') {
      const meta = await handlePoemVoFile(pid, partPath, origName);
      return res.json(meta);
    }
    if (target === 'script') {
      const meta = handleScriptFile(pid, partPath, origName);
      return res.json(meta);
    }
    if (target === 'logo') {
      const meta = handleLogoFile(pid, partPath, origName);
      return res.json(meta);
    }
    if (target === 'scene_vo') {
      const screen = String(req.body?.screen || req.query?.screen || 'screen_1');
      const meta = await handleSceneVoFile(pid, screen, partPath, origName, {
        voiceover_text: req.body?.voiceover_text || req.query?.voiceover_text,
        onscreen_text: req.body?.onscreen_text || req.query?.onscreen_text,
      });
      return res.json(meta);
    }
    if (target === 'media_images' || target === 'media_videos') {
      const kind = target === 'media_videos' ? 'videos' : 'images';
      const allowed = kind === 'images' ? IMAGE_EXT : VIDEO_EXT;
      const ext = path.extname(origName).toLowerCase();
      const destDir = path.join(projectRoot(pid), 'media', kind);
      fs.mkdirSync(destDir, { recursive: true });
      let saved = 0;
      let skipped = 0;
      if (allowed.has(ext)) {
        fs.copyFileSync(partPath, path.join(destDir, origName));
        saved = 1;
      } else {
        skipped = 1;
      }
      try { fs.unlinkSync(partPath); } catch {}
      const items = await reindexMedia(pid);
      return res.json({ count: items.length, saved, skipped, folder: kind, media: items });
    }
    if (target === 'open_file') {
      const result = await handleOpenProjectFile(partPath, origName);
      return res.json(result);
    }

    try { fs.unlinkSync(partPath); } catch {}
    return res.status(400).json({ detail: `Unknown chunk upload target: ${target}` });
  } catch (e) {
    console.error('Chunk upload error:', e);
    res.status(500).json({ detail: String(e) });
  }
}

app.post('/api/upload-chunk', upload.single('chunk'), processChunkUpload);
app.post('/api/projects/:id/upload-chunk', upload.single('chunk'), processChunkUpload);

// Serve built React frontend
const PUBLIC_DIR = path.join(ROOT, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DGS Auto Editor Cloud Server running on port ${PORT} (Data: ${DATA_DIR} | FFmpeg: ${FFMPEG_BIN})`);
});

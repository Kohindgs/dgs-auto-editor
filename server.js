process.env.UV_THREADPOOL_SIZE = '1';
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

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getProcAncestors() {
  const keep = new Set([process.pid, process.ppid]);
  try {
    let cur = process.ppid;
    for (let depth = 0; depth < 10 && cur > 1; depth++) {
      keep.add(cur);
      const st = fs.readFileSync(`/proc/${cur}/status`, 'utf-8');
      const m = st.match(/^PPid:\s*(\d+)/m);
      if (!m) break;
      cur = parseInt(m[1], 10);
    }
  } catch {}
  return keep;
}

function inspectContainerProcs() {
  if (!fs.existsSync('/proc')) return [];
  const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const list = [];
  try {
    for (const ent of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(ent)) continue;
      const pid = parseInt(ent, 10);
      try {
        const st = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
        if (myUid != null) {
          const uidM = st.match(/^Uid:\s*(\d+)/m);
          if (uidM && parseInt(uidM[1], 10) !== myUid) continue;
        }
        const nameM = st.match(/^Name:\s*(\S+)/m);
        const ppidM = st.match(/^PPid:\s*(\d+)/m);
        const thM = st.match(/^Threads:\s*(\d+)/m);
        let cmd = '';
        try {
          cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
        } catch {}
        list.push({
          pid,
          ppid: ppidM ? parseInt(ppidM[1], 10) : 0,
          name: nameM ? nameM[1] : '',
          threads: thM ? parseInt(thM[1], 10) : 1,
          cmd: cmd.slice(0, 160),
        });
      } catch {}
    }
  } catch {}
  return list;
}

// Reaps duplicate LiteSpeed/Passenger node worker processes or orphaned ffmpeg processes
// so CloudLinux LVE thread limits (NPROC) are never exhausted by idle sibling workers.
function reapExtraNodeWorkers(killFfmpegToo = false) {
  if (!fs.existsSync('/proc')) return [];
  const keep = getProcAncestors();
  const procs = inspectContainerProcs();
  const killed = [];
  for (const p of procs) {
    if (keep.has(p.pid)) continue;
    const lowName = p.name.toLowerCase();
    const lowCmd = p.cmd.toLowerCase();
    const isSiblingEditorNode = lowCmd.includes('editor.dgeniussolutions.com') && (lowName.includes('node') || lowName.includes('lsnode'));
    const isEmergencyNode = killFfmpegToo && (lowName.includes('lsnode') || lowCmd.includes('lsnode.js'));
    const isOrphanMedia = killFfmpegToo && (lowName.includes('ffmpeg') || lowName.includes('ffprobe'));
    if (isSiblingEditorNode || isEmergencyNode || isOrphanMedia) {
      try {
        process.kill(p.pid, 'SIGKILL');
        killed.push(p);
      } catch {}
    }
  }
  return killed;
}

let mediaLockChain = Promise.resolve();
function withMediaLock(fn) {
  const next = mediaLockChain.then(() => fn(), () => fn());
  mediaLockChain = next.catch(() => {});
  return next;
}

// Container-safe FFmpeg runner: serializes media subprocesses, reaps sibling workers,
// caps decoder/filtergraph/encoder threads to 1, and auto-retries on transient EAGAIN.
async function runFfmpeg(rawArgs, customOpts = {}) {
  return await withMediaLock(async () => {
    const args = ['-hide_banner', '-loglevel', 'error', '-filter_threads', '1', '-filter_complex_threads', '1'];
    for (let i = 0; i < rawArgs.length; i++) {
      const a = rawArgs[i];
      if (a === '-hide_banner') continue;
      if (a === '-loglevel') {
        i++;
        continue;
      }
      if (a === '-i') {
        args.push('-threads', '1', '-thread_type', 'slice', '-i');
      } else if (i === rawArgs.length - 1 && !String(a).startsWith('-')) {
        args.push('-threads', '1', '-thread_type', 'slice', a);
      } else {
        args.push(a);
      }
    }

    const reaped = reapExtraNodeWorkers(false);
    if (reaped.length) await sleepMs(80);

    let lastErr = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        return await execFileAsync(FFMPEG_BIN, args, { ...EXEC_OPTS, ...customOpts });
      } catch (err) {
        lastErr = err;
        const msg = String((err && err.stderr) || (err && err.message) || '');
        if (/pthread_create|Resource temporarily unavailable|EAGAIN/i.test(msg) && attempt < 5) {
          reapExtraNodeWorkers(true);
          await sleepMs(350 * attempt);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  });
}

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
  return await withMediaLock(async () => {
    const reaped = reapExtraNodeWorkers(false);
    if (reaped.length) await sleepMs(60);
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
      await execFileAsync(FFMPEG_BIN, ['-hide_banner', '-threads', '1', '-i', filePath], {
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
  });
}

async function reindexMedia(pid) {
  const root = projectRoot(pid);
  const mediaDir = path.join(root, 'media');
  const existing = loadJson(pid, 'media.json') || [];
  const byPath = new Map(existing.map((m) => [m.path, m]));
  const byNameKind = new Map(existing.map((m) => [`${m.kind}:${String(m.filename || '').toLowerCase()}`, m]));
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

  const items = [];
  const seenNameKind = new Set();
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext)) continue;
    const kind = IMAGE_EXT.has(ext) ? 'image' : 'video';
    const fname = path.basename(f);
    const nk = `${kind}:${fname.toLowerCase()}`;
    seenNameKind.add(nk);
    const prev = byPath.get(f) || byNameKind.get(nk);
    const screens = detectScreens(fname, path.basename(path.dirname(f)));
    const dur = kind === 'video' ? (prev?.duration ?? (await probeDuration(f))) : null;
    items.push({
      id: prev?.id || crypto.randomUUID(),
      filename: fname,
      path: f,
      kind,
      screen: screens[0] || null,
      screens,
      duration: dur,
      local_only: false,
    });
  }

  // Preserve any local-only metadata items registered directly from the user's browser
  for (const m of existing) {
    if (!m || !m.local_only) continue;
    const nk = `${m.kind}:${String(m.filename || '').toLowerCase()}`;
    if (seenNameKind.has(nk)) continue;
    seenNameKind.add(nk);
    const screens = Array.isArray(m.screens) && m.screens.length ? m.screens : detectScreens(m.filename);
    items.push({
      ...m,
      id: m.id || crypto.randomUUID(),
      screen: m.screen || screens[0] || null,
      screens,
      local_only: true,
    });
  }

  items.sort((a, b) => {
    const sa = Array.isArray(a.screens) && a.screens.length ? a.screens : detectScreens(a.filename);
    const sb = Array.isArray(b.screens) && b.screens.length ? b.screens : detectScreens(b.filename);
    const na = sa.length ? parseInt(sa[0].replace('screen_', ''), 10) : 999999;
    const nb = sb.length ? parseInt(sb[0].replace('screen_', ''), 10) : 999999;
    if (na !== nb) return na - nb;
    return naturalCompare(a.filename, b.filename);
  });

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
    // If a pause tag is between words inside a fill-in-the-blank prompt, keep '...' so the blank is visible
    .replace(/(\w)\s*\[\s*\d+\s*[- ]?(?:second|sec)[^\]]*pause[^\]]*\]\s*(\w)/gi, '$1 ... $2')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/^(?:\s*)(?:narrator|teacher|child|kid|speaker|voice|audio)\s*(?:\([^)]*\))?\s*:\s*/gim, '')
    .replace(/\([^)]*(?:pause|beat|sfx|music|laughter|excited|warm|soft|tone|voice|whisper|sound|chuckle|sigh|gasp)[^)]*\)/gi, ' ')
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

function isIndicScript(scenes) {
  const sample = (scenes || [])
    .slice(0, 40)
    .map((s) => String(s?.voiceover_text || s?.onscreen_text || s?.text || ''))
    .join(' ');
  const devMatches = sample.match(/[\u0900-\u097F]/g);
  return Boolean(devMatches && devMatches.length >= 12);
}

function isSpokenVo(scene, opts = {}) {
  if (!scene || isInstrumentalScene(scene)) return false;
  const text = String(scene.voiceover_text || '').trim();
  if (!text || text === '—' || text === '-' || text === '–') return false;
  const low = text.toLowerCase();
  if (low.startsWith('instrumental')) return false;
  if (low.startsWith('read exact') || low === 'read on-screen text' || low === 'read onscreen text') return false;
  // For Marathi/Indic chapters without a separate Poem VO, poem lyrics are recorded inside the narration VO
  if (opts.indic && !opts.hasPoemVo) {
    return true;
  }
  if (/suno\s*master|attached\s+poem\s+track/i.test(String(scene.voiceover_raw || ''))) return false;
  return true;
}

async function detectSilences(audioPath) {
  if (!audioPath || !fs.existsSync(audioPath)) return [];
  return await withMediaLock(async () => {
    const reaped = reapExtraNodeWorkers(false);
    if (reaped.length) await sleepMs(60);
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const { stderr } = await execFileAsync(FFMPEG_BIN, [
          '-hide_banner', '-nostats', '-loglevel', 'info',
          '-filter_threads', '1', '-filter_complex_threads', '1',
          '-threads', '1', '-i', audioPath,
          '-af', 'silencedetect=noise=-32dB:d=0.20',
          '-threads', '1', '-f', 'null', '-',
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
      } catch (err) {
        const msg = String((err && err.stderr) || (err && err.message) || '');
        if (/pthread_create|Resource temporarily unavailable|EAGAIN/i.test(msg) && attempt < 4) {
          reapExtraNodeWorkers(true);
          await sleepMs(300 * attempt);
          continue;
        }
        return [];
      }
    }
    return [];
  });
}

// Globally optimal monotonic dynamic programming alignment of scenes to acoustic silence boundaries
function alignScenesWithGlobalDP(segScenes, speechWeights, segStart, segEnd, silences, indic) {
  const result = new Map();
  const M = segScenes.length;
  const segDur = Math.max(0.5, segEnd - segStart);
  if (!M) return result;
  if (M === 1) {
    result.set(segScenes[0].screen, [
      Math.round(segStart * 1000) / 1000,
      Math.round(segEnd * 1000) / 1000,
    ]);
    return result;
  }

  const rawW = segScenes.map((s) => Math.max(0.8, Number(speechWeights.get(s.screen) || 2.0)));
  const sumW = rawW.reduce((a, b) => a + b, 0) || 1;
  const expDurs = rawW.map((w) => (w / sumW) * segDur);

  // Filter silence cuts strictly inside (segStart + 0.35, segEnd - 0.35)
  const cuts = [{ t: segStart, dur: 1.0 }];
  for (const pair of silences || []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const ss = Number(pair[0]);
    const se = Number(pair[1]);
    if (!(se > ss)) continue;
    const cutT = Math.max(ss + 0.12, se - 0.12);
    if (cutT > segStart + 0.38 && cutT < segEnd - 0.38) {
      if (cutT - cuts[cuts.length - 1].t >= 0.22) {
        cuts.push({ t: cutT, dur: se - ss });
      }
    }
  }
  cuts.push({ t: segEnd, dur: 1.0 });

  const K = cuts.length;
  // Use Global DP when enough silence candidates exist
  if (K >= M + 1) {
    const dp = Array.from({ length: M + 1 }, () => new Float64Array(K).fill(1e12));
    const parent = Array.from({ length: M + 1 }, () => new Int32Array(K).fill(-1));
    dp[0][0] = 0;

    let cumExp = segStart;
    const maxDrift = Math.max(16, segDur * 0.18);
    for (let i = 1; i <= M; i++) {
      const d = expDurs[i - 1];
      cumExp += d;
      for (let k = i; k < K; k++) {
        if (i === M && k !== K - 1) continue;
        if (i < M && k === K - 1) continue;
        if (Math.abs(cuts[k].t - cumExp) > maxDrift) continue;
        const pauseBonus = Math.min(0.55, cuts[k].dur * (indic ? 1.1 : 0.9));
        for (let p = i - 1; p < k; p++) {
          if (dp[i - 1][p] >= 1e11) continue;
          const actual = cuts[k].t - cuts[p].t;
          if (actual < 0.60 || actual > Math.max(d * 2.7 + 2.5, 14)) continue;
          const relErr = (actual - d) / Math.max(1.0, Math.sqrt(d));
          const cost = dp[i - 1][p] + relErr * relErr - pauseBonus;
          if (cost < dp[i][k]) {
            dp[i][k] = cost;
            parent[i][k] = p;
          }
        }
      }
    }

    if (dp[M][K - 1] < 1e11) {
      const chosen = new Array(M + 1);
      let curK = K - 1;
      let ok = true;
      for (let i = M; i >= 0; i--) {
        if (curK < 0) { ok = false; break; }
        chosen[i] = cuts[curK].t;
        curK = parent[i][curK];
      }
      if (ok) {
        for (let i = 0; i < M; i++) {
          result.set(segScenes[i].screen, [
            Math.round(chosen[i] * 1000) / 1000,
            Math.round(chosen[i + 1] * 1000) / 1000,
          ]);
        }
        return result;
      }
    }
  }

  // Fallback: proportional step with local silence snapping
  let cursor = segStart;
  let remW = sumW;
  for (let i = 0; i < M; i++) {
    const s = segScenes[i];
    const w = rawW[i];
    const isLast = i === M - 1;
    const remVo = Math.max(0.4, segEnd - cursor);
    const expDur = isLast ? remVo : Math.max(0.65, (w / Math.max(0.1, remW)) * remVo);
    let targetEnd = isLast ? segEnd : cursor + expDur;
    if (!isLast && cuts.length > 2) {
      let bestCut = null;
      let bestScore = -999;
      const win = Math.max(1.5, expDur * 0.4);
      for (let cIdx = 1; cIdx < cuts.length - 1; cIdx++) {
        const c = cuts[cIdx];
        const dist = Math.abs(c.t - targetEnd);
        if (dist <= win && c.t > cursor + 0.55) {
          const score = Math.min(0.45, c.dur * 0.85) - dist;
          if (score > bestScore) {
            bestScore = score;
            bestCut = c.t;
          }
        }
      }
      if (bestCut != null) targetEnd = bestCut;
    }
    result.set(s.screen, [
      Math.round(cursor * 1000) / 1000,
      Math.round(targetEnd * 1000) / 1000,
    ]);
    cursor = targetEnd;
    remW = Math.max(0.1, remW - w);
  }
  return result;
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
    const sameScreen = Boolean(clip.screen && prev.screen && normScreenId(clip.screen) === normScreenId(prev.screen));
    const contiguous = Math.abs(Number(clip.start) - Number(prev.end)) < 0.05;
    if (sameMedia && sameScreen && contiguous) {
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
    // If two adjacent scenes share the same multi-scene video, advance source_in so the video plays continuously across scenes
    if (sameMedia && !sameScreen && contiguous && clip.kind === 'video') {
      const prevOut = Number(prev.source_out || prev.duration || 0);
      clip.source_in = Math.round(prevOut * 1000) / 1000;
      clip.source_out = Math.round((prevOut + Number(clip.duration || 0)) * 1000) / 1000;
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

function readingCap(text) {
  const words = (String(text || '').match(/[\u0900-\u097F]+|[\u0600-\u06FF]+|[^\W_]+(?:'[^\W_]+)?/g) || []).length;
  const n = Math.max(1, words);
  if (/[\u0900-\u097F]/.test(String(text || ''))) {
    return Math.max(1.2, Math.min(12.0, n * 0.65 + 0.8));
  }
  return Math.max(0.8, Math.min(12.0, n * 0.38 + 0.4));
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
    end = Math.min(end, start + Math.max(readingCap(txt), end - start));
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

function getReqClient(req) {
  const clientId = String(req.headers['x-client-id'] || req.query?.client_id || req.body?.client_id || '').trim();
  const clientLabel = String(req.headers['x-client-label'] || req.query?.client_label || req.body?.client_label || '').trim();
  return { client_id: clientId || null, client_label: clientLabel || null };
}

function touchProjectClient(pid, req) {
  if (!pid || !fs.existsSync(projectRoot(pid))) return;
  const { client_id, client_label } = getReqClient(req);
  if (!client_id && !client_label) return;
  const cur = loadJson(pid, 'client_meta.json') || {};
  saveJson(pid, 'client_meta.json', {
    ...cur,
    client_id: client_id || cur.client_id || null,
    client_label: client_label || cur.client_label || null,
    updated_at: new Date().toISOString(),
  });
}

app.get('/api/projects/recent', (req, res) => {
  const { client_id: reqClientId } = getReqClient(req);
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
      const clientMeta = loadJson(pid, 'client_meta.json') || {};
      if (!scenesRaw.length && !mediaRaw.length && !voMeta.path && !(tlRaw.clips && tlRaw.clips.length)) continue;
      // Only include projects created/worked on by this individual PC (or legacy unclaimed projects)
      if (reqClientId && clientMeta.client_id && clientMeta.client_id !== reqClientId) continue;
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
        client_id: clientMeta.client_id || null,
        client_label: clientMeta.client_label || null,
        is_this_pc: Boolean(reqClientId && clientMeta.client_id === reqClientId),
      });
    }
  }
  projects.sort((a, b) => {
    if (a.is_this_pc !== b.is_this_pc) return a.is_this_pc ? -1 : 1;
    return b.mtime - a.mtime;
  });
  res.json({ projects: projects.slice(0, 20), recent_paths: [] });
});

app.post('/api/projects', (req, res) => {
  const pid = createProject();
  touchProjectClient(pid, req);
  res.json({ project_id: pid });
});

app.delete('/api/projects/:id', (req, res) => {
  const pid = String(req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!pid) return res.status(400).json({ detail: 'Invalid project id' });
  try {
    const pDir = projectRoot(pid);
    const eDir = path.join(EXPORTS_DIR, pid);
    if (fs.existsSync(pDir)) fs.rmSync(pDir, { recursive: true, force: true });
    if (fs.existsSync(eDir)) fs.rmSync(eDir, { recursive: true, force: true });
    res.json({ ok: true, deleted: pid });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

app.get('/api/projects/:id/load', (req, res) => {
  const pid = req.params.id;
  if (!fs.existsSync(projectRoot(pid))) return res.status(404).json({ detail: 'Project not found' });
  const existingClient = loadJson(pid, 'client_meta.json') || {};
  if (!existingClient.client_id) {
    touchProjectClient(pid, req);
  }
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
    touchProjectClient(pid, req);
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

// Zero-upload Local-File Mode: registers local images/videos metadata without uploading file bytes to server
app.post('/api/projects/:id/media-meta', async (req, res) => {
  try {
    const pid = req.params.id;
    touchProjectClient(pid, req);
    const root = projectRoot(pid);
    if (!fs.existsSync(root)) return res.status(404).json({ detail: 'Project not found' });
    const kind = req.body?.kind === 'videos' ? 'videos' : 'images';
    const allowed = kind === 'images' ? IMAGE_EXT : VIDEO_EXT;
    const incoming = Array.isArray(req.body?.items) ? req.body.items : [];
    const existing = loadJson(pid, 'media.json') || [];
    const byKey = new Map(existing.map((m) => [`${m.kind}:${String(m.filename || '').toLowerCase()}`, m]));
    let saved = 0;
    let skipped = 0;
    for (const raw of incoming) {
      const origName = path.basename(String(raw?.filename || ''));
      const ext = path.extname(origName).toLowerCase();
      if (!origName || !allowed.has(ext)) {
        skipped++;
        continue;
      }
      const itemKind = IMAGE_EXT.has(ext) ? 'image' : 'video';
      const nk = `${itemKind}:${origName.toLowerCase()}`;
      const prev = byKey.get(nk);
      const screens = detectScreens(origName, String(raw?.folder || ''));
      const localPath = String(raw?.local_path || '').trim() || path.join(root, 'media', kind, origName);
      byKey.set(nk, {
        id: prev?.id || crypto.randomUUID(),
        filename: origName,
        path: localPath,
        kind: itemKind,
        screen: screens[0] || null,
        screens,
        duration: itemKind === 'video' ? (Number(raw?.duration) || prev?.duration || 5.0) : null,
        size: Number(raw?.size || 0),
        local_only: true,
      });
      saved++;
    }
    saveJson(pid, 'media.json', Array.from(byKey.values()));
    const items = await reindexMedia(pid);
    res.json({ count: items.length, saved, skipped, folder: kind, media: items });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// Purge temporary physical media/VO/export files on server after render to keep server storage at 0 MB
app.delete('/api/projects/:id/purge-server-media', (req, res) => {
  try {
    const pid = req.params.id;
    const root = projectRoot(pid);
    for (const sub of ['media/images', 'media/videos', 'voiceover', 'logo']) {
      const d = path.join(root, sub);
      if (fs.existsSync(d)) {
        fs.rmSync(d, { recursive: true, force: true });
        fs.mkdirSync(d, { recursive: true });
      }
    }
    const expDir = path.join(EXPORTS_DIR, pid);
    if (fs.existsSync(expDir)) {
      fs.rmSync(expDir, { recursive: true, force: true });
    }
    res.json({ ok: true });
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
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.resolve(item.path));
});

app.get('/api/projects/:id/media-thumb/:mediaId', async (req, res) => {
  const { id, mediaId } = req.params;
  const items = loadJson(id, 'media.json') || [];
  const item = items.find((m) => m.id === mediaId);
  if (!item || !item.path || !fs.existsSync(item.path)) {
    return res.status(404).json({ detail: 'Media not found' });
  }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  if (item.kind === 'image') {
    return res.sendFile(path.resolve(item.path));
  }
  const thumbDir = path.join(projectRoot(id), 'meta', 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });
  const thumbFile = path.join(thumbDir, `${mediaId}.jpg`);
  if (!fs.existsSync(thumbFile)) {
    try {
      await runFfmpeg([
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
    await runFfmpeg([
      '-y', '-i', srcPath,
      '-vn', '-ar', '44100', '-ac', '2',
      '-c:a', 'libmp3lame', '-b:a', '192k',
      normPath,
    ]);
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
    await runFfmpeg([
      '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', '0.5',
      '-c:a', 'libmp3lame', '-b:a', '192k',
      gapPath,
    ]);
    if (fs.existsSync(gapPath)) return gapPath;
  } catch {}
  return null;
}

async function rebuildMergedVo(pid, slots) {
  const root = projectRoot(pid);
  const voDir = path.join(root, 'voiceover');
  fs.mkdirSync(voDir, { recursive: true });
  const active = slots
    .filter((s) => s && s.path && (fs.existsSync(s.path) || s.local_only))
    .sort((a, b) => Number(a.slot) - Number(b.slot));

  if (!active.length) {
    const empty = { path: null, filename: '', duration: 0, kind: 'narration', slots: [], silences: [] };
    saveJson(pid, 'voiceover.json', empty);
    return empty;
  }

  // If any slots are local-only (registered from browser without uploading audio bytes), compute merged offsets & silences in pure JS
  if (active.some((s) => s.local_only || !fs.existsSync(s.path))) {
    let offset = 0;
    const gapSec = 0.5;
    const mergedSilences = [];
    for (let i = 0; i < active.length; i++) {
      const s = active[i];
      const dur = Number(s.duration || 0);
      s.start_offset = Math.round(offset * 1000) / 1000;
      s.end_offset = Math.round((offset + dur) * 1000) / 1000;
      for (const pair of s.silences || []) {
        if (Array.isArray(pair) && pair.length >= 2) {
          mergedSilences.push([
            Math.round((s.start_offset + Number(pair[0])) * 1000) / 1000,
            Math.round((s.start_offset + Number(pair[1])) * 1000) / 1000,
          ]);
        }
      }
      offset += dur;
      if (i < active.length - 1) {
        mergedSilences.push([
          Math.round((offset - 0.02) * 1000) / 1000,
          Math.round((offset + gapSec + 0.02) * 1000) / 1000,
        ]);
        offset += gapSec;
      }
    }
    const totalDur = Math.round(offset * 1000) / 1000;
    const label = active.length === 1 ? active[0].filename : active.map((s) => `VO${s.slot} (${s.filename})`).join(' + ');
    const meta = {
      path: active[0].path,
      filename: label,
      duration: totalDur,
      kind: 'narration',
      slots: active,
      silences: mergedSilences,
      local_only: true,
    };
    saveJson(pid, 'voiceover.json', meta);
    return meta;
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
      await runFfmpeg([
        '-y', '-f', 'concat', '-safe', '0',
        '-i', concatListPath,
        '-c', 'copy',
        mergedPath,
      ]);
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
      await runFfmpeg([
        '-y', ...inputs,
        '-filter_complex', filterParts.join(';'),
        '-map', '[aout]',
        '-vn', '-c:a', 'libmp3lame', '-b:a', '192k',
        mergedPath,
      ]);
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
  const sm = loadJson(pid, 'script_meta.json');
  if (sm && sm.imported_bundle) {
    sm.imported_bundle = false;
    saveJson(pid, 'script_meta.json', sm);
  }
  return await rebuildMergedVo(pid, slots);
}

app.post('/api/projects/:id/voiceover', upload.single('file'), async (req, res) => {
  try {
    const pid = req.params.id;
    touchProjectClient(pid, req);
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

// Zero-upload Local-File Mode: registers VO slot duration & acoustic silence boundaries computed in browser
app.post('/api/projects/:id/voiceover-meta', async (req, res) => {
  try {
    const pid = req.params.id;
    touchProjectClient(pid, req);
    const root = projectRoot(pid);
    if (!fs.existsSync(root)) return res.status(404).json({ detail: 'Project not found' });
    const slot = Math.max(1, Math.min(10, parseInt(req.query.slot || req.body?.slot || '1', 10)));
    const origName = path.basename(String(req.body?.filename || `vo_${slot}.mp3`));
    const duration = Math.max(0.1, Number(req.body?.duration || 0));
    const silences = Array.isArray(req.body?.silences) ? req.body.silences : [];
    const localPath = String(req.body?.local_path || '').trim() || path.join(root, 'voiceover', `slot_${slot}_${origName}`);

    const existing = loadJson(pid, 'voiceover.json') || {};
    let slots = Array.isArray(existing.slots) ? [...existing.slots] : [];
    slots = slots.filter((s) => Number(s.slot) !== slot);
    slots.push({
      slot,
      filename: origName,
      path: localPath,
      duration: Math.round(duration * 1000) / 1000,
      silences,
      local_only: true,
    });
    const sm = loadJson(pid, 'script_meta.json');
    if (sm && sm.imported_bundle) {
      sm.imported_bundle = false;
      saveJson(pid, 'script_meta.json', sm);
    }
    const meta = await rebuildMergedVo(pid, slots);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

app.delete('/api/projects/:id/voiceover/:slot', async (req, res) => {
  try {
    const pid = req.params.id;
    const slot = parseInt(req.params.slot, 10);
    const existing = loadJson(pid, 'voiceover.json') || {};
    const slots = (existing.slots || []).filter((s) => Number(s.slot) !== slot);
    const sm = loadJson(pid, 'script_meta.json');
    if (sm && sm.imported_bundle) {
      sm.imported_bundle = false;
      saveJson(pid, 'script_meta.json', sm);
    }
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

app.post('/api/projects/:id/poem-voiceover-meta', (req, res) => {
  try {
    const pid = req.params.id;
    touchProjectClient(pid, req);
    const root = projectRoot(pid);
    if (!fs.existsSync(root)) return res.status(404).json({ detail: 'Project not found' });
    const origName = path.basename(String(req.body?.filename || 'poem.mp3'));
    const duration = Math.max(0.1, Number(req.body?.duration || 0));
    const localPath = String(req.body?.local_path || '').trim() || path.join(root, 'voiceover', `poem_${origName}`);
    const meta = {
      path: localPath,
      filename: origName,
      duration: Math.round(duration * 1000) / 1000,
      kind: 'poem',
      local_only: true,
    };
    saveJson(pid, 'poem_voiceover.json', meta);
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

app.post('/api/projects/:id/logo-meta', (req, res) => {
  try {
    const pid = req.params.id;
    touchProjectClient(pid, req);
    const root = projectRoot(pid);
    if (!fs.existsSync(root)) return res.status(404).json({ detail: 'Project not found' });
    const origName = path.basename(String(req.body?.filename || 'logo.png'));
    const localPath = String(req.body?.local_path || '').trim() || path.join(root, 'logo', origName);
    const meta = { path: localPath, filename: origName, enabled: true, local_only: true };
    saveJson(pid, 'logo.json', meta);
    const tl = loadJson(pid, 'timeline.json');
    if (tl) {
      tl.logo_path = localPath;
      tl.logo_enabled = true;
      saveJson(pid, 'timeline.json', tl);
    }
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
    touchProjectClient(pid, req);
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
    const scriptMeta = loadJson(pid, 'script_meta.json') || {};
    const existingTl = loadJson(pid, 'timeline.json');

    // If project was imported from a .wfpbundle / .wfp and neither script nor master VO was replaced,
    // preserve the bundle's exact clip timings/alignment while refreshing newly uploaded media, captions, logo, and QA!
    if (scriptMeta.imported_bundle && !req.body?.force_realign && existingTl && Array.isArray(existingTl.clips) && existingTl.clips.length) {
      const sceneMap = new Map(scenes.map((s) => [normScreenId(s.screen), s]));
      for (const c of existingTl.clips) {
        const s = sceneMap.get(normScreenId(c.screen));
        const picked = pickMediaForScreen(c.screen, media, s?.visual_direction || '');
        const primary = picked.video || picked.image || null;
        if (primary) {
          c.media_id = primary.id;
          c.media_path = primary.path;
          c.kind = primary.kind;
          c.fit = primary.kind === 'video' ? 'trim' : 'hold';
        } else {
          const matchedExisting = media.find((m) => m.id === c.media_id || m.path === c.media_path);
          if (!matchedExisting && (!c.media_path || !fs.existsSync(c.media_path))) {
            c.fit = 'missing';
          }
        }
        if (s) {
          const isInst = isInstrumentalScene(s);
          const cap = isInst ? '' : cleanCaptionText(s.onscreen_text || s.voiceover_text || c.caption_text || '');
          c.caption_text = cap;
          if (s.voiceover_text) c.vo_text = isInst ? '' : s.voiceover_text;
          if (s.text) c.script_text = s.text;
        }
      }
      existingTl.logo_path = logoMeta.path || existingTl.logo_path || null;
      existingTl.logo_enabled = logoMeta.enabled !== false && Boolean(existingTl.logo_path);
      if (voMeta.path) existingTl.voiceover_path = voMeta.path;
      if (poemVoMeta.path) existingTl.poem_voiceover_path = poemVoMeta.path;
      existingTl.srt_cues = buildSrtCues(existingTl.clips, existingTl);
      saveJson(pid, 'subtitles.srt', formatSrt(existingTl.srt_cues));

      const qaIssues = [];
      for (const c of existingTl.clips) {
        const matchedExisting = media.find((m) => m.id === c.media_id || m.path === c.media_path);
        if (c.fit === 'missing' || !c.media_path || (!matchedExisting && !fs.existsSync(c.media_path))) {
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
      existingTl.qa_issues = qaIssues;
      existingTl.qa_summary = qaIssues.length
        ? `Bundle alignment preserved · ${errCount} missing · ${warnCount} warnings · ${existingTl.clips.length} scenes`
        : `Bundle alignment preserved · no issues · ${existingTl.clips.length} scenes checked`;
      saveJson(pid, 'timeline.json', existingTl);
      saveJson(pid, 'qa.json', { summary: existingTl.qa_summary, issues: qaIssues });
      return res.json(existingTl);
    }

    // Auto-recover any slot_<N>_* VO files sitting on disk that were not yet saved into voiceover.json
    const voDirDisk = path.join(projectRoot(pid), 'voiceover');
    if (fs.existsSync(voDirDisk) && !voMeta.local_only) {
      const existingSlots = Array.isArray(voMeta.slots) ? [...voMeta.slots] : [];
      const knownSlotNums = new Set(existingSlots.map((s) => Number(s.slot)));
      let addedOrphan = false;
      for (const fname of fs.readdirSync(voDirDisk)) {
        const mSlot = fname.match(/^slot_(\d+)_(?!norm\.mp3$)(.+\.(?:mp3|wav|m4a|aac|ogg|flac))$/i);
        if (mSlot) {
          const sNum = parseInt(mSlot[1], 10);
          const origLabel = mSlot[2];
          const fullP = path.join(voDirDisk, fname);
          if (!knownSlotNums.has(sNum) && fs.statSync(fullP).size > 256) {
            const dur = (await probeDuration(fullP)) || 0;
            existingSlots.push({ slot: sNum, filename: origLabel, path: fullP, duration: dur });
            knownSlotNums.add(sNum);
            addedOrphan = true;
          }
        }
      }
      if (addedOrphan) {
        const rebuilt = await rebuildMergedVo(pid, existingSlots);
        Object.assign(voMeta, rebuilt);
      }
    }

    if (Array.isArray(req.body?.silences) && req.body.silences.length) {
      voMeta.silences = req.body.silences;
      saveJson(pid, 'voiceover.json', voMeta);
    }

    // Auto-heal voMeta.duration === 0 or missing silences if VO file exists on disk
    if (voMeta.path && fs.existsSync(voMeta.path)) {
      if (!voMeta.duration || Number(voMeta.duration) <= 0) {
        const healedDur = await probeDuration(voMeta.path);
        if (healedDur > 0) {
          voMeta.duration = healedDur;
          if (Array.isArray(voMeta.slots) && voMeta.slots.length === 1) {
            voMeta.slots[0].duration = healedDur;
            voMeta.slots[0].end_offset = Number(voMeta.slots[0].start_offset || 0) + healedDur;
          }
          saveJson(pid, 'voiceover.json', voMeta);
        }
      }
      if (!Array.isArray(voMeta.silences) || !voMeta.silences.length) {
        const detected = await detectSilences(voMeta.path);
        if (detected.length) {
          voMeta.silences = detected;
          saveJson(pid, 'voiceover.json', voMeta);
        }
      }
    }

    const voDur = Number(voMeta.duration || 0);
    const poemVoDur = Number(poemVoMeta.duration || 0);
    const hasPoemVo = Boolean((poemVoMeta.path && fs.existsSync(poemVoMeta.path)) || poemVoDur > 0);
    const indic = isIndicScript(scenes);
    const silences = Array.isArray(voMeta.silences) && voMeta.silences.length
      ? voMeta.silences
      : [];

    // Separate scenes into spoken narration vs poem/instrumental so poem scenes do not eat narration VO
    // Note: For Marathi/Indic chapters without a separate Poem VO (!hasPoemVo), poem lyrics live inside the narration VO!
    const speechScenes = scenes.filter((s) => {
      if (hasPoemVo && onPoemTrack(s)) return false;
      if (!indic && s.audio_start != null && s.audio_end != null && onPoemTrack(s)) return false;
      return isSpokenVo(s, { indic, hasPoemVo });
    });

    const speechWeights = new Map();
    let totalSpeechWeight = 0;
    for (const s of speechScenes) {
      const txt = String(s.voiceover_text || s.onscreen_text || '').trim();
      const words = txt.split(/\s+/).filter(Boolean).length;
      const devChars = (txt.match(/[\u0900-\u097F]/g) || []).length;
      const isDevanagari = devChars > 0;
      const sentBreaks = Math.max(0, (txt.match(/[.!?।]/g) || []).length - 1);
      const sents = Math.max(1, (txt.match(/[.!?।]+/g) || []).length);
      const repMatches = (txt.match(/\b([a-zA-Z]{2,})[,\s]+\1\b/gi) || []).length;
      let w;
      if (isDevanagari && voDur > 1) {
        // Pure phonetic character + word + sentence-break weight for Marathi/Hindi (ignores flat 8s Excel placeholders)
        w = Math.max(1.2, devChars * 0.105 + words * 0.22 + sentBreaks * 0.25 + 0.25);
      } else if (voDur > 1) {
        // Natural English instructional speaking duration (~0.31s/word + 0.36s/sentence + expressive sound repeat + pause bonus)
        const qPauseBonus = Math.min(2.2, questionPauseSeconds(s) * 0.45);
        w = words > 0
          ? Math.max(1.1, words * 0.31 + sents * 0.36 + repMatches * 1.1 + qPauseBonus + 0.20)
          : (Number(s.duration) || 2.0);
      } else {
        const wordEst = words > 0 ? Math.max(1.2, words * (isDevanagari ? 0.55 : 0.38) + 0.25) : (Number(s.duration) || 2.0);
        w = s.duration && Number(s.duration) > 0 ? 0.55 * wordEst + 0.45 * Number(s.duration) : wordEst;
      }
      speechWeights.set(s.screen, w);
      totalSpeechWeight += w;
    }

    // Precompute exact [narrIn, narrOut] per spoken scene using Global DP over acoustic silences.
    // Also detect if only a partial VO (e.g., VO 1 covering Story Scenes 1..37 out of 97 scenes) is uploaded so far,
    // or if multiple VO slots (VO 1, VO 2, ...) should be partitioned at section boundaries.
    const alignedSpeechMap = new Map();
    let coveredSpokenCount = speechScenes.length;

    if (voDur > 1 && speechScenes.length > 0) {
      const activeSlots = Array.isArray(voMeta.slots) && voMeta.slots.length > 1
        ? voMeta.slots.filter((sl) => Number(sl.duration || 0) > 0.5)
        : [];

      // Check if uploaded VO only covers a prefix of the script (e.g., VO 1 = 162s while full 97-scene script needs ~340s)
      if (speechScenes.length >= 8 && voDur < totalSpeechWeight * 0.72) {
        let bestCount = speechScenes.length;
        let bestDiff = Infinity;
        let cumW = 0;
        for (let k = 1; k <= speechScenes.length; k++) {
          cumW += speechWeights.get(speechScenes[k - 1].screen) || 2.0;
          const rawDiff = Math.abs(cumW - voDur);
          // Give a strong preference to major section transitions (e.g., Scene 37 Story -> Scene 38 Read and learn)
          const curSec = String(speechScenes[k - 1].section || '').split('|')[0].trim().toLowerCase();
          const nextSec = k < speechScenes.length
            ? String(speechScenes[k].section || '').split('|')[0].trim().toLowerCase()
            : '';
          const isSecBoundary = k < speechScenes.length && curSec && nextSec && curSec !== nextSec;
          const scoreDiff = isSecBoundary ? rawDiff - Math.min(18, voDur * 0.10) : rawDiff;
          if (scoreDiff < bestDiff) {
            bestDiff = scoreDiff;
            bestCount = k;
          }
        }
        coveredSpokenCount = Math.max(1, Math.min(speechScenes.length, bestCount));
      }

      const narratedScenes = speechScenes.slice(0, coveredSpokenCount);
      if (activeSlots.length > 1 && narratedScenes.length >= activeSlots.length) {
        // Partition narratedScenes across VO slots proportionally to slot durations, snapping to section boundaries
        const totalNarrW = narratedScenes.reduce((acc, s) => acc + (speechWeights.get(s.screen) || 2.0), 0) || 1;
        let startIdx = 0;
        let cumSlotDur = 0;
        for (let sIdx = 0; sIdx < activeSlots.length; sIdx++) {
          const sl = activeSlots[sIdx];
          const slStart = Number(sl.start_offset || 0);
          const slEnd = Number(sl.end_offset || (slStart + Number(sl.duration || 0)));
          cumSlotDur += Number(sl.duration || 0);
          let endIdx = narratedScenes.length;
          if (sIdx < activeSlots.length - 1) {
            const targetW = (cumSlotDur / Math.max(1, voDur)) * totalNarrW;
            let bestIdx = startIdx + 1;
            let bestScore = Infinity;
            let runW = 0;
            for (let k = 1; k <= narratedScenes.length - (activeSlots.length - 1 - sIdx); k++) {
              runW += speechWeights.get(narratedScenes[k - 1].screen) || 2.0;
              if (k <= startIdx) continue;
              const diff = Math.abs(runW - targetW);
              const curSec = String(narratedScenes[k - 1].section || '').split('|')[0].trim().toLowerCase();
              const nextSec = k < narratedScenes.length
                ? String(narratedScenes[k].section || '').split('|')[0].trim().toLowerCase()
                : '';
              const secBonus = (curSec && nextSec && curSec !== nextSec && diff < 35) ? 28 : 0;
              if (diff - secBonus < bestScore) {
                bestScore = diff - secBonus;
                bestIdx = k;
              }
            }
            endIdx = bestIdx;
          }
          const subScenes = narratedScenes.slice(startIdx, endIdx);
          const subMap = alignScenesWithGlobalDP(subScenes, speechWeights, slStart, slEnd, silences, indic);
          for (const [k, v] of subMap.entries()) alignedSpeechMap.set(k, v);
          startIdx = endIdx;
        }
      } else {
        const subMap = alignScenesWithGlobalDP(narratedScenes, speechWeights, 0, voDur, silences, indic);
        for (const [k, v] of subMap.entries()) alignedSpeechMap.set(k, v);
      }
    }

    const rawClips = [];
    let tlCursor = 0;
    let poemStartTime = 0;
    let poemEndTime = 0;
    let inPoemBlock = false;
    const anyPoemScene = scenes.some((s) => s.is_poem || onPoemTrack(s));

    // Group scenes into runs of 'poem' vs 'speech' when poem clock is active
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      const isPoemScene = (hasPoemVo || (!indic && s.audio_start != null && s.audio_end != null)) && onPoemTrack(s);
      const spoken = !isPoemScene && speechWeights.has(s.screen);
      const isInst = isInstrumentalScene(s);

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
      } else if (spoken && alignedSpeechMap.has(s.screen)) {
        const [ni, no] = alignedSpeechMap.get(s.screen);
        narrIn = ni;
        narrOut = no;
        clipDur = Math.max(0.4, narrOut - narrIn);
      } else if (spoken) {
        // Scene beyond partial VO coverage (waiting for VO 2+): use natural speaking duration
        clipDur = Math.max(1.2, speechWeights.get(s.screen) || Number(s.duration) || 2.5);
      } else {
        // Silent title / instrumental card: use script duration without advancing narrCursor
        clipDur = Math.max(0.4, Number(s.duration) || 2.0);
      }

      const dur = Math.round(clipDur * 1000) / 1000;
      const { video, image } = pickMediaForScreen(s.screen, media, s.visual_direction || s.visual_type);
      // Prefer the animated scene video over static slide image when both exist for the same scene,
      // and NEVER append a separate unaligned 10s silent "Action Video" clip that interrupts VO playback!
      const primary = video || image;
      const extraVid = null;
      const ostTxt = String(s.onscreen_text || '').trim();
      const voTxt = String(s.voiceover_text || '').trim();
      // Preserve fill-in-the-blank dots ('....') or full heading text ('For the Teacher :') from onscreen_text when present
      const preferOst = ostTxt && (/\.{3,}|_{3,}|—/.test(ostTxt) || (ostTxt.length > voTxt.length && ostTxt.toLowerCase().startsWith(voTxt.toLowerCase())));
      const capTxt = isInst ? '' : (preferOst ? ostTxt : (voTxt || ostTxt || ''));

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
          vo_text: isInst ? (s.voiceover_text || 'Instrumental.') : (s.voiceover_text || ''),
          caption_text: capTxt,
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
          vo_text: isInst ? (s.voiceover_text || 'Instrumental.') : (s.voiceover_text || ''),
          caption_text: capTxt,
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

      // End-of-line question pause hold: only insert synthetic silent holds when NO voiceover recording is present.
      // When a real VO recording is present (voDur > 1), the speaker's audio already contains the natural pauses!
      const qPause = voDur > 1 ? 0 : questionPauseSeconds(s);
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
    const partialVoNote = (voDur > 1 && coveredSpokenCount < speechScenes.length)
      ? ` · VO covers Scenes 1–${coveredSpokenCount} (add VO 2 for Scenes ${coveredSpokenCount + 1}–${speechScenes.length})`
      : '';
    const qaSummary = qaIssues.length
      ? `Align scan: ${errCount} missing · ${warnCount} warnings · ${clips.length} pictures${partialVoNote}`
      : `Align scan: no issues · ${clips.length} pictures checked${partialVoNote}`;

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

app.get('/api/health', (req, res) => {
  const reaped = reapExtraNodeWorkers(false);
  const procs = inspectContainerProcs();
  res.json({
    ok: true,
    pid: process.pid,
    ppid: process.ppid,
    reaped_count: reaped.length,
    reaped,
    proc_count: procs.length,
    total_threads: procs.reduce((acc, p) => acc + (p.threads || 1), 0),
    procs,
  });
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
  if (vcodec === 'libx264') {
    base.push('-preset', x264Preset, '-x264-params', 'threads=1:lookahead-threads=1:sync-lookahead=0:sliced-threads=1');
  } else if (vcodec === 'libx265') {
    base.push('-preset', x264Preset, '-x265-params', 'pools=none:frame-threads=1');
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

    // Use zero-thread intermediate MPEG-4 (q=2) for temp scene parts & logo pass
    const intermediateCodec = ['-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p', '-an'];

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
      const vfBase = `scale=${width}:${height}:force_original_aspect_ratio=decrease:threads=1,format=yuv420p,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`;

      if (!c.media_path || !fs.existsSync(c.media_path) || c.fit === 'missing') {
        await runFfmpeg([
          '-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=${clipDur}:r=${fps}`,
          '-t', String(clipDur), ...intermediateCodec, outPart,
        ]);
      } else if (c.kind === 'image') {
        await runFfmpeg([
          '-y', '-loop', '1', '-framerate', '1', '-i', c.media_path,
          '-t', String(clipDur), '-vf', vfBase,
          ...intermediateCodec, outPart,
        ]);
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
        await runFfmpeg([
          '-y', '-ss', String(srcIn), '-i', c.media_path,
          '-t', String(clipDur), '-vf', vfVideo,
          ...intermediateCodec, outPart,
        ]);
      }
      partFiles.push(outPart);
    }

    exportStatus[pid] = { running: true, percent: 76, message: 'Stitching video scenes…' };
    const concatTxt = path.join(jobDir, 'concat.txt');
    fs.writeFileSync(concatTxt, partFiles.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf-8');
    const silentMp4 = path.join(jobDir, 'silent.mp4');
    await runFfmpeg([
      '-y', '-f', 'concat', '-safe', '0', '-i', concatTxt, '-c', 'copy', silentMp4,
    ]);

    let videoSource = silentMp4;
    if (plan.logo_path && plan.logo_enabled !== false && fs.existsSync(plan.logo_path)) {
      exportStatus[pid] = { running: true, percent: 82, message: 'Applying client logo overlay…' };
      const logoMp4 = path.join(jobDir, 'logo.mp4');
      const logoW = Math.max(90, Math.round(width * 0.1));
      const padX = Math.max(8, Math.round(width * 0.0078));
      const padY = Math.max(10, Math.round(height * 0.0176));
      await runFfmpeg([
        '-y', '-i', silentMp4, '-i', plan.logo_path,
        '-filter_complex', `[1:v]scale=${logoW}:-1:threads=1[lg];[0:v][lg]overlay=W-w-${padX}:${padY}:format=auto,format=yuv420p[vout]`,
        '-map', '[vout]', ...intermediateCodec, logoMp4,
      ]);
      videoSource = logoMp4;
    }

    exportStatus[pid] = { running: true, percent: 88, message: 'Encoding & syncing audio tracks…' };
    const vRateArgs = buildVideoRateArgs(settings);
    const vRateFallbackArgs = buildVideoRateArgs({ ...settings, encoder: 'mpeg4' });
    const aEncArgs = buildAudioEncodeArgs(settings);
    const ext = ['mp4', 'mov', 'mkv', 'avi', 'mp3', 'wav'].includes(String(settings.format || '').toLowerCase())
      ? String(settings.format).toLowerCase()
      : 'mp4';
    const outPath = path.join(EXPORTS_DIR, pid, `${safeTitle}.${ext}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
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
        await runFfmpeg(['-y', '-i', srcAudio, ...aEncArgs, outPath], { timeout: 600000 });
      }
    } else if (hasVo || hasPoem) {
      // Step A: Build synchronized audio track in an audio-only (-vn) pass to minimize container threads
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
      let nextAudioIdx = 0;

      if (hasVo) {
        const voIdx = nextAudioIdx++;
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
        const poemIdx = nextAudioIdx++;
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

      const audioExt = settings.audio_encoder === 'mp3' ? 'mp3' : settings.audio_encoder === 'pcm' ? 'wav' : 'm4a';
      const mixedAudioPath = path.join(jobDir, `mixed_audio.${audioExt}`);
      await runFfmpeg([
        '-y',
        ...audioInputs,
        '-filter_complex', filterComplex,
        '-map', '[aout]',
        '-vn',
        ...aEncArgs,
        '-t', totalTlDur.toFixed(3),
        mixedAudioPath,
      ], { timeout: 300000 });

      // Step B: Encode video-only track with target compression settings (with zero-thread MPEG-4 fallback if container LVE blocks x264)
      exportStatus[pid] = { running: true, percent: 93, message: 'Applying video compression…' };
      const encodedVideoPath = path.join(jobDir, 'video_encoded.mp4');
      try {
        await runFfmpeg([
          '-y',
          '-i', videoSource,
          ...vRateArgs,
          '-an',
          '-t', totalTlDur.toFixed(3),
          encodedVideoPath,
        ], { timeout: 600000 });
      } catch {
        await runFfmpeg([
          '-y',
          '-i', videoSource,
          ...vRateFallbackArgs,
          '-an',
          '-t', totalTlDur.toFixed(3),
          encodedVideoPath,
        ], { timeout: 600000 });
      }

      // Step C: Ultra-lightweight stream-copy mux of encoded video + synced audio
      exportStatus[pid] = { running: true, percent: 97, message: 'Finalizing MP4 container…' };
      await runFfmpeg([
        '-y',
        '-i', encodedVideoPath,
        '-i', mixedAudioPath,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c', 'copy',
        ...movFlags,
        outPath,
      ], { timeout: 120000 });
    } else {
      try {
        await runFfmpeg([
          '-y',
          '-i', videoSource,
          ...vRateArgs,
          '-an',
          ...movFlags,
          outPath,
        ], { timeout: 600000 });
      } catch {
        await runFfmpeg([
          '-y',
          '-i', videoSource,
          ...vRateFallbackArgs,
          '-an',
          ...movFlags,
          outPath,
        ], { timeout: 600000 });
      }
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
          await runFfmpeg([
            '-y', '-i', masterVo, '-i', dest,
            '-filter_complex', filterParts.join(';'),
            '-map', '[aout]', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k',
            splicedPath,
          ]);
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

// Zero-upload Local-File Mode: updates a scene's VO duration & ripples timeline without uploading audio bytes
app.post('/api/projects/:id/scenes/:screen/voiceover-meta', (req, res) => {
  try {
    const { id, screen } = req.params;
    const root = projectRoot(id);
    if (!fs.existsSync(root)) return res.status(404).json({ detail: 'Project not found' });
    const origName = path.basename(String(req.body?.filename || `${screen}.mp3`));
    const newDur = Math.max(0.2, Math.round(Number(req.body?.duration || 2.0) * 1000) / 1000);
    const localPath = String(req.body?.local_path || '').trim() || path.join(root, 'voiceover', 'scenes', origName);

    const scenes = loadJson(id, 'script.json') || [];
    let spokenText = String(req.body?.voiceover_text || '').trim();
    for (const s of scenes) {
      if (s.screen === screen) {
        if (spokenText) {
          s.voiceover_text = spokenText;
          s.voiceover_raw = spokenText;
        }
        if (req.body?.onscreen_text && String(req.body.onscreen_text).trim()) {
          s.onscreen_text = String(req.body.onscreen_text).trim();
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
        const oldClipDur = Number(clip.end || 0) - Number(clip.start || 0);
        const extraHold = Math.max(0, oldClipDur - oldSpokenDur);
        const newClipDur = Math.max(0.4, Math.round((newDur + extraHold) * 1000) / 1000);
        const deltaTl = Math.round((newClipDur - oldClipDur) * 1000) / 1000;

        clip.narration_in = Math.round(oldIn * 1000) / 1000;
        clip.narration_out = Math.round((oldIn + newDur) * 1000) / 1000;
        clip.end = Math.round((Number(clip.start || 0) + newClipDur) * 1000) / 1000;
        clip.duration = newClipDur;
        clip.custom_vo_path = localPath;
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
        }
        tl.total_duration = Math.round(Math.max(...tl.clips.map((c) => Number(c.end || 0))) * 1000) / 1000;
        tl.srt_cues = buildSrtCues(tl.clips, tl);
        saveJson(id, 'timeline.json', tl);
      }
    }
    res.json({
      ok: true,
      screen,
      filename: origName,
      duration: newDur,
      new_duration: newDur,
      spoken_text: spokenText,
      scenes,
      voiceover: voMeta,
      timeline: tl,
    });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// Genuine Wondershare Filmora 15.6.4 (.wfp & .wfpbundle) C++ archive builder & bidirectional importer
const TIMELINE_MEDIA_ID = '{C955B34C-02D9-4f9e-BB82-6EF30033529E}';
const TIMELINE_UUID = '{A8993E2F-2F41-40b5-9C9E-2BD2C11B4E6D}';
const AUDIO_BUS_UID = 'ce4f3d0f-ca76-f111-af78-1893417a1d62';

function makePngBuffer(width, height, rgb = [32, 43, 62]) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (tag, data) => {
    const tagBuf = Buffer.from(tag, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([tagBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([lenBuf, tagBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowLen;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = rgb[0];
      raw[px + 1] = rgb[1];
      raw[px + 2] = rgb[2];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const THUMB_320_180 = makePngBuffer(320, 180, [32, 43, 62]);
const COVER_160_90 = makePngBuffer(160, 90, [24, 34, 52]);

function filmoraGuid(seed) {
  const h = crypto.createHash('md5').update(String(seed), 'utf-8').digest('hex');
  return `{${h.slice(0, 8).toUpperCase()}-${h.slice(8, 12).toUpperCase()}-${h.slice(12, 16).toLowerCase()}-${h.slice(16, 20).toUpperCase()}-${h.slice(20, 32).toUpperCase()}}`;
}
function uidLower(seed) {
  const h = crypto.createHash('md5').update(String(seed), 'utf-8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
function wfpGuid() {
  return `{${crypto.randomUUID().toUpperCase()}}`;
}
function secToTicks(sec) {
  return Math.max(0, Math.round((Number(sec) || 0) * TICKS_PER_SEC));
}
function normSlash(p) {
  return String(p || '').replace(/\\/g, '/');
}
function fileMd5Hex(p) {
  const h = crypto.createHash('md5');
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
    h.update(buf.subarray(0, n));
  } catch {
    h.update(String(p));
  }
  return h.digest('hex');
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

// Filmora 15 C++ userData helpers
function udInt32(val, key) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(Number(val) | 0, 0);
  return { data: b.toString('base64'), key, type: 2 };
}
function udUint32(val, key) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(val) >>> 0, 0);
  return { data: b.toString('base64'), key, type: 3 };
}
function udFloat32(val, key) {
  const b = Buffer.alloc(4);
  b.writeFloatLE(Number(val) || 0, 0);
  return { data: b.toString('base64'), key, type: 4 };
}
function udFloat64(val, key) {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(Number(val) || 0, 0);
  return { data: b.toString('base64'), key, type: 5 };
}
function udStr(text, key, nullTerm = false) {
  const raw = Buffer.from(nullTerm ? `${text}\0` : String(text), 'utf-8');
  return { data: raw.toString('base64'), key, type: 9 };
}
function udBytes(buf, key) {
  return { data: Buffer.from(buf).toString('base64'), key, type: 10 };
}
function udGuid38(guidStr, key) {
  const raw = Buffer.from(String(guidStr).slice(0, 38).padEnd(38, '\0'), 'ascii');
  return { data: raw.toString('base64'), key, type: 10 };
}
function udGuid64(guidStr, key) {
  const raw = Buffer.alloc(64, 0);
  raw.write(String(guidStr).slice(0, 38), 0, 'ascii');
  return { data: raw.toString('base64'), key, type: 10 };
}

function imageMediaJson(absPath, mtimeSec, fileSize) {
  const p = normSlash(absPath);
  const name = path.basename(p);
  return {
    adjust_color_data_new: '',
    ai_palette_property_info_data: '',
    anchor_point: [0.0, 0.0],
    attribute: 1,
    audio_denoise_info: '',
    audio_duck_info: '',
    audio_info: null,
    audio_voice_balance_info: '',
    bModifyTitle: false,
    built_in_color_type: -1,
    cloud_file_download_state: 1,
    cloud_file_type: -1,
    cloud_from_type: -1,
    composition_data: '',
    compound_clip_version: 0,
    custom_info: {},
    custom_speed_Controller: '',
    duration: 0,
    file_create_time: mtimeSec,
    file_modify_time: mtimeSec,
    file_size: fileSize,
    filename: p,
    image_info: {
      color_space: 0,
      crop_bottom: 0.0,
      crop_left: 0.0,
      crop_right: 0.0,
      crop_top: 0.0,
      height: 1080,
      orientation: 1,
      raw_height: 1080,
      raw_width: 1920,
      rotation: 0,
      size: fileSize,
      stream_id: 200,
      width: 1920,
    },
    in_point: 0,
    link_mattings: [],
    media_tree_node_expand_status: false,
    motion_blur_data: '',
    name,
    obj_detect_data: '',
    orientation: 1,
    original_frame_rate: [1, 1],
    original_video_resolution: [0, 0],
    out_point: 0,
    PosScale: [1.0, 1.0],
    preset_manger_data: '',
    proxy_audio_info: null,
    proxy_filename: '',
    proxy_video_info: null,
    retime_method: 1,
    ReverseAudioInfo: null,
    ReverseFileName: '',
    ReverseVideoInfo: null,
    RotateAngle: 0.0,
    SilenceDetectArg: { dThreshold: 0.5, nMinContinueDuration: 500, nMiniVoicelessDuration: 500 },
    solid_color_info: null,
    source_count: 1,
    stabilization_data: '',
    strech_mode: 0,
    text_info: null,
    timeline_data_file: '',
    timeline_extra_data_file: '',
    title: name,
    TransformPosition: [0.0, 0.0],
    type: 1,
    video_info: null,
  };
}

function videoMediaJson(absPath, mtimeSec, fileSize, durTicks, fps = 30) {
  const p = normSlash(absPath);
  const name = path.basename(p);
  const vinfo = {
    bit_rate: 2500000,
    color_primaries: 2,
    color_range: 1,
    color_space: 2,
    color_trc: 2,
    crop_bottom: 0.0,
    crop_left: 0.0,
    crop_right: 0.0,
    crop_top: 0.0,
    duration: durTicks,
    file_fourcc: 875967080,
    format: 0,
    frame_rate: [fps, 1],
    hdr_To_sdr_type: '',
    hdr_data_describe: ' SDR ',
    hdr_type: 0,
    height: 1080,
    mediacodec_10bit_decode: 0,
    mediafoundation_10bit_decode: 1,
    orientation: 0,
    raw_height: 1080,
    raw_width: 1920,
    rotation: 0,
    size: fileSize,
    stream_fourcc: 875967080,
    stream_id: 0,
    time_base: [1, 15360],
    vfr_type: 0,
    video_codecid: 27,
    videotoolbox_10bit_decode: 0,
    width: 1920,
  };
  return {
    adjust_color_data_new: '',
    ai_palette_property_info_data: '',
    anchor_point: [0.0, 0.0],
    attribute: 1,
    audio_denoise_info: '',
    audio_duck_info: '',
    audio_info: null,
    audio_voice_balance_info: '',
    bModifyTitle: false,
    built_in_color_type: -1,
    cloud_file_download_state: 1,
    cloud_file_type: -1,
    cloud_from_type: -1,
    composition_data: '',
    compound_clip_version: 0,
    custom_info: {},
    custom_speed_Controller: '',
    duration: durTicks,
    file_create_time: mtimeSec,
    file_modify_time: mtimeSec,
    file_size: fileSize,
    filename: p,
    image_info: null,
    in_point: 0,
    link_mattings: [],
    media_tree_node_expand_status: false,
    motion_blur_data: '',
    name,
    obj_detect_data: '',
    orientation: 0,
    original_frame_rate: [fps, 1],
    original_video_resolution: [1920, 1080],
    out_point: durTicks,
    PosScale: [1.0, 1.0],
    preset_manger_data: '',
    proxy_audio_info: null,
    proxy_filename: '',
    proxy_video_info: null,
    retime_method: 1,
    ReverseAudioInfo: null,
    ReverseFileName: '',
    ReverseVideoInfo: null,
    RotateAngle: 0.0,
    SilenceDetectArg: { dThreshold: 0.5, nMinContinueDuration: 500, nMiniVoicelessDuration: 500 },
    solid_color_info: null,
    source_count: 1,
    stabilization_data: '',
    strech_mode: 0,
    text_info: null,
    timeline_data_file: '',
    timeline_extra_data_file: '',
    title: name,
    TransformPosition: [0.0, 0.0],
    type: 2,
    video_info: vinfo,
  };
}

function audioMediaJson(absPath, mtimeSec, fileSize, durTicks) {
  const p = normSlash(absPath);
  const name = path.basename(p);
  return {
    adjust_color_data_new: '',
    ai_palette_property_info_data: '',
    anchor_point: [0.0, 0.0],
    attribute: 1,
    audio_denoise_info: '',
    audio_duck_info: '',
    audio_info: {
      bit_rate: 128000,
      channels: 2,
      duration: durTicks,
      sample_format: 6,
      sample_rate: 44100,
      size: fileSize,
      stream_fourcc: 0,
      stream_id: 0,
      time_base: [1, 14112000],
    },
    audio_voice_balance_info: '',
    bModifyTitle: false,
    built_in_color_type: -1,
    cloud_file_download_state: 1,
    cloud_file_type: -1,
    cloud_from_type: -1,
    composition_data: '',
    compound_clip_version: 0,
    custom_info: {},
    custom_speed_Controller: '',
    duration: durTicks,
    file_create_time: mtimeSec,
    file_modify_time: mtimeSec,
    file_size: fileSize,
    filename: p,
    image_info: null,
    in_point: 0,
    link_mattings: [],
    media_tree_node_expand_status: false,
    motion_blur_data: '',
    name,
    obj_detect_data: '',
    orientation: 0,
    original_frame_rate: [1, 1],
    original_video_resolution: [0, 0],
    out_point: durTicks,
    PosScale: [1.0, 1.0],
    preset_manger_data: '',
    proxy_audio_info: null,
    proxy_filename: '',
    proxy_video_info: null,
    retime_method: 1,
    ReverseAudioInfo: null,
    ReverseFileName: '',
    ReverseVideoInfo: null,
    RotateAngle: 0.0,
    SilenceDetectArg: { dThreshold: 0.5, nMinContinueDuration: 500, nMiniVoicelessDuration: 500 },
    solid_color_info: null,
    source_count: 1,
    stabilization_data: '',
    strech_mode: 0,
    text_info: null,
    timeline_data_file: '',
    timeline_extra_data_file: '',
    title: name,
    TransformPosition: [0.0, 0.0],
    type: 4,
    video_info: null,
  };
}

function formatMediasInfoJson(mediaIds, timelineMediaId, mediaItemsMeta) {
  const folderPairs = [];
  for (const mid of [...mediaIds, timelineMediaId]) {
    folderPairs.push(`"media_item":${JSON.stringify(mid)}`);
  }
  const folderBody = folderPairs.join(',');
  const itemsDict = {};
  for (const mid of mediaIds) {
    itemsDict[mid] = mediaItemsMeta[mid];
  }
  itemsDict[timelineMediaId] = {
    cloud_file_type: -1,
    cloud_from_type: -1,
    data: `Medias/${timelineMediaId}/media.json`,
    extra_data: `Medias/${timelineMediaId}/extra.json`,
    media_attribute: 4,
    media_missing: 0,
    media_title: 'Project',
    media_type: 32,
    proxy_missing: 0,
    src_filename: '',
    src_md5: '',
    thumbnail: `Medias/${timelineMediaId}/thumbnail.png`,
    timeline_data: `Medias/${timelineMediaId}/timeline.wesproj`,
    title_modified: false,
  };
  return `{"media_structure":{"Folder":{${folderBody}}},"media_items":${JSON.stringify(itemsDict)},"version":"1.0.1.0"}`;
}

function buildDgsBundleDict(pid, title, relMap = null) {
  const scriptMeta = loadJson(pid, 'script_meta.json') || {};
  const scenes = loadJson(pid, 'script.json') || [];
  const media = (loadJson(pid, 'media.json') || []).map((m) => ({ ...m }));
  const vo = loadJson(pid, 'voiceover.json') ? JSON.parse(JSON.stringify(loadJson(pid, 'voiceover.json'))) : null;
  const poemVo = loadJson(pid, 'poem_voiceover.json') ? JSON.parse(JSON.stringify(loadJson(pid, 'poem_voiceover.json'))) : null;
  const logo = loadJson(pid, 'logo.json') ? JSON.parse(JSON.stringify(loadJson(pid, 'logo.json'))) : null;
  const plan = loadJson(pid, 'timeline.json') ? JSON.parse(JSON.stringify(loadJson(pid, 'timeline.json'))) : null;

  const mapPath = (pStr) => {
    if (!pStr || !relMap) return pStr;
    const k1 = normSlash(path.resolve(pStr));
    const k2 = normSlash(pStr);
    return relMap[k1] || relMap[k2] || pStr;
  };

  if (relMap) {
    for (const m of media) {
      if (m.path) m.path = mapPath(m.path);
    }
    if (vo) {
      if (vo.path) vo.path = mapPath(vo.path);
      if (Array.isArray(vo.slots)) {
        for (const s of vo.slots) {
          if (s && s.path) s.path = mapPath(s.path);
        }
      }
    }
    if (poemVo && poemVo.path) poemVo.path = mapPath(poemVo.path);
    if (logo && logo.path) logo.path = mapPath(logo.path);
    if (plan) {
      if (plan.voiceover_path) plan.voiceover_path = mapPath(plan.voiceover_path);
      if (plan.poem_voiceover_path) plan.poem_voiceover_path = mapPath(plan.poem_voiceover_path);
      if (plan.logo_path) plan.logo_path = mapPath(plan.logo_path);
      for (const c of plan.clips || []) {
        if (c.media_path) c.media_path = mapPath(c.media_path);
      }
      for (const s of plan.voiceover_slots || []) {
        if (s && s.path) s.path = mapPath(s.path);
      }
    }
  }

  return {
    dgs_format: 'dgs_filmora_project_v2',
    created_at: Math.floor(Date.now() / 1000),
    project_id: pid,
    title: title || scriptMeta.filename || `Project_${pid}`,
    portable: Boolean(relMap),
    script_meta: scriptMeta,
    scenes,
    media,
    voiceover: vo,
    poem_voiceover: poemVo,
    logo,
    timeline: plan,
  };
}

function buildWfpAndMediaMap(pid, title = 'Project', opts = {}) {
  const { wfpSavePath = '', archiveMode = false, relMap = null } = opts;
  const plan = loadJson(pid, 'timeline.json');
  if (!plan) throw new Error('Build a timeline first before exporting .wfp');

  const nowTs = Math.floor(Date.now() / 1000);
  const fps = 30;
  const projGuid = filmoraGuid(`proj:${pid}:${title}`);

  const mediaIds = [];
  const mediaItemsMeta = {};
  const perMediaJson = {};
  const mediaGuidToPath = new Map();
  const pathToMediaGuid = new Map();
  const resources = [];
  const mediaClipsMap = {};
  const beatDetectMap = {};

  const registerMedia = (rawPath, kind, approxDurSec = 5.0) => {
    if (!rawPath) return ['', ''];
    const p = path.resolve(rawPath);
    const normAbs = normSlash(p);
    if (pathToMediaGuid.has(normAbs)) return pathToMediaGuid.get(normAbs);

    let mtimeSec = nowTs;
    let fileSize = 0;
    let md5Str = '';
    try {
      const st = fs.statSync(p);
      mtimeSec = Math.floor(st.mtimeMs / 1000);
      fileSize = st.size;
      md5Str = fileMd5Hex(p);
    } catch {
      md5Str = crypto.createHash('md5').update(normAbs, 'utf-8').digest('hex');
    }

    const mid = filmoraGuid(`media:${pid}:${normAbs}`);
    const resUid = uidLower(`res:${pid}:${normAbs}`);
    const durTicks = secToTicks(Math.max(0.5, Number(approxDurSec) || 5.0));

    let normP = normAbs;
    if (archiveMode) {
      normP = `%DOCUMENT_DIR%/Medias/${mid}/${path.basename(p)}`;
    } else if (relMap && (relMap[normAbs] || relMap[normSlash(rawPath)])) {
      normP = relMap[normAbs] || relMap[normSlash(rawPath)];
    }

    mediaIds.push(mid);
    mediaGuidToPath.set(mid, p);
    mediaClipsMap[mid] = [];

    if (kind === 'image') {
      perMediaJson[mid] = imageMediaJson(normP, mtimeSec, fileSize);
      mediaItemsMeta[mid] = {
        cloud_file_type: -1,
        cloud_from_type: -1,
        data: `Medias/${mid}/media.json`,
        media_attribute: 1,
        media_missing: 0,
        media_title: path.basename(p),
        media_type: 1,
        proxy_missing: 1,
        src_filename: normP,
        src_md5: md5Str,
        thumbnail: `Medias/${mid}/thumbnail.png`,
        title_modified: false,
      };
      resources.push({
        duration: -1,
        filename: normP,
        sourceUuid: resUid,
        streamIdx: 200,
        tracks: [{ codec: 'image', height: 1080, index: 200, type: 1, width: 1920 }],
        type: 3,
        userData: [udInt32(0, 62)],
      });
    } else if (kind === 'video') {
      perMediaJson[mid] = videoMediaJson(normP, mtimeSec, fileSize, durTicks, fps);
      mediaItemsMeta[mid] = {
        cloud_file_type: -1,
        cloud_from_type: -1,
        data: `Medias/${mid}/media.json`,
        media_attribute: 1,
        media_missing: 0,
        media_title: path.basename(p),
        media_type: 2,
        proxy_missing: 1,
        src_filename: normP,
        src_md5: md5Str,
        thumbnail: `Medias/${mid}/thumbnail.png`,
        title_modified: false,
      };
      resources.push({
        duration: durTicks,
        filename: normP,
        sourceUuid: resUid,
        streamIdx: 0,
        tracks: [
          {
            bitrate: 2500000,
            codec: 'h264',
            colorSpace: 'BT709',
            duration: durTicks,
            format: 'nv12',
            frameRate: { den: 1, num: fps },
            height: 1080,
            index: 0,
            timebase: { den: 15360, num: 1 },
            type: 1,
            width: 1920,
          },
        ],
        type: 1,
        userData: [udInt32(0, 62)],
      });
    } else {
      perMediaJson[mid] = audioMediaJson(normP, mtimeSec, fileSize, durTicks);
      mediaItemsMeta[mid] = {
        cloud_file_type: -1,
        cloud_from_type: -1,
        data: `Medias/${mid}/media.json`,
        media_attribute: 1,
        media_missing: 0,
        media_title: path.basename(p),
        media_type: 4,
        proxy_missing: 1,
        src_filename: normP,
        src_md5: md5Str,
        title_modified: false,
      };
      beatDetectMap[mid] = {
        bEnableMarkAdded: true,
        beatInterval: 4,
        beatModel: 1,
        nHighlightOnly: 0,
        strMusicAnalysisJsonPath: '',
      };
      resources.push({
        duration: durTicks,
        filename: normP,
        sourceUuid: resUid,
        streamIdx: 0,
        tracks: [
          {
            bitrate: 128000,
            channelLayout: 3,
            channels: 2,
            codec: 'mp3float',
            duration: durTicks,
            format: 'fltp',
            index: 0,
            sampleRate: 44100,
            timebase: { den: 14112000, num: 1 },
            type: 2,
          },
        ],
        type: 2,
        userData: [udInt32(0, 62)],
      });
    }

    const pair = [mid, resUid];
    pathToMediaGuid.set(normAbs, pair);
    return pair;
  };

  const makeVisualClip = (clipKey, mid, resUid, filenameStr, kind, tlBeginTicks, tlEndTicks, srcInSec = 0, srcOutSec = null, customTransform = null) => {
    const durTicks = Math.max(1, tlEndTicks - tlBeginTicks);
    let inTicks;
    let outTicks;
    if (kind === 'image') {
      inTicks = IMAGE_BASE_OFFSET_TICKS;
      outTicks = IMAGE_BASE_OFFSET_TICKS + durTicks;
    } else {
      inTicks = secToTicks(srcInSec || 0);
      outTicks = srcOutSec != null ? secToTicks(srcOutSec) : (inTicks + durTicks);
      if (outTicks <= inTicks) outTicks = inTicks + durTicks;
    }

    const ctype = kind === 'image' ? 3 : 1;
    const outerUid = uidLower(`vclip_out:${clipKey}`);
    const innerUid = uidLower(`vclip_in:${clipKey}`);
    const stabUid = uidLower(`vstab:${clipKey}`);
    const outerGuid38 = `{${outerUid.toUpperCase()}}`;
    const colorRangeXml = '<?xml version="1.0"?>\n<timeline_project name="ColorRangeFilter">\n\t<version>1</version>\n\t<Next FilterId="1001" />\n</timeline_project>\n';

    const clipObj = {
      anchorX: 0.0,
      anchorY: 0.0,
      applyDeinterlace: false,
      audioChannelProcessIndex: 0,
      auto_normalize_value: -1000,
      bOpenAutoNormalize: false,
      bSyncedATempo: true,
      blendMode: 0,
      blendVisible: true,
      bottom: 0.0,
      brightness: 0.0,
      clipList: [
        {
          clipMaskList: [],
          clipMode: 0,
          contextType: 0,
          customSpeedControllJson: '',
          enable: true,
          filename: filenameStr,
          inPoint: inTicks,
          locked: false,
          name: '',
          outPoint: outTicks,
          retimeMethod: 1,
          reverse: false,
          source: resUid,
          sourceUuid: resUid,
          speed: 1.0,
          strVariableSpeedInfo: '',
          streamIdx: kind === 'image' ? 200 : 0,
          sync: 0,
          tlBegin: 0,
          tlEnd: durTicks,
          type: ctype,
          uid: innerUid,
          userData: [udInt32(0, 62)],
          videostabilizer: {
            bEdgeExtend: true,
            bUseStabilizer: false,
            enable: true,
            fSmoothLevel: 0.20000000298023224,
            filename: filenameStr,
            inPoint: inTicks,
            locked: false,
            name: '',
            outPoint: outTicks,
            sourceUuid: resUid,
            speed: 1.0,
            tlBegin: 0,
            tlEnd: durTicks,
            type: 0,
            uid: stabUid,
            userData: [udInt32(0, 62)],
          },
        },
      ],
      clipMaskList: [],
      clipMode: 0,
      colorize: { bColorize: false, brightness: 50.0, hue: 180.0, opacity: 50.0, saturation: 50.0 },
      contextType: 1,
      contrast: 0.0,
      cropMode: 0,
      customSpeedControllJson: '',
      denoiseLevel: 0,
      displayMode: 0,
      dropShadow: { angle: 60.0, bDropShadow: false, blur: 0.0, color: 0, distance: 0.0, opacity: 60, scale: 100.0 },
      enable: true,
      fadeInDuration: 0,
      fadeOutDuration: 0,
      fieldOrder: 0,
      flipHorizontal: false,
      flipVertical: false,
      freezeDuration: 36000000000,
      freezePosition: -1,
      freezeScale: 0.0,
      inPoint: inTicks,
      left: 0.0,
      locked: false,
      lutStrength: 100.0,
      matteMode: 0,
      motionBlur: { bEnable: false, fPhase: 0.0, fShutterAngle: 180.0, nSamplesCount: 16 },
      name: '',
      opacity: 100,
      outPoint: outTicks,
      pitch: 0,
      retimeMethod: 1,
      reverse: false,
      right: 0.0,
      rotation: 0.0,
      rotationX: 0.0,
      rotationY: 0.0,
      saturation: 0.0,
      scaleX: customTransform ? customTransform.scaleX : 1.0,
      scaleY: customTransform ? customTransform.scaleY : 1.0,
      settingScaleToFit: 0,
      sharpness: 0.0,
      speed: 1.0,
      strVariableSpeedInfo: '',
      stretchMode: 0,
      sync: 0,
      tint: 0.0,
      tlBegin: tlBeginTicks,
      tlEnd: tlEndTicks,
      top: 0.0,
      transX: customTransform ? customTransform.transX : 0.0,
      transY: customTransform ? customTransform.transY : 0.0,
      type: ctype,
      uid: outerUid,
      userData: [
        udStr(filenameStr, 30016),
        udStr(path.basename(filenameStr), 50, true),
        udGuid64(mid, 9),
        udInt32(0, 29),
        udInt32(0, 62),
        udUint32(4294967295, 13000),
        udFloat32(0.0, 22),
        udFloat32(0.0, 120),
        udGuid38(outerGuid38, 30309),
        udBytes(Buffer.from([0x04]), 14002),
        udStr('{"type":0,"version":1,"visible":true}', 30304),
        udFloat64(0.0, 71),
        udStr(colorRangeXml, 30059),
      ],
      volume: 0.0,
    };
    if (mediaClipsMap[mid]) mediaClipsMap[mid].push(outerGuid38);
    return clipObj;
  };

  const makeAudioClip = (clipKey, mid, resUid, filenameStr, tlBeginTicks, tlEndTicks, srcInSec = 0, srcOutSec = null) => {
    const durTicks = Math.max(1, tlEndTicks - tlBeginTicks);
    const inTicks = secToTicks(srcInSec || 0);
    let outTicks = srcOutSec != null ? secToTicks(srcOutSec) : (inTicks + durTicks);
    if (outTicks <= inTicks) outTicks = inTicks + durTicks;

    const outerUid = uidLower(`aclip_out:${clipKey}`);
    const innerUid = uidLower(`aclip_in:${clipKey}`);
    const outerGuid38 = `{${outerUid.toUpperCase()}}`;
    const colorRangeXml = '<?xml version="1.0"?>\n<timeline_project name="ColorRangeFilter">\n\t<version>1</version>\n\t<Next FilterId="1001" />\n</timeline_project>\n';

    const clipObj = {
      anchorX: 0.0,
      anchorY: 0.0,
      applyDeinterlace: false,
      audioChannelProcessIndex: 0,
      auto_normalize_value: -1000,
      bOpenAutoNormalize: false,
      bSyncedATempo: true,
      blendMode: 0,
      blendVisible: true,
      bottom: 0.0,
      brightness: 0.0,
      clipList: [
        {
          clipMaskList: [],
          clipMode: 0,
          contextType: 0,
          customSpeedControllJson: '',
          enable: true,
          filename: filenameStr,
          inPoint: inTicks,
          locked: false,
          name: '',
          outPoint: outTicks,
          retimeMethod: 1,
          reverse: false,
          source: resUid,
          sourceUuid: resUid,
          speed: 1.0,
          strVariableSpeedInfo: '',
          streamIdx: 0,
          sync: 0,
          tlBegin: 0,
          tlEnd: durTicks,
          type: 2,
          uid: innerUid,
          userData: [udInt32(0, 62)],
        },
      ],
      clipMaskList: [],
      clipMode: 0,
      colorize: { bColorize: false, brightness: 50.0, hue: 180.0, opacity: 50.0, saturation: 50.0 },
      contextType: 1,
      contrast: 0.0,
      cropMode: 0,
      customSpeedControllJson: '',
      denoiseLevel: 0,
      displayMode: 0,
      dropShadow: { angle: 60.0, bDropShadow: false, blur: 0.0, color: 0, distance: 0.0, opacity: 60, scale: 100.0 },
      enable: true,
      fadeInDuration: 0,
      fadeOutDuration: 0,
      fieldOrder: 0,
      flipHorizontal: false,
      flipVertical: false,
      freezeDuration: 36000000000,
      freezePosition: -1,
      freezeScale: 0.0,
      inPoint: inTicks,
      left: 0.0,
      locked: false,
      lutStrength: 100.0,
      matteMode: 0,
      motionBlur: { bEnable: false, fPhase: 0.0, fShutterAngle: 180.0, nSamplesCount: 16 },
      name: '',
      opacity: 100,
      outPoint: outTicks,
      pitch: 0,
      retimeMethod: 1,
      reverse: false,
      right: 0.0,
      rotation: 0.0,
      rotationX: 0.0,
      rotationY: 0.0,
      saturation: 0.0,
      scaleX: 1.0,
      scaleY: 1.0,
      settingScaleToFit: 0,
      sharpness: 0.0,
      speed: 1.0,
      strVariableSpeedInfo: '',
      stretchMode: 0,
      sync: 0,
      tint: 0.0,
      tlBegin: tlBeginTicks,
      tlEnd: tlEndTicks,
      top: 0.0,
      transX: 0.0,
      transY: 0.0,
      type: 2,
      uid: outerUid,
      userData: [
        udStr(filenameStr, 30016),
        udStr(path.basename(filenameStr), 50, true),
        udGuid64(mid, 9),
        udInt32(0, 29),
        udInt32(0, 62),
        udUint32(4294967295, 13000),
        udFloat32(0.0, 22),
        udFloat32(0.0, 120),
        udGuid38(outerGuid38, 30309),
        udBytes(Buffer.from([0x04]), 14002),
        udFloat64(0.0, 71),
        udStr(colorRangeXml, 30059),
      ],
      volume: 0.0,
    };
    if (mediaClipsMap[mid]) mediaClipsMap[mid].push(outerGuid38);
    return clipObj;
  };

  // 1. Main visual scene clips (Video Track 1)
  const videoClipsTrack = [];
  for (let idx = 0; idx < (plan.clips || []).length; idx++) {
    const c = plan.clips[idx];
    if (!c.media_path || !fs.existsSync(c.media_path)) continue;
    const [mid, resUid] = registerMedia(c.media_path, c.kind, Math.max(Number(c.duration || 0), Number(c.source_out || 0), 5.0));
    if (!mid) continue;
    const tlBegin = secToTicks(c.start);
    const tlEnd = Math.max(tlBegin + 1, secToTicks(c.end));
    const clipFn = mediaItemsMeta[mid].src_filename;
    videoClipsTrack.push(
      makeVisualClip(`scene_${idx}_${c.screen}`, mid, resUid, clipFn, c.kind, tlBegin, tlEnd, c.source_in || 0, c.source_out),
    );
  }

  // 2. Narration VO audio track
  const voClipsTrack = [];
  const slots = Array.isArray(plan.voiceover_slots) ? plan.voiceover_slots : [];
  if (slots.length > 0 && slots.some((s) => s.path && fs.existsSync(s.path))) {
    for (let idx = 0; idx < slots.length; idx++) {
      const s = slots[idx];
      if (!s.path || !fs.existsSync(s.path)) continue;
      const [mid, resUid] = registerMedia(s.path, 'audio', Math.max(Number(s.duration || 0), 5.0));
      if (!mid) continue;
      const tlBegin = secToTicks(s.start);
      const tlEnd = Math.max(tlBegin + 1, secToTicks(s.end));
      const clipFn = mediaItemsMeta[mid].src_filename;
      voClipsTrack.push(
        makeAudioClip(`vo_slot_${idx}_${s.slot}`, mid, resUid, clipFn, tlBegin, tlEnd, 0.0, s.duration),
      );
    }
  } else if (plan.voiceover_path && fs.existsSync(plan.voiceover_path)) {
    const [mid, resUid] = registerMedia(plan.voiceover_path, 'audio', Math.max(Number(plan.total_duration || 10), 5.0));
    if (mid) {
      const clipFn = mediaItemsMeta[mid].src_filename;
      const spokenClips = (plan.clips || []).filter((c) => c.narration_in != null && c.narration_out != null && c.narration_out > c.narration_in);
      if (spokenClips.length) {
        for (let idx = 0; idx < spokenClips.length; idx++) {
          const c = spokenClips[idx];
          const durN = Number(c.narration_out) - Number(c.narration_in);
          const tlBegin = secToTicks(c.start);
          const tlEnd = secToTicks(Number(c.start) + durN);
          voClipsTrack.push(
            makeAudioClip(`vo_seg_${idx}`, mid, resUid, clipFn, tlBegin, tlEnd, c.narration_in, c.narration_out),
          );
        }
      } else {
        voClipsTrack.push(
          makeAudioClip('vo_full', mid, resUid, clipFn, 0, secToTicks(plan.total_duration || 10), 0.0, plan.total_duration),
        );
      }
    }
  }

  // 3. Poem / Suno VO audio track
  const poemClipsTrack = [];
  if (plan.poem_voiceover_path && fs.existsSync(plan.poem_voiceover_path)) {
    const pStart = Number(plan.poem_start_time || 0);
    const pEnd = Number(plan.poem_end_time || 0) > pStart ? Number(plan.poem_end_time) : Number(plan.total_duration || 10);
    const pDur = Math.max(1.0, pEnd - pStart);
    const [mid, resUid] = registerMedia(plan.poem_voiceover_path, 'audio', pDur);
    if (mid) {
      const clipFn = mediaItemsMeta[mid].src_filename;
      poemClipsTrack.push(
        makeAudioClip('poem_vo', mid, resUid, clipFn, secToTicks(pStart), secToTicks(pEnd), 0.0, pDur),
      );
    }
  }

  // 4. Logo overlay track (top-right corner across entire timeline)
  const logoClipsTrack = [];
  const logoMeta = loadJson(pid, 'logo.json') || {};
  const logoPath = plan.logo_path || logoMeta.path;
  const logoEnabled = Boolean(plan.logo_enabled ?? logoMeta.enabled ?? true);
  if (logoEnabled && logoPath && fs.existsSync(logoPath)) {
    const [mid, resUid] = registerMedia(logoPath, 'image', Number(plan.total_duration || 10));
    if (mid) {
      const clipFn = mediaItemsMeta[mid].src_filename;
      logoClipsTrack.push(
        makeVisualClip(
          'logo_overlay',
          mid,
          resUid,
          clipFn,
          'image',
          0,
          secToTicks(Math.max(1.0, Number(plan.total_duration || 10))),
          0.0,
          null,
          { scaleX: 0.14, scaleY: 0.14, transX: 0.4, transY: -0.39 },
        ),
      );
    }
  }

  // 5. Native Filmora 15 Subtitle track (`type: 22` with `subtitleSource` JSON) — supports English & Marathi Devanagari!
  const cuesList = plan.srt_cues && plan.srt_cues.length ? plan.srt_cues : buildSrtCues(plan.clips || [], plan);
  const subtitleClipsTrack = [];
  const totalTicks = secToTicks(Math.max(1.0, Number(plan.total_duration || 10)));
  if (cuesList.length) {
    const subItems = [];
    for (let idx = 0; idx < cuesList.length; idx++) {
      const q = cuesList[idx];
      const sSec = Number(q.start || 0);
      const eSec = Number(q.end || 0);
      const txt = String(q.text || '').trim();
      if (!txt || eSec <= sSec) continue;
      subItems.push({
        Start: secToTicks(sSec),
        End: secToTicks(eSec),
        Content: txt,
        Pos: [0.0, -0.38],
        Scale: [1.0, 1.0],
        Index: idx,
      });
    }
    if (subItems.length) {
      const subGuid = filmoraGuid(`sub_clip:${pid}`);
      const subSourceJson = JSON.stringify({
        Items: subItems,
         FontInfo: {
          FontName: 'Noto Sans Devanagari',
          FontSize: 42,
          TextColor: 4294967295,
          IsBold: true,
        },
      }).replace('" FontInfo":', '"FontInfo":');
      subtitleClipsTrack.push({
        anchorX: 0.0,
        anchorY: 0.0,
        blendMode: 0,
        blendVisible: true,
        clipList: [],
        clipMaskList: [],
        clipMode: 0,
        contextType: 0,
        enable: true,
        inPoint: 0,
        locked: false,
        name: 'Subtitles',
        opacity: 100,
        outPoint: totalTicks,
        rotation: 0.0,
        scaleX: 1.0,
        scaleY: 1.0,
        speed: 1.0,
        subtitleSource: subSourceJson,
        sync: 0,
        tlBegin: 0,
        tlEnd: totalTicks,
        transX: 0.0,
        transY: 0.0,
        type: 22,
        uid: uidLower(`sub_uid:${pid}`),
        userData: [
          udStr('Subtitles', 50, true),
          udGuid38(subGuid, 30309),
        ],
      });
    }
  }

  const tracks = [
    {
      clipList: videoClipsTrack,
      trackTag: 1,
      trackType: 1,
      userData: [udInt32(0, 21), udBytes(Buffer.from([0x00]), 12001), udInt32(54, 12000)],
      uuid: uidLower('track_v_main'),
    },
    {
      audioBusUid: AUDIO_BUS_UID,
      balance: 0.5,
      clipList: [],
      gain: 0.0,
      solo: false,
      trackTag: 1,
      trackType: 2,
      userData: [udInt32(0, 21), udBytes(Buffer.from([0x00]), 12001), udInt32(54, 12000)],
      uuid: uidLower('track_a_default'),
    },
    {
      audioBusUid: AUDIO_BUS_UID,
      balance: 0.5,
      clipList: voClipsTrack,
      gain: 0.0,
      solo: false,
      trackTag: 2,
      trackType: 2,
      userData: [udInt32(1, 21), udBytes(Buffer.from([0x00]), 12001), udInt32(54, 12000)],
      uuid: uidLower('track_a_vo'),
    },
  ];

  if (poemClipsTrack.length) {
    tracks.push({
      audioBusUid: AUDIO_BUS_UID,
      balance: 0.5,
      clipList: poemClipsTrack,
      gain: 0.0,
      solo: false,
      trackTag: 4,
      trackType: 2,
      userData: [udInt32(2, 21), udBytes(Buffer.from([0x00]), 12001), udInt32(54, 12000)],
      uuid: uidLower('track_a_poem'),
    });
  }
  if (subtitleClipsTrack.length) {
    tracks.push({
      clipList: subtitleClipsTrack,
      trackTag: 4,
      trackType: 1,
      userData: [udInt32(1, 21), udBytes(Buffer.from([0x00]), 12001), udInt32(32, 12000)],
      uuid: uidLower('track_v_subtitles'),
    });
  }
  if (logoClipsTrack.length) {
    tracks.push({
      clipList: logoClipsTrack,
      trackTag: 6,
      trackType: 1,
      userData: [udInt32(1, 21), udBytes(Buffer.from([0x00]), 12001), udInt32(32, 12000)],
      uuid: uidLower('track_v_logo'),
    });
  }

  const tlPageJson = Buffer.from(JSON.stringify([{ index: 0, isActive: true, pageIndex: 1, timelineId: TIMELINE_UUID }]), 'utf-8');
  const tlRangeJson = Buffer.from(JSON.stringify({ data: [0, totalTicks] }), 'utf-8');

  const wesproj = {
    currentTimelineId: 9,
    productName: 'Filmora',
    projectName: 'TLB',
    projectVersion: '6,13,101,6',
    resources,
    serialNumber: 16,
    serializationVersion: '28',
    timelineInfos: [
      {
        aspectRatioX: 16,
        aspectRatioY: 9,
        audioBusInfos: [{ balance: 0.5, busUid: AUDIO_BUS_UID, gain: 0.0 }],
        channels: 2,
        format: 'f32',
        frameRate: { den: 1, num: fps },
        hdrMode: 0,
        hdrMode_force_16bit: 0,
        resolutionHeight: 1080,
        resolutionWidth: 1920,
        sampleRate: 44100,
        timelineId: 9,
        trackInfos: tracks,
        type: 0,
        userData: [
          udStr('Untitle', 50, true),
          udGuid64(TIMELINE_UUID, 11000),
          udGuid64(filmoraGuid(`tl3:${pid}`), 3),
          udGuid38(TIMELINE_UUID, 30309),
          udStr(crypto.createHash('md5').update(`Filmora${TIMELINE_MEDIA_ID}`, 'utf-8').digest('hex'), 140),
          udBytes(tlPageJson, 30306),
          udInt32(0, 11003),
          udBytes(tlRangeJson, 11001),
        ],
      },
    ],
  };

  const extraJson = {
    fontNameInfo: [],
    usedBizFont: [],
    usedTemplateResInfo: {},
    mediaClipsMapInfo: mediaClipsMap,
    allMarkersInfo: { beatDetectInfo: beatDetectMap },
    pendingMarkersInfo: {},
    highlightInfo: {},
    TextSentence: { TextSentence: [] },
  };

  const safeName = String(title || `Project_${pid}`).trim().replace(/[^a-zA-Z0-9._ ()-]/g, '_') || `Project_${pid}`;
  const coverBackupPath = `C:/Users/Kohin/AppData/Roaming/Wondershare/Wondershare Filmora/Backup/${projGuid}/ProjectFolder/Anon/Cover/cover_eFWdR.wfpbundle`;
  const projectInfo = {
    vbl_modify_version: '8.6.2.8',
    vbl_create_version: '8.6.2.8',
    project_os_name: 'Windows',
    project_os_version: '',
    project_file_name: safeName,
    project_file_suffix: '.wfp',
    project_editor_name: 'Filmora',
    project_editor_create_version: '15.6.4.11894',
    project_editor_modify_version: '15.6.4.11894',
    project_date_create: nowTs,
    project_date_modify: nowTs,
    project_timeline_duration: totalTicks,
    project_current_position: 0,
    project_timeline_framerate: [fps, 1],
    project_timeline_resolution: [1920, 1080],
    project_timeline_ratio: [16, 9],
    project_color_space: 0,
    project_sample_rate: 44100,
    project_audio_bitdepth: 1,
    project_player_quality: 0,
    project_player_zoom_level: 0,
    project_player_safe_zone: false,
    project_archive: Boolean(archiveMode),
    project_storage: true,
    project_backup: false,
    project_cover: false,
    project_custom_cover: false,
    project_type: 0,
    bRemoveProjectTypeForArchive: false,
    bRemoveProjectTypeForSaveAs: false,
    project_template_name: '',
    timeline_mediaId: TIMELINE_MEDIA_ID,
    project_guid: projGuid,
    proj_zip_save_path: wfpSavePath ? normSlash(wfpSavePath) : `${safeName}.wfp`,
    proj_cover_proj_path: coverBackupPath,
    nSizeRatioType: 0,
    project_source: crypto.createHash('md5').update(`Filmora${nowTs}`, 'utf-8').digest('hex'),
    project_used_pack_list: [],
    user_data: [
      { key: 1, data: '1' },
      { key: 2, data: '' },
    ],
  };

  const bundleRelMap = { ...(relMap || {}) };
  if (archiveMode) {
    for (const [mid, pAbs] of mediaGuidToPath.entries()) {
      const relEntry = `Medias/${mid}/${path.basename(pAbs)}`;
      bundleRelMap[normSlash(path.resolve(pAbs))] = relEntry;
      bundleRelMap[normSlash(pAbs)] = relEntry;
    }
  }
  const dgsBundle = buildDgsBundleDict(pid, title, Object.keys(bundleRelMap).length ? bundleRelMap : null);
  const rawDgs = JSON.stringify(dgsBundle);
  let dgsComment = '';
  try {
    const cand = 'DGS1:' + zlib.deflateSync(Buffer.from(rawDgs, 'utf-8'), { level: 9 }).toString('base64');
    if (cand.length <= 65000) dgsComment = cand;
  } catch {}

  const zip = new AdmZip();
  for (const [mid, mjson] of Object.entries(perMediaJson)) {
    zip.addFile(`ProjectFolder/Medias/${mid}/media.json`, Buffer.from(JSON.stringify(mjson), 'utf-8'));
    const metaEntry = mediaItemsMeta[mid] || {};
    if (metaEntry.media_type !== 4) {
      zip.addFile(`ProjectFolder/Medias/${mid}/thumbnail.png`, THUMB_320_180);
    }
  }
  zip.addFile(`ProjectFolder/Medias/${TIMELINE_MEDIA_ID}/thumbnail.png`, THUMB_320_180);
  zip.addFile('ProjectFolder/Anon/AppData/Windows/functionExtraData.json', Buffer.from('{"9":"2"}', 'utf-8'));
  zip.addFile('ProjectFolder/Medias/medias_info.json', Buffer.from(formatMediasInfoJson(mediaIds, TIMELINE_MEDIA_ID, mediaItemsMeta), 'utf-8'));
  zip.addFile(`ProjectFolder/Medias/${TIMELINE_MEDIA_ID}/extra.json`, Buffer.from(JSON.stringify(extraJson), 'utf-8'));
  zip.addFile(`ProjectFolder/Medias/${TIMELINE_MEDIA_ID}/timeline.wesproj`, Buffer.from(JSON.stringify(wesproj), 'utf-8'));
  zip.addFile('ProjectFolder/project_info.json', Buffer.from(JSON.stringify(projectInfo, null, 4), 'utf-8'));
  zip.addFile('ProjectFolder/Anon/Cover/thumb.fsthumb', COVER_160_90);
  zip.addFile('ProjectFolder/dgs_project.json', Buffer.from(rawDgs, 'utf-8'));
  if (dgsComment) {
    zip.addZipComment(dgsComment);
  }

  return { wfpBuffer: zip.toBuffer(), mediaGuidToPath };
}

function buildWfpBundleFileOnDisk(pid, rawTitle, bundlePath, progressCb = null) {
  const safeTitle = String(rawTitle || `Project_${pid}`).trim().replace(/[^a-zA-Z0-9._ ()-]/g, '_') || `Project_${pid}`;
  if (progressCb) progressCb(10, 'Building Filmora 15 .wfp archive metadata…');
  const innerWfpName = `${safeTitle}.wfp`;
  const { wfpBuffer, mediaGuidToPath } = buildWfpAndMediaMap(pid, rawTitle, {
    wfpSavePath: path.join(path.dirname(bundlePath), innerWfpName),
    archiveMode: true,
  });

  const bundleZip = new AdmZip();
  const items = Array.from(mediaGuidToPath.entries());
  const total = Math.max(1, items.length);
  for (let idx = 0; idx < items.length; idx++) {
    const [mid, srcPath] = items[idx];
    if (progressCb) {
      const pct = 15 + Math.round(((idx + 1) / total) * 75);
      progressCb(pct, `Packing ${path.basename(srcPath)} into .wfpbundle (${idx + 1}/${total})…`);
    }
    if (fs.existsSync(srcPath) && fs.statSync(srcPath).isFile()) {
      bundleZip.addLocalFile(srcPath, `Medias/${mid}`, path.basename(srcPath));
      // Set STORED method on large media entries so Filmora 15 opens .wfpbundle directly
      const entry = bundleZip.getEntry(`Medias/${mid}/${path.basename(srcPath)}`);
      if (entry) entry.header.method = 0;
    }
  }
  if (progressCb) progressCb(94, `Writing ${innerWfpName} into ${path.basename(bundlePath)}…`);
  bundleZip.addFile(innerWfpName, wfpBuffer);
  const wfpEntry = bundleZip.getEntry(innerWfpName);
  if (wfpEntry) wfpEntry.header.method = 0;
  fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
  bundleZip.writeZip(bundlePath);
  return { bundlePath, fileCount: items.length + 1, innerWfpBuffer: wfpBuffer };
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
    const { wfpBuffer } = buildWfpAndMediaMap(pid, rawTitle, { wfpSavePath: outPath, archiveMode: false });
    fs.writeFileSync(outPath, wfpBuffer);
  } else if (fmt === 'wfpbundle') {
    buildWfpBundleFileOnDisk(pid, rawTitle, outPath);
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
  const mode = String(req.body?.mode || req.query?.mode || 'wfpbundle').toLowerCase();
  const rawTitle = String(req.body?.title || req.query?.title || `Project_${pid}`).trim();
  const safeTitle = rawTitle.replace(/[^a-zA-Z0-9._ ()-]/g, '_') || `Project_${pid}`;

  collectStatus[pid] = { running: true, percent: 10, message: 'Packing Filmora 15 .wfpbundle & media…' };
  try {
    const outDir = path.join(EXPORTS_DIR, pid);
    fs.mkdirSync(outDir, { recursive: true });
    const extSuffix = mode === 'wfpbundle' ? 'wfpbundle' : 'zip';
    const bundleFilename = mode === 'wfpbundle' ? `${safeTitle}.wfpbundle` : `${safeTitle}_Collected.zip`;
    const bundlePath = path.join(outDir, bundleFilename);
    const standaloneWfpPath = path.join(outDir, `${safeTitle}.wfp`);

    const { fileCount, innerWfpBuffer } = buildWfpBundleFileOnDisk(pid, rawTitle, bundlePath, (pct, msg) => {
      collectStatus[pid] = { running: true, percent: pct, message: msg };
    });
    fs.writeFileSync(standaloneWfpPath, innerWfpBuffer);

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
      file_count: fileCount,
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
    const rawObj = JSON.parse(fs.readFileSync(tempPath, 'utf-8'));
    try { fs.unlinkSync(tempPath); } catch {}
    if (rawObj.dgs_format && rawObj.timeline) {
      rawObj.project_id = pid;
      rawObj.timeline.project_id = pid;
      if (rawObj.scenes) saveJson(pid, 'script.json', rawObj.scenes);
      if (rawObj.script_meta) saveJson(pid, 'script_meta.json', rawObj.script_meta);
      if (rawObj.media) saveJson(pid, 'media.json', rawObj.media);
      if (rawObj.voiceover) saveJson(pid, 'voiceover.json', rawObj.voiceover);
      if (rawObj.poem_voiceover) saveJson(pid, 'poem_voiceover.json', rawObj.poem_voiceover);
      if (rawObj.logo) saveJson(pid, 'logo.json', rawObj.logo);
      saveJson(pid, 'timeline.json', rawObj.timeline);
      saveJson(pid, 'last_export.json', { title: rawObj.title || projTitle });
      return {
        project_id: pid,
        title: rawObj.title || projTitle,
        scenes: rawObj.scenes || [],
        poem: rawObj.script_meta?.poem || { has_poem: false },
        media: rawObj.media || [],
        voiceover: rawObj.voiceover || null,
        poem_voiceover: rawObj.poem_voiceover || null,
        logo: rawObj.logo || null,
        timeline: rawObj.timeline,
      };
    }
    rawObj.project_id = pid;
    saveJson(pid, 'timeline.json', rawObj);
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
      timeline: rawObj,
    };
  }

  // Extract .wfpbundle, .wfp, or .zip
  const outerZip = new AdmZip(tempPath);
  try { fs.unlinkSync(tempPath); } catch {}
  const entries = outerZip.getEntries();

  const parseDgsComment = (zObj) => {
    try {
      const c = String(zObj.getZipComment() || '');
      if (c.startsWith('DGS1:')) {
        const rawBuf = zlib.inflateSync(Buffer.from(c.slice(5), 'base64'));
        return JSON.parse(rawBuf.toString('utf-8'));
      }
    } catch {}
    return null;
  };

  // Extract Medias/{GUID}/<file>, Media/*, and Resources/* into standard project media/voiceover folders
  const extractedMap = {};
  const wfpbundleGuidMap = {};
  const wfpbundleNameMap = {};
  for (const e of entries) {
    if (e.isDirectory) continue;
    const norm = e.entryName.replace(/\\/g, '/');
    if (
      (norm.startsWith('Medias/') || norm.startsWith('Resources/') || norm.includes('/Media/') || norm.startsWith('Media/')) &&
      !norm.startsWith('ProjectFolder/') &&
      norm !== 'Medias/project_media.json'
    ) {
      const parts = norm.split('/');
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
      wfpbundleNameMap[base.toLowerCase()] = destFile;
      if (norm.startsWith('Medias/') && parts.length >= 3) {
        wfpbundleGuidMap[parts[1]] = destFile;
      }
    }
  }

  let wfpZip = outerZip;
  const innerWfpEntry = entries.find((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.wfp') && !e.entryName.includes('/'));
  if (innerWfpEntry) {
    wfpZip = new AdmZip(innerWfpEntry.getData());
  }

  const wfpEntries = wfpZip.getEntries();
  let dgsData = parseDgsComment(wfpZip) || parseDgsComment(outerZip);
  const dgsEntry = wfpZip.getEntry('ProjectFolder/dgs_project.json');
  if (!dgsData && dgsEntry) {
    try { dgsData = JSON.parse(dgsEntry.getData().toString('utf-8')); } catch {}
  }

  let projInfoData = null;
  const pInfoEntry = wfpZip.getEntry('ProjectFolder/project_info.json');
  if (pInfoEntry) {
    try { projInfoData = JSON.parse(pInfoEntry.getData().toString('utf-8')); } catch {}
  }

  let wesprojData = null;
  const wesEntry = wfpEntries.find((e) => !e.isDirectory && e.entryName.replace(/\\/g, '/').endsWith('timeline.wesproj'));
  if (wesEntry) {
    try { wesprojData = JSON.parse(wesEntry.getData().toString('utf-8')); } catch {}
  }

  const resolveDocDirOrPath = (rawFn) => {
    let s = String(rawFn || '').trim();
    if (!s) return '';
    while (s.startsWith('file:/')) {
      s = s.startsWith('file://') ? s.slice(7) : s.slice(6);
    }
    const normS = s.replace(/\\/g, '/');
    if (normS.includes('%DOCUMENT_DIR%/Medias/')) {
      const after = normS.split('%DOCUMENT_DIR%/Medias/')[1];
      const parts = after.split('/');
      if (parts[0] && wfpbundleGuidMap[parts[0]]) return wfpbundleGuidMap[parts[0]];
      if (extractedMap[`Medias/${after}`]) return extractedMap[`Medias/${after}`];
    }
    if (normS.startsWith('Medias/')) {
      const parts = normS.split('/');
      if (parts.length >= 2 && wfpbundleGuidMap[parts[1]]) return wfpbundleGuidMap[parts[1]];
      if (extractedMap[normS]) return extractedMap[normS];
    }
    if (extractedMap[normS]) return extractedMap[normS];
    const baseLow = path.basename(normS).toLowerCase();
    if (baseLow && wfpbundleNameMap[baseLow]) return wfpbundleNameMap[baseLow];
    if (fs.existsSync(s)) return path.resolve(s);
    return s;
  };

  // Path 1: Full DGS Bundle Restoration (`ProjectFolder/dgs_project.json` or `DGS1:` comment)
  if (dgsData && dgsData.timeline) {
    const title = dgsData.title || projInfoData?.project_file_name || projTitle;
    if (Array.isArray(dgsData.scenes)) saveJson(pid, 'script.json', dgsData.scenes);
    saveJson(pid, 'script_meta.json', {
      ...(dgsData.script_meta || { format: 'imported_wfpbundle', filename: `${title}.xlsx` }),
      imported_bundle: true,
    });

    if (dgsData.logo && dgsData.logo.path) {
      const resolvedLogo = resolveDocDirOrPath(dgsData.logo.path);
      if (resolvedLogo && fs.existsSync(resolvedLogo)) {
        const logoDir = path.join(root, 'logo');
        fs.mkdirSync(logoDir, { recursive: true });
        const dstLogo = path.join(logoDir, path.basename(resolvedLogo));
        if (path.resolve(resolvedLogo) !== path.resolve(dstLogo)) {
          fs.copyFileSync(resolvedLogo, dstLogo);
          if (resolvedLogo.includes(path.join('media', 'images'))) {
            try { fs.unlinkSync(resolvedLogo); } catch {}
          }
        }
        dgsData.logo.path = dstLogo;
        saveJson(pid, 'logo.json', dgsData.logo);
        if (dgsData.timeline) dgsData.timeline.logo_path = dstLogo;
      }
    }

    const mediaItems = await reindexMedia(pid);
    const mediaByPath = new Map(mediaItems.map((m) => [path.resolve(m.path), m]));
    const mediaByName = new Map(mediaItems.map((m) => [m.filename.toLowerCase(), m]));

    if (dgsData.voiceover) {
      const vo = { ...dgsData.voiceover };
      if (vo.path) vo.path = resolveDocDirOrPath(vo.path);
      if (Array.isArray(vo.slots)) {
        for (const s of vo.slots) {
          if (s && s.path) s.path = resolveDocDirOrPath(s.path);
        }
        // If multi-slot VO was archived as individual slots without merged_narration.mp3, rebuild merged narration VO
        if (vo.slots.length > 1 && (!vo.path || !fs.existsSync(vo.path))) {
          const rebuilt = await rebuildMergedVo(pid, vo.slots);
          vo.path = rebuilt.path;
          vo.duration = rebuilt.duration;
        }
      }
      saveJson(pid, 'voiceover.json', vo);
      dgsData.voiceover = vo;
    }

    if (dgsData.poem_voiceover) {
      const pvo = { ...dgsData.poem_voiceover };
      if (pvo.path) pvo.path = resolveDocDirOrPath(pvo.path);
      saveJson(pid, 'poem_voiceover.json', pvo);
      dgsData.poem_voiceover = pvo;
    }

    const plan = dgsData.timeline;
    plan.project_id = pid;
    if (plan.voiceover_path) plan.voiceover_path = dgsData.voiceover?.path || resolveDocDirOrPath(plan.voiceover_path);
    if (plan.poem_voiceover_path) plan.poem_voiceover_path = resolveDocDirOrPath(plan.poem_voiceover_path);
    for (const c of plan.clips || []) {
      if (c.media_path) {
        const rp = resolveDocDirOrPath(c.media_path);
        const found = (rp && mediaByPath.get(path.resolve(rp))) || mediaByName.get(path.basename(rp).toLowerCase());
        c.media_path = found ? found.path : rp;
        if (found) c.media_id = found.id;
      }
    }
    for (const s of plan.voiceover_slots || []) {
      if (s && s.path) s.path = resolveDocDirOrPath(s.path);
    }
    if (!plan.srt_cues || !plan.srt_cues.length) {
      plan.srt_cues = buildSrtCues(plan.clips || [], plan);
    }
    saveJson(pid, 'timeline.json', plan);
    saveJson(pid, 'last_export.json', { title });
    return {
      project_id: pid,
      title,
      scenes: loadJson(pid, 'script.json') || [],
      poem: dgsData.script_meta?.poem || { has_poem: Boolean(plan.has_poem) },
      media: mediaItems,
      voiceover: loadJson(pid, 'voiceover.json'),
      poem_voiceover: loadJson(pid, 'poem_voiceover.json'),
      logo: loadJson(pid, 'logo.json'),
      timeline: plan,
    };
  }

  // Path 2: Native Wondershare Filmora 15/16 `.wfp` or `.wfpbundle` (`timeline.wesproj` created in Filmora 15!)
  if (wesprojData) {
    const title = projInfoData?.project_file_name || projTitle;
    const resUidMap = {};
    for (const rItem of wesprojData.resources || []) {
      const ruid = String(rItem.sourceUuid || rItem.uid || '').trim();
      const rfn = String(rItem.filename || '').trim();
      if (ruid && rfn) resUidMap[ruid] = rfn;
    }

    const tlInfos = wesprojData.timelineInfos || [];
    const clips = [];
    const scenesList = [];
    const voClipsRaw = [];
    const srtCues = [];
    let logoPath = null;

    if (tlInfos.length) {
      const allTracks = tlInfos[0].trackInfos || [];
      let mainVidIdx = -1;
      let maxVidCount = -1;
      allTracks.forEach((tr, idx) => {
        if (tr.trackType === 1 && (tr.clipList || []).some((c) => c.type === 1 || c.type === 3)) {
          const cnt = (tr.clipList || []).length;
          if (cnt > maxVidCount) {
            maxVidCount = cnt;
            mainVidIdx = idx;
          }
        }
      });

      // Pass 1: Extract embedded Filmora 15 subtitle cues (`type === 22` with `subtitleSource.Items`)
      for (const track of allTracks) {
        for (const c of track.clipList || []) {
          if (c.type === 22 && c.subtitleSource) {
            try {
              const subSrc = typeof c.subtitleSource === 'string' ? JSON.parse(c.subtitleSource) : c.subtitleSource;
              const clipTlB = Number(c.tlBegin || 0) / TICKS_PER_SEC;
              for (const item of subSrc.Items || []) {
                const txt = String(item.Content || '').trim();
                if (!txt) continue;
                const sSec = Math.round((clipTlB + Number(item.Start || 0) / TICKS_PER_SEC) * 1000) / 1000;
                const eSec = Math.round((clipTlB + Number(item.End || 0) / TICKS_PER_SEC) * 1000) / 1000;
                if (eSec > sSec) {
                  srtCues.push({ index: srtCues.length + 1, screen: '', start: sSec, end: eSec, text: txt });
                }
              }
            } catch {}
          }
        }
      }

      // Pass 2: Extract video/image scenes, upper-track logo overlay, and audio VO clips
      for (let idx = 0; idx < allTracks.length; idx++) {
        const track = allTracks[idx];
        const ttype = track.trackType;
        for (const c of track.clipList || []) {
          const subClips = c.clipList || [];
          const suid = String(
            c.sourceUuid || c.source || (subClips[0] && (subClips[0].sourceUuid || subClips[0].source)) || '',
          ).trim();
          const rawFn = String(
            c.filename || (subClips[0] && subClips[0].filename) || resUidMap[suid] || '',
          ).trim();
          if (!rawFn) continue;
          let fn = resolveDocDirOrPath(rawFn);
          const tlB = Number(c.tlBegin || 0) / TICKS_PER_SEC;
          const tlE = Number(c.tlEnd || 0) / TICKS_PER_SEC;
          let inP = Number(c.inPoint || 0) / TICKS_PER_SEC;
          let outP = Number(c.outPoint || 0) / TICKS_PER_SEC;
          if (inP >= 3600.0) {
            inP = Math.round((inP - 3600.0) * 1000) / 1000;
            outP = Math.round((outP - 3600.0) * 1000) / 1000;
          }
          const dur = Math.max(0.1, Math.round((tlE - tlB) * 1000) / 1000);

          if (ttype === 1 && (c.type === 1 || c.type === 3)) {
            const fext = path.extname(fn).toLowerCase();
            if (idx !== mainVidIdx && (track.clipList || []).length === 1 && IMAGE_EXT.has(fext)) {
              const logoDir = path.join(root, 'logo');
              fs.mkdirSync(logoDir, { recursive: true });
              const dstLogo = path.join(logoDir, path.basename(fn));
              if (fs.existsSync(fn)) {
                try {
                  if (path.resolve(fn) !== path.resolve(dstLogo)) {
                    fs.copyFileSync(fn, dstLogo);
                    if (fn.includes(path.join('media', 'images'))) {
                      try { fs.unlinkSync(fn); } catch {}
                    }
                  }
                  fn = dstLogo;
                } catch {}
              }
              logoPath = fn;
              continue;
            }

            const sceneIdx = clips.length + 1;
            const detScr = detectScreens(path.basename(fn))[0];
            const usedScreens = new Set(clips.map((ec) => ec.screen));
            let screen = detScr && !usedScreens.has(detScr) ? detScr : `screen_${sceneIdx}`;
            let candIdx = sceneIdx;
            while (usedScreens.has(screen)) {
              candIdx++;
              screen = `screen_${candIdx}`;
            }
            const kind = IMAGE_EXT.has(fext) ? 'image' : 'video';

            const matchedCues = [];
            for (const cue of srtCues) {
              const midT = 0.5 * (cue.start + cue.end);
              if (tlB - 0.05 <= midT && midT <= tlE + 0.05) {
                if (!cue.screen) cue.screen = screen;
                matchedCues.push(cue);
              }
            }
            const voTxt = matchedCues.map((q) => q.text).join(' ').trim();
            const displayTxt = voTxt || path.parse(fn).name;

            clips.push({
              screen,
              media_id: null,
              media_path: fn,
              kind,
              start: Math.round(tlB * 1000) / 1000,
              end: Math.round(tlE * 1000) / 1000,
              duration: dur,
              source_in: Math.round(inP * 1000) / 1000,
              source_out: Math.round(outP * 1000) / 1000,
              script_text: displayTxt,
              vo_text: voTxt,
              narration_in: Math.round(tlB * 1000) / 1000,
              narration_out: Math.round(tlE * 1000) / 1000,
              caption_in: matchedCues.length ? Math.round(matchedCues[0].start * 1000) / 1000 : null,
              caption_out: matchedCues.length ? Math.round(matchedCues[matchedCues.length - 1].end * 1000) / 1000 : null,
              caption_text: voTxt,
              fit: kind === 'video' ? 'trim' : 'hold',
            });
            scenesList.push({
              screen,
              text: displayTxt,
              index: sceneIdx,
              scene_no: sceneIdx,
              section: 'story',
              duration: dur,
              onscreen_text: voTxt,
              voiceover_text: voTxt,
              voiceover_raw: voTxt,
              visual_type: kind === 'image' ? 'Image' : 'Video',
              visual_direction: path.basename(fn),
              audio_start: Math.round(tlB * 1000) / 1000,
              audio_end: Math.round(tlE * 1000) / 1000,
              is_poem: false,
              source: 'filmora',
            });
          } else if (ttype === 2 && track.trackTag !== 1 && fn) {
            voClipsRaw.push({
              path: fn,
              filename: path.basename(fn),
              tl_b: Math.round(tlB * 1000) / 1000,
              tl_e: Math.round(tlE * 1000) / 1000,
              in_p: Math.round(inP * 1000) / 1000,
              out_p: Math.round(outP * 1000) / 1000,
              dur,
            });
          }
        }
      }
    }

    const mediaItems = await reindexMedia(pid);
    const mediaByPath = new Map(mediaItems.map((m) => [path.resolve(m.path), m]));
    const mediaByName = new Map(mediaItems.map((m) => [m.filename.toLowerCase(), m]));
    for (const c of clips) {
      const found = (c.media_path && mediaByPath.get(path.resolve(c.media_path))) || mediaByName.get(path.basename(c.media_path).toLowerCase());
      if (found) {
        c.media_id = found.id;
        c.media_path = found.path;
      }
    }

    const voSlots = [];
    let voPath = null;
    if (voClipsRaw.length) {
      voClipsRaw.sort((a, b) => a.tl_b - b.tl_b);
      for (let i = 0; i < voClipsRaw.length; i++) {
        const vc = voClipsRaw[i];
        voSlots.push({
          slot: i + 1,
          filename: vc.filename,
          duration: vc.dur,
          start_offset: vc.tl_b,
          end_offset: vc.tl_e,
          start: vc.tl_b,
          end: vc.tl_e,
          path: vc.path,
        });
      }
      if (voClipsRaw.length === 1 && voClipsRaw[0].in_p <= 0.05) {
        voPath = voClipsRaw[0].path;
      } else {
        const voDir = path.join(root, 'voiceover');
        fs.mkdirSync(voDir, { recursive: true });
        const mergedVo = path.join(voDir, 'merged_narration.mp3');
        try {
          const inputs = [];
          const fparts = [];
          const clabels = [];
          let cursor = 0;
          let segCount = 0;
          for (let idxV = 0; idxV < voClipsRaw.length; idxV++) {
            const vc = voClipsRaw[idxV];
            if (vc.tl_b > cursor + 0.02) {
              const gapD = vc.tl_b - cursor;
              const glbl = `g${idxV}`;
              fparts.push(`anullsrc=r=44100:cl=stereo,atrim=0:${gapD.toFixed(3)},asetpts=PTS-STARTPTS[${glbl}]`);
              clabels.push(`[${glbl}]`);
              segCount++;
            }
            inputs.push('-i', vc.path);
            const albl = `a${idxV}`;
            fparts.push(`[${idxV}:a]atrim=start=${vc.in_p.toFixed(3)}:end=${vc.out_p.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[${albl}]`);
            clabels.push(`[${albl}]`);
            segCount++;
            cursor = vc.tl_e;
          }
          fparts.push(`${clabels.join('')}concat=n=${segCount}:v=0:a=1[aout]`);
          await runFfmpeg(['-y', ...inputs, '-filter_complex', fparts.join(';'), '-map', '[aout]', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', mergedVo]);
          if (fs.existsSync(mergedVo) && fs.statSync(mergedVo).size > 256) {
            voPath = mergedVo;
          }
        } catch {
          voPath = voClipsRaw[0].path;
        }
      }
    }

    const totalDur = Math.max(
      clips.reduce((acc, c) => Math.max(acc, c.end || 0), 0),
      voSlots.reduce((acc, s) => Math.max(acc, s.end || 0), 0),
      10,
    );
    const finalSrtCues = srtCues.length ? srtCues : buildSrtCues(clips);
    const plan = {
      project_id: pid,
      total_duration: totalDur,
      clips,
      voiceover_path: voPath,
      voiceover_slots: voSlots,
      logo_path: logoPath,
      logo_enabled: Boolean(logoPath),
      language: 'en',
      srt_cues: finalSrtCues,
      qa_issues: [],
      qa_summary: `Imported from Filmora 15 (${clips.length} scenes, ${finalSrtCues.length} captions)`,
    };
    saveJson(pid, 'script.json', scenesList);
    saveJson(pid, 'script_meta.json', {
      format: 'imported_wfp',
      imported_bundle: true,
      filename: `${title}.xlsx`,
      scene_count: scenesList.length,
      poem: { has_poem: false },
    });
    saveJson(pid, 'last_export.json', { title });
    let voObj = null;
    if (voPath) {
      const voLabel = voClipsRaw.length > 1 ? Array.from(new Set(voClipsRaw.map((v) => v.filename))).join(' + ') : path.basename(voPath);
      voObj = {
        path: voPath,
        filename: voLabel,
        duration: (await probeDuration(voPath)) || totalDur,
        kind: 'narration',
        slots: voSlots,
      };
      saveJson(pid, 'voiceover.json', voObj);
    }
    let logoObj = null;
    if (logoPath) {
      logoObj = { path: logoPath, filename: path.basename(logoPath), enabled: true };
      saveJson(pid, 'logo.json', logoObj);
    }
    saveJson(pid, 'timeline.json', plan);
    return {
      project_id: pid,
      title,
      scenes: scenesList,
      poem: { has_poem: false },
      media: mediaItems,
      voiceover: voObj,
      poem_voiceover: null,
      logo: logoObj,
      timeline: plan,
    };
  }

  // Path 3: Legacy `Timelines/timeline.json` fallback
  const tlEntry = wfpZip.getEntry('Timelines/timeline.json');
  if (!tlEntry) {
    throw new Error('Invalid .wfp/.wfpbundle: missing ProjectFolder/Medias/.../timeline.wesproj');
  }
  const tlObj = inflateRawJson(tlEntry.getData());
  const mediaItems = await reindexMedia(pid);
  const mediaByPath = new Map(mediaItems.map((m) => [path.resolve(m.path), m]));
  const mediaByName = new Map(mediaItems.map((m) => [m.filename.toLowerCase(), m]));

  let clips = [];
  if (tlObj.dgs_plan_snapshot && Array.isArray(tlObj.dgs_plan_snapshot.clips)) {
    clips = tlObj.dgs_plan_snapshot.clips.map((c, idx) => {
      const localPath = resolveDocDirOrPath(c.media_path);
      const found =
        (localPath && mediaByPath.get(path.resolve(localPath))) ||
        mediaByName.get(path.basename(localPath || '').toLowerCase());
      return {
        ...c,
        media_id: found ? found.id : c.media_id,
        media_path: found ? found.path : localPath,
        screen: c.screen || `screen_${idx + 1}`,
      };
    });
  }
  const totalDur = clips.reduce((acc, c) => Math.max(acc, c.end || 0), 0) || 10;
  const plan = {
    project_id: pid,
    total_duration: totalDur,
    clips,
    srt_cues: buildSrtCues(clips),
    qa_issues: [],
    qa_summary: `Imported ${clips.length} clips from ${origName}`,
  };
  saveJson(pid, 'timeline.json', plan);
  return {
    project_id: pid,
    title: projTitle,
    scenes: [],
    poem: { has_poem: false },
    media: mediaItems,
    voiceover: null,
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

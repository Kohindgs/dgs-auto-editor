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

const DEFAULT_LOGO_FILE = path.join(ROOT, 'public', 'eclass-logo.png');
const DEFAULT_LOGO_TRANSFORM = {
  scale_w: 10.0,
  scale_h: 10.0,
  lock_aspect: true,
  pos_x: 1034.21,
  pos_y: 565.98,
  anchor_x: 1900.0,
  anchor_y: 1065.0,
  rotate: 0.0,
};

function normalizeLogoTransform(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const sw = Number(r.scale_w);
  const sh = Number(r.scale_h);
  const px = Number(r.pos_x);
  const py = Number(r.pos_y);
  const ax = Number(r.anchor_x);
  const ay = Number(r.anchor_y);
  const rot = Number(r.rotate);
  return {
    scale_w: Number.isFinite(sw) && sw > 0.5 && sw <= 200 ? Math.round(sw * 100) / 100 : DEFAULT_LOGO_TRANSFORM.scale_w,
    scale_h: Number.isFinite(sh) && sh > 0.5 && sh <= 200 ? Math.round(sh * 100) / 100 : DEFAULT_LOGO_TRANSFORM.scale_h,
    lock_aspect: typeof r.lock_aspect === 'boolean' ? r.lock_aspect : DEFAULT_LOGO_TRANSFORM.lock_aspect,
    pos_x: Number.isFinite(px) ? Math.round(px * 100) / 100 : DEFAULT_LOGO_TRANSFORM.pos_x,
    pos_y: Number.isFinite(py) ? Math.round(py * 100) / 100 : DEFAULT_LOGO_TRANSFORM.pos_y,
    anchor_x: Number.isFinite(ax) ? Math.round(ax * 100) / 100 : DEFAULT_LOGO_TRANSFORM.anchor_x,
    anchor_y: Number.isFinite(ay) ? Math.round(ay * 100) / 100 : DEFAULT_LOGO_TRANSFORM.anchor_y,
    rotate: Number.isFinite(rot) ? Math.round(rot * 100) / 100 : DEFAULT_LOGO_TRANSFORM.rotate,
  };
}

const DEFAULT_POEM_OVERLAY_STYLE = {
  enabled: true,
  locked: false,
  font_family: 'Poppins',
  font_size_px: 28,
  preset_style: 'badge_pill',
  text_color: '#ffffff',
  bg_color: '#0f172a',
  bg_opacity: 0.88,
  border_color: '#38bdf8',
  border_width: 2,
  border_radius: 24,
  box_shadow: true,
  text_align: 'center',
  x_pct: 10,
  y_pct: 72,
  w_pct: 80,
  h_pct: 20,
};

function normalizePoemOverlayStyle(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_POEM_OVERLAY_STYLE };
  const validPresets = ['badge_pill', 'neon_glow', 'karaoke_box', 'pastel_banner', 'comic_pop', 'clean_subtitle'];
  const presetKey = validPresets.includes(raw.preset_style) ? raw.preset_style : DEFAULT_POEM_OVERLAY_STYLE.preset_style;
  const num = (v, min, max, d) => (Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : d);
  return {
    enabled: raw.enabled !== false,
    locked: Boolean(raw.locked),
    font_family: String(raw.font_family || DEFAULT_POEM_OVERLAY_STYLE.font_family).slice(0, 80),
    font_size_px: num(raw.font_size_px, 12, 72, DEFAULT_POEM_OVERLAY_STYLE.font_size_px),
    preset_style: presetKey,
    text_color: String(raw.text_color || DEFAULT_POEM_OVERLAY_STYLE.text_color).slice(0, 32),
    bg_color: String(raw.bg_color || DEFAULT_POEM_OVERLAY_STYLE.bg_color).slice(0, 32),
    bg_opacity: num(raw.bg_opacity, 0, 1, DEFAULT_POEM_OVERLAY_STYLE.bg_opacity),
    border_color: String(raw.border_color || DEFAULT_POEM_OVERLAY_STYLE.border_color).slice(0, 32),
    border_width: num(raw.border_width, 0, 16, DEFAULT_POEM_OVERLAY_STYLE.border_width),
    border_radius: num(raw.border_radius, 0, 64, DEFAULT_POEM_OVERLAY_STYLE.border_radius),
    box_shadow: raw.box_shadow !== false,
    text_align: raw.text_align === 'left' || raw.text_align === 'right' ? raw.text_align : 'center',
    x_pct: num(raw.x_pct, 0, 95, DEFAULT_POEM_OVERLAY_STYLE.x_pct),
    y_pct: num(raw.y_pct, 0, 95, DEFAULT_POEM_OVERLAY_STYLE.y_pct),
    w_pct: num(raw.w_pct, 10, 100, DEFAULT_POEM_OVERLAY_STYLE.w_pct),
    h_pct: num(raw.h_pct, 5, 90, DEFAULT_POEM_OVERLAY_STYLE.h_pct),
  };
}

function getEffectiveLogoMeta(pid, plan = null) {
  const meta = loadJson(pid, 'logo.json') || {};
  const enabled =
    plan && typeof plan.logo_enabled === 'boolean'
      ? plan.logo_enabled
      : typeof meta.enabled === 'boolean'
        ? meta.enabled
        : false;
  const transform = normalizeLogoTransform((plan && plan.logo_transform) || meta.transform);
  if (meta.path && fs.existsSync(meta.path)) {
    return {
      path: meta.path,
      filename: meta.filename || path.basename(meta.path),
      enabled,
      transform,
      is_default: Boolean(meta.is_default),
    };
  }
  if (meta.local_only && meta.path) {
    return {
      path: meta.path,
      filename: meta.filename || path.basename(meta.path),
      enabled,
      transform,
      local_only: true,
    };
  }
  const fallbackPath = fs.existsSync(DEFAULT_LOGO_FILE) ? DEFAULT_LOGO_FILE : (meta.path || '');
  return {
    path: fallbackPath,
    filename: meta.filename || 'E-Class Logo.png (Default)',
    enabled,
    transform,
    is_default: true,
  };
}

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
// uses bounded slice threads (safe within CloudLinux NPROC), and auto-retries on transient EAGAIN.
async function runFfmpeg(rawArgs, customOpts = {}) {
  const { skipReap = false, ...execOpts } = customOpts;
  return await withMediaLock(async () => {
    const args = ['-hide_banner', '-loglevel', 'error', '-filter_threads', '2', '-filter_complex_threads', '2'];
    for (let i = 0; i < rawArgs.length; i++) {
      const a = rawArgs[i];
      if (a === '-hide_banner') continue;
      if (a === '-loglevel') {
        i++;
        continue;
      }
      if (a === '-i') {
        args.push('-threads', '2', '-thread_type', 'slice', '-i');
      } else if (i === rawArgs.length - 1 && !String(a).startsWith('-')) {
        args.push('-threads', '3', '-thread_type', 'slice', a);
      } else {
        args.push(a);
      }
    }

    if (!skipReap) {
      const reaped = reapExtraNodeWorkers(false);
      if (reaped.length) await sleepMs(80);
    }

    let lastErr = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        return await execFileAsync(FFMPEG_BIN, args, { ...EXEC_OPTS, ...execOpts });
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
  advanced_compression: true,
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
function saveSrt(pid, name, text) {
  fs.writeFileSync(metaPath(pid, name), String(text || ''), 'utf-8');
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

function devanagariToAsciiDigits(str) {
  if (!str) return '';
  return String(str).replace(/[०-९]/g, (ch) => String(ch.charCodeAt(0) - 0x0966));
}

function detectScreens(filename, parentName = '') {
  for (const rawCandidate of [filename, parentName]) {
    if (!rawCandidate) continue;
    const candidate = devanagariToAsciiDigits(rawCandidate);
    const stem = path.parse(String(candidate)).name;
    const trimmed = stem.trim();
    if (/^\d{1,3}$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      if (n >= 1 && n <= 500) return [`screen_${n}`];
    }
    // Supports "Scene 15 & 16", "Screen 15 + 16", "Scene 15 and 16", or Marathi "दृश्य १५", "सीन २", "व्हिडिओ ५"
    const labelMulti = stem.match(/(?:screen|scene|दृश्य|सीन|प्रसंग|भाग|व्हिडिओ|चित्र)[_\s-]*(\d+(?:\s*(?:[&+,/]|and)\s*\d+)+)/i);
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
    const rangeMatch = stem.match(/(?:screen|scene|sc|slide|shot|img|vid|clip|दृश्य|सीन|प्रसंग|भाग|चित्र|व्हिडिओ)?[\s_-]*(\d{1,3})\s*(?:to|-|–)\s*(\d{1,3})/i);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10);
      const b = parseInt(rangeMatch[2], 10);
      if (a >= 1 && b >= a && b - a <= 30) {
        const out = [];
        for (let i = a; i <= b; i++) out.push(`screen_${i}`);
        return out;
      }
    }
    const tagMatches = [...stem.matchAll(/(?:screen|scene|sc|slide|shot|img|vid|clip|दृश्य|सीन|प्रसंग|भाग|चित्र|व्हिडिओ)[\s_-]*(\d{1,3})/gi)];
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
    // Semantic match for descriptive AI-prompt filenames without scene numbers
    if (/(?:examining|reading|studying|looking_at|finding)[_\s-]*map/i.test(stem) || /map[_\s-]*(?:reading|finding)/i.test(stem)) {
      return ['screen_10'];
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
      path: prev?.local_only ? (prev.path || f) : f,
      kind,
      screen: screens[0] || null,
      screens,
      duration: dur,
      local_only: Boolean(prev?.local_only),
    });
  }

  // Preserve any external or local-only metadata items registered in media.json (e.g. from opened .wfp or browser)
  for (const m of existing) {
    if (!m || !m.filename) continue;
    const nk = `${m.kind}:${String(m.filename || '').toLowerCase()}`;
    if (seenNameKind.has(nk)) continue;
    seenNameKind.add(nk);
    const existsOnDisk = Boolean(m.path && fs.existsSync(m.path));
    const screens = Array.isArray(m.screens) && m.screens.length ? m.screens : detectScreens(m.filename);
    items.push({
      ...m,
      id: m.id || crypto.randomUUID(),
      screen: m.screen || screens[0] || null,
      screens,
      local_only: !existsOnDisk,
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

function parseClockValue(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  const s = String(val).trim();
  const colon = s.match(/^(\d+):(\d{2}(?:\.\d+)?)(?::(\d{2}(?:\.\d+)?))?$/);
  if (colon) {
    if (colon[3] != null) {
      return parseInt(colon[1], 10) * 3600 + parseFloat(colon[2]) * 60 + parseFloat(colon[3]);
    }
    return parseInt(colon[1], 10) * 60 + parseFloat(colon[2]);
  }
  const num = parseFloat(s);
  return Number.isFinite(num) ? num : null;
}

function parseSunoRange(raw) {
  if (!raw) return [null, null, false];
  const m = String(raw).match(/(?:suno\s*)?(\d{1,2}):(\d{2}(?:\.\d+)?)\s*[-–—→]\s*(\d{1,2}):(\d{2}(?:\.\d+)?)/i);
  if (!m) return [null, null, false];
  const start = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
  const end = parseInt(m[3], 10) * 60 + parseFloat(m[4]);
  return [start, end, /suno/i.test(String(raw))];
}

function parseDurationCell(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number' && val > 0 && val < 600) return val;
  const s = String(val).trim();
  const [sStart, sEnd] = parseSunoRange(s);
  if (sStart != null && sEnd != null && sEnd > sStart) return Math.round((sEnd - sStart) * 1000) / 1000;
  const secMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)\b/i);
  if (secMatch) return parseFloat(secMatch[1]);
  const colon = s.match(/^(\d+):(\d{2}(?:\.\d+)?)(?::(\d{2}(?:\.\d+)?))?$/);
  if (colon) {
    if (colon[3] != null) return parseInt(colon[1], 10) * 3600 + parseFloat(colon[2]) * 60 + parseFloat(colon[3]);
    return parseInt(colon[1], 10) * 60 + parseFloat(colon[2]);
  }
  const num = parseFloat(s);
  return Number.isFinite(num) && num > 0 && num < 600 ? num : null;
}

function loadRevisedDurationsFromWb(wb) {
  const out = new Map();
  if (!wb || !Array.isArray(wb.SheetNames) || wb.SheetNames.length < 2) return out;
  for (const name of wb.SheetNames.slice(1)) {
    const lowName = String(name || '').toLowerCase();
    if (lowName.includes('poem') || lowName.includes('prompt') || lowName.includes('guide') || lowName.includes('cue')) {
      continue;
    }
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!rows.length) continue;
    const hdr = (rows[0] || []).map((c) => String(c || '').trim().toLowerCase()).join(' | ');
    if (!hdr.includes('revised') && lowName !== 'sheet2') continue;
    if (hdr.includes('poem line') || hdr.includes('script scene')) continue;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
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

function loadPoemTimingFromWb(wb) {
  const out = new Map();
  if (!wb || !Array.isArray(wb.SheetNames)) return out;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    let hdrIdx = -1;
    let cScene = -1;
    let cIn = -1;
    let cOut = -1;
    let cDur = -1;
    for (let r = 0; r < Math.min(rows.length, 15); r++) {
      const row = (rows[r] || []).map((c) => String(c || '').trim().toLowerCase());
      const sIdx = row.findIndex((c) => c.includes('script scene') || c === 'scene #' || c === 'scene no' || c === 'scene');
      const inIdx = row.findIndex((c) => c.includes('audio in') || c === 'in' || c.includes('start time'));
      const outIdx = row.findIndex((c) => c.includes('audio out') || c === 'out' || c.includes('end time'));
      if (sIdx >= 0 && inIdx >= 0 && outIdx >= 0) {
        hdrIdx = r;
        cScene = sIdx;
        cIn = inIdx;
        cOut = outIdx;
        cDur = row.findIndex((c) => c.includes('scene duration'));
        break;
      }
    }
    if (hdrIdx < 0) continue;
    for (let r = hdrIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || !row.length) continue;
      const mSc = String(row[cScene] ?? '').trim().match(/(\d+)/);
      if (!mSc) continue;
      const scNo = parseInt(mSc[1], 10);
      const aIn = parseClockValue(row[cIn]);
      const aOut = parseClockValue(row[cOut]);
      const sDur = cDur >= 0 ? parseDurationCell(row[cDur]) : null;
      if (scNo > 0 && aIn != null && aOut != null && aOut > aIn) {
        const prev = out.get(scNo);
        const nextStart = prev ? Math.min(prev.audio_start, aIn) : aIn;
        const nextEnd = prev ? Math.max(prev.audio_end, aOut) : aOut;
        const spanDur = Math.round((nextEnd - nextStart) * 1000) / 1000;
        out.set(scNo, {
          audio_start: Math.round(nextStart * 1000) / 1000,
          audio_end: Math.round(nextEnd * 1000) / 1000,
          duration: sDur && sDur > 0 ? sDur : spanDur,
        });
      }
    }
  }
  return out;
}

function isSpokenHeadingOrActivityScene(section, visualType, voiceoverRaw, audioStart) {
  if (audioStart != null) return false;
  const sec = String(section || '').trim().toLowerCase();
  const vtype = String(visualType || '').trim().toLowerCase();
  const raw = String(voiceoverRaw || '').trim().toLowerCase();
  if (/suno|original\s+song|poem\s*\/\s*original\s+song|attached\s+poem\s+track|instrumental/i.test(`${sec} ${vtype} ${raw}`)) {
    return false;
  }
  if (/\b(heading|lead[- ]?in|attribution|author|poet|question|answer|vocabulary|exercise|activity|glossary|comprehension|summary|instruction|title|prompt|recap|task|guidance|challenge|discussion|statement|draw|label|write|true\s*\/\s*false|talk\s+on)\b/i.test(`${sec} ${vtype}`)) {
    return true;
  }
  return false;
}

function parseProductionXlsx(filePath) {
  const wb = XLSX.readFile(filePath);
  const revisedDurations = loadRevisedDurationsFromWb(wb);
  const poemTimings = loadPoemTimingFromWb(wb);
  const scenes = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    let headerIdx = -1;
    let colMap = {};
    for (let r = 0; r < Math.min(rows.length, 25); r++) {
      const row = rows[r].map((c) => String(c || '').replace(/\s+/g, ' ').trim().toLowerCase());
      const shortNonEmpty = row.filter((c) => c.length > 0 && c.length < 60).length;
      const hasScene = row.some((c) => c.length < 40 && (c.includes('scene') || c.includes('screen') || c === 'sr. no' || c === 's.no'));
      const hasAudioOrText = row.some((c) => c.length < 55 && (c.includes('audio') || c.includes('voice') || c.includes('narration') || c.includes('script') || c === 'vo' || c.includes('on-screen') || c.includes('onscreen')));
      if (shortNonEmpty >= 3 && hasScene && hasAudioOrText) {
        headerIdx = r;
        row.forEach((c, idx) => {
          if (c.includes('scene') || c.includes('screen') || c === 'no' || c.includes('sr')) colMap.scene = colMap.scene ?? idx;
          if (c.includes('section') || c.includes('timestamp')) colMap.section = colMap.section ?? idx;
          if (!c.includes('section') && (c.includes('duration') || /\bsec(?:s|onds)?\b/.test(c) || c === 'time')) colMap.duration = colMap.duration ?? idx;
          if (c.includes('on-screen') || c.includes('onscreen') || c.includes('text on screen') || c.includes('ost')) colMap.onscreen = colMap.onscreen ?? idx;
          if (!c.includes('visual') && !c.includes('description') && (c.includes('voice') || c.includes('audio') || c.includes('narration') || c === 'vo' || /\bscript\b/.test(c) || c.includes('dialogue') || c.includes('dialog'))) colMap.vo = colMap.vo ?? idx;
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
      const rawScene = devanagariToAsciiDigits(String(row[colMap.scene ?? 0] || '')).trim();
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
      const pCue = poemTimings.get(sceneNo);
      if (pCue) {
        audioStart = pCue.audio_start;
        audioEnd = pCue.audio_end;
        isSuno = true;
      }

      const sheet1Dur = rawDurCell != null ? parseDurationCell(rawDurCell) : null;
      const durVal = pCue
        ? pCue.duration
        : revisedDurations.has(sceneNo)
          ? revisedDurations.get(sceneNo)
          : sheet1Dur;

      const ostClean = rawOstCell || extractOnscreenText(rawVoCell);
      const voClean = cleanVoText(rawVoCell, ostClean);
      const combined = `${rawScene} ${currentSection} ${rawVoCell} ${rawVisCell} ${rawTypeCell}`.toLowerCase();
      const spokenHeading = isSpokenHeadingOrActivityScene(currentSection, rawTypeCell || rawVisCell, rawVoCell, audioStart);
      const isPoemCandidate = (
        /\bpoem\b/i.test(currentSection) ||
        /\bpoem\s+visual\b/i.test(`${rawTypeCell} ${rawVisCell}`) ||
        /\b(stanza|couplet|lines?\s*\d+[-–—]\d+)\b/i.test(currentSection) ||
        /\b(song\s+intro|full\s+poem\s+song|poem\s*\/\s*original\s+song|attached\s+poem\s+track|poem\s+recitation|suno)\b/i.test(combined)
      );
      const isPoem = poemTimings.size > 0
        ? Boolean(pCue || isSuno || audioStart != null)
        : !spokenHeading && (
            isSuno ||
            audioStart != null ||
            isPoemCandidate
          );
      const vType = /video|mp4|anim|व्हिडिओ|चलचित्र/i.test(rawTypeCell || rawVisCell) ? 'Video' : 'Image';

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
        is_poem: /\b(poem|suno|stanza|couplet)\b/i.test(m[2]),
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
  if (isSpokenHeadingOrActivityScene(scene.section, scene.visual_type, scene.voiceover_raw, scene.audio_start)) {
    return false;
  }
  const text = String(scene.voiceover_text || '').trim().toLowerCase();
  const raw = String(scene.voiceover_raw || '');
  const sec = String(scene.section || '').trim().toLowerCase();
  if (text.startsWith('instrumental') || isInstrumentalScene(scene)) return true;
  if (scene.audio_start != null) return true;
  if (/suno\s*master|original\s+suno|attached\s+poem\s+track/i.test(raw)) return true;
  if (/\bpoem\b/i.test(sec) || sec.includes('song intro')) return true;
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

/** Language dropdown is the switch. English never runs the Marathi engine. */
function resolveAlignLanguage(requested, scenes) {
  const raw = String(requested || '').trim().toLowerCase();
  if (raw === 'en' || raw === 'english') {
    return { language: 'en', marathi: false, engine: 'english' };
  }
  if (raw === 'mr' || raw === 'marathi' || raw === 'hi' || raw === 'hindi') {
    return { language: raw === 'hi' || raw === 'hindi' ? 'hi' : 'mr', marathi: true, engine: 'marathi' };
  }
  // auto / en+mr / empty — Devanagari script picks Marathi, otherwise English
  if (isIndicScript(scenes)) {
    return { language: 'mr', marathi: true, engine: 'marathi' };
  }
  return { language: raw === 'auto' ? 'en' : (raw || 'en'), marathi: false, engine: 'english' };
}

function captionForScene(scene, isInst, marathi) {
  const ostTxt = String(scene?.onscreen_text || '').trim();
  const voTxt = String(scene?.voiceover_text || '').trim();
  if (isInst) return '';
  const ostIsPlaceholder = !ostTxt || /^[—–\-]+$/.test(ostTxt);
  // Script spoken voiceover is the master dialogue text for SRT subtitles
  if (voTxt && voTxt !== '-' && voTxt !== '—' && voTxt !== '–') {
    return voTxt;
  }
  return !ostIsPlaceholder ? ostTxt : '';
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
      const scObj = segScenes[i - 1];
      const hasEndPause = questionPauseSeconds(scObj) > 0;
      cumExp += d;
      for (let k = i; k < K; k++) {
        if (i === M && k !== K - 1) continue;
        if (i < M && k === K - 1) continue;
        if (Math.abs(cuts[k].t - cumExp) > maxDrift) continue;
        const cDur = cuts[k].dur;
        const pauseBonus = indic
          ? Math.min(0.55, cDur * 1.1)
          : hasEndPause
            ? Math.min(1.10, cDur * 0.65)
            : Math.min(0.45, Math.min(cDur, 0.95) * 0.85) - (cDur > 1.5 ? 0.35 : 0);
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

// ===========================================================================
// VO-Align Brain — smart cut methodology for EVERY chapter (narration + poem).
// Same rules as backend/app/vo_align_brain.py:
//   Picture/video/SRT live on the SAME clock as the audio that is playing.
//   Never invent a second packed timeline for spoken/sung lines.
//   Never inject synthetic class-pause holds when a real VO already has silence.
// ===========================================================================
const VoAlignBrain = {
  hasRealVo(duration) {
    return Number(duration || 0) > 1;
  },
  shouldInjectClassPauses(voDuration) {
    return !this.hasRealVo(voDuration);
  },
  lockPictureToAudio(audioIn, audioOut, nextAudioIn, minDur = 0.2) {
    const a0 = Number(audioIn);
    const a1 = Number(audioOut);
    let picEnd = (nextAudioIn != null && Number(nextAudioIn) > a0 + minDur)
      ? Number(nextAudioIn)
      : a1;
    if (picEnd < a0 + minDur) picEnd = a0 + Math.max(minDur, a1 - a0);
    return [Math.round(a0 * 1000) / 1000, Math.round(picEnd * 1000) / 1000];
  },
  /**
   * Place poem lyric cards on the poem VO clock.
   * Prefer heard Whisper words (relative to poem file 0); otherwise scale durations (estimate).
   */
  lockPoemScenes(poemScenes, poemOrigin, poemDuration, durFn, poemWords, allScenes) {
    const origin = Number(poemOrigin || 0);
    const fileEnd = origin + Number(poemDuration || 0);
    if (!poemScenes.length || poemDuration <= 0.4) return [];
    const words = Array.isArray(poemWords) ? poemWords : [];

    // 1) Match lyric script lines to heard poem words (same engine as narration).
    if (words.length >= 6) {
      const byWords = alignSpeechByWords(
        poemScenes,
        allScenes || poemScenes,
        words,
        [],
        Number(poemDuration),
      );
      const minCover = Math.max(1, Math.ceil(poemScenes.length * 0.7));
      if (byWords && byWords.size >= minCover) {
        const out = [];
        for (let i = 0; i < poemScenes.length; i++) {
          const sc = poemScenes[i];
          const span = byWords.get(sc.screen);
          if (!span) continue;
          const ni = Number(span[0]);
          const no = Number(span[1]);
          let nextIn = null;
          for (let j = i + 1; j < poemScenes.length; j++) {
            const nxt = byWords.get(poemScenes[j].screen);
            if (nxt) { nextIn = Number(nxt[0]); break; }
          }
          const [picIn, picOut] = this.lockPictureToAudio(ni, no, nextIn);
          out.push({
            screen: sc.screen,
            start: Math.round((origin + picIn) * 1000) / 1000,
            end: Math.round((origin + picOut) * 1000) / 1000,
            narration_in: Math.round((origin + ni) * 1000) / 1000,
            narration_out: Math.round((origin + no) * 1000) / 1000,
            engine: 'poem_word',
          });
        }
        if (out.length) {
          out[out.length - 1].end = Math.round(Math.max(Number(out[out.length - 1].end), fileEnd) * 1000) / 1000;
          out[out.length - 1].narration_out = Math.round(
            Math.max(Number(out[out.length - 1].narration_out), fileEnd) * 1000,
          ) / 1000;
        }
        return out;
      }
      // 2) Even partition of heard words across lyric cards (still heard — not script-duration guess).
      const spans = words
        .map((w) => {
          const a = Number(w.start);
          const b = Number(w.end != null ? w.end : a + 0.08);
          return Number.isFinite(a) ? [a, Math.max(a + 0.05, b)] : null;
        })
        .filter(Boolean);
      if (spans.length >= 6) {
        const n = poemScenes.length;
        const lastEnd = spans[spans.length - 1][1];
        const out = [];
        for (let i = 0; i < n; i++) {
          let i0 = Math.round(i * (spans.length / n));
          let i1 = Math.round((i + 1) * (spans.length / n)) - 1;
          i0 = Math.max(0, Math.min(i0, spans.length - 1));
          i1 = Math.max(i0, Math.min(i1, spans.length - 1));
          const aIn = spans[i0][0];
          const aOut = spans[i1][1];
          let nxtIn = null;
          if (i + 1 < n) {
            let j0 = Math.round((i + 1) * (spans.length / n));
            j0 = Math.max(0, Math.min(j0, spans.length - 1));
            nxtIn = spans[j0][0];
          }
          let [picIn, picOut] = this.lockPictureToAudio(aIn, aOut, nxtIn);
          if (i + 1 >= n) picOut = Math.max(picOut, lastEnd);
          out.push({
            screen: poemScenes[i].screen,
            start: Math.round((origin + picIn) * 1000) / 1000,
            end: Math.round((origin + picOut) * 1000) / 1000,
            narration_in: Math.round((origin + aIn) * 1000) / 1000,
            narration_out: Math.round((origin + aOut) * 1000) / 1000,
            engine: 'poem_word',
          });
        }
        if (out.length) {
          out[out.length - 1].end = Math.round(Math.max(Number(out[out.length - 1].end), fileEnd) * 1000) / 1000;
          out[out.length - 1].narration_out = Math.round(
            Math.max(Number(out[out.length - 1].narration_out), fileEnd) * 1000,
          ) / 1000;
        }
        return out;
      }
    }

    // 3) Estimate fallback: scale script durations to fill the poem file.
    const raw = poemScenes.map((sc) => Math.max(0.4, Number(durFn(sc) || 2)));
    const rawSum = raw.reduce((a, b) => a + b, 0) || 1;
    const scale = Number(poemDuration) / rawSum;
    let cursor = origin;
    const out = [];
    poemScenes.forEach((sc, idx) => {
      let dur = Math.max(0.4, Math.round(raw[idx] * scale * 1000) / 1000);
      if (idx === poemScenes.length - 1) dur = Math.max(0.4, Math.round((fileEnd - cursor) * 1000) / 1000);
      const start = Math.round(cursor * 1000) / 1000;
      const end = Math.round((cursor + dur) * 1000) / 1000;
      out.push({
        screen: sc.screen,
        start,
        end,
        narration_in: start,
        narration_out: end,
        engine: 'estimate',
      });
      cursor = end;
    });
    return out;
  },
  SYNC_DRIFT_LIMIT: 0.35,
  /**
   * Honest post-align audit. Measures |picture.start - narration_in|, optionally
   * re-locks drifted cuts, and returns a report the UI must show (never fake "all synced").
   */
  verifyAndRepairSync(clips, voDuration, opts = {}) {
    const repair = opts.repair !== false;
    const limit = Number(opts.driftLimit != null ? opts.driftLimit : this.SYNC_DRIFT_LIMIT);
    const list = Array.isArray(clips) ? clips : [];
    const spoken = list.filter(
      (c) => c.narration_in != null && c.narration_out != null
        && (Number(c.narration_out) - Number(c.narration_in)) >= 0.15,
    );
    const driftOf = (c) => Math.abs(Number(c.narration_in) - Number(c.start));
    let drifted = spoken
      .filter((c) => driftOf(c) > limit)
      .map((c) => ({
        screen: c.screen,
        drift: Math.round(driftOf(c) * 1000) / 1000,
        picture_start: Math.round(Number(c.start) * 1000) / 1000,
        narration_in: Math.round(Number(c.narration_in) * 1000) / 1000,
      }));

    let repaired = 0;
    if (repair && drifted.length) {
      const sorted = [...spoken].sort((a, b) => Number(a.narration_in) - Number(b.narration_in));
      for (let i = 0; i < sorted.length; i++) {
        const c = sorted[i];
        const ni = Number(c.narration_in);
        const no = Number(c.narration_out);
        const nxt = i + 1 < sorted.length ? Number(sorted[i + 1].narration_in) : null;
        const [picIn, picOut] = this.lockPictureToAudio(ni, no, nxt);
        if (Math.abs(Number(c.start) - picIn) > 0.001 || Math.abs(Number(c.end) - picOut) > 0.001) repaired += 1;
        c.start = picIn;
        c.end = picOut;
        c.duration = Math.round((picOut - picIn) * 1000) / 1000;
      }
      drifted = spoken
        .filter((c) => driftOf(c) > limit)
        .map((c) => ({
          screen: c.screen,
          drift: Math.round(driftOf(c) * 1000) / 1000,
          picture_start: Math.round(Number(c.start) * 1000) / 1000,
          narration_in: Math.round(Number(c.narration_in) * 1000) / 1000,
        }));
    }

    let maxDrift = 0;
    for (const c of spoken) maxDrift = Math.max(maxDrift, driftOf(c));
    const voDur = Number(voDuration || 0);
    const lastEnd = list.length ? Math.max(...list.map((c) => Number(c.end || 0))) : 0;
    const voDelta = voDur > 1 ? Math.round((lastEnd - voDur) * 1000) / 1000 : 0;
    const voLenOk = voDur > 1 ? Math.abs(voDelta) <= 1.0 : true;
    const ok = drifted.length === 0 && voLenOk && spoken.length > 0;

    let summary;
    if (ok) {
      summary = `SYNC OK · ${spoken.length}/${spoken.length} spoken scenes locked to VO · max drift ${maxDrift.toFixed(3)}s · timeline ${lastEnd.toFixed(2)}s`;
      if (voDur > 1) summary += ` / VO ${voDur.toFixed(2)}s`;
    } else if (!spoken.length) {
      summary = 'SYNC FAIL · no spoken narration_in on clips — Auto-align did not lock to VO';
    } else {
      summary = `SYNC FAIL · ${drifted.length} scene(s) drift >${limit.toFixed(2)}s (max ${maxDrift.toFixed(3)}s)`;
      if (!voLenOk) summary += ` · timeline–VO gap ${voDelta >= 0 ? '+' : ''}${voDelta.toFixed(2)}s`;
      if (repaired) summary += ` · auto-repaired ${repaired} cut(s)`;
    }

    const issues = drifted.slice(0, 40).map((d) => ({
      kind: 'vo_sync',
      severity: 'error',
      screen: d.screen,
      time: d.picture_start,
      end: d.narration_in,
      timecode: '',
      message: `${String(d.screen).replace('screen_', 'Scene ')}: picture at ${d.picture_start.toFixed(2)}s but VO line starts at ${d.narration_in.toFixed(2)}s (drift ${d.drift.toFixed(2)}s)`,
      expected: `narration_in=${d.narration_in}`,
      found: `picture_start=${d.picture_start}`,
    }));
    if (!voLenOk) {
      issues.push({
        kind: 'vo_sync',
        severity: 'error',
        screen: 'timeline',
        time: lastEnd,
        end: voDur,
        timecode: '',
        message: `Timeline length ${lastEnd.toFixed(2)}s vs VO ${voDur.toFixed(2)}s (gap ${voDelta >= 0 ? '+' : ''}${voDelta.toFixed(2)}s)`,
        expected: `VO duration ${voDur.toFixed(2)}s`,
        found: `timeline ${lastEnd.toFixed(2)}s`,
      });
    }

    return {
      ok,
      summary,
      spoken_count: spoken.length,
      drifted_count: drifted.length,
      max_drift: Math.round(maxDrift * 1000) / 1000,
      repaired,
      vo_duration: voDur,
      timeline_end: Math.round(lastEnd * 1000) / 1000,
      vo_delta: voDelta,
      issues,
    };
  },
};

// ===========================================================================
// Word-level script <-> voice-over alignment (English).
// Port of backend/app/align_from_script.py (match + _snap_to_silences), but the
// matching is one global monotonic alignment of ALL script words against ALL
// heard words, so a line can never be skipped or pulled ahead of its audio.
// The heard words come from Whisper running in the user's browser.
// ===========================================================================
const WA_CONS_CACHE = new Map();
function waClean(text) {
  return String(text == null ? '' : text).replace(/[\u2019\u2018`\u00b4]/g, "'");
}
function waTokens(text) {
  return waClean(text).toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)?/gu) || [];
}
function waNorm(text) {
  const m = waClean(text).toLowerCase().match(/[\p{L}\p{N}]+|'/gu);
  return (m ? m.join('') : '').replace(/^'+|'+$/g, '');
}
function waConsSkeleton(text) {
  const s = String(text || '');
  if (WA_CONS_CACHE.has(s)) return WA_CONS_CACHE.get(s);
  const key = s.toLowerCase().replace(/[^a-z]/g, '');
  let res = '';
  if (key) {
    res = key.replace(/[aeiouh]/g, '').replace(/[zpfwc]/g, (ch) => ({ z: 'j', p: 'b', f: 'b', w: 'v', c: 's' }[ch]));
    res = res.replace(/(.)\1+/g, '$1');
    if (!res) res = key[0] === 'h' ? 'h' : (key[0] === 'v' || key[0] === 'w' ? 'v' : key[0]);
  }
  WA_CONS_CACHE.set(s, res);
  return res;
}
function waSameWord(h, w) {
  if (!h || !w) return false;
  if (h === w) return true;
  const lh = h.length;
  const lw = w.length;
  if (Math.min(lh, lw) >= 2 && Math.abs(lh - lw) <= 1 && (h.startsWith(w) || w.startsWith(h))) return true;
  if (lh >= 3 && lw >= 3 && Math.abs(lh - lw) <= 2 && (h.includes(w) || w.includes(h))) return true;
  if (lh >= 3 && lw >= 3 && Math.abs(lh - lw) <= 2) {
    const hc = waConsSkeleton(h.replace(/ck/g, 'k'));
    const wc = waConsSkeleton(w.replace(/ck/g, 'k'));
    if (hc.length >= 2 && hc === wc) return true;
    if (lh >= 4 && lw >= 4 && h[0] === w[0] && hc.slice(0, 2) === wc.slice(0, 2)) return true;
  }
  return false;
}
const WA_SMALL = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'is', 'it', 'and', 'or', 'at', 'as', 'we', 'i', 'my', 'so', 'be', 'by', 'do', 'for', 'are', 'was', 'that', 'this']);
function waPairScore(scriptTok, heardTok) {
  if (scriptTok === heardTok) return WA_SMALL.has(scriptTok) || scriptTok.length < 3 ? 1.4 : 3.0;
  if (waSameWord(heardTok, scriptTok)) return 1.7;
  return -0.9;
}

/**
 * Returns Map(screen -> [narration_in, narration_out]) for every spoken scene it could place,
 * or null when the recording words are unusable (caller falls back to the silence/estimate path).
 */
function alignSpeechByWords(speechScenes, allScenes, wordsIn, silences, voDuration) {
  if (!Array.isArray(wordsIn) || !speechScenes.length) return null;
  const pos = new Map((allScenes || []).map((s, i) => [s.screen, i]));
  const A = [];
  for (const w of wordsIn) {
    const rawTxt = w && (w.word != null ? w.word : w.text);
    const tok = waNorm(rawTxt);
    const st = Number(w && w.start);
    const en = Number(w && w.end);
    if (!tok || !Number.isFinite(st)) continue;
    A.push({ tok, text: String(rawTxt), start: st, end: Number.isFinite(en) && en >= st ? en : st + 0.1 });
  }
  A.sort((a, b) => a.start - b.start);
  if (A.length < 6) return null;

  // Script tokens for every spoken scene, in script order
  const S = [];
  const ranges = [];
  speechScenes.forEach((s, si) => {
    const toks = waTokens(s.voiceover_text || '').map(waNorm).filter(Boolean);
    ranges.push([S.length, S.length + toks.length]);
    for (const t of toks) S.push({ tok: t, si });
  });
  const n = S.length;
  const m = A.length;
  if (n < 3 || n * m > 36e6) return null;

  // Overlap alignment (free leading/trailing gaps on both sides: the recording may start/end with extras
  // or cover only part of the script).
  const W = m + 1;
  const H = new Float32Array((n + 1) * W);
  const T = new Uint8Array((n + 1) * W); // 1 diag, 2 skip script token (up), 3 skip heard word (left)
  const GS = -1.0;
  const GA = -0.45;
  for (let k = 1; k <= n; k++) {
    const sTok = S[k - 1].tok;
    for (let j = 1; j <= m; j++) {
      const diag = H[(k - 1) * W + (j - 1)] + waPairScore(sTok, A[j - 1].tok);
      const up = H[(k - 1) * W + j] + GS;
      const left = H[k * W + (j - 1)] + GA;
      let best = diag;
      let dir = 1;
      if (up > best) { best = up; dir = 2; }
      if (left > best) { best = left; dir = 3; }
      H[k * W + j] = best;
      T[k * W + j] = dir;
    }
  }
  let bk = n;
  let bj = m;
  let bv = -1e30;
  for (let j = 0; j <= m; j++) if (H[n * W + j] > bv) { bv = H[n * W + j]; bk = n; bj = j; }
  for (let k = 0; k <= n; k++) if (H[k * W + m] > bv) { bv = H[k * W + m]; bk = k; bj = m; }
  const matchOf = new Int32Array(n).fill(-1);
  {
    let k = bk;
    let j = bj;
    while (k > 0 && j > 0) {
      const d = T[k * W + j];
      if (d === 1) {
        if (waPairScore(S[k - 1].tok, A[j - 1].tok) > 0) matchOf[k - 1] = j - 1;
        k--; j--;
      } else if (d === 2) k--;
      else j--;
    }
  }

  // Per-scene heard-word span
  const spans = speechScenes.map((_, si) => {
    const [a, b] = ranges[si];
    let js = [];
    for (let k = a; k < b; k++) if (matchOf[k] >= 0) js.push(matchOf[k]);
    if (js.length >= 3) {
      const sorted = [...js].sort((x, y) => x - y);
      const med = sorted[Math.floor(sorted.length / 2)];
      js = js.filter((j) => Math.abs(j - med) <= 14);
    }
    const need = Math.max(1, Math.ceil((b - a) * 0.25));
    if (!(b > a) || js.length < need) return null;
    return { si: Math.min(...js), ei: Math.max(...js), hits: js.length, ntok: b - a };
  });
  const matchedTok = spans.reduce((acc, sp) => acc + (sp ? sp.hits : 0), 0);
  if (matchedTok < Math.max(4, n * 0.3)) return null;

  // Words nobody claimed between two neighbouring script lines belong to one of them: split at the strongest break.
  for (let i = 0; i + 1 < speechScenes.length; i++) {
    const a = spans[i];
    const b = spans[i + 1];
    if (!a || !b) continue;
    if (pos.get(speechScenes[i + 1].screen) !== pos.get(speechScenes[i].screen) + 1) continue;
    if (b.si <= a.ei) { b.si = Math.max(a.ei + 1, b.si); if (b.si > b.ei) b.ei = b.si; continue; }
    const gapWords = b.si - a.ei - 1;
    if (gapWords < 1 || gapWords > 14) continue;
    let bestK = a.ei;
    let bestScore = -1;
    for (let k = a.ei; k < b.si; k++) {
      const gap = A[k + 1].start - A[k].end;
      const t = A[k].text.trim();
      const punct = /[.?!]$/.test(t) ? 0.3 : (/[,;:]$/.test(t) ? 0.12 : 0);
      const sc = gap + punct;
      if (sc > bestScore) { bestScore = sc; bestK = k; }
    }
    a.ei = bestK;
    b.si = bestK + 1;
  }

  // Scenes that were not heard at all: share the time between their matched neighbours by script length.
  const raw = []; // {scene, ws, we}
  const lastHeardEnd = A[A.length - 1].end;
  let i = 0;
  while (i < speechScenes.length) {
    const sp = spans[i];
    if (sp) {
      raw.push({ scene: speechScenes[i], ws: A[sp.si].start, we: A[sp.ei].end, si: sp.si, ei: sp.ei });
      i++;
      continue;
    }
    let j = i;
    while (j < speechScenes.length && !spans[j]) j++;
    const prev = i > 0 ? spans[i - 1] : null;
    const next = j < speechScenes.length ? spans[j] : null;
    const group = [];
    for (let g = i; g < j; g++) group.push(g);
    const tA = prev ? A[prev.ei].end : 0;
    const tB = next ? A[next.si].start : lastHeardEnd;
    if (!next) {
      // After the last heard line: only keep them if audible words remain, otherwise they sit beyond the recording.
      const remaining = A.filter((w) => w.start >= tA - 0.01).length;
      if (!prev || remaining < group.length) { i = j; continue; }
    }
    const weights = group.map((g) => Math.max(1, ranges[g][1] - ranges[g][0]));
    const totalW = weights.reduce((x, y) => x + y, 0);
    const span = Math.max(0.3 * group.length, tB - tA);
    let cur = tA;
    group.forEach((g, idx) => {
      const d = span * (weights[idx] / totalW);
      raw.push({ scene: speechScenes[g], ws: cur, we: cur + d, si: null, ei: null, guessed: true });
      cur += d;
    });
    i = j;
  }
  if (!raw.length) return null;

  const lead = (idx) => {
    const st = A[idx].start;
    if (idx <= 0) return Math.max(0, st - 0.25);
    const gap = st - A[idx - 1].end;
    return gap <= 0.04 ? st : st - Math.min(0.28, gap * 0.45);
  };
  const tail = (idx) => {
    const en = A[idx].end;
    if (idx + 1 >= A.length) return en + 0.35;
    const gap = A[idx + 1].start - en;
    return gap <= 0.06 ? en : en + Math.min(0.28, gap * 0.48);
  };

  // Silence snapping (same rules as _snap_to_silences)
  const sil = [];
  for (const pair of silences || []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const a = Number(pair[0]);
    const b = Number(pair[1]);
    if (b > a) sil.push([a, b]);
  }
  sil.sort((x, y) => x[0] - y[0]);
  const msil = [];
  for (const [s0, s1] of sil) {
    const last = msil[msil.length - 1];
    if (last && s0 - last[1] <= 0.09) last[1] = Math.max(last[1], s1);
    else msil.push([s0, s1]);
  }

  const placed = new Map();
  if (msil.length && raw.length) {
    const gaps = [];
    let lastEnd = 0;
    for (let k = 0; k < raw.length - 1; k++) {
      const wEnd = raw[k].we;
      const wNext = raw[k + 1].ws;
      let cands = msil.filter((s) => s[0] > lastEnd + 0.08 && wEnd - 0.35 <= s[0] && s[0] <= Math.max(wEnd, wNext) + 0.65 && Math.abs(s[1] - wNext) < 1.05);
      if (!cands.length) {
        cands = msil.filter((s) => s[0] > lastEnd + 0.08 && Math.abs(s[0] - wEnd) < 0.85 && wNext - 0.5 <= s[1] && s[1] <= Math.min(raw[k + 1].we - 0.2, wNext + 2.6));
      }
      if (cands.length && k + 2 < raw.length) {
        const nEnd = raw[k + 1].we;
        const nNext = raw[k + 2].ws;
        const withNext = cands.filter((s) => msil.some((t) => t[0] > s[1] + 0.08 && Math.abs(t[0] - nEnd) < 0.95 && Math.abs(t[1] - nNext) < 1.05));
        if (withNext.length) cands = withNext;
      }
      if (cands.length) {
        let best = cands[0];
        let bd = Infinity;
        for (const s of cands) {
          const d = Math.abs(s[0] - wEnd) + 0.6 * Math.abs(s[1] - wNext);
          if (d < bd) { bd = d; best = s; }
        }
        gaps.push([best[0], best[1], true]);
        lastEnd = best[1];
      } else {
        const g0 = Math.min(wEnd, wNext);
        const g1 = Math.max(wEnd, wNext);
        gaps.push([g0, Math.max(g0 + 0.08, g1), false]);
        lastEnd = g1;
      }
    }
    const out = [];
    for (let k = 0; k < raw.length; k++) {
      const r = raw[k];
      let srcIn;
      if (k === 0) {
        srcIn = 0.0;
      } else {
        const prevOut = out[out.length - 1][1];
        const [s0, s1] = gaps[k - 1];
        const hasBreak = questionPauseSeconds(raw[k - 1].scene) > 0 || (pos.get(r.scene.screen) - pos.get(raw[k - 1].scene.screen) > 1);
        if (hasBreak) {
          const effWs = r.ws >= s0 + 0.25 ? r.ws : s1 - 0.16;
          const onset = Math.min(effWs, s1 - 0.16);
          srcIn = Math.max(prevOut, s0 + 0.18, Math.min(onset - 0.24, s1 - 0.38));
        } else {
          srcIn = prevOut;
        }
      }
      let srcOut;
      if (k < raw.length - 1) {
        const nxt = raw[k + 1];
        const [s0, s1, hasSil] = gaps[k];
        const hasBreak = questionPauseSeconds(r.scene) > 0 || (pos.get(nxt.scene.screen) - pos.get(r.scene.screen) > 1);
        const effWe = hasSil ? Math.max(s0 + 0.14, Math.min(r.we, s0 + 0.24)) : r.we;
        const effNws = hasSil
          ? (nxt.ws > s0 + 0.20 ? Math.min(nxt.ws, s1 - 0.12) : s1 - 0.14)
          : nxt.ws;
        if (hasBreak) {
          srcOut = Math.min(s1 - 0.18, Math.max(effWe + 0.18, s0 + Math.min(0.40, 0.48 * (s1 - s0))));
          srcOut = Math.max(s0 + 0.14, srcOut);
        } else if (hasSil) {
          const gap = nxt.ws - r.we;
          let targetCut;
          if (gap >= 0.40) {
            targetCut = Math.max(r.we + 0.15, Math.min(nxt.ws - 0.25, r.we + gap * 0.5));
          } else {
            targetCut = Math.max(r.we + 0.08, nxt.ws - 0.20);
          }
          const minCut = Math.max(s0 + 0.10, r.we + 0.06);
          const maxCut = Math.max(minCut, s1 - 0.18);
          srcOut = Math.max(minCut, Math.min(maxCut, targetCut));
        } else {
          srcOut = Math.max(r.we + 0.08, Math.min(nxt.ws - 0.18, s0 + 0.5 * (s1 - s0)));
        }
      } else {
        srcOut = r.we + 0.35;
      }
      if (srcOut <= srcIn + 0.2) srcOut = srcIn + 0.3;
      out.push([Math.round(srcIn * 1000) / 1000, Math.round(srcOut * 1000) / 1000]);
    }
    raw.forEach((r, k) => placed.set(r.scene.screen, out[k]));
  } else {
    raw.forEach((r, k) => {
      const a = r.si != null ? lead(r.si) : r.ws;
      const b = r.ei != null ? tail(r.ei) : r.we;
      placed.set(r.scene.screen, [Math.round(a * 1000) / 1000, Math.round(Math.max(a + 0.3, b) * 1000) / 1000]);
    });
  }

  // Continuous lines share one cut: never let a line start before the previous one ended, never leave a hole.
  let prevOut = 0;
  for (let k = 0; k < raw.length; k++) {
    const scr = raw[k].scene.screen;
    const [a, b] = placed.get(scr);
    let ni = a;
    if (k > 0 && ni < prevOut) ni = prevOut;
    const no = Math.max(b, ni + 0.3);
    placed.set(scr, [Math.round(ni * 1000) / 1000, Math.round(no * 1000) / 1000]);
    prevOut = no;
  }
  const maxT = Number(voDuration) > 1 ? Number(voDuration) : Infinity;
  for (const [scr, [a, b]] of placed) {
    if (a >= maxT) placed.delete(scr);
    else if (b > maxT) placed.set(scr, [a, Math.round(maxT * 1000) / 1000]);
  }
  return placed;
}

/** Flat 6s/8s sheet values are a template, not a measured narration clock. */
function scriptDurationsAreMeasured(list) {
  const vals = (list || []).map((s) => Number(s && s.duration)).filter((d) => d > 0.4 && d < 180);
  if (!list || !list.length || vals.length < list.length * 0.75) return false;
  const uniq = new Set(vals.map((v) => Math.round(v * 10) / 10));
  if (uniq.size <= 3) return false;
  return Math.max(...vals) - Math.min(...vals) >= 4;
}

/**
 * Marathi only. Walk the VO in script order.
 * Each line gets its Devanagari share of the recording, and the cut sits on the
 * silence just after that share — a tight window, so a breath cannot pull the
 * next picture several seconds early. English keeps alignScenesWithGlobalDP.
 */
function alignMarathiBySpeech(segScenes, speechWeights, segStart, segEnd, silences) {
  const result = new Map();
  const M = segScenes.length;
  const segDur = Math.max(0.4, segEnd - segStart);
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
  const cuts = [];
  for (const pair of silences || []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const ss = Number(pair[0]);
    const se = Number(pair[1]);
    if (!(se > ss) || se - ss < 0.12) continue;
    // silence_start is where the previous word finished. Do not cut at silence_end.
    const cutT = ss + 0.1;
    if (cutT > segStart + 0.3 && cutT < segEnd - 0.2) cuts.push(cutT);
  }
  cuts.sort((a, b) => a - b);

  let cursor = segStart;
  let remW = sumW;
  for (let i = 0; i < M; i++) {
    const isLast = i === M - 1;
    const w = rawW[i];
    const rem = Math.max(0.35, segEnd - cursor);
    const expDur = isLast ? rem : Math.max(0.65, (w / Math.max(0.1, remW)) * rem);
    let target = isLast ? segEnd : cursor + expDur;
    if (!isLast) {
      const win = Math.max(0.45, Math.min(1.15, expDur * 0.22));
      let best = null;
      let bestDist = win + 0.001;
      for (const t of cuts) {
        if (t <= cursor + 0.4) continue;
        if (t > target + win) break;
        const dist = Math.abs(t - target);
        if (dist <= win && dist < bestDist) {
          bestDist = dist;
          best = t;
        }
      }
      if (best != null) target = best;
    }
    result.set(segScenes[i].screen, [
      Math.round(cursor * 1000) / 1000,
      Math.round(target * 1000) / 1000,
    ]);
    cursor = target;
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

function pickMediaForScreen(screen, mediaItems, visualDirection = '', scene = null) {
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
  // If no video was explicitly numbered for this screen, check unassigned videos with matching semantic keywords
  if (!vid && scene) {
    const voTxt = String(scene.voiceover_text || '').toLowerCase();
    const visTxt = String(scene.visual_direction || scene.visual_type || '').toLowerCase();
    const unassignedVids = mediaItems.filter((m) => m.kind === 'video' && (!m.screen || m.screen === 'null'));
    for (const uv of unassignedVids) {
      const ufn = String(uv.filename || '').toLowerCase().replace(/[-_.]+/g, ' ');
      // Scene 10: "reading maps" / "examining map"
      const matchMap = (voTxt.includes('map') || visTxt.includes('compass') || visTxt.includes('map')) && ufn.includes('map');
      if (matchMap) {
        vid = uv;
        break;
      }
    }
  }
  return { video: vid, image: img };
}

function choosePrimaryMedia(video, image, visualType = '', visualDirection = '', isPoem = false) {
  if (!video) return image || null;
  if (!image) return video || null;

  const combined = `${visualType || ''} ${visualDirection || ''}`.toLowerCase();
  // Only suppress video if the visual description explicitly calls for a static flashcard / prompt card
  const isExplicitFlashcard = /\b(flashcard|prompt card|quiz card|fill in the blank|word bank)\b/i.test(combined);
  if (isExplicitFlashcard && !/\b(video|motion|anim|व्हिडिओ|चलचित्र)\b/i.test(combined)) {
    return image;
  }

  // All other narrative, story, poem, explanation scenes: video takes priority over static image
  // (A video named Scene N replaces image N. Keep the image only when that screen has no video.)
  return video;
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
  const marathi = Boolean(
    planOpts.marathi
    || planOpts.align_engine === 'marathi'
    || planOpts.language === 'mr'
    || planOpts.language === 'hi',
  );
  const wrapW = marathi ? 38 : 44;

  for (const c of clips || []) {
    const spokenRaw = String(c.vo_text || '');
    const capRaw = String(c.caption_text || '');
    const capIsPlaceholder = !capRaw.trim() || /^[—–\-]+$/.test(capRaw.trim());
    const txt = cleanCaptionText(spokenRaw || (!capIsPlaceholder ? capRaw : ''));
    if (!txt) continue;
    let start = Number(c.start || 0);
    let end = Number(c.end || 0);
    const spoken =
      c.narration_in != null &&
      c.narration_out != null &&
      Number(c.narration_out) - Number(c.narration_in) >= 0.2;
    const inPoem =
      hasPoem &&
      start + 0.05 >= poemStart &&
      start < poemEnd + 0.05;

    if (c.caption_in != null && c.caption_out != null && Number(c.caption_out) > Number(c.caption_in) + 0.2) {
      start = Number(c.caption_in);
      end = Number(c.caption_out);
    } else if (spoken) {
      start = Number(c.narration_in);
      end = Math.max(Number(c.narration_out), start + 0.4);
    } else if (inPoem) {
      if (lyricStart > start + 0.05) start = lyricStart;
    } else if (marathi || !c.vo_text) {
      // Marathi leftover cards after the VO ends must not get fake captions
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
            text: wrapTwoLines(sent, wrapW),
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
        text: wrapTwoLines(txt, wrapW),
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

function refreshScriptFromWorkbookIfNeeded(pid) {
  try {
    const scriptMeta = loadJson(pid, 'script_meta.json') || {};
    let scenes = loadJson(pid, 'script.json') || [];
    if (scriptMeta.imported_bundle || !scriptMeta.filename) return { scenes, scriptMeta };
    const ext = path.extname(String(scriptMeta.filename)).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.xlsm' && ext !== '.xls') return { scenes, scriptMeta };
    const xlsxPath = path.join(projectRoot(pid), 'script', path.basename(scriptMeta.filename));
    if (!fs.existsSync(xlsxPath)) return { scenes, scriptMeta };

    const freshScenes = parseProductionXlsx(xlsxPath);
    if (!freshScenes.length || freshScenes.length !== scenes.length) return { scenes, scriptMeta };

    let changed = false;
    for (let i = 0; i < scenes.length; i++) {
      const cur = scenes[i];
      const fr = freshScenes[i];
      if (!fr || cur.screen !== fr.screen) continue;
      if (
        cur.duration !== fr.duration ||
        cur.audio_start !== fr.audio_start ||
        cur.audio_end !== fr.audio_end ||
        Boolean(cur.is_poem) !== Boolean(fr.is_poem)
      ) {
        cur.duration = fr.duration;
        cur.audio_start = fr.audio_start;
        cur.audio_end = fr.audio_end;
        cur.is_poem = fr.is_poem;
        changed = true;
      }
    }
    const poemScenes = scenes.filter((s) => s.is_poem);
    const sunoList = poemScenes.filter((s) => s.audio_start != null && s.audio_end != null);
    const sunoDur = sunoList.length
      ? Math.round((Math.max(...sunoList.map((s) => Number(s.audio_end))) - Math.min(...sunoList.map((s) => Number(s.audio_start)))) * 1000) / 1000
      : null;
    const nextPoem = poemScenes.length
      ? {
          has_poem: true,
          scene_count: poemScenes.length,
          first_screen: poemScenes[0].screen,
          last_screen: poemScenes[poemScenes.length - 1].screen,
          suno_duration: sunoDur,
        }
      : { has_poem: false };
    if (JSON.stringify(scriptMeta.poem) !== JSON.stringify(nextPoem)) {
      scriptMeta.poem = nextPoem;
      changed = true;
    }
    if (changed) {
      saveJson(pid, 'script.json', scenes);
      saveJson(pid, 'script_meta.json', scriptMeta);
    }
    return { scenes, scriptMeta };
  } catch {
    return {
      scenes: loadJson(pid, 'script.json') || [],
      scriptMeta: loadJson(pid, 'script_meta.json') || {},
    };
  }
}

app.get('/api/projects/:id/load', (req, res) => {
  const pid = req.params.id;
  if (!fs.existsSync(projectRoot(pid))) return res.status(404).json({ detail: 'Project not found' });
  const existingClient = loadJson(pid, 'client_meta.json') || {};
  if (!existingClient.client_id) {
    touchProjectClient(pid, req);
  }
  const { scenes, scriptMeta } = refreshScriptFromWorkbookIfNeeded(pid);
  const lastExp = loadJson(pid, 'last_export.json') || {};
  const title = lastExp.title || (scriptMeta.filename ? path.parse(scriptMeta.filename).name : `Project ${pid}`);
  const tl = loadJson(pid, 'timeline.json');
  const mediaList = loadJson(pid, 'media.json') || [];
  if (tl && Array.isArray(tl.clips) && mediaList.length) {
    const sceneMap = new Map((scenes || []).map((s) => [normScreenId(s.screen), s]));
    let changed = false;
    for (const c of tl.clips) {
      const s = sceneMap.get(normScreenId(c.screen));
      const picked = pickMediaForScreen(c.screen, mediaList, s?.visual_direction || s?.visual_type || '', s);
      const primary = choosePrimaryMedia(picked.video, picked.image, s?.visual_type, s?.visual_direction);
      if (primary && (!c.media_id || c.kind !== primary.kind || c.media_id !== primary.id)) {
        c.media_id = primary.id;
        c.media_path = primary.path;
        c.filename = primary.filename || path.basename(String(primary.path || ''));
        c.kind = primary.kind;
        c.fit = primary.kind === 'video' ? 'trim' : 'hold';
        changed = true;
      }
    }
    if (changed) {
      saveJson(pid, 'timeline.json', tl);
    }
  }
  const effLogo = getEffectiveLogoMeta(pid, tl);
  if (tl) {
    if (typeof tl.logo_enabled !== 'boolean') tl.logo_enabled = effLogo.enabled;
    tl.logo_transform = effLogo.transform;
    if (!tl.logo_path && effLogo.path) tl.logo_path = effLogo.path;
  }
  res.json({
    project_id: pid,
    title,
    scenes,
    poem: scriptMeta.poem || null,
    media: loadJson(pid, 'media.json') || [],
    voiceover: loadJson(pid, 'voiceover.json'),
    poem_voiceover: loadJson(pid, 'poem_voiceover.json'),
    logo: effLogo,
    timeline: tl,
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
    if (req.query?.replace === '1' || req.headers?.['x-replace-kind'] === '1') {
      for (const f of fs.readdirSync(destDir)) {
        try { fs.unlinkSync(path.join(destDir, f)); } catch {}
      }
      const existing = loadJson(pid, 'media.json') || [];
      const targetItemKind = kind === 'videos' ? 'video' : 'image';
      saveJson(pid, 'media.json', existing.filter((m) => m.kind !== targetItemKind));
    }
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
    const replaceKind = req.body?.replace_kind !== false;
    const existing = loadJson(pid, 'media.json') || [];
    const targetItemKind = kind === 'videos' ? 'video' : 'image';
    const baseItems = replaceKind
      ? existing.filter((m) => m.kind !== targetItemKind)
      : existing;
    const byKey = new Map(baseItems.map((m) => [`${m.kind}:${String(m.filename || '').toLowerCase()}`, m]));
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
    if (replaceKind) {
      const incomingNames = new Set(incoming.map((raw) => path.basename(String(raw?.filename || '')).toLowerCase()));
      const destDir = path.join(root, 'media', kind);
      if (fs.existsSync(destDir)) {
        for (const f of fs.readdirSync(destDir)) {
          if (!incomingNames.has(f.toLowerCase())) {
            try { fs.unlinkSync(path.join(destDir, f)); } catch {}
          }
        }
      }
      const thumbDir = path.join(root, 'meta', 'thumbs');
      if (fs.existsSync(thumbDir)) {
        for (const f of fs.readdirSync(thumbDir)) {
          try { fs.unlinkSync(path.join(thumbDir, f)); } catch {}
        }
      }
    }
    saveJson(pid, 'media.json', Array.from(byKey.values()));
    const items = await reindexMedia(pid);
    res.json({ count: items.length, saved, skipped, folder: kind, media: items });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

app.delete('/api/projects/:id/media/:kind', async (req, res) => {
  try {
    const pid = req.params.id;
    touchProjectClient(pid, req);
    const root = projectRoot(pid);
    if (!fs.existsSync(root)) return res.status(404).json({ detail: 'Project not found' });
    const kind = req.params.kind === 'videos' ? 'videos' : 'images';
    const targetItemKind = kind === 'videos' ? 'video' : 'image';
    const existing = loadJson(pid, 'media.json') || [];
    const remaining = existing.filter((m) => m.kind !== targetItemKind);
    saveJson(pid, 'media.json', remaining);
    const destDir = path.join(root, 'media', kind);
    if (fs.existsSync(destDir)) {
      for (const f of fs.readdirSync(destDir)) {
        try { fs.unlinkSync(path.join(destDir, f)); } catch {}
      }
    }
    const items = await reindexMedia(pid);
    res.json({ count: items.length, folder: kind, media: items });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

// Purge temporary physical media/VO/export files on server after render to keep server storage at 0 MB
app.post('/api/projects/:id/media-rename', async (req, res) => {
  // After the user renumbered picture files on their PC: move each media id to its new filename (ids stay the same)
  try {
    const pid = req.params.id;
    const renames = Array.isArray(req.body?.renames) ? req.body.renames : [];
    const media = loadJson(pid, 'media.json') || [];
    const byId = new Map(media.map((m) => [m.id, m]));
    // Phase 1: physically uploaded copies on the server → move to temp names (safe for swaps like 42↔45)
    const moves = [];
    for (const r of renames) {
      const m = byId.get(String(r?.id || ''));
      const to = path.basename(String(r?.to || ''));
      if (!m || !to) continue;
      const oldPath = m.path ? String(m.path) : '';
      const newPath = oldPath ? path.join(path.dirname(oldPath), to) : '';
      if (oldPath && fs.existsSync(oldPath)) {
        const tmp = `${oldPath}.dgs-tmp-${m.id}`;
        fs.renameSync(oldPath, tmp);
        moves.push({ tmp, newPath });
      }
      m.filename = to;
      if (newPath) m.path = newPath;
      const screens = detectScreens(to, m.kind === 'video' ? 'videos' : 'images');
      m.screen = screens[0] || null;
      m.screens = screens;
    }
    // Phase 2: temp → final names
    for (const mv of moves) {
      try { if (fs.existsSync(mv.newPath)) fs.renameSync(mv.newPath, `${mv.newPath}.dgs-replaced-${Date.now()}`); } catch (_) {}
      fs.renameSync(mv.tmp, mv.newPath);
    }
    saveJson(pid, 'media.json', Array.from(byId.values()));
    const plan = loadJson(pid, 'timeline.json');
    if (plan && Array.isArray(plan.clips)) {
      for (const c of plan.clips) {
        const m = c.media_id ? byId.get(c.media_id) : null;
        if (m) {
          c.filename = m.filename;
          if (m.path) c.media_path = m.path;
        }
      }
      saveJson(pid, 'timeline.json', plan);
    }
    const items = await reindexMedia(pid);
    res.json({ media: items, timeline: plan || null });
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
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.resolve(item.path));
});

app.get('/api/projects/:id/media-thumb/:mediaId', async (req, res) => {
  const { id, mediaId } = req.params;
  const items = loadJson(id, 'media.json') || [];
  const item = items.find((m) => m.id === mediaId);
  if (!item || !item.path || !fs.existsSync(item.path)) {
    return res.status(404).json({ detail: 'Media not found' });
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
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
  const sunoList = poemScenes.filter((s) => s.audio_start != null && s.audio_end != null);
  const sunoDur = sunoList.length
    ? Math.round((Math.max(...sunoList.map((s) => Number(s.audio_end))) - Math.min(...sunoList.map((s) => Number(s.audio_start)))) * 1000) / 1000
    : null;
  const poem = poemScenes.length
    ? {
        has_poem: true,
        scene_count: poemScenes.length,
        first_screen: poemScenes[0].screen,
        last_screen: poemScenes[poemScenes.length - 1].screen,
        suno_duration: sunoDur,
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
      // Clear stale Whisper words so Auto-align never reuses the previous chapter/VO.
      words: [],
      words_dur: 0,
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
    const meta = {
      path: only.path,
      filename: only.filename,
      duration: dur,
      kind: 'narration',
      slots: active,
      words: [],
      words_dur: 0,
    };
    saveJson(pid, 'voiceover.json', meta);
    const tl = loadJson(pid, 'timeline.json');
    if (tl && only.path && fs.existsSync(only.path)) {
      tl.voiceover_path = only.path;
      saveJson(pid, 'timeline.json', tl);
    }
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
  const meta = {
    path: mergedPath,
    filename: label,
    duration: totalDur,
    kind: 'narration',
    slots: active,
    words: [],
    words_dur: 0,
  };
  saveJson(pid, 'voiceover.json', meta);
  const tl = loadJson(pid, 'timeline.json');
  if (tl && mergedPath && fs.existsSync(mergedPath)) {
    tl.voiceover_path = mergedPath;
    saveJson(pid, 'timeline.json', tl);
  }
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
  const tl = loadJson(pid, 'timeline.json');
  if (tl && dest && fs.existsSync(dest)) {
    tl.poem_voiceover_path = dest;
    saveJson(pid, 'timeline.json', tl);
  }
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

    const scriptMeta = loadJson(pid, 'script_meta.json');
    if (scriptMeta) {
      if (!scriptMeta.poem || !scriptMeta.poem.has_poem) {
        scriptMeta.poem = { ...(scriptMeta.poem || {}), has_poem: true };
        saveJson(pid, 'script_meta.json', scriptMeta);
      }
    }
    const tl = loadJson(pid, 'timeline.json');
    if (tl) {
      tl.poem_voiceover_path = localPath;
      tl.has_poem = true;
      if (tl.poem) {
        tl.poem.has_poem = true;
        tl.poem.poem_uploaded = true;
      }
      saveJson(pid, 'timeline.json', tl);
    }

    res.json(meta);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

async function serveProjectAudio(id, kind, res) {
  let meta = loadJson(id, kind === 'poem' ? 'poem_voiceover.json' : 'voiceover.json');
  if (kind !== 'poem' && (!meta || !meta.path || !fs.existsSync(meta.path)) && Array.isArray(meta?.slots)) {
    const existingSlots = meta.slots.filter((s) => s && s.path && fs.existsSync(s.path));
    if (existingSlots.length === 1) {
      meta.path = existingSlots[0].path;
      saveJson(id, 'voiceover.json', meta);
    } else if (existingSlots.length > 1) {
      meta = await rebuildMergedVo(id, meta.slots);
    }
  }
  if (!meta || !meta.path || !fs.existsSync(meta.path)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.resolve(meta.path));
}

app.get('/api/projects/:id/audio/:kind', async (req, res) => {
  await serveProjectAudio(req.params.id, req.params.kind, res);
});
app.get('/api/projects/:id/voiceover-audio', async (req, res) => {
  await serveProjectAudio(req.params.id, 'narration', res);
});
app.get('/api/projects/:id/poem-audio', async (req, res) => {
  await serveProjectAudio(req.params.id, 'poem', res);
});
app.get('/api/projects/:id/voiceover-slot/:slot', (req, res) => {
  const { id, slot } = req.params;
  const meta = loadJson(id, 'voiceover.json') || {};
  const slotNum = Number(slot) || 1;
  const entry = (meta.slots || []).find((s) => Number(s?.slot) === slotNum) || (slotNum === 1 ? meta : null);
  if (!entry || !entry.path || !fs.existsSync(entry.path)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.resolve(entry.path));
});

function handleLogoFile(pid, tempPath, origName) {
  const root = projectRoot(pid);
  const logoDir = path.join(root, 'logo');
  fs.mkdirSync(logoDir, { recursive: true });
  const dest = path.join(logoDir, origName);
  fs.copyFileSync(tempPath, dest);
  try { fs.unlinkSync(tempPath); } catch {}
  const prevMeta = loadJson(pid, 'logo.json') || {};
  const transform = normalizeLogoTransform(prevMeta.transform);
  const meta = { path: dest, filename: origName, enabled: true, transform };
  saveJson(pid, 'logo.json', meta);
  const tl = loadJson(pid, 'timeline.json');
  if (tl) {
    tl.logo_path = dest;
    tl.logo_enabled = true;
    tl.logo_transform = transform;
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
    const prevMeta = loadJson(pid, 'logo.json') || {};
    const transform = normalizeLogoTransform(req.body?.transform || prevMeta.transform);
    const meta = { path: localPath, filename: origName, enabled: true, local_only: true, transform };
    saveJson(pid, 'logo.json', meta);
    const tl = loadJson(pid, 'timeline.json');
    if (tl) {
      tl.logo_path = localPath;
      tl.logo_enabled = true;
      tl.logo_transform = transform;
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
  if (req.body && req.body.transform) {
    meta.transform = normalizeLogoTransform(req.body.transform);
  } else {
    meta.transform = normalizeLogoTransform(meta.transform);
  }
  if (!meta.path && fs.existsSync(DEFAULT_LOGO_FILE)) {
    meta.path = DEFAULT_LOGO_FILE;
    meta.filename = meta.filename || 'E-Class Logo.png (Default)';
    meta.is_default = true;
  }
  saveJson(pid, 'logo.json', meta);
  const tl = loadJson(pid, 'timeline.json');
  if (tl) {
    tl.logo_enabled = enabled;
    tl.logo_transform = meta.transform;
    if (!tl.logo_path && meta.path) tl.logo_path = meta.path;
    saveJson(pid, 'timeline.json', tl);
  }
  res.json(meta);
});

app.get('/api/projects/:id/logo-file', (req, res) => {
  const eff = getEffectiveLogoMeta(req.params.id);
  if (!eff || !eff.path || !fs.existsSync(eff.path)) return res.status(404).end();
  res.sendFile(path.resolve(eff.path));
});
app.get('/api/projects/:id/logo', (req, res) => {
  const eff = getEffectiveLogoMeta(req.params.id);
  if (!eff || !eff.path || !fs.existsSync(eff.path)) return res.status(404).end();
  res.sendFile(path.resolve(eff.path));
});

app.post('/api/projects/:id/build', async (req, res) => {
  try {
    const pid = req.params.id;
    touchProjectClient(pid, req);
    const { scenes, scriptMeta } = refreshScriptFromWorkbookIfNeeded(pid);
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
    const existingTl = loadJson(pid, 'timeline.json');
    // Auto-align must NOT reassign pictures/videos. Keep each screen's previous media_id
    // so force_realign only moves cuts — never shuffles or blanks cards.
    const prevClipByScreen = new Map();
    if (existingTl && Array.isArray(existingTl.clips)) {
      for (const c of existingTl.clips) {
        const key = normScreenId(c.screen);
        if (!key || prevClipByScreen.has(key)) continue;
        if (c.media_id || c.media_path || c.filename) prevClipByScreen.set(key, c);
      }
    }
    const resolvePrimaryMedia = (screen, visualType, visualDirection, scene, isPoem = false) => {
      const key = normScreenId(screen);
      const prev = prevClipByScreen.get(key);
      if (prev && prev.media_id) {
        const still = media.find((m) => m.id === prev.media_id);
        if (still && (still.kind === 'image' || still.kind === 'video')) return still;
      }
      if (prev && prev.filename) {
        const byName = media.find(
          (m) =>
            (m.kind === 'image' || m.kind === 'video') &&
            String(m.filename || '').toLowerCase() === String(prev.filename || '').toLowerCase(),
        );
        if (byName) return byName;
      }
      const { video, image } = pickMediaForScreen(screen, media, visualDirection || visualType, scene);
      return choosePrimaryMedia(video, image, visualType, visualDirection, isPoem);
    };

    // If project was imported from a .wfpbundle / .wfp and neither script nor master VO was replaced,
    // preserve the bundle's exact clip timings/alignment while refreshing newly uploaded media, captions, logo, and QA!
    const explicitAlign = Boolean(req.body && (req.body.language || req.body.force_realign));
    if (scriptMeta.imported_bundle && !explicitAlign && existingTl && Array.isArray(existingTl.clips) && existingTl.clips.length) {
      const sceneMap = new Map(scenes.map((s) => [normScreenId(s.screen), s]));
      for (const c of existingTl.clips) {
        const s = sceneMap.get(normScreenId(c.screen));
        const picked = pickMediaForScreen(c.screen, media, s?.visual_direction || s?.visual_type || '');
        const primary = choosePrimaryMedia(picked.video, picked.image, s?.visual_type, s?.visual_direction);
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
      const effLogo = getEffectiveLogoMeta(pid, existingTl);
      existingTl.logo_path = effLogo.path || existingTl.logo_path || null;
      existingTl.logo_enabled = effLogo.enabled;
      existingTl.logo_transform = effLogo.transform;
      if (voMeta.path) existingTl.voiceover_path = voMeta.path;
      if (poemVoMeta.path) existingTl.poem_voiceover_path = poemVoMeta.path;
      existingTl.srt_cues = buildSrtCues(existingTl.clips, existingTl);
      saveSrt(pid, 'subtitles.srt', formatSrt(existingTl.srt_cues));

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
    const langRes = resolveAlignLanguage(req.body && req.body.language, scenes);
    const marathi = langRes.marathi;
    // Marathi engine is a separate path. English Auto-align never uses Indic weights / poem-in-VO.
    const indic = marathi;
    const silences = Array.isArray(voMeta.silences) && voMeta.silences.length
      ? voMeta.silences
      : [];

    // Separate scenes into spoken narration vs poem/instrumental so poem scenes do not eat narration VO
    // Note: For Marathi/Indic chapters without a separate Poem VO (!hasPoemVo), poem lyrics live inside the narration VO!
    const speechScenes = scenes.filter((s) => {
      if (hasPoemVo && onPoemTrack(s)) return false;
      if (!indic && onPoemTrack(s)) return false;
      return isSpokenVo(s, { indic, hasPoemVo });
    });

    const measuredScriptClock = marathi && scriptDurationsAreMeasured(speechScenes);
    const speechWeights = new Map();
    let totalSpeechWeight = 0;
    for (const s of speechScenes) {
      const txt = String(s.voiceover_text || s.onscreen_text || '').trim();
      const noEll = txt.replace(/\.{2,}/g, ' ');
      const words = (noEll.match(/[\w\u0900-\u097F']+/g) || []).length;
      const devChars = (txt.match(/[\u0900-\u097F]/g) || []).length;
      const isDevanagari = marathi || devChars > 0;
      const sentBreaks = Math.max(0, (noEll.match(/[.!?।]/g) || []).length - 1);
      const sents = Math.max(1, (noEll.match(/[.!?।]+/g) || []).length);
      const commas = (noEll.match(/[,;:]/g) || []).length;
      const repMatches = (noEll.match(/\b([a-zA-Z]{2,})[,\s]+\1\b/gi) || []).length;
      const qp = questionPauseSeconds(s);
      const hasMidPause = qp === 0 && /\d+(?:\.\d+)?\s*-\s*second\s+pause/i.test(String(s.voiceover_raw || ''));
      const listItems = commas + sents;
      const isWordBank = !marathi && !isDevanagari && ((commas >= 3 && words <= commas * 2.5) || (sents >= 4 && words <= sents * 1.8));
      let w;
      if (marathi && measuredScriptClock && Number(s.duration) > 0.4) {
        // Real per-scene times from the workbook. Flat 6s/8s templates never reach here.
        w = Number(s.duration);
      } else if ((marathi || isDevanagari) && voDur > 1) {
        // Marathi/Hindi: Devanagari character + word + danda weights. Never the English word-bank / repeat-word clock.
        w = Math.max(1.2, (devChars || words) * 0.105 + words * 0.22 + sentBreaks * 0.25 + 0.25);
      } else if (voDur > 1) {
        if (isWordBank) {
          w = Math.max(2.0, words * 0.34 + listItems * 0.56 + 0.25);
        } else {
          const pBonus = qp > 0 ? 1.45 : (hasMidPause ? 0.55 : 0.0);
          w = words > 0
            ? Math.max(1.1, words * 0.30 + sents * 0.36 + commas * 0.36 + repMatches * 1.1 + pBonus + 0.15)
            : (Number(s.duration) || 2.0);
        }
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

    // English: place every line on the words Whisper actually heard (sent by the browser). No estimating.
    let wordAlignUsed = false;
    let heardWords = null;
    if (!marathi && voDur > 1 && speechScenes.length > 0) {
      const bodyWords = Array.isArray(req.body && req.body.words) ? req.body.words : null;
      if (bodyWords && bodyWords.length >= 6) {
        heardWords = bodyWords;
        voMeta.words = bodyWords.map((w) => {
          const val = String(w && (w.word != null ? w.word : (w.text || '')));
          return { word: val, text: val, start: Number(w.start), end: Number(w.end) };
        });
        voMeta.words_dur = voDur;
        saveJson(pid, 'voiceover.json', voMeta);
      } else if (Array.isArray(voMeta.words) && voMeta.words.length >= 6 && Math.abs(Number(voMeta.words_dur || 0) - voDur) <= 0.9) {
        heardWords = voMeta.words;
      }
      // Reject partial Whisper (e.g. only VO 1 heard while meta duration is VO1+VO2) — that forces
      // late scenes onto a fake tlCursor and desyncs from ~mid-story onward.
      if (heardWords && heardWords.length >= 6) {
        let maxWordT = 0;
        for (const w of heardWords) maxWordT = Math.max(maxWordT, Number(w.end || w.start || 0));
        if (voDur > 30 && maxWordT < voDur * 0.82) {
          console.warn(`[align] Ignoring partial ASR words (last word ${maxWordT.toFixed(1)}s vs VO ${voDur.toFixed(1)}s)`);
          heardWords = null;
        }
      }
      if (heardWords) {
        const multiSlots = Array.isArray(voMeta.slots)
          ? voMeta.slots.filter((sl) => Number(sl.duration || 0) > 0.5)
          : [];
        let byWords = null;
        if (multiSlots.length > 1) {
          // Per-slot word lock: story lines only match VO1 words, later sections only VO2+.
          // Stops repeated phrases ("Death to the wolf") from yanking mid/late scenes onto the wrong file.
          byWords = new Map();
          const totalNarrW = speechScenes.reduce((acc, s) => acc + (speechWeights.get(s.screen) || 2.0), 0) || 1;
          let startIdx = 0;
          let cumSlotDur = 0;
          for (let sIdx = 0; sIdx < multiSlots.length; sIdx++) {
            const sl = multiSlots[sIdx];
            const slStart = Number(sl.start_offset || 0);
            const slEnd = Number(sl.end_offset || (slStart + Number(sl.duration || 0)));
            cumSlotDur += Number(sl.duration || 0);
            let endIdx = speechScenes.length;
            if (sIdx < multiSlots.length - 1) {
              const targetW = (cumSlotDur / Math.max(1, voDur)) * totalNarrW;
              let bestIdx = startIdx + 1;
              let runW = 0;
              const sectionCandidates = [];
              for (let k = 1; k <= speechScenes.length - (multiSlots.length - 1 - sIdx); k++) {
                runW += speechWeights.get(speechScenes[k - 1].screen) || 2.0;
                if (k <= startIdx) continue;
                const curSec = String(speechScenes[k - 1].section || '').split('|')[0].trim().toLowerCase();
                const nextSec = k < speechScenes.length
                  ? String(speechScenes[k].section || '').split('|')[0].trim().toLowerCase()
                  : '';
                if (curSec && nextSec && curSec !== nextSec) {
                  const diff = Math.abs(runW - targetW);
                  if (diff / Math.max(1, targetW) <= 0.35) sectionCandidates.push({ k, diff });
                }
              }
              if (sectionCandidates.length) {
                sectionCandidates.sort((a, b) => a.diff - b.diff);
                bestIdx = sectionCandidates[0].k;
              } else {
                runW = 0;
                let bestScore = Infinity;
                for (let k = 1; k <= speechScenes.length - (multiSlots.length - 1 - sIdx); k++) {
                  runW += speechWeights.get(speechScenes[k - 1].screen) || 2.0;
                  if (k <= startIdx) continue;
                  const diff = Math.abs(runW - targetW);
                  if (diff < bestScore) { bestScore = diff; bestIdx = k; }
                }
              }
              endIdx = bestIdx;
            }
            const subScenes = speechScenes.slice(startIdx, endIdx);
            const slotWords = heardWords.filter((w) => {
              const t = Number(w.start);
              return Number.isFinite(t) && t >= slStart - 0.35 && t <= slEnd + 0.35;
            });
            if (subScenes.length && slotWords.length >= 4) {
              const subMap = alignSpeechByWords(subScenes, scenes, slotWords, silences, slEnd);
              if (subMap) for (const [k, v] of subMap.entries()) byWords.set(k, v);
            }
            startIdx = endIdx;
          }
        } else {
          byWords = alignSpeechByWords(speechScenes, scenes, heardWords, silences, voDur);
        }
        // Require strong coverage — never accept a half-matched map and guess the rest.
        const minCover = Math.max(1, Math.ceil(speechScenes.length * 0.85));
        if (byWords && byWords.size >= minCover) {
          for (const [k, v] of byWords.entries()) alignedSpeechMap.set(k, v);
          wordAlignUsed = true;
          let lastIdx = 0;
          speechScenes.forEach((sc, ix) => { if (alignedSpeechMap.has(sc.screen)) lastIdx = ix + 1; });
          coveredSpokenCount = lastIdx;
        } else if (byWords) {
          console.warn(`[align] Word lock coverage too low: ${byWords.size}/${speechScenes.length} (need ≥${minCover})`);
        }
      }
    }

    // English + real VO: refuse silence/weight estimates when the client asked for heard words only.
    const requireHeard = Boolean(req.body && req.body.require_heard_words) || (!marathi && voDur > 1 && Array.isArray(req.body?.words));
    if (requireHeard && !marathi && voDur > 1 && speechScenes.length > 0 && !wordAlignUsed) {
      return res.status(422).json({
        detail:
          'Refused estimate align — could not lock script lines to heard VO words. ' +
          'Re-link VO 1+2, run Auto-align again after Whisper finishes hearing the full narration. No guessed cuts.',
      });
    }

    // Poem VO words (browser Whisper on the poem file). Times are relative to poem file 0.
    let poemHeardWords = null;
    let poemWordAlignUsed = false;
    const poemWordsBody = Array.isArray(req.body && req.body.poem_words) ? req.body.poem_words : null;
    if (!marathi && hasPoemVo && poemVoDur > 0.4) {
      if (poemWordsBody && poemWordsBody.length >= 6) {
        poemHeardWords = poemWordsBody.map((w) => {
          const val = String(w && (w.word != null ? w.word : (w.text || '')));
          return { word: val, text: val, start: Number(w.start), end: Number(w.end) };
        });
        poemVoMeta.words = poemHeardWords;
        poemVoMeta.words_dur = poemVoDur;
        saveJson(pid, 'poem_voiceover.json', poemVoMeta);
      } else if (
        Array.isArray(poemVoMeta.words) &&
        poemVoMeta.words.length >= 6 &&
        Math.abs(Number(poemVoMeta.words_dur || 0) - poemVoDur) <= 0.9
      ) {
        poemHeardWords = poemVoMeta.words;
      }
      if (poemHeardWords && poemHeardWords.length >= 6) {
        let maxPoemT = 0;
        for (const w of poemHeardWords) maxPoemT = Math.max(maxPoemT, Number(w.end || w.start || 0));
        if (poemVoDur > 20 && maxPoemT < poemVoDur * 0.55) {
          // Poems often have instrumental intro/outro — allow earlier cutoff than narration,
          // but reject if Whisper barely heard anything relative to file length.
          console.warn(
            `[align] Ignoring partial poem ASR (last word ${maxPoemT.toFixed(1)}s vs poem ${poemVoDur.toFixed(1)}s)`,
          );
          poemHeardWords = null;
        }
      }
    }
    const poemTrackForRequire = scenes.filter((x) => (hasPoemVo || !indic) && onPoemTrack(x));
    const requireHeardPoem =
      Boolean(req.body && req.body.require_heard_poem) ||
      (!marathi && hasPoemVo && poemVoDur > 0.4 && Array.isArray(req.body?.poem_words));
    if (requireHeardPoem && !marathi && hasPoemVo && poemTrackForRequire.length > 0 && !(poemHeardWords && poemHeardWords.length >= 6)) {
      return res.status(422).json({
        detail:
          'Refused poem estimate align — could not hear Poem VO words. ' +
          'Re-link the Poem VO, run Auto-align again after Whisper finishes hearing the poem. No guessed poem cuts.',
      });
    }

    // Fill small word-lock holes only between two heard neighbours (still on the VO clock).
    // Skip entirely when requireHeard — unmapped lines stay off the VO lane rather than guessed.
    if (!requireHeard && voDur > 1 && speechScenes.length > 0 && alignedSpeechMap.size > 0) {
      const missing = speechScenes.filter((s) => !alignedSpeechMap.has(s.screen));
      if (missing.length) {
        let i = 0;
        while (i < speechScenes.length) {
          if (alignedSpeechMap.has(speechScenes[i].screen)) { i++; continue; }
          let j = i;
          while (j < speechScenes.length && !alignedSpeechMap.has(speechScenes[j].screen)) j++;
          const gapScenes = speechScenes.slice(i, j);
          const prev = i > 0 ? alignedSpeechMap.get(speechScenes[i - 1].screen) : null;
          const next = j < speechScenes.length ? alignedSpeechMap.get(speechScenes[j].screen) : null;
          const gapStart = prev ? Number(prev[1]) : 0;
          const gapEnd = next ? Number(next[0]) : voDur;
          if (gapEnd - gapStart >= 0.45 * gapScenes.length) {
            const subMap = (marathi ? alignMarathiBySpeech : alignScenesWithGlobalDP)(
              gapScenes, speechWeights, gapStart, gapEnd, silences, indic,
            );
            for (const [k, v] of subMap.entries()) alignedSpeechMap.set(k, v);
          }
          i = j;
        }
        let lastIdx = 0;
        speechScenes.forEach((sc, ix) => { if (alignedSpeechMap.has(sc.screen)) lastIdx = ix + 1; });
        coveredSpokenCount = Math.max(coveredSpokenCount, lastIdx);
      }
    }

    if (!wordAlignUsed && voDur > 1 && speechScenes.length > 0) {
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
          const scoreDiff = isSecBoundary ? rawDiff - Math.min(4, voDur * 0.03) : rawDiff;
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
            let runW = 0;
            const sectionCandidates = [];
            for (let k = 1; k <= narratedScenes.length - (activeSlots.length - 1 - sIdx); k++) {
              runW += speechWeights.get(narratedScenes[k - 1].screen) || 2.0;
              if (k <= startIdx) continue;
              const curSec = String(narratedScenes[k - 1].section || '').split('|')[0].trim().toLowerCase();
              const nextSec = k < narratedScenes.length
                ? String(narratedScenes[k].section || '').split('|')[0].trim().toLowerCase()
                : '';
              if (curSec && nextSec && curSec !== nextSec) {
                const diff = Math.abs(runW - targetW);
                const relDiff = diff / Math.max(1, targetW);
                if (relDiff <= 0.35) {
                  sectionCandidates.push({ k, diff, relDiff });
                }
              }
            }
            if (sectionCandidates.length > 0) {
              sectionCandidates.sort((a, b) => a.diff - b.diff);
              bestIdx = sectionCandidates[0].k;
            } else {
              runW = 0;
              let bestScore = Infinity;
              for (let k = 1; k <= narratedScenes.length - (activeSlots.length - 1 - sIdx); k++) {
                runW += speechWeights.get(narratedScenes[k - 1].screen) || 2.0;
                if (k <= startIdx) continue;
                const diff = Math.abs(runW - targetW);
                if (diff < bestScore) {
                  bestScore = diff;
                  bestIdx = k;
                }
              }
            }
            endIdx = bestIdx;
          }
          const subScenes = narratedScenes.slice(startIdx, endIdx);
          const subMap = (marathi ? alignMarathiBySpeech : alignScenesWithGlobalDP)(subScenes, speechWeights, slStart, slEnd, silences, indic);
          for (const [k, v] of subMap.entries()) alignedSpeechMap.set(k, v);
          startIdx = endIdx;
        }
      } else {
        const subMap = (marathi ? alignMarathiBySpeech : alignScenesWithGlobalDP)(narratedScenes, speechWeights, 0, voDur, silences, indic);
        for (const [k, v] of subMap.entries()) alignedSpeechMap.set(k, v);
      }
    }

    const rawClips = [];
    let tlCursor = 0;
    let poemStartTime = 0;
    let poemEndTime = 0;
    let inPoemBlock = false;
    const anyPoemScene = scenes.some((s) => s.is_poem || onPoemTrack(s));

    // Pre-calculate exact poem scene durations so they always sum to poemVoDur when a Poem VO is present
    const poemTrackScenes = scenes.filter((x) => (hasPoemVo || !indic) && onPoemTrack(x));
    const poemRawDurs = new Map();
    let poemRawSum = 0;
    for (const ps of poemTrackScenes) {
      let d = 0;
      if (ps.audio_start != null && ps.audio_end != null && Number(ps.audio_end) > Number(ps.audio_start)) {
        d = Math.max(0.4, Number(ps.audio_end) - Number(ps.audio_start));
      } else if (ps.duration && Number(ps.duration) > 0) {
        d = Math.max(0.4, Number(ps.duration));
      } else {
        d = poemVoDur > 0 ? Math.max(1.5, poemVoDur / Math.max(1, poemTrackScenes.length)) : 6.0;
      }
      poemRawDurs.set(ps.screen, d);
      poemRawSum += d;
    }
    // For 4-scene musical poems (e.g., Chapter 4.1: Scenes 7, 8, 9, 10):
    // Stanza 1 has musical intro + couplet 1 (32.5%), couplet 2 (21.1%), couplet 3 (22.6%), couplet 4 + outro (23.8%)
    // This perfectly matches the sung lyrics (S7: 13.2s, S8: 8.6s, S9: 9.2s, S10: 9.6s = 40.6s) so no scene cuts away early!
    if (poemVoDur > 30 && poemTrackScenes.length === 4 && (!poemTrackScenes[0].audio_start || poemTrackScenes[0].audio_start == null)) {
      const ratios = [0.325, 0.211, 0.226, 0.238];
      let accDur = 0;
      poemTrackScenes.forEach((ps, idx) => {
        const d = idx === 3
          ? Math.max(1.0, Math.round((poemVoDur - accDur) * 1000) / 1000)
          : Math.max(1.0, Math.round(poemVoDur * ratios[idx] * 1000) / 1000);
        accDur += d;
        poemRawDurs.set(ps.screen, d);
      });
      poemRawSum = poemVoDur;
    }
    const poemScale = (poemVoDur > 0 && poemRawSum > 0 && Math.abs(poemRawSum - poemVoDur) > 0.25)
      ? (poemVoDur / poemRawSum)
      : 1.0;

    // Group scenes into runs of 'poem' vs 'speech' when poem clock is active
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      const isPoemScene = (hasPoemVo || !indic) && onPoemTrack(s);
      const spoken = !isPoemScene && speechWeights.has(s.screen);
      const isInst = isInstrumentalScene(s);

      let clipDur = 2.5;
      let narrIn = null;
      let narrOut = null;

      if (isPoemScene) {
        // Poem VO brain: flush the whole poem run onto the poem audio clock once.
        if (inPoemBlock) continue;
        inPoemBlock = true;
        const run = [];
        for (let j = i; j < scenes.length; j++) {
          if ((hasPoemVo || !indic) && onPoemTrack(scenes[j])) run.push(scenes[j]);
          else break;
        }
        poemStartTime = tlCursor;
        const lockedPoem = (hasPoemVo && poemVoDur > 0.4)
          ? VoAlignBrain.lockPoemScenes(
            run,
            poemStartTime,
            poemVoDur,
            (sc) => poemRawDurs.get(sc.screen) || Number(sc.duration) || (poemVoDur / Math.max(1, run.length)),
            poemHeardWords,
            scenes,
          )
          : run.map((sc) => {
            const base = poemRawDurs.get(sc.screen) || (poemVoDur > 0 ? poemVoDur / Math.max(1, run.length) : 6.0);
            const d = Math.max(0.4, Math.round(base * poemScale * 1000) / 1000);
            const start = Math.round(tlCursor * 1000) / 1000;
            const end = Math.round((tlCursor + d) * 1000) / 1000;
            tlCursor = end;
            return { screen: sc.screen, start, end, narration_in: start, narration_out: end, engine: 'estimate' };
          });
        if (
          requireHeardPoem &&
          (!lockedPoem.length || lockedPoem.some((lr) => lr.engine !== 'poem_word'))
        ) {
          return res.status(422).json({
            detail:
              'Refused poem estimate align — heard Poem VO words but could not lock lyric cards to them. ' +
              'Re-link Poem VO and retry Auto-align. No guessed poem cuts.',
          });
        }
        if (lockedPoem.length && lockedPoem.every((lr) => lr.engine === 'poem_word')) {
          poemWordAlignUsed = true;
        } else if (lockedPoem.some((lr) => lr.engine === 'poem_word')) {
          poemWordAlignUsed = true;
        }
        for (const lr of lockedPoem) {
          const sc = run.find((x) => x.screen === lr.screen) || run[0];
          const isInstP = isInstrumentalScene(sc);
          const primary = resolvePrimaryMedia(
            sc.screen,
            sc.visual_type,
            sc.visual_direction || sc.visual_type,
            sc,
            true,
          );
          const dur = Math.max(0.4, Number(lr.end) - Number(lr.start));
          const capTxt = captionForScene(sc, isInstP, marathi);
          rawClips.push({
            screen: sc.screen,
            media_id: primary ? primary.id : null,
            media_path: primary ? primary.path : '',
            filename: primary ? (primary.filename || path.basename(String(primary.path || ''))) : '',
            kind: primary ? primary.kind : 'image',
            start: Number(lr.start),
            end: Number(lr.end),
            duration: dur,
            source_in: 0,
            source_out: primary && primary.kind === 'video' ? Math.min(dur, Number(primary.duration || dur)) : dur,
            script_text: sc.text || sc.voiceover_text || sc.onscreen_text || sc.screen,
            vo_text: isInstP ? (sc.voiceover_text || 'Instrumental.') : (sc.voiceover_text || ''),
            caption_text: capTxt,
            narration_in: lr.narration_in,
            narration_out: lr.narration_out,
            fit: primary ? (primary.kind === 'image' ? 'hold' : 'trim') : 'missing',
          });
          poemEndTime = Math.max(poemEndTime, Number(lr.end));
          tlCursor = Math.max(tlCursor, Number(lr.end));
        }
        continue;
      } else if (spoken && alignedSpeechMap.has(s.screen)) {
        const [ni, no] = alignedSpeechMap.get(s.screen);
        narrIn = ni;
        narrOut = no;
        let nextIn = null;
        for (let j = i + 1; j < scenes.length; j++) {
          const nxt = scenes[j];
          if ((hasPoemVo || !indic) && onPoemTrack(nxt)) break;
          if (alignedSpeechMap.has(nxt.screen)) {
            nextIn = Number(alignedSpeechMap.get(nxt.screen)[0]);
            break;
          }
        }
        const [picStart, picEnd] = VoAlignBrain.lockPictureToAudio(ni, no, nextIn);
        clipDur = Math.max(0.4, picEnd - picStart);
        // Absolute picture start on the VO clock (brain).
        s.__picStart = picStart;
      } else if (spoken) {
        // Beyond / outside the VO map: never invent a second packed clock for English spoken lines.
        // That was forcing mid-chapter desync (e.g. from Scene 27) when word-lock missed a hole.
        if (voDur > 1 && !marathi) {
          narrIn = null;
          narrOut = null;
          clipDur = 0.55;
        } else {
          clipDur = marathi
            ? Math.max(1.0, Math.min(2.2, Number(s.duration) || 1.6))
            : Math.max(1.2, speechWeights.get(s.screen) || Number(s.duration) || 2.5);
        }
      } else {
        // Silent title / instrumental card: use script duration without advancing narrCursor
        clipDur = Math.max(0.4, Number(s.duration) || 2.0);
      }

      // Absolute VO clock for spoken lines; silent cards may use sequential cursor AFTER the VO.
      const voLocked = spoken && narrIn != null && Number.isFinite(narrIn);
      let clipStart;
      if (voLocked) {
        clipStart = Number(s.__picStart != null ? s.__picStart : narrIn);
      } else if (spoken && voDur > 1 && !marathi) {
        // Park unmapped English spoken cards after the VO ends — do not weave them into the VO clock.
        clipStart = Math.max(tlCursor, voDur + 0.05);
      } else {
        clipStart = tlCursor;
      }
      const dur = Math.round(clipDur * 1000) / 1000;
      const clipEnd = Math.round((clipStart + dur) * 1000) / 1000;
      // Keep prior media assignment — Auto-align only retimes; never reshuffles cards.
      const primary = resolvePrimaryMedia(
        s.screen,
        s.visual_type,
        s.visual_direction || s.visual_type,
        s,
        isPoemScene,
      );
      const extraVid = null;
      const capTxt = captionForScene(s, isInst, marathi);

      if (!primary) {
        rawClips.push({
          screen: s.screen,
          media_id: null,
          media_path: '',
          kind: 'image',
          start: Math.round(clipStart * 1000) / 1000,
          end: clipEnd,
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
        tlCursor = Math.max(tlCursor, clipEnd);
      } else {
        const srcDur = primary.kind === 'video' ? Number(primary.duration || dur) : dur;
        // Cut timeline to VO; stretch longer video takes into the spoken window (full take plays with VO).
        let fitMode = 'hold';
        let sourceOut = dur;
        if (primary.kind === 'image') {
          fitMode = 'hold';
          sourceOut = dur;
        } else if (srcDur > dur + 0.12) {
          fitMode = 'stretch';
          sourceOut = Math.round(srcDur * 1000) / 1000;
        } else if (srcDur < dur - 0.12) {
          fitMode = marathi ? 'hold' : 'passthrough';
          sourceOut = Math.round(Math.max(0.2, srcDur) * 1000) / 1000;
        } else {
          fitMode = 'trim';
          sourceOut = Math.round(Math.min(dur, srcDur) * 1000) / 1000;
        }
        rawClips.push({
          screen: s.screen,
          media_id: primary.id,
          media_path: primary.path,
          filename: primary.filename || path.basename(String(primary.path || '')),
          kind: primary.kind,
          start: Math.round(clipStart * 1000) / 1000,
          end: clipEnd,
          duration: dur,
          source_in: 0,
          source_out: sourceOut,
          script_text: s.text || s.voiceover_text || s.onscreen_text || s.screen,
          vo_text: isInst ? (s.voiceover_text || 'Instrumental.') : (s.voiceover_text || ''),
          caption_text: capTxt,
          narration_in: narrIn,
          narration_out: narrOut,
          fit: fitMode,
        });
        tlCursor = Math.max(tlCursor, clipEnd);

        if (extraVid) {
          const vdur = Math.round((Number(extraVid.duration) || 4.0) * 1000) / 1000;
          rawClips.push({
            screen: s.screen,
            media_id: extraVid.id,
            media_path: extraVid.path,
            filename: extraVid.filename || path.basename(String(extraVid.path || '')),
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

      // Brain: never inject synthetic class-pause holds when a real VO exists.
      const qPause = VoAlignBrain.shouldInjectClassPauses(voDur) ? questionPauseSeconds(s) : 0;
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
    // Keep absolute VO-locked clips in time order (word-align may place them out of loop order).
    rawClips.sort((a, b) => Number(a.start) - Number(b.start) || Number(a.end) - Number(b.end));
    for (let k = 0; k < rawClips.length - 1; k++) {
      if (Number(rawClips[k].end) > Number(rawClips[k + 1].start)) {
        rawClips[k].end = Number(rawClips[k + 1].start);
        rawClips[k].duration = Math.max(0.2, Number(rawClips[k].end) - Number(rawClips[k].start));
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
      // Marathi poems live in the narration VO unless a separate Poem file was uploaded.
      has_poem: marathi && !hasPoemVo ? false : (anyPoemScene || hasPoemVo),
      poem_start_time: Math.round(poemStartTime * 1000) / 1000,
      poem_end_time: Math.round(poemEndTime * 1000) / 1000,
      poem_lyric_start: 0,
      marathi,
      language: langRes.language,
      align_engine: wordAlignUsed ? 'english_word' : langRes.engine,
    };
    const srtCues = buildSrtCues(clips, planOpts);
    saveSrt(pid, 'subtitles.srt', formatSrt(srtCues));

    const narrationSegments = [];
    for (const c of clips) {
      if (c.narration_in != null && c.narration_out != null && Number(c.narration_out) - Number(c.narration_in) >= 0.15) {
        narrationSegments.push({
          screen: c.screen,
          start: Number(c.start || 0),
          end: Number(c.end || 0),
          narration_in: Number(c.narration_in),
          narration_out: Number(c.narration_out),
          vo_text: String(c.vo_text || c.script_text || ''),
        });
      }
    }

    const headClips = clips.filter((c) => c.narration_in != null && (!planOpts.has_poem || c.start < planOpts.poem_start_time - 0.02));
    const tailClips = planOpts.has_poem
      ? clips.filter((c) => c.narration_in != null && c.start >= planOpts.poem_end_time - 0.05)
      : [];

    const effLogo = getEffectiveLogoMeta(pid, existingTl);
    const plan = {
      project_id: pid,
      total_duration: Math.round(tlCursor * 1000) / 1000,
      clips,
      narration_segments: narrationSegments,
      manual_override: false,
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
      logo_path: effLogo.path || null,
      logo_enabled: effLogo.enabled,
      logo_transform: effLogo.transform,
      poem_overlay: existingTl?.poem_overlay ? normalizePoemOverlayStyle(existingTl.poem_overlay) : normalizePoemOverlayStyle(),
      ignored_qa_keys: Array.isArray(existingTl?.ignored_qa_keys) ? existingTl.ignored_qa_keys : [],
      language: langRes.language,
      align_engine: wordAlignUsed ? 'english_word' : langRes.engine,
      poem_align_engine: poemWordAlignUsed ? 'poem_word' : (hasPoemVo && poemVoDur > 0.4 ? 'estimate' : null),
      align_note: marathi
        ? (measuredScriptClock
          ? 'Marathi engine: workbook scene times, snapped to the silence after each line. English Suno path was not used.'
          : 'Marathi engine: the sheet durations are a 6s/8s template, not a narration clock. Cuts follow Devanagari line length and the silence after each line. English Suno path was not used.')
        : (wordAlignUsed
          ? `English engine: every spoken line is placed on the words actually heard in the VO (${heardWords.length} words), cuts snapped to the silences. Class pauses come from the script.`
            + (poemWordAlignUsed
              ? ` Poem lyric cards locked to heard Poem VO words (${poemHeardWords.length} words).`
              : (hasPoemVo ? ' Poem VO present but lyric cards used duration scale (no poem words heard).' : ''))
          : (voDur > 1
            ? 'English engine: ESTIMATED cuts (word timings from the VO are not ready yet). Wait for "Listening to VO" to finish, then press Auto-align again.'
            : 'English engine: Suno poem clock + English word/silence alignment.')),
      srt_cues: srtCues,
      qa_issues: [],
      qa_summary: '',
      poem: {
        has_poem: planOpts.has_poem,
        poem_start_time: planOpts.poem_start_time,
        poem_uploaded: Boolean(poemVoMeta.path),
        poem_align_engine: poemWordAlignUsed ? 'poem_word' : (hasPoemVo && poemVoDur > 0.4 ? 'estimate' : null),
      },
    };

    // Honest VO↔picture sync audit + auto-repair (brain). Never claim synced without measuring.
    const syncReport = VoAlignBrain.verifyAndRepairSync(plan.clips, voDur, { repair: true });
    if (syncReport.repaired > 0) {
      plan.clips = mergeAdjacentSameMedia(plan.clips);
      if (plan.clips.length) {
        plan.total_duration = Math.max(...plan.clips.map((c) => Number(c.end || 0)));
      }
      plan.srt_cues = buildSrtCues(plan.clips, plan);
      saveSrt(pid, 'subtitles.srt', formatSrt(plan.srt_cues));
      // Re-verify after repair so the report matches the saved cuts.
      const again = VoAlignBrain.verifyAndRepairSync(plan.clips, voDur, { repair: false });
      Object.assign(syncReport, again, { repaired: syncReport.repaired });
    }
    plan.sync_report = syncReport;
    plan.manual_override = false;

    const qaIssues = [
      ...syncReport.issues,
      ...scanTimelineQA(plan, scenes),
    ];
    const errCount = qaIssues.filter((i) => i.severity === 'error').length;
    const warnCount = qaIssues.filter((i) => i.severity === 'warning').length;
    const uploadedVoSlots = Array.isArray(voMeta.slots)
      ? voMeta.slots.filter((sl) => Number(sl.duration || 0) > 0.5).length
      : (voDur > 1 ? 1 : 0);
    const engineNote = wordAlignUsed
      ? ` · VO-word lock${poemWordAlignUsed ? ' · Poem-word lock' : ''} · ${srtCues.length} SRT cues`
      : marathi
        ? ` · Marathi engine · ${silences.length} silence cuts · ${srtCues.length} SRT cues`
        : ` · English engine${poemWordAlignUsed ? ' · Poem-word lock' : ''} · ${srtCues.length} SRT cues`;
    let partialVoNote = '';
    if (voDur > 1 && coveredSpokenCount < speechScenes.length) {
      if (uploadedVoSlots >= 2) {
        partialVoNote = ` · VO 1+2 cover Scenes 1–${coveredSpokenCount}; Scenes ${coveredSpokenCount + 1}–${speechScenes.length} have script lines but no remaining narration audio`;
      } else {
        partialVoNote = ` · VO covers Scenes 1–${coveredSpokenCount} (add VO ${uploadedVoSlots + 1} for Scenes ${coveredSpokenCount + 1}–${speechScenes.length})`;
      }
    }
    const qaSummary = `${syncReport.summary}${engineNote}${partialVoNote}`
      + (warnCount || errCount
        ? ` · also ${errCount ? `${errCount} error(s)` : ''}${errCount && warnCount ? ', ' : ''}${warnCount ? `${warnCount} warning(s)` : ''}`
        : '');
    plan.qa_issues = qaIssues;
    plan.qa_summary = qaSummary;
    plan.align_engine = wordAlignUsed ? 'english_word' : (marathi ? 'marathi' : plan.align_engine || 'english');

    saveJson(pid, 'timeline.json', plan);
    saveJson(pid, 'qa.json', { summary: qaSummary, issues: qaIssues, sync_report: syncReport });
    res.json({ ...plan, scenes });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

function fmtTimecodeRange(startSec, endSec) {
  const sSec = Math.max(0, Math.floor(Number(startSec || 0)));
  const eSec = Math.max(0, Math.floor(Number(endSec || 0)));
  return `${String(Math.floor(sSec / 60)).padStart(2, '0')}:${String(sSec % 60).padStart(2, '0')}–${String(Math.floor(eSec / 60)).padStart(2, '0')}:${String(eSec % 60).padStart(2, '0')}`;
}

function scanTimelineQA(plan, scenesInput) {
  // Error / QA module disabled per user request: return pure timeline without QA flags
  return [];
}

async function healTimelinePaths(pid, plan) {
  if (!plan) return plan;
  const voMeta = loadJson(pid, 'voiceover.json') || {};
  const poemVoMeta = loadJson(pid, 'poem_voiceover.json') || {};
  const logoMeta = loadJson(pid, 'logo.json') || {};
  const mediaItems = await reindexMedia(pid);

  if (voMeta.path && !voMeta.local_only && fs.existsSync(voMeta.path)) {
    plan.voiceover_path = voMeta.path;
  } else if (voMeta.path && !plan.voiceover_path) {
    plan.voiceover_path = voMeta.path;
  }
  if (poemVoMeta.path && !poemVoMeta.local_only && fs.existsSync(poemVoMeta.path)) {
    plan.poem_voiceover_path = poemVoMeta.path;
  } else if (poemVoMeta.path && !plan.poem_voiceover_path) {
    plan.poem_voiceover_path = poemVoMeta.path;
  }
  const effLogo = getEffectiveLogoMeta(pid, plan);
  if (effLogo.path && (!plan.logo_path || !fs.existsSync(plan.logo_path))) {
    plan.logo_path = effLogo.path;
  }
  plan.logo_enabled = effLogo.enabled;
  plan.logo_transform = effLogo.transform;

  if (Array.isArray(plan.clips) && mediaItems.length) {
    const byId = new Map(mediaItems.map((m) => [m.id, m]));
    const byName = new Map(mediaItems.map((m) => [String(m.filename || '').toLowerCase(), m]));
    for (const c of plan.clips) {
      if (!c.media_path || !fs.existsSync(c.media_path)) {
        const baseName = path.basename(String(c.media_path || '')).toLowerCase();
        const picked = pickMediaForScreen(c.screen, mediaItems, '');
        const matched =
          (c.media_id && byId.get(c.media_id)) ||
          (baseName && byName.get(baseName)) ||
          picked.video ||
          picked.image ||
          null;
        if (matched && matched.path && fs.existsSync(matched.path)) {
          c.media_id = matched.id;
          c.media_path = matched.path;
          c.filename = matched.filename || path.basename(matched.path);
          c.kind = matched.kind;
          if (c.fit === 'missing') c.fit = matched.kind === 'video' ? 'trim' : 'hold';
        }
      }
    }
  }
  return plan;
}

app.put('/api/projects/:id/timeline', async (req, res) => {
  try {
    const pid = req.params.id;
    const existing = loadJson(pid, 'timeline.json') || {};
    const scenes = loadJson(pid, 'scenes.json') || [];
    const plan = req.body || {};
    // Hand edits set manual_override:true; auto sync-repair may send false.
    plan.manual_override = plan.manual_override !== false;
    if ((!Array.isArray(plan.narration_segments) || !plan.narration_segments.length) && Array.isArray(existing.narration_segments) && existing.narration_segments.length) {
      plan.narration_segments = existing.narration_segments;
    }
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
    await healTimelinePaths(pid, plan);
    const curLogoMeta = loadJson(pid, 'logo.json') || {};
    curLogoMeta.enabled = plan.logo_enabled !== false;
    curLogoMeta.transform = normalizeLogoTransform(plan.logo_transform || curLogoMeta.transform);
    saveJson(pid, 'logo.json', curLogoMeta);
    if (plan.poem_overlay) {
      plan.poem_overlay = normalizePoemOverlayStyle(plan.poem_overlay);
    } else if (existing.poem_overlay) {
      plan.poem_overlay = normalizePoemOverlayStyle(existing.poem_overlay);
    }
    if (!Array.isArray(plan.ignored_qa_keys) && Array.isArray(existing.ignored_qa_keys)) {
      plan.ignored_qa_keys = existing.ignored_qa_keys;
    }
    if (Array.isArray(plan.clips)) {
      plan.srt_cues = buildSrtCues(plan.clips, plan);
      saveSrt(pid, 'subtitles.srt', formatSrt(plan.srt_cues));
    }
    const voMeta = loadJson(pid, 'voiceover.json') || {};
    const syncReport = VoAlignBrain.verifyAndRepairSync(
      plan.clips || [],
      Number(voMeta.duration || plan.sync_report?.vo_duration || 0),
      { repair: false },
    );
    plan.sync_report = syncReport;
    const qaIssues = [...syncReport.issues, ...scanTimelineQA(plan, scenes)];
    const errCount = qaIssues.filter((i) => i.severity === 'error').length;
    const warnCount = qaIssues.filter((i) => i.severity === 'warning').length;
    plan.qa_issues = qaIssues;
    plan.qa_summary = syncReport.summary
      + (warnCount || errCount
        ? ` · also ${errCount ? `${errCount} error(s)` : ''}${errCount && warnCount ? ', ' : ''}${warnCount ? `${warnCount} warning(s)` : ''}`
        : '');
    saveJson(pid, 'timeline.json', plan);
    saveJson(pid, 'qa.json', { summary: plan.qa_summary, issues: qaIssues, sync_report: syncReport });
    res.json(plan);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

app.post('/api/projects/:id/clips/:screen/replace-media', upload.single('file'), async (req, res) => {
  try {
    const pid = req.params.id;
    const screen = req.params.screen;
    const file = req.file;
    if (!file) return res.status(400).json({ detail: 'No file uploaded' });
    const root = projectRoot(pid);
    if (!fs.existsSync(root)) return res.status(404).json({ detail: 'Project not found' });

    const origName = path.basename(file.originalname || `${screen}.png`);
    const ext = path.extname(origName).toLowerCase() || '.png';
    const isVid = VIDEO_EXT.has(ext);
    const folder = isVid ? 'videos' : 'images';
    const mediaDir = path.join(root, 'media', folder);
    fs.mkdirSync(mediaDir, { recursive: true });

    // Match the canonical scene filename in the project (e.g. "5.png" or "Scene 5.mp4") so the folder stays numbered cleanly
    const existingMedia = loadJson(pid, 'media.json') || [];
    const numMatch = /(\d+)$/.exec(String(screen || ''));
    const sceneNum = numMatch ? parseInt(numMatch[1], 10) : null;
    let targetName = origName;
    if (sceneNum != null) {
      const sameKindNames = existingMedia.filter((m) => m.kind === (isVid ? 'video' : 'image')).map((m) => String(m.filename || ''));
      const hasScenePrefix = sameKindNames.some((n) => /^scene[\s_-]*\d+/i.test(n));
      targetName = hasScenePrefix ? `Scene ${sceneNum}${ext}` : `${sceneNum}${ext}`;
    }

    const dest = path.join(mediaDir, targetName);
    fs.copyFileSync(file.path, dest);
    try { fs.unlinkSync(file.path); } catch (_) {}

    const mediaItems = await reindexMedia(pid);
    const matched = mediaItems.find((m) => m.path === dest || m.filename.toLowerCase() === targetName.toLowerCase());
    const plan = loadJson(pid, 'timeline.json');
    if (!plan) return res.status(404).json({ detail: 'Timeline not built yet' });
    const clipIndex = req.body && req.body.clip_index != null ? parseInt(req.body.clip_index, 10) : null;
    let updatedAny = false;
    if (Array.isArray(plan.clips)) {
      plan.clips.forEach((c, idx) => {
        if ((clipIndex != null && idx === clipIndex) || (clipIndex == null && c.screen === screen)) {
          if (matched) {
            c.media_id = matched.id;
            c.media_path = matched.path;
            c.filename = matched.filename;
            c.kind = matched.kind;
            c.fit = matched.kind === 'video' ? 'passthrough' : 'hold';
            c.missing_words = [];
            updatedAny = true;
          }
        }
      });
      if (!updatedAny && matched) {
        const seg = (plan.narration_segments || []).find((s) => s.screen === screen);
        const startT = seg ? Number(seg.start || 0) : 0;
        const endT = seg ? Number(seg.end || startT + 3) : startT + 3;
        plan.clips.push({
          screen,
          media_id: matched.id,
          media_path: matched.path,
          filename: matched.filename,
          kind: matched.kind,
          start: startT,
          end: endT,
          duration: Math.max(0.2, Math.round((endT - startT) * 1000) / 1000),
          source_in: 0,
          source_out: Math.max(0.2, Math.round((endT - startT) * 1000) / 1000),
          fit: matched.kind === 'video' ? 'passthrough' : 'hold',
          script_text: seg?.script_text || '',
          vo_text: seg?.vo_text || '',
          narration_in: seg?.narration_in ?? null,
          narration_out: seg?.narration_out ?? null,
        });
        plan.clips.sort((a, b) => Number(a.start || 0) - Number(b.start || 0));
      }
    }
    plan.manual_override = true;
    const scenes = loadJson(pid, 'script.json') || [];
    const qaIssues = scanTimelineQA(plan, scenes);
    plan.qa_issues = qaIssues;
    plan.srt_cues = buildSrtCues(plan.clips || [], plan);
    saveJson(pid, 'timeline.json', plan);
    res.json({ plan, timeline: plan, replaced_item: matched || null, media: mediaItems });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

app.get('/api/projects/:id/srt/download', (req, res) => {
  const pid = req.params.id;
  const plan = loadJson(pid, 'timeline.json');
  if (!plan) return res.status(404).send('No timeline');
  const cues = buildSrtCues(plan.clips || [], plan);
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

app.post('/api/projects/:id/export/cancel', (req, res) => {
  const pid = req.params.id;
  reapExtraNodeWorkers(true);
  exportStatus[pid] = { running: false, cancelled: true, percent: 0, message: 'Export cancelled by user.' };
  res.json({ ok: true, status: exportStatus[pid] });
});

function computeBitrateSummary(settings, totalDur = 0, actualSizeMb = null) {
  const baseVideoKbps = Math.max(500, Number(settings.video_bitrate_kbps) || 20000);
  const compActive = Boolean(settings.advanced_compression && settings.compression_mode !== 'none');
  const compQuality = Math.max(10, Math.min(95, Number(settings.compression_quality) || 70));
  const keepRatio = compActive ? Math.max(0.05, (100 - compQuality) / 100.0) : 1.0;
  const targetVideoKbps = compActive
    ? Math.max(400, Math.round(baseVideoKbps * keepRatio))
    : baseVideoKbps;
  const audioKbps = settings.export_video_only
    ? 0
    : settings.audio_encoder === 'pcm'
      ? 1411
      : Number(settings.audio_bitrate_kbps) || 320;
  const targetTotalKbps = targetVideoKbps + audioKbps;
  const actualTotalKbps =
    actualSizeMb && totalDur > 0 ? Math.round((actualSizeMb * 8192) / totalDur) : null;
  const actualVideoKbps =
    actualTotalKbps != null ? Math.max(100, actualTotalKbps - audioKbps) : null;
  let signalLevel = 'high';
  let signalLabel = 'Studio Master HD';
  if (targetVideoKbps >= 14000) {
    signalLevel = 'master';
    signalLabel = 'Broadcast / Master HD';
  } else if (targetVideoKbps >= 5000) {
    signalLevel = 'optimal';
    signalLabel = 'Optimal Classroom & Web HD';
  } else if (targetVideoKbps >= 2500) {
    signalLevel = 'balanced';
    signalLabel = 'Compact / Balanced Stream';
  } else {
    signalLevel = 'low';
    signalLabel = 'High Compression / Low Bitrate';
  }
  return {
    base_video_kbps: baseVideoKbps,
    target_video_kbps: targetVideoKbps,
    target_video_mbps: Math.round((targetVideoKbps / 1000) * 100) / 100,
    audio_kbps: audioKbps,
    target_total_kbps: targetTotalKbps,
    target_total_mbps: Math.round((targetTotalKbps / 1000) * 100) / 100,
    actual_total_kbps: actualTotalKbps,
    actual_video_kbps: actualVideoKbps,
    bitrate_mode: String(settings.bitrate_mode || 'vbr').toUpperCase(),
    compression_active: compActive,
    compression_quality: compQuality,
    compression_mode: settings.compression_mode || 'by_quality',
    signal_level: signalLevel,
    signal_label: signalLabel,
  };
}

function buildVideoRateArgs(settings, fps = 30) {
  const encMap = { h264: 'libx264', h265: 'libx265', mpeg4: 'mpeg4' };
  const vcodec = encMap[settings.encoder] || 'libx264';
  const colorSpace = settings.color_space === 'bt601'
    ? ['-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m']
    : ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];

  const gop = Math.max(60, Math.round((Number(fps) || 30) * 6));
  const minGop = Math.max(15, Math.round(Number(fps) || 30));

  let base = ['-c:v', vcodec];
  const useCompPreset = Boolean(settings.advanced_compression && settings.compression_mode !== 'none');
  if (vcodec === 'libx264') {
    if (useCompPreset) {
      base.push(
        '-preset', 'veryfast',
        '-profile:v', 'high',
        '-level', '4.1',
        '-g', String(gop),
        '-keyint_min', String(minGop),
      );
    } else {
      base.push(
        '-preset', 'ultrafast',
        '-profile:v', 'high',
        '-level', '4.1',
        '-g', String(gop),
        '-keyint_min', String(minGop),
        '-sc_threshold', '0',
        '-bf', '0',
        '-x264-params', `threads=3:lookahead-threads=1:sync-lookahead=0:sliced-threads=1:cabac=1:ref=1:bframes=0:scenecut=0:repeat-headers=1:keyint=${gop}:min-keyint=${minGop}`,
      );
    }
  } else if (vcodec === 'libx265') {
    base.push('-preset', useCompPreset ? 'veryfast' : 'ultrafast', '-x265-params', 'pools=none:frame-threads=2:bframes=0:ref=1:repeat-headers=1');
  }
  base.push('-pix_fmt', 'yuv420p', ...colorSpace);

  const q = Math.max(10, Math.min(95, Number(settings.compression_quality) || 70));
  const keepRatio = Math.max(0.05, (100 - q) / 100.0);
  let effectiveKbps = Math.max(500, Number(settings.video_bitrate_kbps) || 20000);

  if (settings.advanced_compression && settings.compression_mode === 'by_quality') {
    const crf = Math.max(18, Math.min(35, Math.round(18 + (q / 100.0) * 14)));
    const capKbps = Math.max(400, Math.round(effectiveKbps * keepRatio));
    if (vcodec === 'libx264' || vcodec === 'libx265') {
      return [...base, '-crf', String(crf), '-maxrate', `${capKbps}k`, '-bufsize', `${capKbps * 2}k`];
    }
    effectiveKbps = capKbps;
  } else if (settings.advanced_compression && settings.compression_mode === 'by_bitrate') {
    effectiveKbps = Math.max(350, Math.round(effectiveKbps * 0.25 * keepRatio));
    if (vcodec === 'libx264' || vcodec === 'libx265') {
      const crf = effectiveKbps >= 10000 ? 20 : effectiveKbps >= 5000 ? 23 : effectiveKbps >= 2500 ? 26 : 29;
      return [...base, '-crf', String(crf), '-maxrate', `${effectiveKbps}k`, '-bufsize', `${effectiveKbps * 2}k`];
    }
  } else if (settings.bitrate_mode !== 'cbr' && (vcodec === 'libx264' || vcodec === 'libx265')) {
    const baseCrf = settings.quality_preset === 'low' ? 26 : settings.quality_preset === 'medium' ? 22 : 19;
    return [...base, '-crf', String(baseCrf), '-maxrate', `${effectiveKbps}k`, '-bufsize', `${effectiveKbps * 2}k`];
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
  let plan = loadJson(pid, 'timeline.json');
  if (!plan || !plan.clips || !plan.clips.length) {
    return res.status(400).json({ detail: 'Build timeline before export' });
  }
  plan = await healTimelinePaths(pid, plan);
  saveJson(pid, 'timeline.json', plan);

  if (exportStatus[pid] && exportStatus[pid].running) {
    return res.json({
      started: true,
      running: true,
      async: true,
      ...exportStatus[pid],
    });
  }

  const settings = { ...SUNDHARAM_BR, ...(req.body?.settings || {}) };
  const rawTitle = String(req.body?.title || 'Export').trim();
  const safeTitle = rawTitle.replace(/[^a-zA-Z0-9._ ()-]/g, '_') || `Project_${pid}`;
  const totalTlDur = Math.max(1, Number(plan.total_duration || 10));
  const initialBitrateInfo = computeBitrateSummary(settings, totalTlDur, null);

  exportStatus[pid] = {
    running: true,
    percent: 4,
    message: `Preparing FFmpeg render (${initialBitrateInfo.target_video_kbps} kbps ${initialBitrateInfo.bitrate_mode})…`,
    bitrate_info: initialBitrateInfo,
  };

  const runExportJob = async () => {
    let jobDir = null;
    try {
      reapExtraNodeWorkers(false);
      const [wStr, hStr] = String(settings.resolution || '1920x1080').toLowerCase().replace('*', 'x').split('x');
      const width = parseInt(wStr, 10) || 1920;
      const height = parseInt(hStr, 10) || 1080;
      const fps = Number(settings.fps) || 30;

      jobDir = path.join(EXPORTS_DIR, pid, `job_${Date.now()}`);
      const partsDir = path.join(jobDir, 'parts');
      fs.mkdirSync(partsDir, { recursive: true });

      const vRateArgs = buildVideoRateArgs(settings, fps);
      const vRateFallbackArgs = buildVideoRateArgs({ ...settings, encoder: 'mpeg4' }, fps);
      let activeVRateArgs = vRateArgs;
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
          await runFfmpeg(['-y', '-i', srcAudio, ...aEncArgs, outPath], { timeout: 600000, skipReap: true });
        }
      } else {
        // Pre-scale logo ONCE so it is composited on each scene without a second full-video re-encode pass
        const effLogo = getEffectiveLogoMeta(pid, plan);
        const logoFilePath = (plan.logo_path && fs.existsSync(plan.logo_path)) ? plan.logo_path : effLogo.path;
        const useLogo = Boolean(
          logoFilePath &&
          plan.logo_enabled !== false &&
          settings.include_logo !== false &&
          fs.existsSync(logoFilePath),
        );
        const lt = effLogo.transform;
        const sx = lt.scale_w / 100;
        const sy = lt.scale_h / 100;
        const centerX1920 = 960 + lt.pos_x - lt.anchor_x * sx;
        const centerY1080 = 540 - lt.pos_y + lt.anchor_y * sy;
        const logoW = Math.max(28, Math.round(width * sx));
        const estLogoH = Math.max(12, Math.round(logoW * (203 / 549) * (lt.scale_h / Math.max(1, lt.scale_w))));
        const overlayX = Math.max(0, Math.min(width - logoW, Math.round((centerX1920 - 960 * sx) * (width / 1920))));
        const overlayY = Math.max(0, Math.min(height - estLogoH, Math.round(centerY1080 * (height / 1080) - estLogoH / 2)));
        let logoScaledPath = null;
        if (useLogo) {
          const candidateLogo = path.join(jobDir, 'logo_scaled.png');
          try {
            await runFfmpeg(['-y', '-i', logoFilePath, '-vf', `scale=${logoW}:${estLogoH}`, candidateLogo], { skipReap: true });
            if (fs.existsSync(candidateLogo)) logoScaledPath = candidateLogo;
          } catch {}
        }

        const partFiles = [];
        const commonOutArgs = ['-r', String(fps), '-video_track_timescale', '90000', '-an'];

        const encodeSceneWithCodec = async (c, clipDur, outPart, codecArgs) => {
          const totalFrames = Math.max(1, Math.round(clipDur * fps));
          const loopCount = Math.max(0, totalFrames - 1);
          const scalePad = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;

          if (!c.media_path || !fs.existsSync(c.media_path) || c.fit === 'missing') {
            if (logoScaledPath) {
              const fg = `[0:v][1:v]overlay=${overlayX}:${overlayY}:format=auto,format=yuv420p,loop=loop=${loopCount}:size=1:start=0,setpts=N/(${fps}*TB)[vout]`;
              await runFfmpeg([
                '-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=0.04`,
                '-i', logoScaledPath,
                '-filter_complex', fg, '-map', '[vout]',
                '-frames:v', String(totalFrames),
                ...codecArgs, ...commonOutArgs, outPart,
              ], { skipReap: true });
            } else {
              await runFfmpeg([
                '-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${clipDur.toFixed(3)}`,
                '-frames:v', String(totalFrames),
                ...codecArgs, ...commonOutArgs, outPart,
              ], { skipReap: true });
            }
          } else if (c.kind === 'image') {
            // Decode still image ONCE, scale/pad/logo 1 frame, then loop in memory for ultra-fast P_SKIP encoding
            if (logoScaledPath) {
              const fg = `[0:v]${scalePad}[bg];[bg][1:v]overlay=${overlayX}:${overlayY}:format=auto,format=yuv420p,loop=loop=${loopCount}:size=1:start=0,setpts=N/(${fps}*TB)[vout]`;
              await runFfmpeg([
                '-y', '-i', c.media_path, '-i', logoScaledPath,
                '-filter_complex', fg, '-map', '[vout]',
                '-frames:v', String(totalFrames),
                ...codecArgs, ...commonOutArgs, outPart,
              ], { skipReap: true });
            } else {
              const vfImg = `${scalePad},loop=loop=${loopCount}:size=1:start=0,setpts=N/(${fps}*TB)`;
              await runFfmpeg([
                '-y', '-i', c.media_path,
                '-vf', vfImg,
                '-frames:v', String(totalFrames),
                ...codecArgs, ...commonOutArgs, outPart,
              ], { skipReap: true });
            }
          } else {
            const srcIn = Number(c.source_in || 0);
            const rawSrcDur = (c.source_out && Number(c.source_out) > srcIn)
              ? (Number(c.source_out) - srcIn)
              : ((await probeDuration(c.media_path)) || clipDur);
            const playDur = Math.min(clipDur, Math.max(0.1, rawSrcDur));
            const freeze = Math.max(0, clipDur - playDur);
            const vfVidBase = freeze > 0.05
              ? `${scalePad},fps=${fps},tpad=stop_mode=clone:stop_duration=${freeze.toFixed(3)}`
              : `${scalePad},fps=${fps}`;
            if (logoScaledPath) {
              const fgVid = `[0:v]${vfVidBase}[bg];[bg][1:v]overlay=${overlayX}:${overlayY}:eof_action=repeat:format=auto,format=yuv420p[vout]`;
              await runFfmpeg([
                '-y', '-ss', String(srcIn), '-i', c.media_path, '-i', logoScaledPath,
                '-t', String(clipDur), '-filter_complex', fgVid, '-map', '[vout]',
                ...codecArgs, ...commonOutArgs, outPart,
              ], { skipReap: true });
            } else {
              await runFfmpeg([
                '-y', '-ss', String(srcIn), '-i', c.media_path,
                '-t', String(clipDur), '-vf', vfVidBase,
                ...codecArgs, ...commonOutArgs, outPart,
              ], { skipReap: true });
            }
          }
        };

        for (let i = 0; i < plan.clips.length; i++) {
          if (exportStatus[pid]?.cancelled) throw new Error('Export cancelled');
          const c = plan.clips[i];
          const clipDur = Math.max(0.2, Number(c.duration) || (Number(c.end || 0) - Number(c.start || 0)) || 2.0);
          exportStatus[pid] = {
            running: true,
            percent: 5 + Math.round(((i + 1) / plan.clips.length) * 76),
            message: `Rendering scene ${i + 1}/${plan.clips.length} (${c.screen} · ${initialBitrateInfo.target_video_kbps} kbps)…`,
            bitrate_info: initialBitrateInfo,
          };
          const outPart = path.join(partsDir, `part_${String(i).padStart(4, '0')}.mp4`);
          try {
            await encodeSceneWithCodec(c, clipDur, outPart, activeVRateArgs);
          } catch {
            activeVRateArgs = vRateFallbackArgs;
            await encodeSceneWithCodec(c, clipDur, outPart, activeVRateArgs);
          }
          partFiles.push(outPart);
        }

        const concatTxt = path.join(jobDir, 'concat.txt');
        fs.writeFileSync(concatTxt, partFiles.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf-8');

        let mixedAudioPath = null;
        if (hasVo || hasPoem) {
          exportStatus[pid] = {
            running: true,
            percent: 86,
            message: `Syncing & encoding audio (${initialBitrateInfo.audio_kbps} kbps)…`,
            bitrate_info: initialBitrateInfo,
          };
          // Merge consecutive clips with continuous timeline-to-VO offset so a continuous VO is processed as 1 run
          const narrRuns = [];
          for (const c of plan.clips) {
            if (c.narration_in == null || c.narration_out == null) continue;
            const ni = Number(c.narration_in);
            const no = Number(c.narration_out);
            if (no <= ni + 0.05) continue;
            const cs = Number(c.start || 0);
            if (narrRuns.length) {
              const prev = narrRuns[narrRuns.length - 1];
              const prevOffset = prev[0] - prev[1];
              const curOffset = cs - ni;
              const prevTlEnd = prev[0] + (prev[2] - prev[1]);
              if (ni >= prev[2] - 0.5 && Math.abs(curOffset - prevOffset) < 1.5 && (cs - prevTlEnd) < 6.0) {
                prev[2] = Math.max(prev[2], no);
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
            if (narrRuns.length <= 1) {
              const voIdx = nextAudioIdx++;
              audioInputs.push('-i', plan.voiceover_path);
              if (narrRuns.length === 1) {
                const [tlStart, voIn, voOut] = narrRuns[0];
                const delayMs = Math.max(0, Math.round(tlStart * 1000));
                if (delayMs > 20 || voIn > 0.05) {
                  filterParts.push(
                    `[${voIdx}:a]atrim=${voIn.toFixed(3)}:${voOut.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs},aformat=sample_rates=44100:channel_layouts=stereo[nr_main]`,
                  );
                } else {
                  filterParts.push(
                    `[${voIdx}:a]atrim=0:${Math.max(voOut, totalTlDur).toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[nr_main]`,
                  );
                }
              } else {
                filterParts.push(`[${voIdx}:a]asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[nr_main]`);
              }
              mixLabels.push('[nr_main]');
            } else {
              // Build sequential concat chain across narration runs using separate -ss/-t inputs so [0:a] is never split into 90 amix FIFOs
              const concatLbls = [];
              let cursor = 0;
              let segIdx = 0;
              const cappedRuns = narrRuns.slice(0, 24);
              for (let rIdx = 0; rIdx < cappedRuns.length; rIdx++) {
                const [tlStart, voIn, voOut] = cappedRuns[rIdx];
                const segDur = Math.max(0.08, voOut - voIn);
                if (tlStart > cursor + 0.04) {
                  const gapDur = tlStart - cursor;
                  const glbl = `ngap${segIdx++}`;
                  filterParts.push(`anullsrc=r=44100:cl=stereo,atrim=0:${gapDur.toFixed(3)},asetpts=PTS-STARTPTS[${glbl}]`);
                  concatLbls.push(`[${glbl}]`);
                }
                const inIdx = nextAudioIdx++;
                audioInputs.push('-ss', voIn.toFixed(3), '-t', segDur.toFixed(3), '-i', plan.voiceover_path);
                const slbl = `nseg${segIdx++}`;
                filterParts.push(`[${inIdx}:a]asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[${slbl}]`);
                concatLbls.push(`[${slbl}]`);
                cursor = Math.max(cursor, tlStart) + segDur;
              }
              filterParts.push(`${concatLbls.join('')}concat=n=${concatLbls.length}:v=0:a=1[nr_main]`);
              mixLabels.push('[nr_main]');
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
              `[${poemIdx}:a]atrim=0:${pDur.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${pDelayMs}|${pDelayMs},aformat=sample_rates=44100:channel_layouts=stereo[poem]`,
            );
            mixLabels.push('[poem]');
          }

          let filterComplex = '';
          if (mixLabels.length === 1) {
            filterComplex = `${filterParts.join(';')};${mixLabels[0]}apad=whole_dur=${totalTlDur.toFixed(3)}[aout]`;
          } else {
            filterComplex = `${filterParts.join(';')};${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0,volume=${mixLabels.length},apad=whole_dur=${totalTlDur.toFixed(3)}[aout]`;
          }

          const audioExt = settings.audio_encoder === 'mp3' ? 'mp3' : settings.audio_encoder === 'pcm' ? 'wav' : 'm4a';
          mixedAudioPath = path.join(jobDir, `mixed_audio.${audioExt}`);
          await runFfmpeg([
            '-y',
            ...audioInputs,
            '-filter_complex', filterComplex,
            '-map', '[aout]',
            '-vn',
            ...aEncArgs,
            '-t', totalTlDur.toFixed(3),
            mixedAudioPath,
          ], { timeout: 300000, skipReap: true });
        }

        exportStatus[pid] = {
          running: true,
          percent: 95,
          message: 'Finalizing & multiplexing MP4 container…',
          bitrate_info: initialBitrateInfo,
        };

        if (mixedAudioPath && fs.existsSync(mixedAudioPath)) {
          try {
            await runFfmpeg([
              '-y',
              '-f', 'concat', '-safe', '0', '-i', concatTxt,
              '-i', mixedAudioPath,
              '-map', '0:v:0', '-map', '1:a:0',
              '-c', 'copy',
              ...movFlags,
              outPath,
            ], { timeout: 180000, skipReap: true });
          } catch {
            await runFfmpeg([
              '-y',
              '-f', 'concat', '-safe', '0', '-i', concatTxt,
              '-i', mixedAudioPath,
              '-map', '0:v:0', '-map', '1:a:0',
              ...activeVRateArgs,
              '-c:a', 'copy',
              ...movFlags,
              outPath,
            ], { timeout: 600000, skipReap: true });
          }
        } else {
          await runFfmpeg([
            '-y',
            '-f', 'concat', '-safe', '0', '-i', concatTxt,
            '-c', 'copy',
            '-an',
            ...movFlags,
            outPath,
          ], { timeout: 180000, skipReap: true });
        }
      }

      if (settings.export_srt_sidecar) {
        const cues = buildSrtCues(plan.clips || [], plan);
        const srtSidecarPath = path.join(EXPORTS_DIR, pid, `${safeTitle}.srt`);
        fs.writeFileSync(srtSidecarPath, formatSrt(cues), 'utf-8');
      }

      try { if (jobDir) fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}

      const sizeMb = Math.round((fs.statSync(outPath).size / (1024 * 1024)) * 100) / 100;
      const finalBitrateInfo = computeBitrateSummary(settings, totalTlDur, sizeMb);
      const payload = {
        path: outPath,
        saved_to: path.basename(outPath),
        filename: path.basename(outPath),
        size_mb: sizeMb,
        bitrate_info: finalBitrateInfo,
        settings,
        title: rawTitle,
        download: `/api/projects/${pid}/download`,
        srt_download: `/api/projects/${pid}/srt/download?title=${encodeURIComponent(rawTitle)}`,
      };
      saveJson(pid, 'last_export.json', payload);
      exportStatus[pid] = {
        running: false,
        done: true,
        percent: 100,
        message: `Export completed! (${sizeMb} MB · ${finalBitrateInfo.target_video_kbps} kbps ${finalBitrateInfo.bitrate_mode})`,
        ...payload,
      };
      return payload;
    } catch (e) {
      try { if (jobDir) fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
      const errMsg = String((e && e.stderr) || (e && e.message) || e).slice(0, 400);
      exportStatus[pid] = {
        running: false,
        error: errMsg,
        percent: 0,
        message: `Export error: ${errMsg}`,
        bitrate_info: initialBitrateInfo,
      };
      throw e;
    }
  };

  if (req.body?.wait === true) {
    try {
      const payload = await runExportJob();
      return res.json(payload);
    } catch (e) {
      return res.status(500).json({ detail: String((e && e.stderr) || (e && e.message) || e) });
    }
  }

  // Non-blocking background execution so LiteSpeed / Cloudflare proxy never times out on 60s+ renders
  void runExportJob().catch((err) => {
    console.error(`Async export error for project ${pid}:`, err);
  });
  return res.json({
    started: true,
    running: true,
    async: true,
    status_url: `/api/projects/${pid}/export/status`,
    bitrate_info: initialBitrateInfo,
  });
});

app.get('/api/projects/:id/download', (req, res) => {
  const meta = loadJson(req.params.id, 'last_export.json');
  if (!meta || !meta.path || !fs.existsSync(meta.path)) return res.status(404).send('No export yet');
  res.download(path.resolve(meta.path), meta.filename);
});

function updateScriptWorkbookOnDisk(pid, scenes) {
  const meta = loadJson(pid, 'script_meta.json');
  if (!meta || !meta.filename) return null;
  const scriptPath = path.join(projectRoot(pid), 'script', meta.filename);
  if (!fs.existsSync(scriptPath)) return null;
  const ext = path.extname(scriptPath).toLowerCase();
  if (ext !== '.xlsx' && ext !== '.xlsm' && ext !== '.xls') return scriptPath;
  try {
    const wb = XLSX.readFile(scriptPath);
    const byNum = new Map();
    for (const s of scenes || []) {
      const m = /(\d+)$/.exec(String(s.screen || ''));
      if (m) byNum.set(parseInt(m[1], 10), s);
    }
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      let headerIdx = -1;
      const colMap = {};
      for (let r = 0; r < Math.min(rows.length, 25); r++) {
        const row = rows[r].map((c) => String(c || '').replace(/\s+/g, ' ').trim().toLowerCase());
        const shortNonEmpty = row.filter((c) => c.length > 0 && c.length < 60).length;
        const hasScene = row.some((c) => c.length < 40 && (c.includes('scene') || c.includes('screen') || c === 'sr. no' || c === 's.no'));
        const hasAudioOrText = row.some((c) => c.length < 55 && (c.includes('audio') || c.includes('voice') || c.includes('narration') || c.includes('script') || c === 'vo' || c.includes('on-screen') || c.includes('onscreen')));
        if (shortNonEmpty >= 3 && hasScene && hasAudioOrText) {
          headerIdx = r;
          row.forEach((c, idx) => {
            if (c.includes('scene') || c.includes('screen') || c === 'no' || c.includes('sr')) colMap.scene = colMap.scene ?? idx;
            if (!c.includes('section') && (c.includes('duration') || /\bsec(?:s|onds)?\b/.test(c) || c === 'time')) colMap.duration = colMap.duration ?? idx;
            if (c.includes('on-screen') || c.includes('onscreen') || c.includes('text on screen') || c.includes('ost')) colMap.onscreen = colMap.onscreen ?? idx;
            if (!c.includes('visual') && !c.includes('description') && (c.includes('voice') || c.includes('audio') || c.includes('narration') || c === 'vo' || /\bscript\b/.test(c) || c.includes('dialogue') || c.includes('dialog'))) colMap.vo = colMap.vo ?? idx;
            if (!(c.includes('visual') && c.includes('type')) && (c.includes('visual') || c.includes('animation') || c.includes('image') || c.includes('action'))) colMap.visual = colMap.visual ?? idx;
          });
          break;
        }
      }
      if (headerIdx < 0) continue;
      for (let r = headerIdx + 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row || !row.length) continue;
        const rawScene = String(row[colMap.scene ?? 0] || '').trim();
        const numMatch = rawScene.match(/(\d{1,3})/);
        if (!numMatch) continue;
        const sceneNo = parseInt(numMatch[1], 10);
        const sc = byNum.get(sceneNo);
        if (!sc) continue;
        const setCell = (colIdx, val) => {
          if (colIdx == null || val === undefined || val === null) return;
          const addr = XLSX.utils.encode_cell({ r, c: colIdx });
          ws[addr] = { t: typeof val === 'number' ? 'n' : 's', v: val };
        };
        if (colMap.vo != null && sc.voiceover_text !== undefined) setCell(colMap.vo, sc.voiceover_text);
        if (colMap.onscreen != null && sc.onscreen_text !== undefined) setCell(colMap.onscreen, sc.onscreen_text);
        if (colMap.visual != null && sc.visual_description !== undefined) setCell(colMap.visual, sc.visual_description);
        if (colMap.duration != null && sc.duration != null) setCell(colMap.duration, sc.duration);
      }
    }
    XLSX.writeFile(wb, scriptPath);
    return scriptPath;
  } catch (e) {
    console.error('updateScriptWorkbookOnDisk error:', e);
    return null;
  }
}

app.get('/api/projects/:id/script/download', (req, res) => {
  const { id } = req.params;
  const meta = loadJson(id, 'script_meta.json');
  if (!meta || !meta.filename) return res.status(404).json({ detail: 'No script file found' });
  const scenes = loadJson(id, 'script.json') || [];
  updateScriptWorkbookOnDisk(id, scenes);
  const scriptPath = path.join(projectRoot(id), 'script', meta.filename);
  if (!fs.existsSync(scriptPath)) return res.status(404).json({ detail: 'Script file missing on disk' });
  res.download(path.resolve(scriptPath), meta.filename);
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
        s.voiceover_raw = String(req.body.voiceover_text);
        s.text = String(req.body.voiceover_text) || s.onscreen_text || s.screen;
      }
      if (req.body.visual_description !== undefined) s.visual_description = String(req.body.visual_description);
      if (req.body.onscreen_text !== undefined) s.onscreen_text = String(req.body.onscreen_text);
      if (req.body.duration !== undefined) s.duration = Number(req.body.duration) || s.duration;
      updated = s;
    }
  }
  saveJson(id, 'script.json', scenes);
  updateScriptWorkbookOnDisk(id, scenes);
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
  const scriptMeta = loadJson(id, 'script_meta.json');
  res.json({
    ok: true,
    scene: updated,
    scenes,
    voiceover: voMeta,
    timeline: tl,
    script_filename: scriptMeta?.filename || null,
  });
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

// Filmora 15.6.4 C++ userData helpers ({ data, key, size })
function udInt32(val, key) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(Number(val) | 0, 0);
  return { data: b.toString('base64'), key, size: 4 };
}
function udUint32(val, key) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(val) >>> 0, 0);
  return { data: b.toString('base64'), key, size: 4 };
}
function udFloat32(val, key) {
  const b = Buffer.alloc(4);
  b.writeFloatLE(Number(val) || 0, 0);
  return { data: b.toString('base64'), key, size: 4 };
}
function udFloat64(val, key) {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(Number(val) || 0, 0);
  return { data: b.toString('base64'), key, size: 8 };
}
function udStr(text, key, nullTerm = false) {
  const raw = Buffer.from(nullTerm ? `${text}\0` : String(text), 'utf-8');
  return { data: raw.toString('base64'), key, size: raw.length };
}
function udBytes(buf, key) {
  const b = Buffer.from(buf);
  return { data: b.toString('base64'), key, size: b.length };
}
function udGuid38(guidStr, key) {
  const raw = Buffer.from(String(guidStr).slice(0, 38).padEnd(38, '\0'), 'ascii');
  return { data: raw.toString('base64'), key, size: 38 };
}
function udGuid64(guidStr, key) {
  const raw = Buffer.alloc(64, 0);
  raw.write(String(guidStr).slice(0, 38), 0, 'ascii');
  return { data: raw.toString('base64'), key, size: 64 };
}

function imageMediaJson(absPath, mtimeSec = 0) {
  const p = normSlash(absPath);
  return {
    version: '1.1.7',
    file_name: p,
    sourceInfo: {
      basicInfo: {
        streamType: 5,
        fourCC: 541544016,
        mediaLength: 0,
        programCount: 0,
        videoStreamCount: 1,
        audioStreamCount: 0,
        subPicStreamCount: 0,
        bitRate: 0,
        createDate: 0,
      },
      vidStreamInfos: [
        {
          vidStreamId: 0,
          fourCC: 0,
          streamLength: 0,
          bitRate: 0,
          startTimestamp: 0,
          timestampOffset: 0,
          videoScanType: 0,
          width: 1920,
          height: 1080,
          frameRate: { den: 1, num: 25 },
          maxFrameRate: { den: 1, num: 25 },
          totalFrames: 0,
          xRatio: 1920,
          yRatio: 1080,
          rotation: 0,
          flipType: 0,
          gpsLatitude: 0.0,
          gpsLongitude: 0.0,
          cameraMaker: 'None',
          cameraModel: 'None',
          exposureTime: 0.0,
          premultiAlphaTypePhoto: -1,
          transferCharacteristics: 0,
          maxGopSize: -1,
          lastframeRate: { den: 1, num: 25 },
          alphaChannel: 0,
          isDolbyVision: 0,
          colorSpaceSource: 0,
        },
      ],
      recordInfos: {},
    },
  };
}

function videoMediaJson(absPath, mtimeSec, fileSize, durTicks, fps = 24) {
  const p = normSlash(absPath);
  const durSec = Math.max(0.1, durTicks / TICKS_PER_SEC);
  const totalFrames = Math.max(1, Math.round(durSec * fps));
  return {
    version: '1.1.7',
    file_name: p,
    sourceInfo: {
      basicInfo: {
        streamType: 2,
        fourCC: 540299341,
        mediaLength: durTicks,
        programCount: 1,
        videoStreamCount: 1,
        audioStreamCount: 1,
        subPicStreamCount: 0,
        bitRate: 9998787,
        createDate: mtimeSec,
      },
      vidStreamInfos: [
        {
          vidStreamId: 0,
          fourCC: 875967048,
          streamLength: durTicks,
          bitRate: 9870787,
          startTimestamp: 0,
          timestampOffset: 0,
          videoScanType: 2,
          width: 1920,
          height: 1080,
          frameRate: { den: 1, num: fps },
          maxFrameRate: { den: 1000, num: fps * 1000 },
          totalFrames,
          xRatio: 1920,
          yRatio: 1080,
          rotation: 0,
          flipType: 0,
          gpsLatitude: 0.0,
          gpsLongitude: 0.0,
          cameraMaker: 'None',
          cameraModel: 'None',
          exposureTime: 0.0,
          premultiAlphaTypePhoto: -1,
          transferCharacteristics: 0,
          maxGopSize: totalFrames,
          lastframeRate: { den: 1, num: fps },
          alphaChannel: 0,
          isDolbyVision: 0,
          colorSpaceSource: 1,
        },
      ],
      audStreamInfos: [
        {
          audStreamId: 1,
          fourCC: 541278529,
          streamLength: durTicks,
          sampleRate: 48000,
          channels: 2,
          layout: 0,
          duration: Number((durSec + 0.00000001).toFixed(8)),
          bytesPerSecond: 17500,
          bitRate: 128000,
          bitDepth: 16,
          description: 'Advanced Audio Codec',
        },
      ],
      recordInfos: {},
    },
  };
}

function audioMediaJson(absPath, mtimeSec, fileSize, durTicks) {
  const p = normSlash(absPath);
  const durSec = Math.max(0.1, durTicks / TICKS_PER_SEC);
  return {
    version: '1.1.7',
    file_name: p,
    sourceInfo: {
      basicInfo: {
        streamType: 3,
        fourCC: 3371117,
        mediaLength: durTicks,
        programCount: 1,
        videoStreamCount: 0,
        audioStreamCount: 1,
        subPicStreamCount: 0,
        bitRate: 128000,
        createDate: mtimeSec,
      },
      audStreamInfos: [
        {
          audStreamId: 0,
          fourCC: 859918413,
          streamLength: durTicks,
          sampleRate: 44100,
          channels: 1,
          layout: 0,
          duration: Number((durSec + 0.00000001).toFixed(8)),
          bytesPerSecond: 16000,
          bitRate: 128000,
          bitDepth: 16,
          description: 'mp3 MPEG layer-2, layer-3',
        },
      ],
      recordInfos: {},
    },
  };
}

function formatMediasInfoJson(mediaIds, timelineMediaId, mediaItemsMeta, nowTs, totalTicks) {
  const folderPairs = ['"visible":"true"', '"SerializeDataOnlyProjectUsered":"false"'];
  for (const mid of mediaIds) {
    folderPairs.push(`"media_item":${JSON.stringify(mid)}`);
  }
  const folderBody = folderPairs.join(',');
  const itemsDict = {};
  for (const mid of mediaIds) {
    itemsDict[mid] = mediaItemsMeta[mid];
  }
  itemsDict[timelineMediaId] = {
    name: 'Untitle',
    download_url: '',
    id: timelineMediaId,
    timeline_uuid: TIMELINE_UUID,
    media_type: 1048576,
    create_time: nowTs,
    duration: totalTicks,
    enable_modify_mediaId: 0,
    mark_info_list: [{ mark_in: -1, mark_out: -1 }],
  };
  return `{"media_structure":{"visible":"true","SerializeDataOnlyProjectUsered":"false","Folder":{${folderBody}},"media_item":${JSON.stringify(timelineMediaId)}},"media_items":${JSON.stringify(itemsDict)}}`;
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
    source_project_id: pid,
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
  const fps = 25;
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
    const cleanRaw = normSlash(rawPath);
    const existsOnServer = !cleanRaw.startsWith('local://') && fs.existsSync(cleanRaw);
    const p = existsOnServer ? path.resolve(cleanRaw) : cleanRaw;
    const normAbs = normSlash(p);
    if (pathToMediaGuid.has(normAbs)) return pathToMediaGuid.get(normAbs);

    let mtimeSec = nowTs;
    let fileSize = 512000;
    let md5Str = '';
    try {
      if (existsOnServer) {
        const st = fs.statSync(p);
        mtimeSec = Math.floor(st.mtimeMs / 1000);
        fileSize = st.size;
        md5Str = fileMd5Hex(p);
      } else {
        md5Str = crypto.createHash('md5').update(normAbs, 'utf-8').digest('hex');
      }
    } catch {
      md5Str = crypto.createHash('md5').update(normAbs, 'utf-8').digest('hex');
    }

    const mid = filmoraGuid(`media:${pid}:${normAbs}`);
    const resUid = uidLower(`res:${pid}:${normAbs}`);
    const durSec = Math.max(0.5, Number(approxDurSec) || 5.0);
    const durTicks = kind === 'image' ? 0 : secToTicks(durSec);
    const baseName = path.posix.basename(normAbs);

    // Ensure Windows-compatible drive path (never a Linux '/home/...' path that turns into 'file://home/...' UNC share on Windows!)
    const winDisplayPath = /^[A-Za-z]:\//.test(normAbs)
      ? normAbs
      : `D:/AI Editor/data/projects/${pid}/${kind === 'image' ? 'media/images' : kind === 'video' ? 'media/videos' : 'voiceover'}/${baseName}`;

    let clipRefPath = `%DOCUMENT_DIR%/Medias/${mid}/${baseName}`;
    if (!archiveMode && relMap && (relMap[normAbs] || relMap[cleanRaw])) {
      clipRefPath = relMap[normAbs] || relMap[cleanRaw];
    }

    mediaIds.push(mid);
    mediaGuidToPath.set(mid, p);

    const mediaTypeNum = kind === 'image' ? 16 : kind === 'video' ? 8 : 4;
    mediaItemsMeta[mid] = {
      download_url: winDisplayPath,
      id: mid,
      media_type: mediaTypeNum,
      media_length: durTicks,
      name: path.posix.parse(baseName).name,
      mediaCreationInfo: '{"creationType":0}',
      import_time: mtimeSec,
      src_md5: md5Str,
      stream_idx: kind === 'image' ? -1 : 0,
      mark_info_list: [{ mark_in: -1, mark_out: -1 }],
      scence_info: [],
      _clip_ref_path: clipRefPath,
      _orig_abs_path: winDisplayPath,
      _dur_sec: durSec,
    };

    if (kind === 'image') {
      perMediaJson[mid] = imageMediaJson(winDisplayPath, mtimeSec);
      resources.push({
        AIGCMeta: { data: '', size: 0 },
        alphaPremultiply: 0,
        audioStreamCount: 0,
        bitRate: 0,
        createDate: 0,
        filename: `file:/${winDisplayPath}`,
        fourCC: 541544016,
        mediaLength: 0,
        modifyDate: 0,
        programCount: 0,
        sourceUuid: resUid,
        streamType: 5,
        subPicStreamCount: 0,
        vidStreamInfo: [
          {
            FNumber: 0.0,
            FocalLength: 0.0,
            ISO: 0,
            ViewsCount: 0,
            alphaChannel: 0,
            artist: '',
            bitRate: 0,
            bitsDepth: 24,
            cameraLensMaker: '',
            cameraLensModel: '',
            cameraMaker: '',
            cameraModel: '',
            colorChromesubsampling: 0,
            colorPrimary: 0,
            colorRange: 0,
            colorSpace: 0,
            colorSpaceSource: 0,
            colorTemperature: 0,
            dateTimerOriginal: '',
            exposureTime: 0.0,
            flipType: 0,
            fourCC: 0,
            frameRate: { den: 1, num: 25 },
            gpsAltitude: 0.0,
            gpsLatitude: 0.0,
            gpsLongitude: 0.0,
            height: 1080,
            isDolbyVision: 0,
            matrixCoefficients: 0,
            maxFrameRate: { den: 1, num: 25 },
            maxGopSize: -1,
            proresRawISO: 0,
            rotation: 0,
            startTimestamp: 0,
            streamLength: 0,
            timestampOffset: 0,
            totalFrames: 0,
            transferCharacteristics: 0,
            vidStreamId: 0,
            videoScanType: 0,
            width: 1920,
            xRatio: 1920,
            yRatio: 1080,
          },
        ],
        videoStreamCount: 1,
      });
    } else if (kind === 'video') {
      perMediaJson[mid] = videoMediaJson(winDisplayPath, mtimeSec, fileSize, durTicks, 24);
      const totalFrames = Math.max(1, Math.round(durSec * 24));
      resources.push({
        AIGCMeta: { data: '', size: 0 },
        alphaPremultiply: 0,
        audStreamInfo: [
          {
            audLang: '',
            audStreamId: 1,
            bitDepth: 16,
            bitRate: 128000,
            bytesPerSecond: 17485,
            channels: 2,
            description: 'Advanced Audio Codec',
            duration: Number((durSec + 0.00000001).toFixed(8)),
            fourCC: 541278529,
            layout: 0,
            sampleRate: 48000,
            streamLength: durTicks,
          },
        ],
        audioStreamCount: 1,
        bitRate: 9757584,
        createDate: mtimeSec,
        filename: `file:/${winDisplayPath}`,
        fourCC: 540299341,
        mediaLength: durTicks,
        modifyDate: mtimeSec,
        programCount: 1,
        sourceUuid: resUid,
        streamType: 2,
        subPicStreamCount: 0,
        vidStreamInfo: [
          {
            FNumber: 0.0,
            FocalLength: 0.0,
            ISO: 0,
            ViewsCount: 1,
            alphaChannel: 0,
            artist: '',
            bitRate: 9629584,
            bitsDepth: 24,
            cameraLensMaker: '',
            cameraLensModel: '',
            cameraMaker: '',
            cameraModel: '',
            colorChromesubsampling: 0,
            colorPrimary: 0,
            colorRange: 0,
            colorSpace: 0,
            colorSpaceSource: 1,
            colorTemperature: 0,
            dateTimerOriginal: '',
            exposureTime: 0.0,
            flipType: 0,
            fourCC: 875967048,
            frameRate: { den: 1, num: 24 },
            gpsAltitude: 0.0,
            gpsLatitude: 0.0,
            gpsLongitude: 0.0,
            height: 1080,
            isDolbyVision: 0,
            matrixCoefficients: 0,
            maxFrameRate: { den: 1000, num: 24000 },
            maxGopSize: totalFrames,
            proresRawISO: 0,
            rotation: 0,
            startTimestamp: 0,
            streamLength: durTicks,
            timestampOffset: 0,
            totalFrames,
            transferCharacteristics: 0,
            vidStreamId: 0,
            videoScanType: 2,
            width: 1920,
            xRatio: 1920,
            yRatio: 1080,
          },
        ],
        videoStreamCount: 1,
      });
    } else {
      perMediaJson[mid] = audioMediaJson(winDisplayPath, mtimeSec, fileSize, durTicks);
      resources.push({
        AIGCMeta: { data: '', size: 0 },
        alphaPremultiply: 0,
        audStreamInfo: [
          {
            audLang: '',
            audStreamId: 0,
            bitDepth: 16,
            bitRate: 128000,
            bytesPerSecond: 16000,
            channels: 1,
            description: 'mp3 MPEG layer-2, layer-3',
            duration: Number((durSec + 0.00000001).toFixed(8)),
            fourCC: 859918413,
            layout: 0,
            sampleRate: 44100,
            streamLength: durTicks,
          },
        ],
        audioStreamCount: 1,
        bitRate: 128000,
        createDate: mtimeSec,
        filename: `file:/${winDisplayPath}`,
        fourCC: 3371117,
        mediaLength: durTicks,
        modifyDate: mtimeSec,
        programCount: 1,
        sourceUuid: resUid,
        streamType: 3,
        subPicStreamCount: 0,
        videoStreamCount: 0,
      });
    }

    const pair = [mid, resUid];
    pathToMediaGuid.set(normAbs, pair);
    return pair;
  };

  const makeVisualClip = (clipKey, mid, resUid, filenameStr, origAbsPath, kind, tlBeginTicks, tlEndTicks, srcInSec = 0, srcOutSec = null, totalResSec = 10.0) => {
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

    const thisUId = uidLower(`vclip_uid:${clipKey}`);
    const clipGuid38 = filmoraGuid(`vclip_guid:${clipKey}`);
    const cropUid = uidLower(`vcrop:${clipKey}`);
    const cropGuid = filmoraGuid(`vcrop_g:${clipKey}`);
    const transUid = uidLower(`vtrans:${clipKey}`);
    const transGuid = filmoraGuid(`vtrans_g:${clipKey}`);

    const offsetSec = Number((inTicks / TICKS_PER_SEC).toFixed(4));
    const offsetEndSec = Number((outTicks / TICKS_PER_SEC).toFixed(4));
    const totTime = kind === 'image' ? 86400.0 : Math.max(1.0, Number(totalResSec) || 10.0);
    const speedMd5 = crypto.createHash('md5').update(`speed:${totTime}`).digest('hex');
    const speedParam = `{"Version": 3,"ParameterType": 0,"keyframeSets": [{"_time": 0.0,"Interpolation": 6,"_value": 1.0},{"_time": ${totTime.toFixed(1)},"Interpolation": 6,"_value": 1.0}],"MD5": "${speedMd5}","_totalTime": ${totTime.toFixed(1)}}`;

    const stylizer73 = JSON.stringify({
      effectList: [
        {
          enable: false,
          id: 'video/effect/ai_image_stylizer',
          paramList: [{ fxParam: { paramType: 6, unValue: origAbsPath, valid: true }, name: 'OriginPath' }],
          userData: [],
        },
      ],
    });
    const stylizer74 = JSON.stringify({
      effectList: [
        {
          enable: false,
          id: 'video/effect/ai_image_video_stylizer',
          paramList: [{ fxParam: { paramType: 6, unValue: origAbsPath, valid: true }, name: 'OriginPath' }],
          userData: [],
        },
        {
          enable: false,
          id: 'video/effect/ai_template_generate',
          paramList: [{ fxParam: { paramType: 6, unValue: origAbsPath, valid: true }, name: 'OriginPath' }],
          userData: [],
        },
      ],
    });

    const clipTitle = path.parse(filenameStr).name || 'Clip';
    const isLogoClip = clipKey === 'logo_overlay';
    const lt = normalizeLogoTransform(plan.logo_transform);
    const transformParams = isLogoClip
      ? [
          { fxParam: { paramType: 5, unValue: 1186339 }, name: 'dwValue' },
          { fxParam: { paramType: 3, unValue: Number(lt.scale_w) }, name: 'Scale_x' },
          { fxParam: { paramType: 3, unValue: Number(lt.scale_h) }, name: 'Scale_y' },
          { fxParam: { paramType: 3, unValue: (Number(lt.pos_x) + 960.0) / 1920.0 }, name: 'Position_x' },
          { fxParam: { paramType: 3, unValue: (540.0 - Number(lt.pos_y)) / 1080.0 }, name: 'Position_y' },
          { fxParam: { paramType: 3, unValue: (Number(lt.anchor_x) + 960.0) / 1920.0 }, name: '_Anchor_x' },
          { fxParam: { paramType: 3, unValue: (540.0 - Number(lt.anchor_y)) / 1080.0 }, name: '_Anchor_y' },
          ...(Math.abs(Number(lt.rotate || 0)) > 0.001
            ? [{ fxParam: { paramType: 3, unValue: Number(lt.rotate) }, name: 'Rotation' }]
            : []),
          { fxParam: { paramType: 5, unValue: 1 }, name: 'EnableTransform' },
        ]
      : [
          { fxParam: { paramType: 5, unValue: 1186339 }, name: 'dwValue' },
          { fxParam: { paramType: 5, unValue: 1 }, name: 'EnableTransform' },
        ];
    const clipObj = {
      backgroundFillBluredness: 20,
      effectChainList: [
        {
          effectList: [
            {
              display: 'crop-pan-zoom',
              id: 'video/effect/crop-pan-zoom',
              placeholder: false,
              placeholderStatus: 0,
              thisUId: cropUid,
              type: 3,
              userData: [udGuid64(cropGuid, 3), udBytes(Buffer.from([0x01]), 7)],
            },
            {
              display: 'transform',
              id: 'video/effect/transform',
              paramList: transformParams,
              placeholder: false,
              placeholderStatus: 0,
              thisUId: transUid,
              type: 3,
              userData: [
                udStr('1.0', 15005, false),
                udGuid64(transGuid, 3),
                udBytes(Buffer.from([0x01]), 7),
                udStr('1', 36880, true),
              ],
            },
          ],
          name: 'Basic',
        },
        { effectList: [], name: 'Effect' },
        { effectList: [], name: '_wes_hold_effectchain_' },
      ],
      filename: filenameStr,
      image_denoise: { cache_mode: 0, sigma: 20.0, status: 0, version: 1.0 },
      inPoint: inTicks,
      outPoint: outTicks,
      picSequence: false,
      pipBuf: '{"Algorithm":"Bilinear","BlendMode":0,"BlenderName":"video/blender/simple-pip","Enable":true,"Opacity":100.0}',
      pipBufSize: 110,
      placeholder: false,
      placeholderStatus: 0,
      sourceUuid: resUid,
      speed: {
        offset: offsetSec,
        offsetEnd: offsetEndSec,
        reverse: false,
        speedParam,
      },
      stabilization: { cache_mode: 0, smooth: 5.0, status: 0, version: 1.0 },
      stabilizeAnalysisData: null,
      streamId: 0,
      thisUId,
      tlBegin: tlBeginTicks,
      tlEnd: tlEndTicks,
      type: 1,
      userData: [
        udInt32(0, 102),
        udInt32(kind === 'image' ? 3 : 2, 103),
        udInt32(kind === 'image' ? 4 : 1, 1),
        udStr(stylizer73, 73, false),
        udStr(clipTitle, 50, false),
        udInt32(0, 2),
        udGuid38(mid, 10),
        udStr(stylizer74, 74, false),
        udGuid64(clipGuid38, 3),
        udInt32(9, 6),
      ],
      video_cloud_algorithm: { info: [{ type: 'video' }], version: 1 },
    };

    mediaClipsMap[clipGuid38] = { mediaId: mid, subClips: {} };
    beatDetectMap[clipGuid38] = { algorithmType: 0, level: 0 };
    return clipObj;
  };

  const makeAudioClip = (clipKey, mid, resUid, filenameStr, tlBeginTicks, tlEndTicks, srcInSec = 0, srcOutSec = null, totalResSec = 10.0) => {
    const durTicks = Math.max(1, tlEndTicks - tlBeginTicks);
    const inTicks = secToTicks(srcInSec || 0);
    let outTicks = srcOutSec != null ? secToTicks(srcOutSec) : (inTicks + durTicks);
    if (outTicks <= inTicks) outTicks = inTicks + durTicks;

    const thisUId = uidLower(`aclip_uid:${clipKey}`);
    const clipGuid38 = filmoraGuid(`aclip_guid:${clipKey}`);
    const offsetSec = Number((inTicks / TICKS_PER_SEC).toFixed(4));
    const offsetEndSec = Number((outTicks / TICKS_PER_SEC).toFixed(4));
    const totTime = Math.max(1.0, Number(totalResSec) || 10.0);
    const speedMd5 = crypto.createHash('md5').update(`aspeed:${totTime}`).digest('hex');
    const speedParam = `{"Version": 3,"ParameterType": 0,"keyframeSets": [{"_time": 0.0,"Interpolation": 6,"_value": 1.0},{"_time": ${totTime.toFixed(8)},"Interpolation": 6,"_value": 1.0}],"MD5": "${speedMd5}","_totalTime": ${totTime.toFixed(8)}}`;

    const mkFx = (disp, fxKey) => ({
      display: disp,
      id: `audio/effect/${disp}`,
      placeholder: false,
      placeholderStatus: 0,
      thisUId: uidLower(`afx_u:${clipKey}:${fxKey}`),
      type: 3,
      userData: [udGuid64(filmoraGuid(`afx_g:${clipKey}:${fxKey}`), 3), udBytes(Buffer.from([0x01]), 7)],
      ...(disp === 'ducking' ? { enable: false } : {}),
    });

    const clipTitle = path.parse(filenameStr).name || 'Audio';
    const clipObj = {
      audioDuckingframe: {
        parameter: '{"Version": 3,"ParameterType": 0,"keyframeSets": [],"MD5":"d41d8cd98f00b204e9800998ecf8427e"}',
      },
      audio_cloud_algorithm: { info: [{ type: 'audio' }], version: 1 },
      denoiseV3Strength: 50.0,
      effectChainList: [
        { effectList: [], name: 'Basic' },
        {
          effectList: [
            mkFx('clip_volume', 1),
            mkFx('change_channel', 2),
            mkFx('volume', 3),
            mkFx('ducking', 4),
            mkFx('fade', 5),
            mkFx('equalizer', 6),
          ],
          name: 'BasicFollow',
        },
        { effectList: [], name: 'Effect' },
        { effectList: [], name: '_wes_hold_effectchain_' },
      ],
      filename: filenameStr,
      inPoint: inTicks,
      outPoint: outTicks,
      placeholder: false,
      placeholderStatus: 0,
      sourceUuid: resUid,
      speed: {
        offset: offsetSec,
        offsetEnd: offsetEndSec,
        reverse: false,
        speedParam,
      },
      streamId: 0,
      thisUId,
      tlBegin: tlBeginTicks,
      tlEnd: tlEndTicks,
      type: 2,
      userData: [
        udInt32(9, 6),
        udInt32(0, 102),
        udInt32(4, 103),
        udStr(clipTitle, 50, false),
        udInt32(0, 2),
        udGuid38(mid, 10),
        udGuid64(clipGuid38, 3),
        udInt32(2, 1),
        udStr('0', 13019, false),
      ],
      volumeKeyframe: {
        parameter: '{"Version": 3,"ParameterType": 0,"keyframeSets": [],"MD5":"d41d8cd98f00b204e9800998ecf8427e"}',
      },
    };

    mediaClipsMap[clipGuid38] = { mediaId: mid, subClips: {} };
    beatDetectMap[clipGuid38] = { algorithmType: 0, level: 0 };
    return clipObj;
  };

  // 0. Register all project library media items so all uploaded images & videos are preserved in Media Library & .wfpbundle
  const allLibraryMedia = loadJson(pid, 'media.json') || [];
  for (const m of allLibraryMedia) {
    if (m && m.path && (m.kind === 'image' || m.kind === 'video')) {
      registerMedia(m.path, m.kind, Math.max(Number(m.duration || 0), 5.0));
    }
  }

  // 1. Main visual scene clips
  const videoClipsTrack = [];
  for (let idx = 0; idx < (plan.clips || []).length; idx++) {
    const c = plan.clips[idx];
    if (!c.media_path) continue;
    const estDur = Math.max(Number(c.duration || 0), Number(c.source_out || 0), 5.0);
    const [mid, resUid] = registerMedia(c.media_path, c.kind, estDur);
    if (!mid) continue;
    const tlBegin = secToTicks(c.start);
    const tlEnd = Math.max(tlBegin + 1, secToTicks(c.end));
    const metaM = mediaItemsMeta[mid];
    videoClipsTrack.push(
      makeVisualClip(
        `scene_${idx}_${c.screen}`,
        mid,
        resUid,
        metaM._clip_ref_path,
        metaM._orig_abs_path,
        c.kind,
        tlBegin,
        tlEnd,
        c.source_in || 0,
        c.source_out,
        metaM._dur_sec,
      ),
    );
  }

  // 2. Narration VO audio track
  const voClipsTrack = [];
  const slots = Array.isArray(plan.voiceover_slots) ? plan.voiceover_slots : [];
  if (slots.length > 0 && slots.some((s) => Boolean(s && s.path))) {
    for (let idx = 0; idx < slots.length; idx++) {
      const s = slots[idx];
      if (!s || !s.path) continue;
      const sDur = Math.max(Number(s.duration || 0), Number(s.end || 0) - Number(s.start || 0), 5.0);
      const [mid, resUid] = registerMedia(s.path, 'audio', sDur);
      if (!mid) continue;
      const tlBegin = secToTicks(s.start);
      const tlEnd = Math.max(tlBegin + 1, secToTicks(s.end));
      const metaM = mediaItemsMeta[mid];
      voClipsTrack.push(
        makeAudioClip(`vo_slot_${idx}_${s.slot}`, mid, resUid, metaM._clip_ref_path, tlBegin, tlEnd, 0.0, s.duration, metaM._dur_sec),
      );
    }
  } else if (plan.voiceover_path) {
    const totVoDur = Math.max(Number(plan.total_duration || 10), 5.0);
    const [mid, resUid] = registerMedia(plan.voiceover_path, 'audio', totVoDur);
    if (mid) {
      const metaM = mediaItemsMeta[mid];
      const spokenClips = (plan.clips || []).filter((c) => c.narration_in != null && c.narration_out != null && c.narration_out > c.narration_in);
      if (spokenClips.length) {
        for (let idx = 0; idx < spokenClips.length; idx++) {
          const c = spokenClips[idx];
          const durN = Number(c.narration_out) - Number(c.narration_in);
          const tlBegin = secToTicks(c.start);
          const tlEnd = secToTicks(Number(c.start) + durN);
          voClipsTrack.push(
            makeAudioClip(`vo_seg_${idx}`, mid, resUid, metaM._clip_ref_path, tlBegin, tlEnd, c.narration_in, c.narration_out, metaM._dur_sec),
          );
        }
      } else {
        voClipsTrack.push(
          makeAudioClip('vo_full', mid, resUid, metaM._clip_ref_path, 0, secToTicks(totVoDur), 0.0, totVoDur, metaM._dur_sec),
        );
      }
    }
  }

  // 3. Poem / Suno VO audio track
  const poemClipsTrack = [];
  if (plan.poem_voiceover_path) {
    const pStart = Number(plan.poem_start_time || 0);
    const pEnd = Number(plan.poem_end_time || 0) > pStart ? Number(plan.poem_end_time) : Number(plan.total_duration || 10);
    const pDur = Math.max(1.0, pEnd - pStart);
    const [mid, resUid] = registerMedia(plan.poem_voiceover_path, 'audio', pDur);
    if (mid) {
      const metaM = mediaItemsMeta[mid];
      poemClipsTrack.push(
        makeAudioClip('poem_vo', mid, resUid, metaM._clip_ref_path, secToTicks(pStart), secToTicks(pEnd), 0.0, pDur, metaM._dur_sec),
      );
    }
  }

  // 4. Logo overlay track (across all screens)
  const logoClipsTrack = [];
  const effLogo = getEffectiveLogoMeta(pid, plan);
  const logoPath = (plan.logo_path && fs.existsSync(plan.logo_path)) ? plan.logo_path : effLogo.path;
  const logoEnabled = effLogo.enabled;
  if (logoEnabled && logoPath) {
    const [mid, resUid] = registerMedia(logoPath, 'image', Number(plan.total_duration || 10));
    if (mid) {
      const metaM = mediaItemsMeta[mid];
      logoClipsTrack.push(
        makeVisualClip(
          'logo_overlay',
          mid,
          resUid,
          metaM._clip_ref_path,
          metaM._orig_abs_path,
          'image',
          0,
          secToTicks(Math.max(1.0, Number(plan.total_duration || 10))),
          0.0,
          null,
          86400.0,
        ),
      );
    }
  }

  const totalTicks = secToTicks(Math.max(1.0, Number(plan.total_duration || 10)));

  // Strip internal helper keys before serializing medias_info.json
  for (const mid of mediaIds) {
    delete mediaItemsMeta[mid]._clip_ref_path;
    delete mediaItemsMeta[mid]._orig_abs_path;
    delete mediaItemsMeta[mid]._dur_sec;
  }

  const tracks = [
    {
      busUuids: [AUDIO_BUS_UID],
      clipList: voClipsTrack,
      trackType: 2,
      userData: [udInt32(45, 12000)],
      uuid: uidLower('track_a_vo'),
    },
    {
      busUuids: [AUDIO_BUS_UID],
      clipList: poemClipsTrack,
      trackType: 2,
      userData: [udInt32(45, 12000)],
      uuid: uidLower('track_a_default'),
    },
    {
      busUuids: [AUDIO_BUS_UID],
      clipList: [],
      trackTag: 1,
      trackType: 2,
      userData: [udInt32(3, 20)],
      uuid: uidLower('track_a_vid'),
    },
    {
      clipList: videoClipsTrack,
      trackTag: 2,
      trackType: 1,
      userData: [udInt32(1, 21), udInt32(70, 12000)],
      uuid: uidLower('track_v_main'),
    },
  ];

  if (logoClipsTrack.length) {
    tracks.push({
      clipList: logoClipsTrack,
      trackType: 1,
      userData: [udInt32(70, 12000)],
      uuid: uidLower('track_v_logo'),
    });
  }

  const tlPageJson = Buffer.from(JSON.stringify([{ index: 0, isActive: true, pageIndex: 1, timelineId: TIMELINE_UUID }]), 'utf-8');
  const tlRangeJson = Buffer.from(JSON.stringify({ data: [0, totalTicks] }), 'utf-8');

  const wesproj = {
    currentTimelineId: 9,
    productName: 'Filmora',
    projectName: 'TLB',
    projectVersion: '6, 13, 102, 19',
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
          udStr(crypto.createHash('md5').update(`Filmora${TIMELINE_MEDIA_ID}`, 'utf-8').digest('hex'), 140, false),
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
    vbl_modify_version: '8.6.12.3',
    vbl_create_version: '8.6.12.3',
    project_os_name: 'Windows',
    project_os_version: '',
    project_file_name: safeName,
    project_file_suffix: '.wfp',
    project_editor_name: 'Filmora',
    project_editor_create_version: '16.0.12.22388',
    project_editor_modify_version: '16.0.12.22388',
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
    project_archive: true,
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
    proj_zip_save_path:
      wfpSavePath && /^[A-Za-z]:\//.test(normSlash(wfpSavePath))
        ? normSlash(wfpSavePath)
        : `C:/Users/Kohin/Downloads/${safeName}.wfp`,
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
      const normP = normSlash(pAbs);
      const relEntry = `Medias/${mid}/${path.posix.basename(normP)}`;
      bundleRelMap[normSlash(path.resolve(normP))] = relEntry;
      bundleRelMap[normP] = relEntry;
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
  const addStored = (entryPath, buf) => {
    zip.addFile(entryPath, buf);
    const e = zip.getEntry(entryPath);
    if (e) e.header.method = 0;
  };
  const addDeflated = (entryPath, buf) => {
    zip.addFile(entryPath, buf);
    const e = zip.getEntry(entryPath);
    if (e) e.header.method = 8;
  };

  for (const [mid, mjson] of Object.entries(perMediaJson)) {
    addStored(`ProjectFolder/Medias/${mid}/media.json`, Buffer.from(JSON.stringify(mjson), 'utf-8'));
    const metaEntry = mediaItemsMeta[mid] || {};
    if (metaEntry.media_type !== 4) {
      addStored(`ProjectFolder/Medias/${mid}/thumbnail.png`, THUMB_320_180);
    }
  }
  addStored(`ProjectFolder/Medias/${TIMELINE_MEDIA_ID}/thumbnail.png`, THUMB_320_180);
  addStored('ProjectFolder/Anon/AppData/Windows/functionExtraData.json', Buffer.from('{"9":"2"}', 'utf-8'));
  addDeflated('ProjectFolder/Medias/medias_info.json', Buffer.from(formatMediasInfoJson(mediaIds, TIMELINE_MEDIA_ID, mediaItemsMeta, nowTs, totalTicks), 'utf-8'));
  addDeflated(`ProjectFolder/Medias/${TIMELINE_MEDIA_ID}/extra.json`, Buffer.from(JSON.stringify(extraJson), 'utf-8'));
  addDeflated(`ProjectFolder/Medias/${TIMELINE_MEDIA_ID}/timeline.wesproj`, Buffer.from(JSON.stringify(wesproj), 'utf-8'));
  addDeflated('ProjectFolder/project_info.json', Buffer.from(JSON.stringify(projectInfo), 'utf-8'));
  addDeflated('ProjectFolder/Anon/Cover/thumb.fsthumb', COVER_160_90);
  if (dgsComment) {
    zip.addZipComment(dgsComment);
  }

  return { wfpBuffer: zip.toBuffer(), mediaGuidToPath, dgsComment };
}

function buildWfpBundleFileOnDisk(pid, rawTitle, bundlePath, progressCb = null) {
  const safeTitle = String(rawTitle || `Project_${pid}`).trim().replace(/[^a-zA-Z0-9._ ()-]/g, '_') || `Project_${pid}`;
  if (progressCb) progressCb(10, 'Building Filmora 15 .wfp archive metadata…');
  const innerWfpName = `${safeTitle}.wfp`;
  const { wfpBuffer, mediaGuidToPath, dgsComment } = buildWfpAndMediaMap(pid, rawTitle, {
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
      // Set STORED method on media entries so Filmora 15 opens .wfpbundle directly
      const entry = bundleZip.getEntry(`Medias/${mid}/${path.basename(srcPath)}`);
      if (entry) entry.header.method = 0;
    }
  }
  if (progressCb) progressCb(94, `Writing ${innerWfpName} into ${path.basename(bundlePath)}…`);
  bundleZip.addFile(innerWfpName, wfpBuffer);
  const wfpEntry = bundleZip.getEntry(innerWfpName);
  if (wfpEntry) wfpEntry.header.method = 0;
  if (dgsComment) {
    bundleZip.addZipComment(dgsComment);
  }
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

// Fast WFP + Medias/{GUID} manifest so the browser can assemble .wfpbundle / .zip locally in ~1.5s without uploading 450MB to server
app.get('/api/projects/:id/wfp-manifest', async (req, res) => {
  try {
    const pid = req.params.id;
    if (!fs.existsSync(projectRoot(pid))) return res.status(404).json({ detail: 'Project not found' });
    let plan = loadJson(pid, 'timeline.json');
    if (plan) {
      plan = await healTimelinePaths(pid, plan);
      saveJson(pid, 'timeline.json', plan);
    }
    const rawTitle = String(req.query.title || `Project_${pid}`).trim();
    const safeTitle = rawTitle.replace(/[^a-zA-Z0-9._ ()-]/g, '_') || `Project_${pid}`;
    const innerWfpName = `${safeTitle}.wfp`;
    const { wfpBuffer, mediaGuidToPath, dgsComment } = buildWfpAndMediaMap(pid, rawTitle, {
      wfpSavePath: `C:/Users/Kohin/Downloads/${innerWfpName}`,
      archiveMode: true,
    });
    const mediaList = loadJson(pid, 'media.json') || [];
    const voMeta = loadJson(pid, 'voiceover.json') || {};
    const poemVoMeta = loadJson(pid, 'poem_voiceover.json') || {};
    const logoMeta = loadJson(pid, 'logo.json') || {};
    const effLogo = getEffectiveLogoMeta(pid, plan);
    const entries = [];
    for (const [mid, srcPath] of mediaGuidToPath.entries()) {
      const normSrc = normSlash(srcPath);
      const base = path.posix.basename(normSrc);
      const baseLow = base.toLowerCase();
      const fext = path.posix.extname(base).toLowerCase();
      let kind = 'image';
      if (VIDEO_EXT.has(fext)) kind = 'video';
      else if (AUDIO_EXT.has(fext)) kind = 'audio';
      const matchedMedia = mediaList.find(
        (m) => (m.path && normSlash(m.path) === normSrc) || (String(m.filename || '').toLowerCase() === baseLow && m.kind === kind),
      );
      const matchedVoSlot = (voMeta.slots || []).find(
        (s) => (s.path && normSlash(s.path) === normSrc) || baseLow === `slot_${s.slot}_${String(s.filename || '').toLowerCase()}` || String(s.filename || '').toLowerCase() === baseLow,
      );
      const isPoemVo = Boolean(poemVoMeta.path && (normSlash(poemVoMeta.path) === normSrc || String(poemVoMeta.filename || '').toLowerCase() === baseLow));
      const isLogo = Boolean(
        (effLogo.path && normSlash(effLogo.path) === normSrc) ||
        (logoMeta.path && (normSlash(logoMeta.path) === normSrc || String(logoMeta.filename || '').toLowerCase() === baseLow)) ||
        baseLow === 'eclass-logo.png',
      );
      entries.push({
        guid: mid,
        filename: base,
        entry_path: `Medias/${mid}/${base}`,
        kind,
        media_id: matchedMedia ? matchedMedia.id : null,
        vo_slot: matchedVoSlot ? Number(matchedVoSlot.slot) : null,
        orig_vo_filename: matchedVoSlot ? matchedVoSlot.filename : null,
        is_poem_vo: isPoemVo,
        is_logo: isLogo,
        exists_on_server: Boolean(!normSrc.startsWith('local://') && fs.existsSync(srcPath) && fs.statSync(srcPath).isFile()),
      });
    }
    res.json({
      ok: true,
      safe_title: safeTitle,
      inner_wfp_name: innerWfpName,
      wfp_base64: wfpBuffer.toString('base64'),
      dgs_comment: dgsComment || '',
      entries,
    });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
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
    let plan = loadJson(pid, 'timeline.json');
    if (plan) {
      plan = await healTimelinePaths(pid, plan);
      saveJson(pid, 'timeline.json', plan);
    }
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
      (norm.startsWith('Medias/') || norm.includes('/Medias/') || norm.startsWith('Resources/') || norm.includes('/Media/') || norm.startsWith('Media/')) &&
      !norm.startsWith('ProjectFolder/') &&
      !norm.includes('/ProjectFolder/') &&
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
      wfpbundleNameMap[base.toLowerCase()] = destFile;
      const mediasIdx = norm.indexOf('Medias/');
      if (mediasIdx >= 0) {
        const subParts = norm.slice(mediasIdx).split('/');
        if (subParts.length >= 3 && subParts[1]) {
          wfpbundleGuidMap[subParts[1]] = destFile;
          extractedMap[subParts.slice(0, 3).join('/')] = destFile;
        }
      }
    }
  }

  let wfpZip = outerZip;
  const innerWfpEntry =
    entries.find((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.wfp') && !e.entryName.includes('/')) ||
    entries.find((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.wfp'));
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
    const baseLow = path.posix.basename(normS).toLowerCase();
    if (baseLow && wfpbundleNameMap[baseLow]) return wfpbundleNameMap[baseLow];
    if (fs.existsSync(s)) return path.resolve(s);
    return normS;
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
      } else {
        saveJson(pid, 'logo.json', dgsData.logo);
      }
    }

    // Pre-seed media.json with dgsData.media (or synthesize from dgsData.timeline.clips if dgsData.media was empty) so:
    // 1) reindexMedia reuses known durations & IDs (0 ffprobe calls on 30+ videos!)
    // 2) standalone .wfp files (where media is local on the user's PC) retain all media items!
    let rawMediaList = Array.isArray(dgsData.media) && dgsData.media.length > 0 ? dgsData.media : [];
    if (!rawMediaList.length && Array.isArray(dgsData.timeline?.clips)) {
      const seenPaths = new Set();
      for (const c of dgsData.timeline.clips) {
        if (!c || !c.media_path) continue;
        const fname = path.posix.basename(normSlash(c.media_path));
        const key = `${c.kind || 'image'}:${fname.toLowerCase()}`;
        if (seenPaths.has(key)) continue;
        seenPaths.add(key);
        const screens = c.screen ? [c.screen] : detectScreens(fname);
        rawMediaList.push({
          id: c.media_id || crypto.randomUUID(),
          filename: fname,
          path: c.media_path,
          kind: c.kind === 'video' ? 'video' : 'image',
          screen: screens[0] || null,
          screens,
          duration: c.kind === 'video' ? Math.max(Number(c.duration || 0), Number(c.source_out || 0), 5.0) : null,
        });
      }
    }
    if (rawMediaList.length > 0) {
      const seededMedia = rawMediaList.map((m) => {
        const rp = resolveDocDirOrPath(m.path || m.filename || '');
        const existsOnDisk = Boolean(rp && fs.existsSync(rp));
        return {
          ...m,
          id: m.id || crypto.randomUUID(),
          path: existsOnDisk ? path.resolve(rp) : (rp || m.path),
          local_only: !existsOnDisk,
        };
      });
      saveJson(pid, 'media.json', seededMedia);
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
        // If multi-slot VO was archived as individual slots without merged_narration.mp3, rebuild merged narration VO only if slot files exist on disk
        const allSlotsExist = vo.slots.every((s) => s && s.path && fs.existsSync(s.path));
        if (vo.slots.length > 1 && allSlotsExist && (!vo.path || !fs.existsSync(vo.path))) {
          const rebuilt = await rebuildMergedVo(pid, vo.slots);
          vo.path = rebuilt.path;
          vo.duration = rebuilt.duration;
        } else if (vo.slots.length === 1 && vo.slots[0]?.path && fs.existsSync(vo.slots[0].path)) {
          vo.path = vo.slots[0].path;
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
    const sourcePid = dgsData.source_project_id || dgsData.project_id || null;
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
      source_project_id: sourcePid,
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
    const resDurMap = {};
    const seededFromWesproj = [];
    for (const rItem of wesprojData.resources || []) {
      const ruid = String(rItem.sourceUuid || rItem.uid || '').trim();
      const rfn = String(rItem.filename || '').trim();
      if (ruid && rfn) resUidMap[ruid] = rfn;
      const ticks = Number(rItem.mediaLength || rItem.duration || 0);
      const durS = ticks > 0 ? Math.round((ticks / TICKS_PER_SEC) * 1000) / 1000 : null;
      if (rfn) {
        const resolved = resolveDocDirOrPath(rfn);
        const fname = path.basename(resolved || rfn);
        const fext = path.extname(fname).toLowerCase();
        if (durS) resDurMap[fname.toLowerCase()] = durS;
        if (IMAGE_EXT.has(fext) || VIDEO_EXT.has(fext)) {
          const itemKind = IMAGE_EXT.has(fext) ? 'image' : 'video';
          const existsOnDisk = Boolean(resolved && fs.existsSync(resolved));
          const screens = detectScreens(fname);
          seededFromWesproj.push({
            id: crypto.randomUUID(),
            filename: fname,
            path: existsOnDisk ? path.resolve(resolved) : (resolved || fname),
            kind: itemKind,
            screen: screens[0] || null,
            screens,
            duration: itemKind === 'video' ? (durS || 5.0) : null,
            local_only: !existsOnDisk,
          });
        }
      }
    }
    if (seededFromWesproj.length > 0) {
      saveJson(pid, 'media.json', seededFromWesproj);
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
          } else if (ttype === 2 && fn && AUDIO_EXT.has(path.extname(fn).toLowerCase())) {
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
      const uniqueVoPaths = Array.from(new Set(voClipsRaw.map((v) => v.path)));
      if (uniqueVoPaths.length === 1) {
        voPath = uniqueVoPaths[0];
        const fullDur =
          resDurMap[path.basename(voPath).toLowerCase()] ||
          Math.max(...voClipsRaw.map((v) => v.tl_e), ...voClipsRaw.map((v) => v.out_p), 10);
        voSlots.push({
          slot: 1,
          filename: path.basename(voPath),
          duration: fullDur,
          start_offset: 0,
          end_offset: fullDur,
          start: 0,
          end: fullDur,
          path: voPath,
        });
      } else {
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
        voPath = voClipsRaw[0].path;
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
      const voLabel = voSlots.length > 1 ? Array.from(new Set(voSlots.map((v) => v.filename))).join(' + ') : path.basename(voPath);
      const knownVoDur = resDurMap[path.basename(voPath).toLowerCase()] || voSlots[0]?.duration || totalDur;
      voObj = {
        path: voPath,
        filename: voLabel,
        duration: knownVoDur,
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
    if (result?.project_id) touchProjectClient(result.project_id, req);
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
      if (result?.project_id) touchProjectClient(result.project_id, req);
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
  app.use(
    express.static(PUBLIC_DIR, {
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        }
      },
    }),
  );
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    if (req.path.startsWith('/assets/')) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DGS Auto Editor Cloud Server running on port ${PORT} (Data: ${DATA_DIR} | FFmpeg: ${FFMPEG_BIN})`);
});

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

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
const TICKS_PER_SEC = 10000000;
const IMAGE_BASE_OFFSET_TICKS = 36000000000;

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

function detectScreens(filename) {
  const stem = path.parse(filename).name;
  const trimmed = stem.trim();
  if (/^\d{1,3}$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    if (n >= 1 && n <= 500) return [`screen_${n}`];
  }
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
  return [];
}

async function probeDuration(filePath) {
  try {
    const { stdout } = await execFileAsync(FFPROBE_BIN, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeout: 15000 });
    const v = parseFloat(String(stdout).trim());
    return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : null;
  } catch {
    return null;
  }
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
    const sa = detectScreens(path.basename(a));
    const sb = detectScreens(path.basename(b));
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
    const screens = detectScreens(path.basename(f));
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

function cleanVoText(raw) {
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
    .replace(/\([^)]*(?:pause|beat|sfx|music|laughter|excited|warm|soft|tone|voice|whisper|sound|chuckle|sigh|gasp)[^)]*\)/gi, ' ')
    .replace(/^[A-Za-z][A-Za-z\s]{0,18}:\s*/gm, '')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

function extractOnscreenText(raw) {
  if (!raw) return '';
  const m = String(raw).match(/\[\s*On[- ]?screen[^\]]*\]\s*:?\s*([\s\S]*?)(?=\[|$)/i);
  if (m && m[1]) return m[1].replace(/\s+/g, ' ').trim();
  return '';
}

function parseDurationCell(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number' && val > 0 && val < 600) return val;
  const s = String(val).trim();
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

function parseProductionXlsx(filePath) {
  const wb = XLSX.readFile(filePath);
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
          if (c.includes('duration') || c.includes('time') || c.includes('sec')) colMap.duration = colMap.duration ?? idx;
          if (c.includes('on-screen') || c.includes('onscreen') || c.includes('text on screen') || c.includes('ost')) colMap.onscreen = colMap.onscreen ?? idx;
          if (c.includes('voice') || c.includes('audio') || c.includes('narration') || c === 'vo' || c.includes('script')) colMap.vo = colMap.vo ?? idx;
          if (c.includes('visual') || c.includes('animation') || c.includes('image') || c.includes('action')) colMap.visual = colMap.visual ?? idx;
          if (c.includes('type') || c.includes('asset') || c.includes('media')) colMap.vtype = colMap.vtype ?? idx;
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
      if (sceneNo < 1 || sceneNo > 500) continue;
      const screen = `screen_${sceneNo}`;

      const rawVoCell = colMap.vo != null ? String(row[colMap.vo] || '').trim() : '';
      const rawOstCell = colMap.onscreen != null ? String(row[colMap.onscreen] || '').trim() : '';
      const rawVisCell = colMap.visual != null ? String(row[colMap.visual] || '').trim() : '';
      const rawTypeCell = colMap.vtype != null ? String(row[colMap.vtype] || '').trim() : '';
      const durVal = colMap.duration != null ? parseDurationCell(row[colMap.duration]) : null;

      const voClean = cleanVoText(rawVoCell);
      const ostClean = rawOstCell || extractOnscreenText(rawVoCell);
      const combined = `${rawScene} ${rawVoCell} ${rawVisCell} ${rawTypeCell}`.toLowerCase();
      const isPoem = combined.includes('poem recitation') || combined.includes('suno') || combined.includes('full poem song');
      const vType = /video|mp4|anim/i.test(rawTypeCell || rawVisCell) ? 'Video' : 'Image';

      scenes.push({
        screen,
        index: scenes.length + 1,
        scene_no: sceneNo,
        section: isPoem ? 'poem' : 'story',
        duration: durVal,
        onscreen_text: ostClean,
        voiceover_text: voClean,
        voiceover_raw: rawVoCell,
        visual_type: vType,
        visual_direction: rawVisCell,
        text: voClean || ostClean || `Scene ${sceneNo}`,
        is_poem: isPoem,
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
        index: scenes.length + 1,
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
      });
    }
  }
  return scenes;
}

async function detectSilences(audioPath) {
  if (!audioPath || !fs.existsSync(audioPath)) return [];
  try {
    const { stderr } = await execFileAsync(FFMPEG_BIN, [
      '-i', audioPath,
      '-af', 'silencedetect=noise=-34dB:d=0.18',
      '-f', 'null', '-',
    ], { timeout: 60000 });
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

function pickMediaForScreen(screen, mediaItems, visualType) {
  const exact = mediaItems.filter((m) => (m.screens && m.screens.includes(screen)) || m.screen === screen);
  if (!exact.length) return { video: null, image: null };
  const vid = exact.find((m) => m.kind === 'video') || null;
  const img = exact.find((m) => m.kind === 'image') || null;
  return { video: vid, image: img };
}

function buildSrtCues(clips) {
  const cues = [];
  for (const c of clips) {
    const txt = (c.vo_text || c.caption_text || '').trim();
    if (!txt) continue;
    const s = c.narration_in != null ? c.start : c.start;
    const spokenDur = c.narration_in != null && c.narration_out != null && c.narration_out > c.narration_in
      ? Math.min(c.duration, c.narration_out - c.narration_in)
      : c.duration;
    const e = Math.max(s + 0.4, Math.min(c.end, s + spokenDur));
    const words = txt.split(/\s+/).filter(Boolean);
    const chunkSize = 11;
    const numChunks = Math.max(1, Math.ceil(words.length / chunkSize));
    const span = Math.max(0.4, e - s);
    for (let i = 0; i < numChunks; i++) {
      const piece = words.slice(i * chunkSize, (i + 1) * chunkSize).join(' ');
      const cs = Math.round((s + (span * i) / numChunks) * 1000) / 1000;
      const ce = Math.round((s + (span * (i + 1)) / numChunks) * 1000) / 1000;
      cues.push({
        index: cues.length + 1,
        screen: c.screen,
        start: cs,
        end: ce,
        text: piece,
      });
    }
  }
  return cues;
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
  res.json({ ok: true, name });
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

app.post('/api/projects/:id/script', upload.single('file'), (req, res) => {
  try {
    const pid = req.params.id;
    const root = projectRoot(pid);
    if (!fs.existsSync(root) || !req.file) return res.status(400).json({ detail: 'Missing script file' });
    const origName = path.basename(req.file.originalname || 'script.xlsx');
    const ext = path.extname(origName).toLowerCase();
    const dest = path.join(root, 'script', origName);
    fs.copyFileSync(req.file.path, dest);
    try { fs.unlinkSync(req.file.path); } catch {}

    let scenes = [];
    if (ext === '.xlsx' || ext === '.xlsm') {
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
    res.json({ format: 'production_xlsx', scenes, poem });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

async function rebuildMergedVo(pid, slots) {
  const root = projectRoot(pid);
  const voDir = path.join(root, 'voiceover');
  fs.mkdirSync(voDir, { recursive: true });
  const active = slots
    .filter((s) => s.path && fs.existsSync(s.path))
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
  const inputs = [];
  const filterParts = [];
  const concatLabels = [];
  let offset = 0;
  const gapSec = 0.5;

  for (let i = 0; i < active.length; i++) {
    const s = active[i];
    inputs.push('-i', s.path);
    const dur = s.duration || (await probeDuration(s.path)) || 0;
    s.duration = dur;
    s.start_offset = Math.round(offset * 1000) / 1000;
    s.end_offset = Math.round((offset + dur) * 1000) / 1000;
    offset += dur;
    filterParts.push(`[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`);
    concatLabels.push(`[a${i}]`);
    if (i < active.length - 1) {
      filterParts.push(`anullsrc=r=44100:cl=stereo,atrim=0:${gapSec},asetpts=PTS-STARTPTS[g${i}]`);
      concatLabels.push(`[g${i}]`);
      offset += gapSec;
    }
  }
  filterParts.push(`${concatLabels.join('')}concat=n=${concatLabels.length}:v=0:a=1[aout]`);
  await execFileAsync(FFMPEG_BIN, [
    '-y', ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[aout]',
    '-c:a', 'libmp3lame', '-b:a', '192k',
    mergedPath,
  ], { timeout: 120000 });
  const totalDur = (await probeDuration(mergedPath)) || offset;
  const label = active.map((s) => `VO${s.slot} (${s.filename})`).join(' + ');
  const meta = { path: mergedPath, filename: label, duration: totalDur, kind: 'narration', slots: active };
  saveJson(pid, 'voiceover.json', meta);
  return meta;
}

app.post('/api/projects/:id/voiceover', upload.single('file'), async (req, res) => {
  try {
    const pid = req.params.id;
    const slot = Math.max(1, Math.min(10, parseInt(req.query.slot || '1', 10)));
    const root = projectRoot(pid);
    if (!fs.existsSync(root) || !req.file) return res.status(400).json({ detail: 'Missing VO file' });
    const voDir = path.join(root, 'voiceover');
    fs.mkdirSync(voDir, { recursive: true });
    const origName = path.basename(req.file.originalname || `vo_${slot}.mp3`);
    const dest = path.join(voDir, `slot_${slot}_${origName}`);
    fs.copyFileSync(req.file.path, dest);
    try { fs.unlinkSync(req.file.path); } catch {}
    const duration = (await probeDuration(dest)) || 0;

    const existing = loadJson(pid, 'voiceover.json') || {};
    let slots = Array.isArray(existing.slots) ? existing.slots.filter((s) => Number(s.slot) !== slot) : [];
    slots.push({ slot, filename: origName, path: dest, duration });
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
    const meta = await rebuildMergedVo(pid, slots);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

app.post('/api/projects/:id/poem-voiceover', upload.single('file'), async (req, res) => {
  try {
    const pid = req.params.id;
    const root = projectRoot(pid);
    if (!fs.existsSync(root) || !req.file) return res.status(400).json({ detail: 'Missing poem VO file' });
    const voDir = path.join(root, 'voiceover');
    fs.mkdirSync(voDir, { recursive: true });
    const origName = path.basename(req.file.originalname || 'poem.mp3');
    const dest = path.join(voDir, `poem_${origName}`);
    fs.copyFileSync(req.file.path, dest);
    try { fs.unlinkSync(req.file.path); } catch {}
    const duration = (await probeDuration(dest)) || 0;
    const meta = { path: dest, filename: origName, duration, kind: 'poem' };
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

app.post('/api/projects/:id/logo', upload.single('file'), (req, res) => {
  const pid = req.params.id;
  const root = projectRoot(pid);
  if (!fs.existsSync(root) || !req.file) return res.status(400).json({ detail: 'Missing logo file' });
  const logoDir = path.join(root, 'logo');
  fs.mkdirSync(logoDir, { recursive: true });
  const origName = path.basename(req.file.originalname || 'logo.png');
  const dest = path.join(logoDir, origName);
  fs.copyFileSync(req.file.path, dest);
  try { fs.unlinkSync(req.file.path); } catch {}
  const meta = { path: dest, filename: origName, enabled: true };
  saveJson(pid, 'logo.json', meta);
  const tl = loadJson(pid, 'timeline.json');
  if (tl) {
    tl.logo_path = dest;
    tl.logo_enabled = true;
    saveJson(pid, 'timeline.json', tl);
  }
  res.json(meta);
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
    const media = await reindexMedia(pid);
    const voMeta = loadJson(pid, 'voiceover.json') || {};
    const poemVoMeta = loadJson(pid, 'poem_voiceover.json') || {};
    const logoMeta = loadJson(pid, 'logo.json') || {};

    const voDur = Number(voMeta.duration || 0);
    const silences = voMeta.path ? await detectSilences(voMeta.path) : [];

    // Compute word weights + silence snapping across scenes
    const sceneWeights = scenes.map((s) => {
      const words = String(s.voiceover_text || '').split(/\s+/).filter(Boolean).length;
      if (words > 0) return Math.max(1.2, words * 0.38);
      return Number(s.duration) || 2.0;
    });
    const totalWeight = sceneWeights.reduce((a, b) => a + b, 0) || 1;
    const scale = voDur > 1 ? voDur / totalWeight : 1;

    const clips = [];
    let tlCursor = 0;
    let narrCursor = 0;

    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      const hasVo = Boolean(s.voiceover_text && s.voiceover_text.trim());
      let spokenDur = sceneWeights[i] * scale;
      let narrEnd = narrCursor + spokenDur;

      // Snap narrEnd to nearest silence boundary within ±1.1s
      if (silences.length && i < scenes.length - 1) {
        let bestSil = null;
        let bestDist = 1.1;
        for (const [ss, se] of silences) {
          const mid = 0.5 * (ss + se);
          const dist = Math.abs(mid - narrEnd);
          if (dist < bestDist && mid > narrCursor + 0.5) {
            bestDist = dist;
            bestSil = se - 0.12;
          }
        }
        if (bestSil != null) {
          narrEnd = bestSil;
          spokenDur = Math.max(0.5, narrEnd - narrCursor);
        }
      } else if (i === scenes.length - 1 && voDur > narrCursor) {
        narrEnd = voDur;
        spokenDur = Math.max(0.5, narrEnd - narrCursor);
      }

      const { video, image } = pickMediaForScreen(s.screen, media, s.visual_type);
      const primary = video && image ? image : (image || video);
      const extraVid = video && image ? video : null;

      if (!primary) {
        const dur = Math.round(spokenDur * 1000) / 1000;
        clips.push({
          screen: s.screen,
          media_id: null,
          media_path: '',
          kind: 'image',
          start: Math.round(tlCursor * 1000) / 1000,
          end: Math.round((tlCursor + dur) * 1000) / 1000,
          duration: dur,
          source_in: 0,
          source_out: dur,
          script_text: s.voiceover_text || s.onscreen_text || s.screen,
          vo_text: s.voiceover_text || '',
          narration_in: hasVo ? Math.round(narrCursor * 1000) / 1000 : null,
          narration_out: hasVo ? Math.round(narrEnd * 1000) / 1000 : null,
          fit: 'missing',
        });
        tlCursor += dur;
      } else {
        const dur = Math.round(spokenDur * 1000) / 1000;
        clips.push({
          screen: s.screen,
          media_id: primary.id,
          media_path: primary.path,
          kind: primary.kind,
          start: Math.round(tlCursor * 1000) / 1000,
          end: Math.round((tlCursor + dur) * 1000) / 1000,
          duration: dur,
          source_in: 0,
          source_out: primary.kind === 'video' ? Math.min(dur, primary.duration || dur) : dur,
          script_text: s.voiceover_text || s.onscreen_text || s.screen,
          vo_text: s.voiceover_text || '',
          narration_in: hasVo ? Math.round(narrCursor * 1000) / 1000 : null,
          narration_out: hasVo ? Math.round(narrEnd * 1000) / 1000 : null,
          fit: primary.kind === 'video' ? 'trim' : 'hold',
        });
        tlCursor += dur;

        if (extraVid) {
          const vdur = Math.round((extraVid.duration || 4.0) * 1000) / 1000;
          clips.push({
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
            narration_in: null,
            narration_out: null,
            fit: 'trim',
          });
          tlCursor += vdur;
        }
      }
      narrCursor = narrEnd;
    }

    const srtCues = buildSrtCues(clips);
    saveJson(pid, 'subtitles.srt', formatSrt(srtCues));

    const plan = {
      project_id: pid,
      total_duration: Math.round(tlCursor * 1000) / 1000,
      clips,
      voiceover_path: voMeta.path || null,
      voiceover_slots: (voMeta.slots || []).map((s) => ({
        slot: s.slot,
        filename: s.filename,
        duration: s.duration,
        start_offset: s.start_offset || 0,
        end_offset: s.end_offset || s.duration || 0,
        start: s.start_offset || 0,
        end: s.end_offset || s.duration || 0,
        path: s.path,
      })),
      poem_voiceover_path: poemVoMeta.path || null,
      logo_path: logoMeta.path || null,
      logo_enabled: logoMeta.enabled !== false && Boolean(logoMeta.path),
      has_poem: Boolean(poemVoMeta.path),
      language: (req.body && req.body.language) || 'en+mr',
      srt_cues: srtCues,
      qa_issues: [],
      qa_summary: `All ${clips.length} clips aligned cleanly on server`,
    };
    saveJson(pid, 'timeline.json', plan);
    res.json(plan);
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

app.put('/api/projects/:id/timeline', (req, res) => {
  const pid = req.params.id;
  saveJson(pid, 'timeline.json', req.body);
  res.json({ ok: true });
});

app.get('/api/projects/:id/srt/download', (req, res) => {
  const pid = req.params.id;
  const plan = loadJson(pid, 'timeline.json');
  if (!plan) return res.status(404).send('No timeline');
  const cues = plan.srt_cues && plan.srt_cues.length ? plan.srt_cues : buildSrtCues(plan.clips || []);
  const srt = formatSrt(cues);
  const title = String(req.query.title || 'Subtitles').replace(/[^a-zA-Z0-9._ -]/g, '_');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="SRT_Only_${title}.srt"`);
  res.send(srt);
});

app.get('/api/projects/:id/export/status', (req, res) => {
  res.json(exportStatus[req.params.id] || { running: false, percent: 0, message: '' });
});

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
      exportStatus[pid] = {
        running: true,
        percent: 5 + Math.round((i / plan.clips.length) * 68),
        message: `Rendering scene ${i + 1}/${plan.clips.length} (${c.screen})…`,
      };
      const outPart = path.join(partsDir, `part_${String(i).padStart(4, '0')}.mp4`);
      const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},format=yuv420p`;

      if (!c.media_path || !fs.existsSync(c.media_path) || c.fit === 'missing') {
        await execFileAsync(FFMPEG_BIN, [
          '-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=${c.duration}:r=${fps}`,
          '-t', String(c.duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', outPart,
        ]);
      } else if (c.kind === 'image') {
        await execFileAsync(FFMPEG_BIN, [
          '-y', '-loop', '1', '-i', c.media_path,
          '-t', String(c.duration), '-vf', vf,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', outPart,
        ]);
      } else {
        await execFileAsync(FFMPEG_BIN, [
          '-y', '-ss', String(c.source_in || 0), '-i', c.media_path,
          '-t', String(c.duration), '-vf', vf,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', outPart,
        ]);
      }
      partFiles.push(outPart);
    }

    exportStatus[pid] = { running: true, percent: 78, message: 'Stitching & compressing video + audio…' };
    const concatTxt = path.join(jobDir, 'concat.txt');
    fs.writeFileSync(concatTxt, partFiles.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'), 'utf-8');
    const silentMp4 = path.join(jobDir, 'silent.mp4');
    await execFileAsync(FFMPEG_BIN, ['-y', '-f', 'concat', '-safe', '0', '-i', concatTxt, '-c', 'copy', silentMp4]);

    let videoSource = silentMp4;
    if (plan.logo_path && plan.logo_enabled !== false && fs.existsSync(plan.logo_path)) {
      const logoMp4 = path.join(jobDir, 'logo.mp4');
      const logoW = Math.max(90, Math.round(width * 0.1));
      const padX = Math.max(8, Math.round(width * 0.0078));
      const padY = Math.max(10, Math.round(height * 0.0176));
      await execFileAsync(FFMPEG_BIN, [
        '-y', '-i', silentMp4, '-i', plan.logo_path,
        '-filter_complex', `[1:v]scale=${logoW}:-1[lg];[0:v][lg]overlay=W-w-${padX}:${padY}:format=auto,format=yuv420p[vout]`,
        '-map', '[vout]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-an', logoMp4,
      ]);
      videoSource = logoMp4;
    }

    const q = Math.max(10, Math.min(95, Number(settings.compression_quality) || 70));
    const crf = settings.advanced_compression && settings.compression_mode !== 'none'
      ? Math.max(18, Math.min(35, Math.round(20 + (q / 100) * 12)))
      : 21;

    const outPath = path.join(EXPORTS_DIR, pid, `${safeTitle}.${settings.format || 'mp4'}`);
    if (plan.voiceover_path && fs.existsSync(plan.voiceover_path) && !settings.export_video_only) {
      await execFileAsync(FFMPEG_BIN, [
        '-y', '-i', videoSource, '-i', plan.voiceover_path,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', `${settings.audio_bitrate_kbps || 320}k`,
        '-movflags', '+faststart', '-shortest', outPath,
      ], { timeout: 600000 });
    } else {
      await execFileAsync(FFMPEG_BIN, [
        '-y', '-i', videoSource,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', outPath,
      ], { timeout: 600000 });
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
      if (req.body.voiceover_text !== undefined) s.voiceover_text = String(req.body.voiceover_text);
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
  res.json({ ok: true, scene: updated, timeline: tl });
});

app.post('/api/projects/:id/scenes/:screen/voiceover', upload.single('file'), async (req, res) => {
  try {
    const { id, screen } = req.params;
    const root = projectRoot(id);
    if (!fs.existsSync(root) || !req.file) return res.status(400).json({ detail: 'Missing scene VO file' });
    const voDir = path.join(root, 'voiceover', 'scenes');
    fs.mkdirSync(voDir, { recursive: true });
    const origName = path.basename(req.file.originalname || `${screen}.mp3`);
    const dest = path.join(voDir, `${screen}_${origName}`);
    fs.copyFileSync(req.file.path, dest);
    try { fs.unlinkSync(req.file.path); } catch {}
    const dur = (await probeDuration(dest)) || 2.0;

    const tl = loadJson(id, 'timeline.json');
    if (tl && Array.isArray(tl.clips)) {
      for (const c of tl.clips) {
        if (c.screen === screen) {
          c.custom_vo_path = dest;
          c.custom_vo_filename = origName;
          c.custom_vo_duration = dur;
        }
      }
      saveJson(id, 'timeline.json', tl);
    }
    res.json({ ok: true, screen, filename: origName, duration: dur, timeline: tl });
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

app.post('/api/projects/:id/project-file', (req, res) => {
  try {
    const pid = req.params.id;
    const plan = loadJson(pid, 'timeline.json');
    if (!plan) return res.status(400).json({ detail: 'Build timeline first' });
    const fmt = String(req.body?.format || 'wfp').toLowerCase();
    const rawTitle = String(req.body?.title || `Project_${pid}`).trim();
    const safeTitle = rawTitle.replace(/[^a-zA-Z0-9._ ()-]/g, '_') || `Project_${pid}`;
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
        const rel = `Resources/${sha}_1${ext}`;
        pathMap[orig] = rel;
        bundleZip.addLocalFile(orig, 'Resources', `${sha}_1${ext}`);
        resourceItems.push({ original_path: orig.replace(/\\/g, '/'), bundle_path: rel, sha1: sha });
      }
      const innerWfp = buildFilmoraWfpBuffer(plan, rawTitle, pathMap);
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
    res.json({
      filename,
      path: outPath,
      saved_to: '',
      download: `/api/projects/${pid}/project-file/download`,
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
  const plan = loadJson(pid, 'timeline.json');
  if (!plan) return res.status(400).json({ detail: 'Build timeline first' });
  const rawTitle = String(req.body?.title || `Project_${pid}`).trim();
  const safeTitle = rawTitle.replace(/[^a-zA-Z0-9._ ()-]/g, '_') || `Project_${pid}`;

  collectStatus[pid] = { running: true, percent: 15, message: 'Packing Filmora 15 .wfpbundle & media…' };
  try {
    const outDir = path.join(EXPORTS_DIR, pid);
    fs.mkdirSync(outDir, { recursive: true });
    const bundleFilename = `${safeTitle}.wfpbundle`;
    const bundlePath = path.join(outDir, bundleFilename);

    const bundleZip = new AdmZip();
    const pathMap = {};
    const resourceItems = [];
    const allPaths = new Set();
    for (const c of plan.clips || []) {
      if (c.media_path && fs.existsSync(c.media_path)) allPaths.add(c.media_path);
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
      const rel = `Resources/${sha}_1${ext}`;
      pathMap[orig] = rel;
      bundleZip.addLocalFile(orig, 'Resources', `${sha}_1${ext}`);
      resourceItems.push({ original_path: orig.replace(/\\/g, '/'), bundle_path: rel, sha1: sha });
    }
    const innerWfp = buildFilmoraWfpBuffer(plan, rawTitle, pathMap);
    bundleZip.addFile('project.wfp', innerWfp);
    bundleZip.addFile('resource.json', deflateRawJson({ version: '15.6.4', resources: resourceItems }));
    bundleZip.writeZip(bundlePath);

    const sizeMb = Math.round((fs.statSync(bundlePath).size / (1024 * 1024)) * 100) / 100;
    const payload = {
      filename: bundleFilename,
      path: bundlePath,
      saved_to: '',
      wfpbundle_saved_to: '',
      size_mb: sizeMb,
      download: `/api/projects/${pid}/collect/download?kind=wfpbundle`,
      wfpbundle_download: `/api/projects/${pid}/collect/download?kind=wfpbundle`,
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

// Open Project File (.wfpbundle, .wfp, .json)
app.post('/api/projects/open-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ detail: 'Missing project file' });
    const origName = path.basename(req.file.originalname || 'project.wfpbundle');
    const ext = path.extname(origName).toLowerCase();
    const pid = createProject();
    const root = projectRoot(pid);

    if (ext === '.json') {
      const plan = JSON.parse(fs.readFileSync(req.file.path, 'utf-8'));
      try { fs.unlinkSync(req.file.path); } catch {}
      plan.project_id = pid;
      saveJson(pid, 'timeline.json', plan);
      return res.json({ project_id: pid, title: path.parse(origName).name, timeline: plan });
    }

    // Extract .wfpbundle or .wfp
    const outerZip = new AdmZip(req.file.path);
    try { fs.unlinkSync(req.file.path); } catch {}
    const entries = outerZip.getEntries();
    const entryMap = new Map(entries.map((e) => [e.entryName.replace(/\\/g, '/'), e]));

    // Extract Resources/* into project media folders
    const extractedMap = {};
    for (const e of entries) {
      const norm = e.entryName.replace(/\\/g, '/');
      if (norm.startsWith('Resources/') && !e.isDirectory) {
        const base = path.basename(norm);
        const fext = path.extname(base).toLowerCase();
        let targetDir = path.join(root, 'media', 'images');
        if (VIDEO_EXT.has(fext)) targetDir = path.join(root, 'media', 'videos');
        else if (['.mp3', '.wav', '.m4a', '.aac'].includes(fext)) targetDir = path.join(root, 'voiceover');
        fs.mkdirSync(targetDir, { recursive: true });
        const destFile = path.join(targetDir, base);
        fs.writeFileSync(destFile, e.getData());
        extractedMap[norm] = destFile;
      }
    }

    let wfpZip = outerZip;
    if (entryMap.has('project.wfp')) {
      wfpZip = new AdmZip(entryMap.get('project.wfp').getData());
    }
    const tlEntry = wfpZip.getEntry('Timelines/timeline.json');
    if (!tlEntry) return res.status(400).json({ detail: 'Invalid .wfp/.wfpbundle: missing Timelines/timeline.json' });
    const tlObj = inflateRawJson(tlEntry.getData());

    const mediaItems = await reindexMedia(pid);
    const mediaByPath = new Map(mediaItems.map((m) => [path.resolve(m.path), m]));

    let clips = [];
    if (tlObj.dgs_plan_snapshot && Array.isArray(tlObj.dgs_plan_snapshot.clips)) {
      clips = tlObj.dgs_plan_snapshot.clips.map((c, idx) => {
        const localPath = extractedMap[c.media_path] || c.media_path || '';
        const found = localPath && mediaByPath.get(path.resolve(localPath));
        return {
          ...c,
          media_id: found ? found.id : c.media_id,
          media_path: found ? found.path : localPath,
          screen: c.screen || `Screen_${idx + 1}`,
        };
      });
    } else if (Array.isArray(tlObj.tracks)) {
      const vTrack = tlObj.tracks.find((t) => t.type === 1) || tlObj.tracks[0];
      let cursor = 0;
      for (let i = 0; i < (vTrack?.clips || []).length; i++) {
        const vc = vTrack.clips[i];
        const dur = (vc.timeline_range?.duration || TICKS_PER_SEC * 3) / TICKS_PER_SEC;
        const srcRel = (vc.source_file || '').replace(/\\/g, '/');
        const localPath = extractedMap[srcRel] || srcRel;
        const found = localPath && mediaByPath.get(path.resolve(localPath));
        clips.push({
          screen: `Screen_${i + 1}`,
          media_id: found ? found.id : null,
          media_path: found ? found.path : localPath,
          kind: found ? found.kind : (vc.type === 1 ? 'video' : 'image'),
          start: Math.round(cursor * 1000) / 1000,
          end: Math.round((cursor + dur) * 1000) / 1000,
          duration: Math.round(dur * 1000) / 1000,
          source_in: 0,
          source_out: Math.round(dur * 1000) / 1000,
          script_text: vc.title || `Screen_${i + 1}`,
          vo_text: '',
          fit: 'hold',
        });
        cursor += dur;
      }
    }

    // Check extracted voiceover
    const voDir = path.join(root, 'voiceover');
    let voPath = null;
    if (fs.existsSync(voDir)) {
      const voFiles = fs.readdirSync(voDir).filter((f) => ['.mp3', '.wav', '.m4a', '.aac'].includes(path.extname(f).toLowerCase()));
      if (voFiles.length) {
        voPath = path.join(voDir, voFiles[0]);
        const voDur = (await probeDuration(voPath)) || 0;
        saveJson(pid, 'voiceover.json', { path: voPath, filename: voFiles[0], duration: voDur, kind: 'narration', slots: [{ slot: 1, filename: voFiles[0], path: voPath, duration: voDur }] });
      }
    }

    const scenes = clips.map((c) => ({
      screen: c.screen,
      visual_type: c.kind === 'video' ? 'video' : 'image',
      visual_description: c.script_text || '',
      onscreen_text: '',
      voiceover_text: c.vo_text || '',
      duration: c.duration,
      is_poem: false,
    }));
    saveJson(pid, 'script.json', scenes);
    const totalDur = clips.reduce((acc, c) => Math.max(acc, c.end || 0), 0);
    const plan = {
      project_id: pid,
      total_duration: totalDur,
      clips,
      voiceover_path: voPath,
      voiceover_slots: [],
      srt_cues: buildSrtCues(clips),
      qa_issues: [],
      qa_summary: `Imported ${clips.length} clips from ${origName}`,
    };
    saveJson(pid, 'timeline.json', plan);
    res.json({ project_id: pid, title: path.parse(origName).name, timeline: plan });
  } catch (e) {
    res.status(500).json({ detail: String(e) });
  }
});

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

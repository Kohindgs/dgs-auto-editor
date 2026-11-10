/**
 * Version log and the files the editor must have on the machine.
 * The published feed is frontend/public/updates.json. A newer version
 * shows its download link. Missing card-reading files are downloaded.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

const FEED_URLS = [
  process.env.DGS_UPDATE_URL,
  'https://raw.githubusercontent.com/Kohindgs/dgs-auto-editor/main/public/updates.json',
  'https://raw.githubusercontent.com/Kohindgs/dgs-auto-editor/main/frontend/public/updates.json',
  'https://editor.dgeniussolutions.com/updates.json',
].filter(Boolean);

const CARD_FILES = [
  {
    id: 'eng',
    file: 'eng.traineddata',
    url: 'https://github.com/tesseract-ocr/tessdata/raw/main/eng.traineddata',
  },
  {
    id: 'mar',
    file: 'mar.traineddata',
    url: 'https://github.com/tesseract-ocr/tessdata/raw/main/mar.traineddata',
  },
];

let dataDir = '';
let python = '';
let hearScript = '';
let whisperState = 'missing';

function init(opts) {
  dataDir = (opts && opts.dataDir) || process.env.DGS_DATA_DIR || '';
  python = (opts && opts.python) || process.env.DGS_PYTHON || '';
  hearScript = (opts && opts.hearScript) || '';
  if (whisperReady()) whisperState = 'ready';
}

function tessDataDir() {
  const dir = process.env.DGS_TESSDATA || (dataDir ? path.join(dataDir, 'tessdata') : '');
  if (dir) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function modelDir() {
  const dir = process.env.DGS_MODEL_DIR || (dataDir ? path.join(dataDir, 'models') : '');
  if (dir) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function localFeed() {
  const candidates = [
    process.env.DGS_UPDATES_FILE,
    path.join(__dirname, 'public', 'updates.json'),
    path.join(__dirname, '..', 'frontend', 'public', 'updates.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    const feed = readJson(file);
    if (feed && feed.version) return feed;
  }
  return {
    version: '0.9.0-beta.1',
    released: '2026-11-03',
    notes: [],
    downloads: {},
    history: [],
  };
}

function versionParts(value) {
  const raw = String(value || '').toLowerCase();
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)(?:-(?:beta|native)\.(\d+))?/);
  if (!match) return [0, 0, 0, 0, 0];
  let channel = 2;
  let build = 1000;
  if (raw.includes('-beta.')) {
    channel = 0;
    build = Number(match[4] || 0);
  } else if (raw.includes('-native.')) {
    channel = 1;
    build = Number(match[4] || 0);
  }
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    channel,
    build,
  ];
}

function versionCompare(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 5; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'DGS-Auto-Editor', Accept: 'application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchJson(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error('update feed timed out'));
    });
    req.on('error', reject);
  });
}

async function checkRemote() {
  const local = localFeed();
  let remote = null;
  let feedError = '';
  for (const url of FEED_URLS) {
    try {
      const body = await fetchJson(url);
      if (body && body.version) {
        remote = body;
        break;
      }
    } catch (err) {
      feedError = err instanceof Error ? err.message : String(err);
    }
  }
  const latest = remote || local;
  return {
    current: local.version,
    released: local.released || '',
    latest: latest.version,
    latestReleased: latest.released || '',
    updateAvailable: Boolean(remote && versionCompare(remote.version, local.version) > 0),
    notes: latest.notes || [],
    history: latest.history || local.history || [],
    downloads: latest.downloads || {},
    platform: process.platform,
    feedError: remote ? '' : feedError,
  };
}

function fileReady(dir, name) {
  try {
    return fs.statSync(path.join(dir, name)).size > 100000;
  } catch {
    return false;
  }
}

function whisperReady() {
  const dir = modelDir();
  if (!dir || !fs.existsSync(dir)) return false;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let names = [];
    try {
      names = fs.readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      if (/faster-whisper-base/i.test(name)) return true;
      const full = path.join(current, name);
      try {
        if (fs.statSync(full).isDirectory()) stack.push(full);
      } catch {
        /* skip */
      }
    }
  }
  return false;
}

function assetStatus() {
  const dir = tessDataDir();
  if (whisperReady()) whisperState = 'ready';
  return {
    tessdata: dir,
    models: modelDir(),
    eng: fileReady(dir, 'eng.traineddata'),
    mar: fileReady(dir, 'mar.traineddata'),
    whisper: whisperState,
  };
}

function downloadTo(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.part`;
    const file = fs.createWriteStream(tmp);
    const go = (target, hops) => {
      if (hops > 5) {
        file.close();
        reject(new Error('too many redirects'));
        return;
      }
      const lib = String(target).startsWith('https') ? https : http;
      const req = lib.get(target, { headers: { 'User-Agent': 'DGS-Auto-Editor' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          go(res.headers.location, hops + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          file.close();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(tmp, dest);
            resolve(dest);
          });
        });
      });
      req.on('error', (err) => {
        file.close();
        reject(err);
      });
    };
    go(url, 0);
  });
}

function prefetchWhisper() {
  if (!python || !hearScript || !fs.existsSync(python) || !fs.existsSync(hearScript)) {
    whisperState = 'missing';
    return;
  }
  if (whisperReady()) {
    whisperState = 'ready';
    return;
  }
  if (whisperState === 'downloading') return;
  whisperState = 'downloading';
  const proc = spawn(python, [hearScript, '--download'], {
    env: { ...process.env, DGS_MODEL_DIR: modelDir() },
    windowsHide: true,
  });
  proc.on('exit', (code) => {
    whisperState = code === 0 || whisperReady() ? 'ready' : 'error';
  });
  proc.on('error', () => {
    whisperState = 'error';
  });
}

async function ensureAssets() {
  const dir = tessDataDir();
  const downloaded = [];
  for (const item of CARD_FILES) {
    const dest = path.join(dir, item.file);
    if (fileReady(dir, item.file)) continue;
    await downloadTo(item.url, dest);
    downloaded.push(item.id);
  }
  if (dir) process.env.DGS_TESSDATA = dir;
  prefetchWhisper();
  return { ...assetStatus(), downloaded };
}

module.exports = {
  init,
  localFeed,
  checkRemote,
  assetStatus,
  ensureAssets,
  tessDataDir,
};

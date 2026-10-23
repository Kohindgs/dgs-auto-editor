// Offline script-to-voice recognition for DGS Auto Editor.
// Audio is temporary, never published in public_html. Only word timings are cached.
'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

function installAudioAlignRoutes({ app, upload, projectRoot, ffmpegPath }) {
  const jobs = new Map();
  const home = process.env.DGS_AUDIO_ALIGN_HOME || path.join(os.userInfo().homedir, 'dgs_audio_align');
  const worker = path.join(__dirname, 'audio-align-worker.py');
  const model = path.join(home, 'models', 'vosk-model-small-en-in-0.4');
  const pythonLib = path.join(home, 'python');

  function requestInfo(req) {
    const id = String(req.params.id || '');
    if (!/^[a-z0-9][a-z0-9-]{7,63}$/i.test(id)) throw new Error('Invalid project ID');
    const kind = String(req.query.kind || req.body?.kind || 'narration');
    const slot = kind === 'poem' ? 'poem' : String(Math.min(10, Math.max(1, Number(req.query.slot || req.body?.slot || 1) || 1)));
    const root = projectRoot(id);
    if (!fs.existsSync(root)) throw new Error('Project not found');
    return { id, slot, root, key: id + ':' + slot };
  }
  function cachePath(info) {
    return path.join(info.root, 'meta', 'audio_sync_' + info.slot + '.json');
  }
  function getCache(info) {
    try { return JSON.parse(fs.readFileSync(cachePath(info), 'utf8')); } catch { return null; }
  }
  function safeWords(words) {
    return (Array.isArray(words) ? words : []).filter(w => {
      const a = Number(w.start), b = Number(w.end);
      return typeof w.word === 'string' && w.word.length < 80 && Number.isFinite(a)
        && Number.isFinite(b) && a >= 0 && b >= a && b < 18000;
    }).slice(0, 35000).map(w => ({
      word: String(w.word).slice(0, 80),
      start: Math.round(Number(w.start) * 1000) / 1000,
      end: Math.round(Number(w.end) * 1000) / 1000,
      confidence: Math.max(0, Math.min(1, Number(w.confidence) || 0)),
    }));
  }
  function cacheResult(data, hash) {
    return {
      status: 'ready',
      hash,
      engine: 'vosk-small-en-in-0.4',
      word_count: data.words.length,
      words: data.words,
      decoded_duration: data.decoded_duration,
    };
  }
  async function computeHash(file) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      const inp = fs.createReadStream(file);
      inp.on('data', b => h.update(b));
      inp.on('error', reject);
      inp.on('end', () => resolve(h.digest('hex')));
    });
  }
  function launch(info, filePath, hash) {
    const job = { status: 'processing', hash, processed_seconds: 0, started: Date.now(), error: null };
    jobs.set(info.key, job);
    const proc = spawn('python3', [worker, filePath, model], {
      cwd: info.root,
      env: {
        ...process.env,
        DGS_VOSK_PYTHONPATH: pythonLib,
        DGS_FFMPEG_BIN: ffmpegPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let rest = '';
    let result = null;
    let errors = '';
    function parseLine(line) {
      if (line.startsWith('PROGRESS ')) {
        job.processed_seconds = Math.max(job.processed_seconds, Number(line.slice(9)) || 0);
      } else if (line.startsWith('RESULT ')) {
        try { result = JSON.parse(line.slice(7)); } catch (e) { job.error = 'Invalid speech recognition response'; }
      } else if (line.startsWith('ERROR ')) {
        job.error = line.slice(6).slice(0, 250);
      }
    }
    proc.stdout.on('data', buf => {
      rest += buf.toString('utf8');
      if (rest.length > 4 * 1024 * 1024) { job.error = 'Speech response too large'; proc.kill(); return; }
      let i;
      while ((i = rest.indexOf('\n')) >= 0) {
        parseLine(rest.slice(0, i).trim());
        rest = rest.slice(i + 1);
      }
    });
    proc.stderr.on('data', buf => { errors = (errors + buf.toString('utf8')).slice(-900); });
    proc.on('error', e => { job.error = e.message; });
    proc.on('close', async code => {
      try {
        if (rest.trim()) parseLine(rest.trim());
        const words = safeWords(result?.words);
        if (code !== 0 || job.error || words.length < 6) {
          job.status = 'error';
          job.error = String(job.error || errors || 'Not enough recognized narration words').slice(0, 250);
          return;
        }
        const doc = cacheResult({
          words,
          decoded_duration: Number(result.decoded_duration) || 0,
        }, hash);
        doc.created_at = new Date().toISOString();
        const dest = cachePath(info);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const temp = dest + '.new-' + process.pid;
        await fsp.writeFile(temp, JSON.stringify(doc));
        await fsp.rename(temp, dest);
        job.status = 'ready';
        job.word_count = words.length;
        job.processed_seconds = doc.decoded_duration;
      } catch (e) {
        job.status = 'error';
        job.error = e.message;
      } finally {
        try { await fsp.unlink(filePath); } catch {}
      }
    });
    return job;
  }
  function snapshot(info, wantedHash) {
    const stored = getCache(info);
    if (stored && stored.status === 'ready' && (!wantedHash || stored.hash === wantedHash)) return stored;
    const job = jobs.get(info.key);
    if (job && (!wantedHash || job.hash === wantedHash)) return {
      status: job.status,
      hash: job.hash,
      processed_seconds: job.processed_seconds,
      word_count: job.word_count || 0,
      error: job.error,
    };
    return { status: 'missing', detail: 'No matching audio recognition cache. Upload VO audio to sync.' };
  }

  app.post('/api/projects/:id/audio-align-track', upload.single('file'), async (req, res) => {
    let filePath = req.file?.path || null;
    try {
      const info = requestInfo(req);
      if (!filePath) return res.status(400).json({ detail: 'Upload VO file to align its script' });
      const ext = path.extname(String(req.file.originalname || '')).toLowerCase();
      if (!['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus', '.webm', '.mp4'].includes(ext) || req.file.size > 90 * 1024 * 1024) {
        return res.status(415).json({ detail: 'Unsupported or oversized VO audio file' });
      }
      if (!fs.existsSync(worker) || !fs.existsSync(model)) {
        return res.status(503).json({ detail: 'Offline audio aligner is not installed' });
      }
      const hash = await computeHash(filePath);
      const stored = getCache(info);
      if (stored?.status === 'ready' && stored.hash === hash && stored.words?.length >= 6) return res.json(stored);
      const existing = jobs.get(info.key);
      if (existing?.status === 'processing') {
        if (existing.hash !== hash) return res.status(409).json({ detail: 'A different VO is currently being analyzed for this track' });
        return res.status(202).json(snapshot(info, hash));
      }
      const privateDir = path.join(info.root, 'audio_alignment_private');
      await fsp.mkdir(privateDir, { recursive: true });
      const workFile = path.join(privateDir, info.slot + '-' + hash.slice(0, 16) + ext);
      await fsp.rename(filePath, workFile);
      filePath = null;
      launch(info, workFile, hash);
      return res.status(202).json(snapshot(info, hash));
    } catch (e) {
      return res.status(400).json({ detail: String(e.message || e) });
    } finally {
      if (filePath) try { await fsp.unlink(filePath); } catch {}
    }
  });

  app.get('/api/projects/:id/audio-align-track', (req, res) => {
    try { return res.json(snapshot(requestInfo(req), String(req.query.hash || ''))); }
    catch (e) { return res.status(404).json({ detail: String(e.message || e) }); }
  });
}

module.exports = { installAudioAlignRoutes };

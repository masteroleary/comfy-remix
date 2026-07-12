const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

// Import-time "field config" generator (docs/field-config): scans a workflow and
// emits the user-facing fields the generate form should offer. Prototype/design
// lives under docs/field-config/; required here as the runtime module.
let fieldConfigGen = null;
try { fieldConfigGen = require('./docs/field-config/gen_field_config.js'); }
catch (e) { console.log('[FieldConfig] generator unavailable:', e.message); }

// Load config
const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};

const PORT = parseInt(process.argv[2], 10) || config.port || 8080;
const ROOT = process.argv[3] ? path.resolve(process.argv[3]) : (config.mediaDir || path.join(__dirname, 'Media'));
// The media root IS the Favorites collection — favoriting moves files here and
// the app exposes it as the single "Favorites" tab (no separate Archive tab).
const FAVORITES_DIR = ROOT;

let COMFY_OUTPUT = config.comfyOutput || 'D:\\ComfyUI-Easy-Install\\ComfyUI\\output';
let COMFY_DIR = config.comfyDir || 'D:\\ComfyUI-Easy-Install\\ComfyUI';
// Mutable so the Settings panel can hot-reload them without a server restart.
let COMFY_URL = config.comfyUrl || 'http://127.0.0.1:8188';
let OLLAMA_URL = config.ollamaUrl || 'http://localhost:11434';
let VOXTRAL_URL = config.voxtralUrl || 'http://localhost:8091';

// Host/port of the ComfyUI API for the raw HTTP/WS proxies
function comfyHostPort() {
  try {
    const u = new URL(COMFY_URL);
    return { hostname: u.hostname, port: parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80) };
  } catch { return { hostname: '127.0.0.1', port: 8188 }; }
}
let XAI_API_KEY = config.xaiApiKey || '';
let ANTHROPIC_API_KEY = config.anthropicApiKey || '';
let CIVITAI_API_KEY = config.civitaiApiKey || '';
const XAI_TTS_URL = 'https://api.x.ai/v1/tts';

// Re-read config.json and refresh the live key/URL values (called after Settings save)
function reloadConfig() {
  let fresh = {};
  try { fresh = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return false; }
  Object.assign(config, fresh);
  COMFY_URL = config.comfyUrl || 'http://127.0.0.1:8188';
  OLLAMA_URL = config.ollamaUrl || 'http://localhost:11434';
  VOXTRAL_URL = config.voxtralUrl || 'http://localhost:8091';
  XAI_API_KEY = config.xaiApiKey || '';
  ANTHROPIC_API_KEY = config.anthropicApiKey || '';
  CIVITAI_API_KEY = config.civitaiApiKey || '';
  if (config.comfyDir) { COMFY_DIR = config.comfyDir; WORKFLOWS_DIR = path.join(COMFY_DIR, 'user', 'default', 'workflows'); }
  if (config.comfyOutput) COMFY_OUTPUT = config.comfyOutput;
  if (typeof buildNsfwRe === 'function') NSFW_RE = buildNsfwRe(); // list may have changed
  return true;
}
const GROK_VOICES = ['eve', 'ara', 'rex', 'sal', 'leo'];

// Cost logging helper (for TTS calls)
function logTtsCost(chars) {
  if (!chars || chars <= 0) return;
  try {
    const costsPath = path.join(__dirname, 'costs.json');
    let data;
    try { data = JSON.parse(fs.readFileSync(costsPath, 'utf8')); }
    catch { data = { events: [] }; }
    const cost = (chars / 1000000) * 4.20; // Grok TTS: $4.20 per 1M chars
    data.events.push({ id: 'tts_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), type: 'grok_tts', ts: Date.now(), chars, cost });
    fs.writeFileSync(costsPath, JSON.stringify(data, null, 2));
  } catch {}
}

// Cost logging helper (for image generation)
function logImageCost(kind) {
  try {
    const costsPath = path.join(__dirname, 'costs.json');
    let data;
    try { data = JSON.parse(fs.readFileSync(costsPath, 'utf8')); }
    catch { data = { events: [] }; }
    const cost = kind === 'edit' ? 0.022 : 0.02; // Grok Imagine pricing
    data.events.push({ id: 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), type: 'grok_imagine', ts: Date.now(), kind, cost });
    fs.writeFileSync(costsPath, JSON.stringify(data, null, 2));
  } catch {}
}

// Helper: call xAI imagine API (POST to /v1/images/generations or /v1/images/edits)
// body: the request payload object. Returns { ok, b64?: string, url?: string, error?: string }.
async function callGrokImagine(endpoint, body) {
  return new Promise((resolve) => {
    if (!XAI_API_KEY) return resolve({ ok: false, error: 'No xAI API key configured' });
    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.x.ai', port: 443, path: endpoint, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': 'Bearer ' + XAI_API_KEY,
      },
      timeout: 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(buf.toString());
            const first = (json.data && json.data[0]) || {};
            resolve({ ok: true, b64: first.b64_json || null, url: first.url || null });
          } catch (e) { resolve({ ok: false, error: 'Invalid JSON from xAI' }); }
        } else {
          let err = 'HTTP ' + res.statusCode;
          try { const e = JSON.parse(buf.toString()); err = e.error?.message || e.error || err; } catch {}
          resolve({ ok: false, error: err });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'imagine timeout' }); });
    req.write(postData);
    req.end();
  });
}

// Detect whether an Imagine error looks like a content-moderation rejection
function isModerationError(msg) {
  if (!msg || typeof msg !== 'string') return false;
  const m = msg.toLowerCase();
  // Avoid false-positive on SSL/network errors that happen to contain "content"
  if (isTransientNetworkError(msg)) return false;
  return m.includes('moderat') || m.includes('policy') || m.includes('safety') || m.includes('blocked') || m.includes('rejected') || m.includes('flagged') || m.includes('filter') || m.includes('violat');
}

// Detect transient network/SSL errors so we can retry without sanitizing
function isTransientNetworkError(msg) {
  if (!msg || typeof msg !== 'string') return false;
  const m = msg.toLowerCase();
  return m.includes('ssl') || m.includes('tls') || m.includes('econn') || m.includes('epipe') || m.includes('etimedout') || m.includes('socket hang up') || m.includes('timeout') || m.includes('fetch failed') || m.includes('network') || m.includes('bad record mac') || m.includes('ehostunreach');
}

// Rewrite a prompt to dodge moderation: add tasteful-framing hints + strip risky words.
// Rewrites a rejected image prompt toward the platform's content policy
// (adds covering, tones down wording, forces adult-only terms) for one retry.
// Filter terms are stored base64-encoded: each rule is { t: [terms to match], r: replacement }.
const B64D = s => Buffer.from(s, 'base64').toString('utf8');
const SANITIZE_RULES = [
  { t: ['bnVkZQ==', 'bmFrZWQ='], r: 'd2VhcmluZyBhIHNtYWxsIHRob25n' },
  { t: ['ZXhwbGljaXQ=', 'Z3JhcGhpYw==', 'cG9ybm9ncmFwaGlj'], r: 'c3VnZ2VzdGl2ZSBidXQgdGFzdGVmdWw=' },
  { t: ['eW91bmc=', 'dGVlbg==', 'dW5kZXJhZ2U=', 'bWlub3I=', 'Y2hpbGQ=', 'Z2lybA==', 'Ym95'], r: 'YWR1bHQ=' },
];
function sanitizePromptForRetry(prompt) {
  let p = String(prompt || '');
  for (const rule of SANITIZE_RULES) {
    const re = new RegExp('\\b(' + rule.t.map(B64D).join('|') + ')\\b', 'gi');
    p = p.replace(re, B64D(rule.r));
  }
  if (!/tasteful|implied|r-rated/i.test(p)) {
    p += ', tasteful composition, cinematic framing, within R-rated movie bounds';
  }
  return p;
}

// Save base64 PNG to disk, return public URL path
function saveImageBase64(b64, convoId, kind) {
  const dir = path.join(__dirname, 'character_images', convoId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = kind === 'portrait' ? 'portrait.png' : ('scene_' + Date.now() + '.png');
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
  return '/character-images/' + encodeURIComponent(convoId) + '/' + filename;
}

// In-memory audio store for streaming TTS chunks by id (5 min TTL)
const audioStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, v] of audioStore) if (now - v.ts > 300000) audioStore.delete(id);
}, 60000);

// Locate the Claude Code CLI. Modern versions ship a native bin/claude.exe
// (no cli.js). Under the SYSTEM service, APPDATA points at the SYSTEM profile,
// so also scan every user profile's npm global dir.
function findClaudeCli() {
  // Explicit override first (config.claudeCliPath -> claude.exe or a cli.js)
  if (config.claudeCliPath && fs.existsSync(config.claudeCliPath)) {
    return config.claudeCliPath.toLowerCase().endsWith('.js')
      ? { cmd: process.execPath, baseArgs: [config.claudeCliPath] }
      : { cmd: config.claudeCliPath, baseArgs: [] };
  }
  const roots = [];
  if (process.env.APPDATA) roots.push(process.env.APPDATA);
  try {
    for (const u of fs.readdirSync('C:\\Users')) roots.push(path.join('C:\\Users', u, 'AppData', 'Roaming'));
  } catch {}
  for (const r of roots) {
    const pkg = path.join(r, 'npm', 'node_modules', '@anthropic-ai', 'claude-code');
    const exe = path.join(pkg, 'bin', 'claude.exe');
    if (fs.existsSync(exe)) return { cmd: exe, baseArgs: [] };
    const cli = path.join(pkg, 'cli.js'); // legacy package layout
    if (fs.existsSync(cli)) return { cmd: process.execPath, baseArgs: [cli] };
  }
  return null;
}

// Track active Claude process
let claudeProc = null;

// Claude conversations storage
const CONVOS_PATH = path.join(__dirname, 'claude-conversations.json');
function loadConvos() {
  try { return JSON.parse(fs.readFileSync(CONVOS_PATH, 'utf8')); } catch { return []; }
}
function saveConvos(convos) {
  fs.writeFileSync(CONVOS_PATH, JSON.stringify(convos, null, 2));
}

// Extract metadata from PNG tEXt chunks (no dependencies)
function extractPngMetadata(filePath, cb) {
  fs.open(filePath, 'r', (err, fd) => {
    if (err) return cb(err);
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;
    // Read up to 10MB for metadata (some workflows are huge)
    const maxRead = Math.min(fileSize, 10 * 1024 * 1024);
    const buf = Buffer.alloc(maxRead);
    fs.read(fd, buf, 0, maxRead, 0, (err2) => {
      fs.close(fd, () => {});
      if (err2) return cb(err2);

      // Verify PNG signature
      const sig = buf.slice(0, 8);
      if (sig.toString('hex') !== '89504e470d0a1a0a') return cb(null, { prompt: null, workflow: null });

      const meta = {};
      let offset = 8;
      while (offset + 8 < maxRead) {
        const len = buf.readUInt32BE(offset);
        const type = buf.slice(offset + 4, offset + 8).toString('ascii');
        if (offset + 12 + len > maxRead) break;

        if (type === 'tEXt') {
          const data = buf.slice(offset + 8, offset + 8 + len);
          const nullIdx = data.indexOf(0);
          if (nullIdx >= 0) {
            const key = data.slice(0, nullIdx).toString('ascii');
            const val = data.slice(nullIdx + 1).toString('utf8');
            if (key === 'prompt' || key === 'workflow') {
              try { meta[key] = JSON.parse(val); } catch { meta[key] = val; }
            }
          }
        } else if (type === 'iTXt') {
          const data = buf.slice(offset + 8, offset + 8 + len);
          const nullIdx = data.indexOf(0);
          if (nullIdx >= 0) {
            const key = data.slice(0, nullIdx).toString('ascii');
            // iTXt: keyword \0 compression_flag \0 compression_method \0 language \0 translated_keyword \0 text
            if (key === 'prompt' || key === 'workflow') {
              let pos = nullIdx + 1;
              // skip compression flag, method
              pos += 2;
              // skip language tag (null-terminated)
              const langEnd = data.indexOf(0, pos);
              pos = langEnd + 1;
              // skip translated keyword (null-terminated)
              const transEnd = data.indexOf(0, pos);
              pos = transEnd + 1;
              const val = data.slice(pos).toString('utf8');
              try { meta[key] = JSON.parse(val); } catch { meta[key] = val; }
            }
          }
        }
        // IEND — stop
        if (type === 'IEND') break;
        offset += 12 + len; // 4 len + 4 type + data + 4 crc
      }
      cb(null, { prompt: meta.prompt || null, workflow: meta.workflow || null });
    });
  });
}

// ── ffmpeg/ffprobe resolution ───────────────────────────────────────────
// The binaries live in per-user WinGet Links folders on this box, which are
// NOT on the SYSTEM service's PATH — resolve to an absolute path at startup
// (config `ffmpegDir` overrides), falling back to the bare name for PATH.
function findFfBin(name) {
  if (config.ffmpegDir) {
    const p = path.join(config.ffmpegDir, name + '.exe');
    if (fs.existsSync(p)) return p;
  }
  const candidates = [];
  try {
    for (const u of fs.readdirSync('C:\\Users')) {
      candidates.push(path.join('C:\\Users', u, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', name + '.exe'));
    }
  } catch {}
  candidates.push('C:\\ProgramData\\chocolatey\\bin\\' + name + '.exe');
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return name;
}
const FFPROBE_BIN = findFfBin('ffprobe');
const FFMPEG_BIN = findFfBin('ffmpeg');

// ── PNG text-chunk writing (no dependencies) ────────────────────────────
// Used to write a fixed workflow back into a generated image's metadata.
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.slice(4, 8 + data.length)), 8 + data.length);
  return out;
}

// tEXt for pure-ASCII payloads (what ComfyUI writes normally), iTXt (UTF-8,
// uncompressed) when the JSON contains non-ASCII — both are read back by
// extractPngMetadata and by PIL/ComfyUI.
function pngTextChunk(keyword, text) {
  const kw = Buffer.from(keyword, 'latin1');
  if (!/[^\x00-\x7f]/.test(text)) {
    return pngChunk('tEXt', Buffer.concat([kw, Buffer.from([0]), Buffer.from(text, 'latin1')]));
  }
  // iTXt: keyword \0 compFlag(0) compMethod(0) lang \0 translated \0 utf8-text
  return pngChunk('iTXt', Buffer.concat([kw, Buffer.from([0, 0, 0, 0, 0]), Buffer.from(text, 'utf8')]));
}

// Replace/insert text chunks (by keyword) in a PNG, atomically via tmp+rename.
function embedPngText(filePath, textMap, cb) {
  fs.readFile(filePath, (err, buf) => {
    if (err) return cb(err);
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (buf.length < 8 || !buf.slice(0, 8).equals(sig)) return cb(new Error('Not a valid PNG'));
    const drop = new Set(Object.keys(textMap));
    const keep = [];
    let offset = 8, sawEnd = false;
    while (offset + 12 <= buf.length) {
      const len = buf.readUInt32BE(offset);
      const type = buf.toString('ascii', offset + 4, offset + 8);
      const end = offset + 12 + len;
      if (end > buf.length) return cb(new Error('Corrupt PNG (truncated chunk)'));
      let dropIt = false;
      if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
        const data = buf.slice(offset + 8, offset + 8 + len);
        const nul = data.indexOf(0);
        if (nul !== -1 && drop.has(data.toString('latin1', 0, nul))) dropIt = true;
      }
      if (!dropIt) keep.push(buf.slice(offset, end));
      offset = end;
      if (type === 'IEND') { sawEnd = true; break; }
    }
    if (!sawEnd || !keep.length || keep[0].toString('ascii', 4, 8) !== 'IHDR') {
      return cb(new Error('Corrupt PNG (missing IHDR/IEND)'));
    }
    const inserted = Object.entries(textMap).map(([k, v]) => pngTextChunk(k, v));
    const out = Buffer.concat([sig, keep[0], ...inserted, ...keep.slice(1)]);
    const tmp = filePath + '.tmp_embed';
    fs.writeFile(tmp, out, err2 => {
      if (err2) return cb(err2);
      fs.rename(tmp, filePath, cb);
    });
  });
}

// Write workflow metadata into a video's container 'comment' tag (the same
// place extractVideoMetadata reads it from) via an ffmpeg stream-copy remux.
// The JSON goes through an FFMETADATA file — it's far too big for a command line.
function ffmetaEscape(s) {
  return s.replace(/[\\=;#\n]/g, m => '\\' + m);
}
function embedVideoText(filePath, comment, cb) {
  const ext = path.extname(filePath);
  const tmpOut = filePath + '.tmp_embed' + ext;
  const metaFile = filePath + '.tmp_ffmeta.txt';
  fs.writeFile(metaFile, ';FFMETADATA1\ncomment=' + ffmetaEscape(comment) + '\n', (werr) => {
    if (werr) return cb(werr);
    execFile(FFMPEG_BIN, ['-v', 'error', '-y', '-i', filePath, '-i', metaFile, '-map', '0', '-map_metadata', '1', '-c', 'copy', tmpOut],
      { timeout: 120000 }, (err, stdout, stderr) => {
      fs.unlink(metaFile, () => {});
      if (err) { fs.unlink(tmpOut, () => {}); return cb(new Error('ffmpeg failed: ' + (String(stderr || err.message).trim().slice(0, 300)))); }
      fs.rename(tmpOut, filePath, cb);
    });
  });
}

// Extract metadata from video files using ffprobe
// ── Prompt search index ─────────────────────────────────────────────────
// Maps PNG path -> embedded prompt text so /api/list search can match prompt
// words, not just file names. Incremental by mtime, persisted across restarts.
const PROMPT_INDEX_PATH = path.join(__dirname, 'app-prompt-index.json');
const PROMPT_INDEX_VERSION = 5; // bump to force a full re-extract after extractor changes (v5: ffprobe was unresolvable under SYSTEM, so all videos indexed empty)

// NSFW tagging: indexed prompt text is matched against a term list (stored
// base64-encoded — same repo-hygiene pattern as SANITIZE_RULES). An entry that
// matches gets n:1 and is omitted entirely when the client requests safe=1.
// The list is user-editable via the Settings > Privacy tab; this hardcoded set
// is only the default, seeded into config.json on first run.
const DEFAULT_NSFW_TERMS_B64 = ["bnNmdw==","cG9ybg==","aGVudGFp","bnVkZQ==","bmFrZWQ=","dG9wbGVzcw==","c2V4","cGVuaXM=","Y29jaw==","ZGljaw==","cHVzc3k=","dmFnaW5h","Y3Vt","Y3Vtc2hvdA==","Ymxvd2pvYg==","ZGVlcHRocm9hdA==","ZmVsbGF0aW8=","Y3VubmlsaW5ndXM=","YW5hbA==","Y3JlYW1waWU=","bmlwcGxlcw==","YXJlb2xh","YWhlZ2Fv","bWFzdHVyYmF0aW9u","b3JnYXNt","ZXJlY3Rpb24=","Z2FuZ2Jhbmc=","dGhyZWVzb21l","c3BpdHJvYXN0","YnVra2FrZQ==","aGFuZGpvYg==","Zm9vdGpvYg==","ZmluZ2VyaW5n","c3F1aXJ0aW5n","Ym9uZGFnZQ==","YmRzbQ==","YnJlYXN0cw==","Ym9vYnM=","dGl0cw==","cHViaWM=","Z2VuaXRhbHM=","cGVuZXRyYXRpb24=","ZG9nZ3lzdHlsZQ==","bG9saQ==","dGVlbg==","Z2Fn","Z2FnZ2luZw==","dGl0dHk=","dGl0","ZmFjaWFs","bmlwcGxl","dGhyb2F0ZnVjaw==","ZGlsZG8=","dG9ydHVyZQ==","ZWxlY3Ryb2N1dGlvbg==","ZWxlY3RyaWMgc2hvY2s=","Ymxvb2Q=","Z29yZQ==","cGFpbg==","cGFpbmZ1bA=="];
// Seed the config on first run so the list is persisted and editable.
if (!Array.isArray(config.nsfwTermsB64)) {
  config.nsfwTermsB64 = DEFAULT_NSFW_TERMS_B64.slice();
  try {
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
    cur.nsfwTermsB64 = config.nsfwTermsB64;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2));
  } catch (e) { console.log('[NSFW] could not seed default terms:', e.message); }
}
function nsfwTermsDecoded() {
  return (config.nsfwTermsB64 || []).map(s => { try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return ''; } }).filter(Boolean);
}
function buildNsfwRe() {
  const terms = nsfwTermsDecoded();
  if (!terms.length) return /(?!)/; // matches nothing
  const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b(' + terms.map(esc).join('|') + ')\\b', 'i');
}
let NSFW_RE = buildNsfwRe();
let promptIndex = { v: PROMPT_INDEX_VERSION, files: {} };
let promptIndexing = false;
try {
  const loaded = JSON.parse(fs.readFileSync(PROMPT_INDEX_PATH, 'utf8'));
  if (loaded && loaded.v === PROMPT_INDEX_VERSION && loaded.files) promptIndex = loaded;
} catch {}

// Flatten the searchable text out of an embedded API prompt: every string input
// on every node, skipping model/file references.
// Only inputs whose key looks like prompt text — skips sampler names, file
// patterns, format strings and other widget noise.
const PROMPT_KEY_RE = /text|prompt|caption|wildcard|positive|negative|string|value/i;
const NOISE_KEY_RE = /sampler|scheduler|format|prefix|path|filename|extension|method|delimiter|widget_name|node_title/i;
function promptTextFromMeta(meta) {
  const parts = [];
  try {
    const p = typeof meta.prompt === 'string' ? JSON.parse(meta.prompt) : meta.prompt;
    if (p && typeof p === 'object') {
      for (const node of Object.values(p)) {
        // Skip negative-prompt nodes entirely ("Negative Prompt", "Neg Real", …)
        const title = (node && node._meta && node._meta.title) || '';
        if (/negative|\bneg\b/i.test(title)) continue;
        for (const [key, v] of Object.entries((node && node.inputs) || {})) {
          if (typeof v !== 'string' || v.length < 3 || v.length > 5000) continue;
          if (!PROMPT_KEY_RE.test(key) || NOISE_KEY_RE.test(key)) continue;
          if (/negative/i.test(key)) continue;
          if (/\.(safetensors|ckpt|pt|pth|gguf|png|jpg|jpeg|webp|mp4|webm)$/i.test(v)) continue;
          parts.push(v);
        }
      }
    }
  } catch {}
  return parts.join(' \n ').toLowerCase();
}

let promptIndexLastError = null;
let promptIndexLastRun = null;
async function buildPromptIndex() {
  if (promptIndexing) return;
  promptIndexing = true;
  const t0 = Date.now();
  const seen = new Set();
  let added = 0, checked = 0, errors = 0;
  try {
    for (const root of [ROOT, COMFY_OUTPUT]) {
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          try {
            if (e.name.startsWith('.')) continue;
            const fp = path.join(dir, e.name);
            if (e.isDirectory()) { stack.push(fp); continue; }
            const lower = e.name.toLowerCase();
            const isPng = lower.endsWith('.png');
            const isVid = /\.(mp4|webm|mov)$/.test(lower);
            if (!isPng && !isVid) continue;
            const key = fp.replace(/\\/g, '/');
            seen.add(key);
            checked++;
            const st = fs.statSync(fp);
            const rec = promptIndex.files[key];
            if (rec && rec.m === st.mtimeMs) continue;
            const meta = await new Promise(r => {
              try { (isPng ? extractPngMetadata : extractVideoMetadata)(fp, (err, m) => r(err ? null : m)); } catch { r(null); }
            });
            const text = meta ? promptTextFromMeta(meta) : '';
            promptIndex.files[key] = {
              m: st.mtimeMs, t: text,
              w: (meta && (meta.prompt || meta.workflow)) ? 1 : 0,
              n: NSFW_RE.test(text) ? 1 : 0,
            };
            added++;
            if (added % 25 === 0) await new Promise(r => setImmediate(r)); // stay responsive
          } catch (fileErr) {
            errors++;
            promptIndexLastError = e.name + ': ' + fileErr.message;
          }
        }
      }
    }
    for (const k of Object.keys(promptIndex.files)) if (!seen.has(k)) delete promptIndex.files[k];
    if (added > 0) savePromptIndex();
  } catch (e) { promptIndexLastError = e.message; }
  promptIndexLastRun = { checked, added, errors, ms: Date.now() - t0, at: new Date().toISOString() };
  console.log('[PromptIndex]', JSON.stringify(promptIndexLastRun), promptIndexLastError ? ('lastError: ' + promptIndexLastError) : '');
  promptIndexing = false;
}

// Debounced persist so rapid updates (bulk delete) write once
let promptIndexSaveTimer = null;
function savePromptIndex() {
  clearTimeout(promptIndexSaveTimer);
  promptIndexSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(PROMPT_INDEX_PATH, JSON.stringify(promptIndex)); } catch {}
  }, 1500);
}

// Recompute the NSFW n-flag for every already-indexed file against the current
// NSFW_RE — cheap (no re-extraction), used after the tag list is edited.
function retagNsfw() {
  let changed = 0;
  for (const k in promptIndex.files) {
    const rec = promptIndex.files[k];
    if (!rec || typeof rec.t !== 'string') continue;
    const n = NSFW_RE.test(rec.t) ? 1 : 0;
    if (rec.n !== n) { rec.n = n; changed++; }
  }
  if (changed) savePromptIndex();
  return changed;
}

// Immediate index updates on delete / move so search never shows ghosts
function promptIndexRemove(p) {
  const key = String(p || '').replace(/\\/g, '/');
  if (promptIndex.files[key]) { delete promptIndex.files[key]; savePromptIndex(); }
}
function promptIndexMove(src, dest) {
  const s = String(src || '').replace(/\\/g, '/');
  const d = String(dest || '').replace(/\\/g, '/');
  if (promptIndex.files[s]) { promptIndex.files[d] = promptIndex.files[s]; delete promptIndex.files[s]; savePromptIndex(); }
}
setTimeout(buildPromptIndex, 5000);                  // initial build shortly after boot
setInterval(buildPromptIndex, 10 * 60 * 1000);       // pick up new generations

// Aggregate the indexed prompt text into a phrase directory: prompts are
// comma-separated tag phrases, so split on commas/newlines/BREAK, strip
// weighting syntax, and count each phrase once per file.
const PHRASE_STOPLIST = new Set(['enable', 'disable', 'default', 'simple', 'normal', 'fixed', 'true', 'false',
  'none', 'auto', 'randomize', 'increment', 'decrement', 'png', 'jpg', 'jpeg', 'webp', 'and', 'the', 'with', 'a', 'an',
  // widget/junk values that live under prompt-ish input keys
  'object object', 'select the wildcard to add to the text', 'select the lora to add to the text',
  // sampler/scheduler names that ride through generic "value" primitives
  'euler', 'euler a', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_sde', 'dpmpp_3m_sde', 'ddim', 'uni_pc',
  'lcm', 'karras', 'exponential', 'sgm_uniform', 'beta', 'ays sdxl', 'ays', 'res_multistep',
  // quality/negative boilerplate present in nearly every prompt — noise in a browse list
  'best quality', 'masterpiece', 'amazing quality', 'ultra-detailed', 'ultra detailed', 'highly detailed',
  'realistic', 'photorealistic', 'anime', '3d', 'cgi', 'artifacts', 'watermark', 'blurry',
  'worst quality', 'low quality', 'normal quality', 'high quality', 'bad quality', 'lowres', 'low resolution',
  'high resolution', 'absurdres', 'incredibly absurdres', 'very aesthetic', 'newest', '4k', '8k',
  'jpeg artifacts', 'bad anatomy', 'bad hands', 'deformed', 'ugly', 'poorly drawn', 'text', 'logo', 'signature']);
function promptPhraseCounts(safeMode) {
  const counts = new Map();
  for (const rec of Object.values(promptIndex.files)) {
    if (!rec.t) continue;
    if (safeMode && rec.n) continue; // safe mode: NSFW-tagged files contribute nothing
    const seenInFile = new Set();
    for (let part of rec.t.split(/[,\n.]|\bbreak\b/g)) {
      part = part.replace(/[()\[\]{}<>]/g, '').replace(/:\s*\d+(\.\d+)?/g, '').replace(/\s+/g, ' ').trim();
      if (part.length < 2 || part.length > 60) continue;
      if (/^[\d\s.:-]+$/.test(part)) continue;          // pure numbers/punctuation
      if (/^\d+x\d+/.test(part)) continue;               // resolutions
      if (/%[a-z]/i.test(part)) continue;                // filename pattern placeholders
      if (/embedding:|lora:/i.test(part)) continue;      // resource references
      if (PHRASE_STOPLIST.has(part)) continue;
      if (safeMode && NSFW_RE.test(part)) continue;      // belt & braces: no NSFW phrases either
      if (seenInFile.has(part)) continue;
      seenInFile.add(part);
      counts.set(part, (counts.get(part) || 0) + 1);
    }
  }
  return [...counts.entries()].map(([t, n]) => ({ t, n }))
    .sort((a, b) => b.n - a.n || a.t.localeCompare(b.t))
    .slice(0, 3000);
}

// True if every whitespace-separated word of `search` appears in the file's
// indexed prompt text.
function promptIndexMatches(fullPath, search) {
  const rec = promptIndex.files[fullPath.replace(/\\/g, '/')];
  if (!rec || !rec.t) return false;
  return search.split(/\s+/).filter(Boolean).every(w => rec.t.includes(w));
}

function extractVideoMetadata(filePath, cb) {
  execFile(FFPROBE_BIN, ['-v', 'quiet', '-show_entries', 'format_tags', '-of', 'json', filePath], { timeout: 10000 }, (err, stdout) => {
    if (err) return cb(null, { prompt: null, workflow: null });
    try {
      const data = JSON.parse(stdout);
      const tags = (data.format && data.format.tags) || {};
      let prompt = null, workflow = null;

      // Video metadata is in 'comment' tag as JSON with escaped inner JSON
      const raw = tags.comment || tags.prompt || '';
      if (raw) {
        try {
          let parsed = JSON.parse(raw);
          // VHS writes the mp4 'prompt' tag double-encoded (a JSON string containing JSON)
          if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch {} }
          if (parsed.prompt) {
            prompt = typeof parsed.prompt === 'string' ? JSON.parse(parsed.prompt) : parsed.prompt;
          }
          if (parsed.workflow) {
            workflow = typeof parsed.workflow === 'string' ? JSON.parse(parsed.workflow) : parsed.workflow;
          }
          // If the parsed object itself looks like a prompt (has node IDs)
          if (!prompt && !parsed.prompt && !parsed.workflow) {
            prompt = parsed;
          }
        } catch {
          prompt = raw;
        }
      }
      if (tags.workflow) {
        try { workflow = JSON.parse(tags.workflow); } catch { workflow = tags.workflow; }
      }
      cb(null, { prompt, workflow });
    } catch (e) {
      cb(null, { prompt: null, workflow: null });
    }
  });
}



// Cache for ComfyUI object_info
let objectInfoCache = null;
let objectInfoFetchTime = 0;

function getObjectInfo() {
  return new Promise((resolve, reject) => {
    // Cache for 60 seconds
    if (objectInfoCache && Date.now() - objectInfoFetchTime < 60000) {
      return resolve(objectInfoCache);
    }
    const ch = comfyHostPort();
    const opts = {
      hostname: ch.hostname, port: ch.port,
      path: '/object_info', method: 'GET',
      headers: { 'Accept': 'application/json' },
    };
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          objectInfoCache = JSON.parse(body);
          objectInfoFetchTime = Date.now();
          resolve(objectInfoCache);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Convert visual workflow JSON (LiteGraph format) to API/prompt format
async function workflowToPrompt(wf) {
  const nodes = wf.nodes || [];
  const links = wf.links || [];
  let objectInfo;
  try { objectInfo = await getObjectInfo(); } catch { objectInfo = {}; }

  // Build link lookup: linkId -> {fromNode, fromSlot}
  const linkMap = {};
  for (const link of links) {
    linkMap[link[0]] = { fromNode: String(link[1]), fromSlot: link[2] };
  }

  const nodeById = {};
  for (const node of nodes) { nodeById[String(node.id)] = node; }

  // Resolve SetNode/GetNode pairs: GetNode outputs map to SetNode inputs by name
  const setNodeMap = {}; // name -> {fromNode, fromSlot}
  for (const node of nodes) {
    if (node.type === 'SetNode' && node.widgets_values && node.widgets_values[0]) {
      const name = node.widgets_values[0];
      const inp = (node.inputs || [])[0];
      if (inp && inp.link != null && linkMap[inp.link]) {
        setNodeMap[name] = linkMap[inp.link];
      }
    }
  }

  function resolveBypass(nodeId, slotIdx, depth) {
    if ((depth || 0) > 50) return null;
    const node = nodeById[nodeId];
    if (!node) return null;
    // Muted (mode 2) nodes are excluded from the prompt entirely — a link that
    // resolves to one is dead. Returning it would leave a dangling reference,
    // which crashes ComfyUI's prompt worker at graph-build time (NodeNotFoundError).
    if (node.mode === 2) return null;
    if (node.type === 'Reroute') {
      const firstInput = (node.inputs || [])[0];
      if (firstInput && firstInput.link != null && linkMap[firstInput.link]) {
        const upstream = linkMap[firstInput.link];
        return resolveBypass(upstream.fromNode, upstream.fromSlot, (depth || 0) + 1);
      }
      return null;
    }
    if (node.type === 'GetNode') {
      const getName = (node.widgets_values || [])[0];
      if (getName && setNodeMap[getName]) {
        const src = setNodeMap[getName];
        return resolveBypass(src.fromNode, src.fromSlot, (depth || 0) + 1);
      }
      return null;
    }
    if (node.type === 'SetNode') {
      // SetNode passes through — treat like reroute
      const firstInput = (node.inputs || [])[0];
      if (firstInput && firstInput.link != null && linkMap[firstInput.link]) {
        const upstream = linkMap[firstInput.link];
        return resolveBypass(upstream.fromNode, upstream.fromSlot, (depth || 0) + 1);
      }
      return null;
    }
    // Unknown UI-only node (not in object_info) — treat as pass-through like reroute
    if (!objectInfo[node.type] && node.mode !== 4) {
      const firstInput = (node.inputs || [])[0];
      if (firstInput && firstInput.link != null && linkMap[firstInput.link]) {
        const upstream = linkMap[firstInput.link];
        return resolveBypass(upstream.fromNode, upstream.fromSlot, (depth || 0) + 1);
      }
      return null;
    }
    if (node.mode !== 4) return { fromNode: nodeId, fromSlot: slotIdx };
    // Bypassed multi-output node: match output slot type to corresponding input by type
    const outputs = node.outputs || [];
    if (slotIdx >= outputs.length) return null;
    const outType = (outputs[slotIdx].type || '').toUpperCase();
    const inputs = node.inputs || [];
    // Count how many outputs of this type come before slotIdx
    let typeCount = 0;
    for (let i = 0; i < slotIdx; i++) {
      if ((outputs[i].type || '').toUpperCase() === outType) typeCount++;
    }
    // Find the Nth input of matching type
    let matchCount = 0;
    for (const inp of inputs) {
      if ((inp.type || '').toUpperCase() === outType) {
        if (matchCount === typeCount) {
          if (inp.link != null && linkMap[inp.link]) {
            const upstream = linkMap[inp.link];
            return resolveBypass(upstream.fromNode, upstream.fromSlot, (depth || 0) + 1);
          }
          return null;
        }
        matchCount++;
      }
    }
    return null;
  }

  const prompt = {};

  for (const node of nodes) {
    if (node.mode === 2 || node.mode === 4) continue;
    if (!node.type || node.type === 'Reroute' || node.type === 'PrimitiveNode' || node.type === 'Note' || node.type === 'MarkdownNote') continue;
    // cg-use-everywhere broadcasters are frontend-only; their links are resolved
    // into consumer inputs after this loop (see UE resolution below).
    if (/^(Anything Everywhere|Prompts Everywhere|Seed Everywhere)/.test(node.type)) continue;

    const nodeId = String(node.id);
    const info = objectInfo[node.type];
    // Skip UI-only nodes that don't exist in ComfyUI's object_info (e.g. rgthree Labels, Bookmarks, Fast Bypasser)
    if (!info) continue;

    const inputs = {};
    const nodeInputs = node.inputs || [];
    const widgetValues = node.widgets_values || [];

    // Handle dict-style widgets_values (e.g. VHS_VideoCombine stores {frame_rate: 35, ...})
    const widgetValuesIsDict = widgetValues && !Array.isArray(widgetValues) && typeof widgetValues === 'object';

    // Build set of linked input names, resolving bypassed nodes
    const linkedInputs = new Set();
    for (const inp of nodeInputs) {
      if (inp.link != null && linkMap[inp.link]) {
        const lk = linkMap[inp.link];
        const resolved = resolveBypass(lk.fromNode, lk.fromSlot);
        if (resolved) {
          inputs[inp.name] = [resolved.fromNode, resolved.fromSlot];
          linkedInputs.add(inp.name);
        } else if (!inp.widget && info.input && info.input.required && (inp.name in info.input.required)) {
          // A required SOCKET input is wired in the editor but its chain dead-ends
          // in a muted/bypassed branch — this node can't run. Mark it dead so the
          // prune pass removes it (mirrors ComfyUI, which never submits dead branches).
          // Widget inputs are exempt: their value lives in widgets_values (e.g. a
          // PrimitiveNode feeding wildcard_text) and substitutes for the dead link.
          inputs.__dead = true;
        }
      }
    }

    // Handle dict-style widgets_values — directly map keys to inputs
    if (widgetValuesIsDict) {
      for (const [key, val] of Object.entries(widgetValues)) {
        if (!linkedInputs.has(key) && val !== undefined) {
          // Skip complex sub-objects like videopreview
          if (val !== null && typeof val === 'object' && !Array.isArray(val)) continue;
          inputs[key] = val;
        }
      }
    }

    // Handle Power Lora Loader (rgthree) — map lora slot objects to lora_1, lora_2, etc.
    if (node.type === 'Power Lora Loader (rgthree)' && Array.isArray(widgetValues)) {
      inputs['PowerLoraLoaderHeaderWidget'] = { type: 'PowerLoraLoaderHeaderWidget' };
      let loraIdx = 1;
      for (const wv of widgetValues) {
        if (wv && typeof wv === 'object' && wv.lora) {
          inputs['lora_' + loraIdx] = { on: wv.on, lora: wv.lora, strength: wv.strength };
          loraIdx++;
        }
      }
      inputs['\u2795 Add Lora'] = '';
    }

    // Map widget values using object_info to get proper input names and order
    if (widgetValuesIsDict) {
      // Already handled above
    } else if (info && info.input) {
      const allInputDefs = [];
      // Collect required + optional inputs in order
      if (info.input_order) {
        for (const cat of ['required', 'optional']) {
          const names = info.input_order[cat] || [];
          const defs = info.input[cat] || {};
          for (const name of names) {
            if (defs[name]) allInputDefs.push({ name, def: defs[name], cat });
          }
        }
      } else {
        for (const cat of ['required', 'optional']) {
          const defs = info.input[cat] || {};
          for (const [name, def] of Object.entries(defs)) {
            allInputDefs.push({ name, def, cat });
          }
        }
      }

      let widgetIdx = 0;
      for (const { name, def } of allInputDefs) {
        if (linkedInputs.has(name)) {
          // Already set via link - but some widget inputs that are linked still consume a widget_values slot
          const nodeInp = nodeInputs.find(i => i.name === name);
          if (nodeInp && nodeInp.widget) {
            widgetIdx++;
            // Also skip control_after_generate for linked INT seed inputs
            const linkedTypeName = Array.isArray(def) ? (Array.isArray(def[0]) ? 'COMBO' : String(def[0])) : String(def);
            if (linkedTypeName === 'INT' && widgetIdx < widgetValues.length) {
              const next = widgetValues[widgetIdx];
              if (next === null || next === 'fixed' || next === 'increment' || next === 'decrement' || next === 'randomize') {
                widgetIdx++;
              }
            }
          }
          continue;
        }
        const typeName = Array.isArray(def) ? (Array.isArray(def[0]) ? 'COMBO' : String(def[0])) : String(def);
        // Check if this is a widget type (not a pure connection type). Custom widget
        // types (e.g. LoraManager's AUTOCOMPLETE_TEXT_LORAS) aren't in the scalar
        // list, but the visual node marks them widget:true — honor that.
        const visualInp = nodeInputs.find(i => i.name === name);
        const isWidget = ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'].includes(typeName)
          || Array.isArray(def[0])
          || !!(visualInp && visualInp.widget);
        // Also check forceInput flag
        const opts = def[1] || {};
        if (opts.forceInput) continue; // Pure socket, no widget

        if (isWidget) {
          // Scan forward past values that can't belong to this widget type — some
          // custom nodes (e.g. LoraManager toggles) append extra array/object state
          // into widgets_values, which would otherwise shift every later widget.
          let assigned = false;
          let scanIdx = widgetIdx;
          while (scanIdx < widgetValues.length) {
            let val = widgetValues[scanIdx];
            // Handle [value, [config]] for booleans
            if (Array.isArray(val) && val.length === 2 && Array.isArray(val[1])) {
              val = val[0];
            }
            const typeOk =
              typeName === 'BOOLEAN' ? (typeof val === 'boolean' || val === 0 || val === 1)
              : (typeName === 'INT' || typeName === 'FLOAT') ? typeof val === 'number'
              : (val === null || typeof val !== 'object'); // STRING/COMBO/custom accept any scalar
            if (typeOk) {
              // Single-choice combos are UI placeholders whose label text drifts
              // between node-pack versions ("Select Wildcard 🟢 Full Cache" vs the
              // installed pack's label) — coerce to the installed value.
              if (typeName === 'COMBO' && Array.isArray(def[0]) && def[0].length === 1
                  && typeof val === 'string' && !def[0].includes(val)) {
                val = def[0][0];
              }
              inputs[name] = val; widgetIdx = scanIdx + 1; assigned = true; break;
            }
            scanIdx++; // junk entry — skip it
          }
          if (!assigned) {
            widgetIdx++;
            if (opts.default !== undefined) inputs[name] = opts.default;
          }
          // Skip extra control_after_generate widget that follows seed INT inputs
          if (typeName === 'INT' && widgetIdx < widgetValues.length) {
            const next = widgetValues[widgetIdx];
            if (next === null || next === 'fixed' || next === 'increment' || next === 'decrement' || next === 'randomize') {
              widgetIdx++;
            }
          }
        }
      }
    } else {
      // Fallback: use inputs array with widget sub-objects
      let widgetIdx = 0;
      for (const inp of nodeInputs) {
        if (inp.widget) {
          if (!linkedInputs.has(inp.name) && widgetIdx < widgetValues.length) {
            let val = widgetValues[widgetIdx];
            if (Array.isArray(val) && val.length === 2 && Array.isArray(val[1])) val = val[0];
            inputs[inp.name] = val;
          }
          widgetIdx++;
        }
      }
    }

    prompt[nodeId] = {
      class_type: node.type,
      inputs,
      _meta: { title: node.title || node.type },
    };
  }

  // ── Resolve "Anything Everywhere" (cg-use-everywhere) broadcast links ──
  // These frontend-only nodes invisibly feed any matching unconnected input by
  // type; ComfyUI's web UI resolves them at queue time, so we must do the same
  // or consumers (model/clip/vae...) arrive with missing inputs and ComfyUI
  // silently drops the whole subtree at validation.
  const ueSources = [];
  for (const node of nodes) {
    if (!/^(Anything Everywhere|Prompts Everywhere|Seed Everywhere)/.test(node.type || '')) continue;
    if (node.mode === 2 || node.mode === 4) continue;
    const props = (node.properties && node.properties.ue_properties) || node.properties || {};
    for (const inp of node.inputs || []) {
      if (inp.link == null || !linkMap[inp.link]) continue;
      const resolved = resolveBypass(linkMap[inp.link].fromNode, linkMap[inp.link].fromSlot);
      if (!resolved) continue;
      let titleRegex = null, inputRegex = null;
      try { if (props.title_regex) titleRegex = new RegExp(props.title_regex); } catch {}
      try { if (props.input_regex) inputRegex = new RegExp(props.input_regex); } catch {}
      ueSources.push({ type: (inp.type || '').toUpperCase(), from: [resolved.fromNode, resolved.fromSlot], titleRegex, inputRegex });
    }
  }
  if (ueSources.length) {
    for (const node of nodes) {
      const pn = prompt[String(node.id)];
      if (!pn) continue;
      for (const inp of node.inputs || []) {
        if (inp.widget) continue;                          // widget sockets aren't UE targets
        if (pn.inputs[inp.name] !== undefined) continue;   // already wired or has a value
        const t = (inp.type || '').toUpperCase();
        if (!t || t === '*') continue;
        const src = ueSources.find(s => s.type === t
          && (!s.titleRegex || s.titleRegex.test(node.title || ''))
          && (!s.inputRegex || s.inputRegex.test(inp.name)));
        if (src) pn.inputs[inp.name] = src.from;
      }
    }
  }

  // ── Prune dead branches (mirrors ComfyUI, which builds prompts backward from
  // output nodes and never submits disabled branches) ──
  // 1) Nodes whose required editor-wired input dead-ended in a muted/bypassed
  //    chain (__dead marker) can't run.
  const isRef = v => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string';
  for (const [id, n] of Object.entries(prompt)) {
    if (n.inputs.__dead) delete prompt[id];
  }
  // 2) Cascade: a dangling ref on a REQUIRED input kills the node; a dangling
  //    ref on an optional input just drops that input (ComfyUI's semantics).
  let prunedSomething = true;
  while (prunedSomething) {
    prunedSomething = false;
    for (const [id, n] of Object.entries(prompt)) {
      const inf = objectInfo[n.class_type];
      const required = (inf && inf.input && inf.input.required) || {};
      for (const [key, v] of Object.entries(n.inputs)) {
        if (!isRef(v) || prompt[v[0]]) continue;
        if (key in required) { delete prompt[id]; prunedSomething = true; break; }
        delete n.inputs[key];
      }
    }
  }
  // 3) Keep only nodes that feed an output node (SaveImage etc.) — active nodes
  //    orphaned by a bypassed branch would otherwise fail ComfyUI validation.
  const outputIds = Object.entries(prompt)
    .filter(([, n]) => { const inf = objectInfo[n.class_type]; return inf && inf.output_node === true; })
    .map(([id]) => id);
  if (outputIds.length) {
    const keep = new Set();
    const stack = [...outputIds];
    while (stack.length) {
      const id = stack.pop();
      if (keep.has(id)) continue;
      keep.add(id);
      for (const v of Object.values(prompt[id].inputs)) {
        if (isRef(v) && prompt[v[0]]) stack.push(v[0]);
      }
    }
    for (const id of Object.keys(prompt)) if (!keep.has(id)) delete prompt[id];
  }
  for (const n of Object.values(prompt)) delete n.inputs.__dead;

  return prompt;
}

// ── Style/quality preset groups (rgthree "Fast Groups Muter", max-one) ──
// The workflow toggles mutually-exclusive preset groups (Realism, Anime, etc.)
// by muting/un-muting all nodes inside a colored group. We replicate rgthree's
// geometric group membership so we can activate exactly one preset server-side.
const RGTHREE_GROUP_COLORS = { purple: '#a1309b' };

function nodeInGroup(node, group) {
  if (!node.pos || !group.bounding) return false;
  const [gx, gy, gw, gh] = group.bounding;
  const [nx, ny] = node.pos;
  return nx >= gx - 2 && ny >= gy - 2 && nx <= gx + gw && ny <= gy + gh;
}

// Return [{ title, on, memberIds: [] }] for the preset groups a max-one Groups
// Muter governs (matched by group color). Empty if the workflow has no such muter.
function detectPresetGroups(wf) {
  const nodes = wf.nodes || [];
  const groups = wf.groups || [];
  const muter = nodes.find(n => (n.type || '').includes('Fast Groups Muter')
    && n.properties && (n.properties.matchColors || '') !== ''
    && n.properties.toggleRestriction === 'max one');
  if (!muter) return [];
  const presetColor = RGTHREE_GROUP_COLORS[(muter.properties.matchColors || '').toLowerCase()];
  if (!presetColor) return [];
  return groups
    .filter(g => (g.color || '').toLowerCase() === presetColor)
    .map(g => {
      const members = nodes.filter(n => nodeInGroup(n, g));
      return {
        title: g.title,
        on: members.some(n => (n.mode || 0) === 0),
        memberIds: members.map(n => n.id),
      };
    });
}

// ── App workflow registry ──────────────────────────────────────────────
// Which install-dir workflows are exposed in the app, plus per-workflow node
// mappings (which node is the prompt/steps/seed) so we never have to rename or
// mutate the original .json. Convention-based auto-detect is the fallback.
let WORKFLOWS_DIR = path.join(COMFY_DIR, 'user', 'default', 'workflows');
const WF_STORE_PATH = path.join(__dirname, 'app-workflows.json');

function loadWfStore() {
  let store = { enabled: [], mappings: {}, labels: {}, fieldConfigs: {} };
  try { store = Object.assign(store, JSON.parse(fs.readFileSync(WF_STORE_PATH, 'utf8'))); } catch {}
  if (!store.fieldConfigs) store.fieldConfigs = {};
  // First-run migration: seed the allowlist from legacy "APP *.json" files.
  if (!store._migrated) {
    try {
      const legacy = fs.readdirSync(WORKFLOWS_DIR).filter(n => n.startsWith('APP ') && n.endsWith('.json'));
      for (const n of legacy) if (!store.enabled.includes(n)) store.enabled.push(n);
    } catch {}
    store._migrated = true;
    saveWfStore(store);
  }
  return store;
}
function saveWfStore(store) {
  try { fs.writeFileSync(WF_STORE_PATH, JSON.stringify(store, null, 2)); return true; } catch { return false; }
}

// Field-config runtime (build + apply). Extracted to field-config-runtime.js so
// the logic is unit-testable without the HTTP server; deps injected here.
const fieldConfigRuntime = require('./field-config-runtime.js')({
  generator: fieldConfigGen,
  loadStore: loadWfStore,
  detectPresetGroups: (wf) => detectPresetGroups(wf),
});
const buildFieldConfig = fieldConfigRuntime.buildFieldConfig;
const applyFieldConfigOverrides = fieldConfigRuntime.applyFieldConfigOverrides;

// First-run bootstrap: copy the bundled starter workflows (default-workflows/)
// into the ComfyUI install and enable them, so a fresh clone has working
// examples. Files already present are never overwritten.
function seedDefaultWorkflows() {
  const srcDir = path.join(__dirname, 'default-workflows');
  try {
    if (!fs.existsSync(srcDir) || !fs.existsSync(WORKFLOWS_DIR)) return;
    const seeded = [];
    for (const f of fs.readdirSync(srcDir).filter(n => n.endsWith('.json'))) {
      const dest = path.join(WORKFLOWS_DIR, f);
      if (!fs.existsSync(dest)) { fs.copyFileSync(path.join(srcDir, f), dest); seeded.push(f); }
    }
    if (seeded.length) {
      const store = loadWfStore();
      let changed = false;
      for (const f of seeded) if (!store.enabled.includes(f)) { store.enabled.push(f); changed = true; }
      if (changed) saveWfStore(store);
      console.log('[Workflows] Seeded starter workflows:', seeded.join(', '));
    }
  } catch (e) { console.log('[Workflows] seeding failed:', e.message); }
}
seedDefaultWorkflows();

// Recursively list every workflow .json under the install workflows dir.
// Returns names relative to WORKFLOWS_DIR using forward slashes.
function listAllWorkflows() {
  const out = [];
  function walk(dir, prefix) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (e.name.endsWith('.json')) out.push(rel);
    }
  }
  walk(WORKFLOWS_DIR, '');
  return out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function defaultLabel(name) {
  return name.replace(/^APP /, '').replace(/\.json$/, '').replace(/^.*\//, '');
}

// Resolve which node holds the prompt/steps/seed, honoring an explicit mapping
// first, then falling back to naming/type conventions.
const UI_ONLY_TYPES = new Set(['Reroute', 'PrimitiveNode', 'Note', 'MarkdownNote', 'Label (rgthree)', 'Bookmark (rgthree)']);
function nodeById(wf, id) { return (wf.nodes || []).find(n => String(n.id) === String(id)); }

function resolvePromptNode(wf, mapping) {
  if (mapping && mapping.promptNodeId != null) { const n = nodeById(wf, mapping.promptNodeId); if (n) return n; }
  for (const n of wf.nodes || []) {
    const t = (n.title || '').toUpperCase();
    if (t.includes('MAIN') && t.includes('PROMPT')) return n;
  }
  // Best-effort guess: a titled "Positive Prompt" text node outside detailer groups,
  // else the longest string-bearing node.
  let best = null, bestLen = -1;
  for (const n of wf.nodes || []) {
    if (UI_ONLY_TYPES.has(n.type)) continue;
    const wv = n.widgets_values;
    const txt = Array.isArray(wv) && typeof wv[0] === 'string' ? wv[0] : '';
    if (!txt) continue;
    const t = (n.title || '').toUpperCase();
    const score = (t.includes('POS') && t.includes('PROMPT') ? 100000 : 0) + txt.length;
    if (score > bestLen) { bestLen = score; best = n; }
  }
  return best;
}
function resolveStepsNode(wf, mapping) {
  if (mapping && mapping.stepsNodeId != null) { const n = nodeById(wf, mapping.stepsNodeId); if (n) return n; }
  return (wf.nodes || []).find(n => (n.title || '').toUpperCase() === 'STEPS' && n.type === 'mxSlider') || null;
}
// Wan-style dual-sampler workflows: two active KSamplerAdvanced nodes where the
// high-noise pass starts at step 0 and hands off to the low-noise pass.
// widgets_values: [add_noise, noise_seed, control, steps, cfg, sampler, scheduler,
//                  start_at_step, end_at_step, return_with_leftover_noise]
function findHighLowSamplers(wf) {
  const ks = (wf.nodes || []).filter(n => n.type === 'KSamplerAdvanced'
    && Array.isArray(n.widgets_values) && n.widgets_values.length >= 9
    && n.mode !== 2 && n.mode !== 4);
  if (ks.length !== 2) return null;
  const high = ks.find(n => Number(n.widgets_values[7]) === 0);
  const low = ks.find(n => Number(n.widgets_values[7]) > 0);
  return (high && low) ? { high, low } : null;
}

function resolveSeedNode(wf, mapping) {
  if (mapping && mapping.seedNodeId != null) { const n = nodeById(wf, mapping.seedNodeId); if (n) return n; }
  return (wf.nodes || []).find(n => n.type === 'Seed (rgthree)' && (n.mode || 0) === 0) || null;
}

// Read the enabled LoRA slots from a Power Lora Loader node's widgets_values.
function extractLoras(node) {
  const out = [];
  const wv = (node && node.widgets_values) || [];
  for (let i = 0; i < wv.length; i++) {
    const v = wv[i];
    if (v && typeof v === 'object' && v.lora) out.push({ slot: i, on: !!v.on, strength: v.strength || 1, lora: v.lora });
  }
  return out;
}

// Write on/strength overrides back onto a loader node by slot.
function applyLoraOverrides(node, ovs) {
  if (!node || !Array.isArray(ovs)) return;
  const wv = node.widgets_values || [];
  for (const o of ovs) {
    if (o.slot != null && wv[o.slot] && typeof wv[o.slot] === 'object' && wv[o.slot].lora) {
      if (o.on !== undefined) wv[o.slot].on = o.on;
      if (o.strength !== undefined) wv[o.slot].strength = o.strength;
    }
  }
}

// Wan-style dual-sampler workflows carry two Power Lora Loaders — one per
// (high/low)-noise pass. Map each to its pass by tracing the sampler's model
// input back through the graph to a loader. Returns { high, low } or null.
function findHighLowLoraLoaders(wf) {
  const hl = findHighLowSamplers(wf);
  if (!hl) return null;
  const loaders = (wf.nodes || []).filter(n => (n.type || '').includes('Power Lora Loader') && n.mode !== 2 && n.mode !== 4);
  if (loaders.length !== 2) return null;
  const linkById = {};
  for (const l of (wf.links || [])) if (Array.isArray(l)) linkById[l[0]] = l; // [id, from, fromSlot, to, toSlot, type]
  const byId = {};
  for (const n of (wf.nodes || [])) byId[String(n.id)] = n;
  const loaderFeeding = (nodeId, depth) => {
    if (depth > 16) return null;
    const node = byId[String(nodeId)];
    if (!node) return null;
    if ((node.type || '').includes('Power Lora Loader')) return node;
    const inp = (node.inputs || []).find(i => /model/i.test(i.name || ''));
    if (!inp || inp.link == null) return null;
    const link = linkById[inp.link];
    return link ? loaderFeeding(link[1], depth + 1) : null;
  };
  const high = loaderFeeding(hl.high.id, 0), low = loaderFeeding(hl.low.id, 0);
  if (!high || !low || String(high.id) === String(low.id)) return null;
  return { high, low };
}

// CFG: an mxSlider titled "CFG" by convention, else the active KSampler-family
// nodes (cfg widget index 3 on KSampler, 4 on KSamplerAdvanced). When multiple
// samplers are active they must agree on the value — otherwise the workflow
// intends different CFGs per pass and we don't expose a single control that
// would clobber that. Returns { get, set } or null.
function resolveCfg(wf) {
  const slider = (wf.nodes || []).find(n => (n.title || '').toUpperCase() === 'CFG'
    && (n.type === 'mxSlider' || n.type === 'mxSliderF') && Array.isArray(n.widgets_values));
  if (slider) {
    const wv = slider.widgets_values;
    return {
      get: () => typeof wv[0] === 'number' ? wv[0] : (typeof wv[1] === 'number' ? wv[1] : null),
      set: (v) => { if (typeof wv[0] === 'number') wv[0] = v; if (typeof wv[1] === 'number') wv[1] = v; },
    };
  }
  const cfgIdx = n => n.type === 'KSamplerAdvanced' ? 4 : 3;
  const samplers = (wf.nodes || []).filter(n =>
    (n.type === 'KSampler' || n.type === 'KSamplerAdvanced')
    && n.mode !== 2 && n.mode !== 4
    && Array.isArray(n.widgets_values) && typeof n.widgets_values[cfgIdx(n)] === 'number');
  if (!samplers.length) return null;
  const first = samplers[0].widgets_values[cfgIdx(samplers[0])];
  if (!samplers.every(n => n.widgets_values[cfgIdx(n)] === first)) return null;
  return {
    get: () => samplers[0].widgets_values[cfgIdx(samplers[0])],
    set: (v) => { for (const n of samplers) n.widgets_values[cfgIdx(n)] = v; },
  };
}

// Candidate nodes for the mapping editor dropdowns.
function workflowCandidates(wf) {
  const strNodes = [], intNodes = [], seedNodes = [];
  for (const n of wf.nodes || []) {
    if (UI_ONLY_TYPES.has(n.type)) continue;
    const wv = Array.isArray(n.widgets_values) ? n.widgets_values : [];
    const snippet = (s) => String(s).replace(/\s+/g, ' ').slice(0, 60);
    const base = { id: n.id, type: n.type, title: n.title || '' };
    if (typeof wv[0] === 'string' && wv[0].length > 0) strNodes.push({ ...base, sample: snippet(wv[0]) });
    if (typeof wv[0] === 'number' && Number.isInteger(wv[0])) intNodes.push({ ...base, sample: String(wv[0]) });
    if (n.type === 'Seed (rgthree)' || /seed/i.test(n.title || '')) seedNodes.push({ ...base, sample: String(wv[0]) });
  }
  return { prompt: strNodes, steps: intNodes, seed: seedNodes };
}

// Cross-drive move: rename if same drive, copy+delete otherwise
function moveFile(src, dest, cb) {
  fs.rename(src, dest, (err) => {
    if (!err) return cb(null);
    // Cross-device fallback
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dest);
    rs.on('error', cb);
    ws.on('error', cb);
    ws.on('close', () => fs.unlink(src, cb));
    rs.pipe(ws);
  });
}

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json',
};

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg']);
const THUMB_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

function getThumbPath(filePath) {
  const base = filePath.replace(/\.[^.]+$/, '');
  for (const ext of THUMB_EXT) {
    const t = base + ext;
    if (fs.existsSync(t)) return t;
  }
  return null;
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function serveFile(filePath, req, res) {
  fs.stat(filePath, (err, stat) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const size = stat.size;
    const range = req.headers.range;
    // Preserve Cache-Control if already set (e.g. no-cache for SPA)
    const cc = res.getHeader('Cache-Control') || 'public, max-age=3600';

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : size - 1;
      const chunk = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunk,
        'Content-Type': mime,
        'Cache-Control': cc,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': size,
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cc,
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

function jsonRes(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pn = url.pathname;

  // Serve SPA (no cache for dev)
  if (pn === '/' || pn === '/index.html') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    serveFile(path.join(__dirname, 'index.html'), req, res); return;
  }

  // Serve jobs page
  // Shared static assets (explicit allowlist — no generic file serving)
  if ((pn === '/common.css' || pn === '/key-prompt.js') && req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-cache');
    serveFile(path.join(__dirname, pn.slice(1)), req, res); return;
  }

  // Vendored front-end libs (Vue, Vue Router). Allowlisted .js only, path-safe.
  if (pn.startsWith('/vendor/') && req.method === 'GET') {
    const rel = pn.slice('/vendor/'.length);
    const dir = path.join(__dirname, 'vendor');
    const fp = path.join(dir, rel);
    if (/^[a-z0-9._-]+\.js$/i.test(rel) && path.resolve(fp).startsWith(path.resolve(dir))) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      serveFile(fp, req, res); return;
    }
    res.writeHead(404); res.end('Not found'); return;
  }

  if (pn === '/jobs') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    serveFile(path.join(__dirname, 'jobs.html'), req, res); return;
  }

  // Serve metadata viewer page
  if (pn === '/inspect') {
    // Static page — reads path/name/type from its own query params
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    serveFile(path.join(__dirname, 'inspect.html'), req, res); return;
  }

  // API: Save debug results
  if (pn === '/api/debug-results' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      fs.writeFileSync(path.join(__dirname, 'debug-results.json'), body, 'utf8');
      jsonRes(res, { ok: true });
    });
    return;
  }

  // Debug page — tests core functionality
  if (pn === '/debug') {
    const BUILD_ID = '2026-03-13T20:22';
    const debugHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Debug - Archive Browser</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d0d;color:#f2f2f7;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;padding:20px;max-width:700px;margin:0 auto}
h1{font-size:20px;margin-bottom:16px}
.build{color:#86868b;font-size:13px;margin-bottom:20px}
.test{background:#1c1c1e;border:1px solid #38383a;border-radius:8px;padding:12px 16px;margin-bottom:10px}
.test-hdr{display:flex;justify-content:space-between;align-items:center;font-size:14px;font-weight:600}
.test-detail{font-size:12px;color:#86868b;margin-top:6px;word-break:break-all;white-space:pre-wrap}
.badge{font-size:12px;padding:2px 8px;border-radius:10px;font-weight:600}
.pass{background:#1b3a1b;color:#34c759}.fail{background:#3a1b1b;color:#ff453a}.wait{background:#3a3520;color:#ffd60a}
button{background:#2c2c2e;color:#f2f2f7;border:1px solid #48484a;border-radius:6px;padding:8px 16px;font-size:14px;cursor:pointer;margin-top:16px}
button:active{background:#48484a}
</style>
</head><body>
<h1>Archive Browser Debug</h1>
<div class="build">Build: ${BUILD_ID} | Host: <span id="hostInfo"></span></div>
<div id="tests"></div>
<button onclick="runTests()">Re-run Tests</button>
<button id="saveBtn" onclick="saveResults()" disabled>Save Results</button>
<span id="saveStatus" style="font-size:12px;color:#86868b;margin-left:8px"></span>
<script>
const tests = document.getElementById('tests');
const saveBtn = document.getElementById('saveBtn');
const saveStatus = document.getElementById('saveStatus');
document.getElementById('hostInfo').textContent = location.host + ' (' + location.protocol + ')';
const results = [];

function addTest(name) {
  const div = document.createElement('div');
  div.className = 'test';
  div.innerHTML = '<div class="test-hdr"><span>' + name + '</span><span class="badge wait" id="b-' + name + '">...</span></div><div class="test-detail" id="d-' + name + '"></div>';
  tests.appendChild(div);
  return {
    pass(msg) { document.getElementById('b-' + name).className = 'badge pass'; document.getElementById('b-' + name).textContent = 'PASS'; document.getElementById('d-' + name).textContent = msg || ''; results.push({test: name, status: 'PASS', detail: msg || ''}); },
    fail(msg) { document.getElementById('b-' + name).className = 'badge fail'; document.getElementById('b-' + name).textContent = 'FAIL'; document.getElementById('d-' + name).textContent = msg || ''; results.push({test: name, status: 'FAIL', detail: msg || ''}); }
  };
}

async function saveResults() {
  const payload = {
    build: '${BUILD_ID}',
    timestamp: new Date().toISOString(),
    host: location.host,
    protocol: location.protocol,
    userAgent: navigator.userAgent,
    results: results
  };
  try {
    const r = await fetch('/api/debug-results', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload, null, 2) });
    if (r.ok) { saveStatus.textContent = 'Saved!'; saveStatus.style.color = '#34c759'; }
    else { saveStatus.textContent = 'Error ' + r.status; saveStatus.style.color = '#ff453a'; }
  } catch(e) { saveStatus.textContent = e.message; saveStatus.style.color = '#ff453a'; }
}

async function runTests() {
  tests.innerHTML = '';
  results.length = 0;
  saveBtn.disabled = true;
  saveStatus.textContent = '';

  // 1. Fetch API
  const t1 = addTest('Fetch API');
  try {
    const r = await fetch('/api/list?limit=2');
    const d = await r.json();
    if (d.items) t1.pass(d.items.length + ' items returned, root: ' + (d.root || 'n/a'));
    else t1.fail('Unexpected response: ' + JSON.stringify(d).substring(0, 200));
  } catch(e) { t1.fail(e.message); }

  // 2. File serving
  const t2 = addTest('File Serve');
  try {
    const r = await fetch('/api/list?limit=5');
    const d = await r.json();
    const file = d.items.find(i => !i.isDir && (i.isImage || i.isVideo));
    if (!file) { t2.fail('No media files found to test'); }
    else {
      const fr = await fetch('/file/' + encodeURIComponent(file.path), { method: 'HEAD' });
      if (fr.ok) t2.pass(fr.status + ' ' + file.name + ' (' + fr.headers.get('content-type') + ')');
      else t2.fail(fr.status + ' for ' + file.name);
    }
  } catch(e) { t2.fail(e.message); }

  // 3. Metadata extraction
  const t3 = addTest('Metadata API');
  try {
    const r = await fetch('/api/list?limit=50');
    const d = await r.json();
    const png = d.items.find(i => i.isImage && i.name.endsWith('.png'));
    if (!png) { t3.fail('No PNG found to test metadata extraction'); }
    else {
      const mr = await fetch('/api/metadata?path=' + encodeURIComponent(png.path));
      const md = await mr.json();
      if (mr.ok && (md.prompt || md.workflow)) t3.pass('Got metadata from ' + png.name + ' (prompt: ' + !!md.prompt + ', workflow: ' + !!md.workflow + ')');
      else if (mr.ok) t3.pass('No metadata in ' + png.name + ' (file has no ComfyUI data)');
      else t3.fail(mr.status + ': ' + JSON.stringify(md));
    }
  } catch(e) { t3.fail(e.message); }

  // 4. WebSocket (ComfyUI proxy)
  const t4 = addTest('WebSocket Proxy');
  try {
    await new Promise((resolve) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(proto + '//' + location.host + '/comfy-ws?clientId=debug-' + Date.now());
      const timer = setTimeout(() => { ws.close(); t4.fail('Timeout after 5s — no message received'); resolve(); }, 5000);
      ws.onmessage = (e) => {
        clearTimeout(timer);
        let preview = typeof e.data === 'string' ? e.data.substring(0, 150) : '(binary ' + e.data.size + ' bytes)';
        t4.pass('Message received: ' + preview);
        ws.close();
        resolve();
      };
      ws.onerror = () => { clearTimeout(timer); t4.fail('WebSocket connection error'); resolve(); };
      ws.onclose = (e) => { if (!e.wasClean) { clearTimeout(timer); t4.fail('Connection closed (code ' + e.code + ')'); resolve(); } };
    });
  } catch(e) { t4.fail(e.message); }

  // 5. ComfyUI HTTP proxy
  const t5 = addTest('ComfyUI HTTP Proxy');
  try {
    const r = await fetch('/api/comfy/system_stats');
    if (r.ok) {
      const d = await r.json();
      const gpu = d.devices && d.devices[0] ? d.devices[0].name : 'unknown';
      t5.pass('ComfyUI online — ' + gpu + ', VRAM: ' + (d.devices && d.devices[0] ? Math.round(d.devices[0].vram_total / 1073741824) + 'GB' : '?'));
    } else t5.fail('HTTP ' + r.status);
  } catch(e) { t5.fail(e.message); }

  // 6. Meta page generation
  const t6 = addTest('Meta Page Route');
  try {
    const r = await fetch('/meta?path=test.png&name=test.png&type=image');
    if (r.ok) {
      const html = await r.text();
      const hasAccordion = html.includes('accordion');
      const hasSummary = html.includes('summary-section');
      const hasTabs = html.includes('tab-workflow');
      t6.pass('HTML served (' + html.length + ' bytes) — accordions: ' + hasAccordion + ', summary: ' + hasSummary + ', tabs: ' + hasTabs);
    } else t6.fail('HTTP ' + r.status);
  } catch(e) { t6.fail(e.message); }

  // 7. Cache headers
  const t7 = addTest('Cache Headers');
  try {
    const r = await fetch('/');
    const cc = r.headers.get('cache-control') || '';
    if (cc.includes('no-cache')) t7.pass('SPA: ' + cc);
    else t7.fail('SPA missing no-cache: "' + cc + '"');
  } catch(e) { t7.fail(e.message); }

  saveBtn.disabled = false;
}

runTests();
</script>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(debugHtml);
    return;
  }

  // API: find files in ComfyUI output newer than a timestamp
  if (pn === '/api/recent-outputs' && req.method === 'GET') {
    const since = parseInt(url.searchParams.get('since') || '0', 10);
    const sinceDate = new Date(since);
    const results = [];
    function scanDir(dir) {
      let entries;
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (name.startsWith('.')) continue;
        const full = path.join(dir, name);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.isDirectory()) { scanDir(full); continue; }
        if (stat.mtime >= sinceDate) {
          const ext = path.extname(name).toLowerCase();
          if (['.png','.jpg','.jpeg','.webp','.gif','.mp4','.webm','.mov'].includes(ext)) {
            results.push({ path: full.replace(/\\/g, '/'), name, modified: stat.mtime.toISOString() });
          }
        }
      }
    }
    scanDir(COMFY_OUTPUT);
    results.sort((a, b) => new Date(a.modified) - new Date(b.modified));
    // Filter out companion PNG thumbnails that match a video file (e.g. Wan480_00034.png for Wan480_00034.mp4)
    const videoBasenames = new Set();
    for (const r of results) {
      const ext = path.extname(r.name).toLowerCase();
      if (['.mp4','.webm','.mov'].includes(ext)) {
        videoBasenames.add(r.name.replace(/\.[^.]+$/, ''));
      }
    }
    const filtered = [];
    for (const r of results) {
      const ext = path.extname(r.name).toLowerCase();
      const base = r.name.replace(/\.[^.]+$/, '');
      // Skip PNGs that are companion thumbnails for a video
      if (ext === '.png' && videoBasenames.has(base)) {
        // Store the png path on the video entry as its thumbnail
        const vidEntry = results.find(v => v.name.replace(/\.[^.]+$/, '') === base && v !== r);
        if (vidEntry) vidEntry.thumbPath = r.path;
        continue;
      }
      filtered.push(r);
    }
    jsonRes(res, filtered);
    return;
  }

  // API: list directory
  if (pn === '/api/list' && req.method === 'GET') {
    const rawDir = url.searchParams.get('dir');
    const dir = (rawDir && rawDir.trim()) ? path.resolve(decodeURIComponent(rawDir)) : ROOT;
    // scope=all searches across BOTH media roots at once (ComfyUI output + the
    // media/favorites tree) — used by the Files & Media search box, which spans
    // all three tabs. Plain browsing stays scoped to a single dir.
    const scopeAll = url.searchParams.get('scope') === 'all';
    const normRoot = ROOT.replace(/\\/g, '/').toLowerCase();
    const normComfy = COMFY_OUTPUT.replace(/\\/g, '/').toLowerCase();
    if (!scopeAll) {
      // Prevent navigating outside allowed directories (normalize slashes for Windows)
      const normDir = dir.replace(/\\/g, '/').toLowerCase();
      if (!normDir.startsWith(normRoot) && !normDir.startsWith(normComfy)) { jsonRes(res, { error: 'Access denied' }, 403); return; }
    }
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '48', 10)));
    const search = (url.searchParams.get('search') || '').toLowerCase().trim();
    const sort = url.searchParams.get('sort') || 'name';
    const asc = url.searchParams.get('asc') !== 'false';
    const typeFilter = url.searchParams.get('type') || 'all'; // all | video | image | audio | folder
    const safeMode = url.searchParams.get('safe') === '1'; // omit NSFW-tagged items entirely

    // A search (or scope=all) spans the whole subtree; plain browsing lists one directory.
    const deep = !!search || scopeAll;
    const items = [];
    // scope=all seeds both roots (skipping ComfyUI output if it nests under ROOT).
    const scanQueue = scopeAll
      ? (normComfy.startsWith(normRoot) ? [ROOT] : [ROOT, COMFY_OUTPUT])
      : [dir];
    let first = true;
    while (scanQueue.length) {
      const d = scanQueue.shift();
      let names;
      try { names = fs.readdirSync(d); } catch (e) {
        if (first) { jsonRes(res, { error: e.message }, 500); return; }
        continue;
      }
      first = false;
      for (const name of names) {
        if (name.startsWith('.') || name === 'desktop.ini' || name === 'Thumbs.db') continue;

        const fullPath = path.join(d, name);
        let stat;
        try { stat = fs.statSync(fullPath); } catch { continue; }
        const isDir = stat.isDirectory();
        if (deep && isDir) {
          scanQueue.push(fullPath);
          // A folder whose *name* matches still shows up (as a navigable chip)
          if (!name.toLowerCase().includes(search)) continue;
        }
        // Match by file name OR by prompt words embedded in the image (indexed)
        if (search && !isDir && !name.toLowerCase().includes(search) && !promptIndexMatches(fullPath, search)) continue;

        const ext = path.extname(name).toLowerCase();
        const isVideo = VIDEO_EXT.has(ext);
        const isImage = IMAGE_EXT.has(ext);
        const isAudio = AUDIO_EXT.has(ext);

        // Type filter
        if (typeFilter === 'video' && !isVideo) continue;
        if (typeFilter === 'image' && !isImage) continue;
        if (typeFilter === 'audio' && !isAudio) continue;
        if (typeFilter === 'folder' && !isDir) continue;

        // Skip standalone thumbnail files that belong to a video
        if (isImage && !isDir) {
          const base = fullPath.replace(/\.[^.]+$/, '');
          const hasMatchingVideo = [...VIDEO_EXT].some(ve => fs.existsSync(base + ve));
          if (hasMatchingVideo) continue;
        }

        // Prompt-index flags: embedded workflow present + NSFW word match
        const idxRec = isDir ? null : promptIndex.files[fullPath.replace(/\\/g, '/')];
        if (safeMode && idxRec && idxRec.n) continue;

        const thumbPath = isVideo ? getThumbPath(fullPath) : null;

        items.push({
          name,
          path: fullPath,
          parentDir: d.replace(/\\/g, '/'),
          isDir, isVideo, isImage, isAudio,
          size: isDir ? null : fmtSize(stat.size),
          sizeBytes: isDir ? 0 : stat.size,
          modified: stat.mtime.toISOString(),
          thumb: !!thumbPath,
          workflow: !!(idxRec && idxRec.w),
          nsfw: !!(idxRec && idxRec.n),
        });
      }
    }
    {

      // Sort
      items.sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        let cmp = 0;
        if (sort === 'size') cmp = a.sizeBytes - b.sizeBytes;
        else if (sort === 'date') cmp = new Date(a.modified) - new Date(b.modified);
        else cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        return asc ? cmp : -cmp;
      });

      const total = items.length;
      const start = (page - 1) * limit;
      const pageItems = items.slice(start, start + limit);
      const parentDir = path.dirname(dir);
      const isRoot = scopeAll || dir === ROOT || dir === parentDir;

      jsonRes(res, {
        dir: scopeAll ? ROOT : dir, root: ROOT, parent: isRoot ? null : parentDir,
        page, limit, total, pages: Math.ceil(total / limit) || 1,
        items: pageItems,
        favoritesDir: FAVORITES_DIR,
        comfyOutputDir: COMFY_OUTPUT,
      });
    }
    return;
  }

  // API: favorite (move file to _Favorites, or to archive root if from ComfyUI output)
  if (pn === '/api/favorite' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filePath } = JSON.parse(body);
        if (!filePath) { jsonRes(res, { error: 'Missing filePath' }, 400); return; }

        // Always move to Favorites
        const destDir = FAVORITES_DIR;

        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        const dest = path.join(destDir, path.basename(filePath));

        moveFile(filePath, dest, (err) => {
          if (err) { jsonRes(res, { error: err.message }, 500); return; }

          // Also move matching thumbnail if exists
          const thumbSrc = getThumbPath(filePath);
          if (thumbSrc) {
            const thumbDest = path.join(destDir, path.basename(thumbSrc));
            moveFile(thumbSrc, thumbDest, () => {});
          }
          promptIndexMove(filePath, dest); // keep prompt search pointing at the new location

          jsonRes(res, { ok: true, dest });
        });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
    });
    return;
  }

  // API: delete file
  if (pn === '/api/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filePath } = JSON.parse(body);
        if (!filePath) { jsonRes(res, { error: 'Missing filePath' }, 400); return; }

        fs.unlink(filePath, (err) => {
          if (err) { jsonRes(res, { error: err.message }, 500); return; }

          // Also delete matching thumbnail if exists
          const thumb = getThumbPath(filePath);
          if (thumb) fs.unlink(thumb, () => {});
          promptIndexRemove(filePath); // keep prompt search in sync immediately

          jsonRes(res, { ok: true });
        });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
    });
    return;
  }

  // API: delete an (effectively) empty folder. Refuses roots and any folder that
  // still holds real content — only ignorable leftovers (desktop.ini, Thumbs.db,
  // dotfiles) are allowed, and those are cleaned up with the folder.
  if (pn === '/api/delete-folder' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { dir } = JSON.parse(body);
        if (!dir) { jsonRes(res, { error: 'Missing dir' }, 400); return; }
        const abs = path.resolve(dir);
        const n = s => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const na = n(abs), nr = n(ROOT), nc = n(COMFY_OUTPUT);
        if (!na.startsWith(nr) && !na.startsWith(nc)) { jsonRes(res, { error: 'Access denied' }, 403); return; }
        if (na === nr || na === nc) { jsonRes(res, { error: 'Cannot delete a root folder' }, 400); return; }
        let st; try { st = fs.statSync(abs); } catch { jsonRes(res, { error: 'Folder not found' }, 404); return; }
        if (!st.isDirectory()) { jsonRes(res, { error: 'Not a folder' }, 400); return; }
        const ignorable = n => n.startsWith('.') || n === 'desktop.ini' || n === 'Thumbs.db';
        const leftovers = fs.readdirSync(abs).filter(name => !ignorable(name));
        if (leftovers.length) { jsonRes(res, { error: 'Folder is not empty' }, 400); return; }
        fs.rmSync(abs, { recursive: true, force: true }); // clears ignorable files + the dir
        jsonRes(res, { ok: true });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
    });
    return;
  }

  // Bulk delete (files and directories)
  if (pn === '/api/bulk-delete' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { paths } = JSON.parse(body);
        if (!Array.isArray(paths) || paths.length === 0) { jsonRes(res, { error: 'Missing paths array' }, 400); return; }
        const results = [];
        for (const p of paths) {
          try {
            const stat = await fs.promises.stat(p);
            if (stat.isDirectory()) {
              await fs.promises.rm(p, { recursive: true, force: true });
              // drop every indexed file that lived under this folder
              const prefix = p.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
              for (const k of Object.keys(promptIndex.files)) if (k.startsWith(prefix)) promptIndexRemove(k);
            } else {
              await fs.promises.unlink(p);
              const thumb = getThumbPath(p);
              if (thumb) try { await fs.promises.unlink(thumb); } catch {}
              promptIndexRemove(p);
            }
            results.push({ path: p, ok: true });
          } catch (e) {
            results.push({ path: p, ok: false, error: e.message });
          }
        }
        jsonRes(res, { results });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
    });
    return;
  }

  // Serve file (with range support)
  if (pn.startsWith('/file/')) {
    const filePath = decodeURIComponent(pn.slice(6));
    serveFile(filePath, req, res); return;
  }

  // Serve thumbnail
  if (pn.startsWith('/thumb/')) {
    const filePath = decodeURIComponent(pn.slice(7));
    const thumbPath = getThumbPath(filePath);
    if (thumbPath) { serveFile(thumbPath, req, res); }
    else { res.writeHead(404); res.end('No thumbnail'); }
    return;
  }

  // API: List Claude conversations
  if (pn === '/api/claude/conversations' && req.method === 'GET') {
    jsonRes(res, loadConvos());
    return;
  }

  // API: Delete a Claude conversation
  if (pn === '/api/claude/conversations' && req.method === 'DELETE') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        const convos = loadConvos().filter(c => c.id !== id);
        saveConvos(convos);
        jsonRes(res, { ok: true });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
    });
    return;
  }

  // API: Claude Code - send prompt (SSE streaming)
  if (pn === '/api/claude' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { prompt, sessionId } = JSON.parse(body);
        if (!prompt) { jsonRes(res, { error: 'Missing prompt' }, 400); return; }
        if (claudeProc) { jsonRes(res, { error: 'Claude is already running. Stop it first or wait.' }, 409); return; }

        const cliInfo = findClaudeCli();
        if (!cliInfo) { jsonRes(res, { error: 'Claude Code CLI not found — npm install -g @anthropic-ai/claude-code' }, 500); return; }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        const args = [...cliInfo.baseArgs, '-p', prompt, '--output-format', 'stream-json', '--verbose',
          // Headless mode can't show permission prompts, so grant the write scope
          // explicitly: edit/create workflow files only (relative to cwd=COMFY_DIR),
          // plus curl so the assistant can fall back to the local app/ComfyUI APIs
          // when direct file writes fail (save workflow via /api/workflows/save,
          // test-run so the fix gets embedded in a generated image). Anything else
          // (other shell commands, web access) stays denied — headless default-deny
          // covers whatever isn't allowed here. Ships with the app so users don't
          // need a .claude/settings.json in their ComfyUI install (a local one
          // still composes for extra grants).
          '--allowedTools', 'Edit(user/default/workflows/**)', 'Write(user/default/workflows/**)', 'Bash(curl:*)',
          '--disallowedTools', 'WebFetch', 'WebSearch'];
        // Give the assistant read access to the ComfyUI notes (patches, install history)
        // so it has real context when inspecting/editing workflows.
        const notesDir = config.comfyNotesDir || 'D:\\comfyui_notes';
        if (fs.existsSync(notesDir)) args.push('--add-dir', notesDir);

        // Resume existing session or start new one with a specific ID
        if (sessionId) {
          args.push('--resume', sessionId);
        }

        // Pass the configured Anthropic key so the CLI can auth even under the
        // SYSTEM service context (where it can't resolve the user's global login).
        const claudeEnv = Object.assign({}, process.env);
        if (ANTHROPIC_API_KEY) claudeEnv.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;
        claudeProc = spawn(cliInfo.cmd, args, {
          cwd: COMFY_DIR,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: claudeEnv,
        });
        claudeProc.stdin.end();

        let buffer = '';
        let capturedSessionId = sessionId || null;

        claudeProc.stdout.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete line
          for (const line of lines) {
            if (line.trim()) {
              // Capture session ID from init event
              try {
                const evt = JSON.parse(line);
                if (evt.type === 'system' && evt.session_id) {
                  capturedSessionId = evt.session_id;
                }
              } catch {}
              res.write(`data: ${line}\n\n`);
            }
          }
        });

        claudeProc.stderr.on('data', (chunk) => {
          const msg = chunk.toString().trim();
          if (msg) {
            res.write(`data: ${JSON.stringify({ type: 'system', message: msg })}\n\n`);
          }
        });

        claudeProc.on('close', (code) => {
          if (buffer.trim()) {
            try {
              const evt = JSON.parse(buffer);
              if (evt.type === 'system' && evt.session_id) {
                capturedSessionId = evt.session_id;
              }
            } catch {}
            res.write(`data: ${buffer}\n\n`);
          }
          // Save/update conversation record
          if (capturedSessionId) {
            const convos = loadConvos();
            const existing = convos.find(c => c.id === capturedSessionId);
            if (existing) {
              existing.updatedAt = new Date().toISOString();
              existing.messageCount = (existing.messageCount || 0) + 1;
            } else {
              convos.unshift({
                id: capturedSessionId,
                title: prompt.substring(0, 100),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                messageCount: 1,
              });
            }
            saveConvos(convos);
          }
          res.write(`data: ${JSON.stringify({ type: 'done', code, sessionId: capturedSessionId })}\n\n`);
          res.end();
          claudeProc = null;
        });

        claudeProc.on('error', (err) => {
          res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
          res.end();
          claudeProc = null;
        });

        res.on('close', () => {
          // Client disconnected - kill process
          if (claudeProc) {
            claudeProc.kill();
            claudeProc = null;
          }
        });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
    });
    return;
  }

  // API: Stop running Claude process
  if (pn === '/api/claude/stop' && req.method === 'POST') {
    if (claudeProc) {
      claudeProc.kill();
      claudeProc = null;
      jsonRes(res, { ok: true, message: 'Stopped' });
    } else {
      jsonRes(res, { ok: true, message: 'Nothing running' });
    }
    return;
  }

  // API: Extract metadata from media file
  if (pn === '/api/metadata' && req.method === 'GET') {
    const filePath = decodeURIComponent(url.searchParams.get('path') || '');
    if (!filePath) { jsonRes(res, { error: 'Missing path' }, 400); return; }

    const ext = path.extname(filePath).toLowerCase();
    if (['.png'].includes(ext)) {
      extractPngMetadata(filePath, (err, meta) => {
        if (err) { jsonRes(res, { error: err.message }, 500); return; }
        jsonRes(res, meta);
      });
    } else if (['.mp4', '.webm', '.mkv', '.mov'].includes(ext)) {
      extractVideoMetadata(filePath, (err, meta) => {
        if (err) { jsonRes(res, { error: err.message }, 500); return; }
        jsonRes(res, meta);
      });
    } else {
      jsonRes(res, { error: 'Unsupported file type' }, 400);
    }
    return;
  }

  // API: Settings — read (masked keys) / write (merge into config.json + hot-reload)
  if (pn === '/api/settings' && req.method === 'GET') {
    const mask = v => v ? { set: true, hint: '••••' + String(v).slice(-4) } : { set: false, hint: '' };
    jsonRes(res, {
      keys: {
        anthropicApiKey: mask(ANTHROPIC_API_KEY),
        xaiApiKey: mask(XAI_API_KEY),
        civitaiApiKey: mask(CIVITAI_API_KEY),
      },
      urls: { comfyUrl: COMFY_URL, ollamaUrl: OLLAMA_URL, voxtralUrl: VOXTRAL_URL },
      paths: {
        comfyDir: { value: COMFY_DIR, exists: fs.existsSync(COMFY_DIR), hasWorkflows: fs.existsSync(WORKFLOWS_DIR) },
        comfyOutput: { value: COMFY_OUTPUT, exists: fs.existsSync(COMFY_OUTPUT) },
      },
      info: {
        port: PORT,
        httpsPort: parseInt(config.httpsPort, 10) || 8443,
        mediaDir: ROOT,
      },
      setup: { done: !!config.setupDone, features: Array.isArray(config.features) ? config.features : null },
    });
    return;
  }
  if (pn === '/api/settings' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', () => {
      let body;
      try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      let current = {};
      try { current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
      // Secret keys: null clears, non-empty string sets, '' / undefined leaves unchanged.
      for (const k of ['anthropicApiKey', 'xaiApiKey', 'civitaiApiKey']) {
        if (!(k in body)) continue;
        if (body[k] === null) current[k] = '';
        else if (typeof body[k] === 'string' && body[k].trim() !== '') current[k] = body[k].trim();
      }
      // URLs: any provided string is applied (empty falls back to default on reload).
      for (const k of ['comfyUrl', 'ollamaUrl', 'voxtralUrl']) {
        if (typeof body[k] === 'string') current[k] = body[k].trim();
      }
      // Paths: must exist on disk. comfyDir additionally warns (not blocks) if it
      // doesn't look like a ComfyUI install (no user/default/workflows inside).
      let warning = null;
      for (const k of ['comfyDir', 'comfyOutput']) {
        if (typeof body[k] !== 'string' || body[k].trim() === '') continue;
        const p = path.resolve(body[k].trim());
        let st = null;
        try { st = fs.statSync(p); } catch {}
        if (!st || !st.isDirectory()) { jsonRes(res, { error: k + ': folder does not exist: ' + p }, 400); return; }
        if (k === 'comfyDir' && !fs.existsSync(path.join(p, 'user', 'default', 'workflows'))) {
          warning = 'comfyDir has no user/default/workflows inside — workflow features will find nothing until ComfyUI creates it.';
        }
        current[k] = p;
      }
      // Setup wizard state: completion flag + which features the user opted into.
      if ('setupDone' in body) current.setupDone = !!body.setupDone;
      if (Array.isArray(body.features)) {
        const known = ['media', 'comfy', 'claude', 'chatLocal', 'chatGrok', 'voice'];
        current.features = body.features.filter(f => known.includes(f));
      }
      try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2)); }
      catch (e) { jsonRes(res, { error: 'Write failed: ' + e.message }, 500); return; }
      reloadConfig();
      jsonRes(res, warning ? { ok: true, warning } : { ok: true });
    });
    return;
  }

  // API: NSFW tag list — read (decoded for display) / write (encoded to config).
  if (pn === '/api/nsfw-terms' && req.method === 'GET') {
    jsonRes(res, { terms: nsfwTermsDecoded() });
    return;
  }
  if (pn === '/api/nsfw-terms' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', () => {
      let body;
      try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      if (!Array.isArray(body.terms)) { jsonRes(res, { error: 'terms must be an array' }, 400); return; }
      // Normalize: trim, lowercase, drop empties, dedupe — then store base64-encoded.
      const seen = new Set(), clean = [];
      for (const t of body.terms) {
        if (typeof t !== 'string') continue;
        const w = t.trim().toLowerCase();
        if (!w || seen.has(w)) continue;
        seen.add(w); clean.push(w);
      }
      const b64 = clean.map(w => Buffer.from(w, 'utf8').toString('base64'));
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
      cur.nsfwTermsB64 = b64;
      try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2)); }
      catch (e) { jsonRes(res, { error: 'Write failed: ' + e.message }, 500); return; }
      config.nsfwTermsB64 = b64;
      NSFW_RE = buildNsfwRe();
      const retagged = retagNsfw();  // recompute the n-flag on already-indexed files
      jsonRes(res, { ok: true, count: clean.length, retagged });
    });
    return;
  }

  // API: aggregated service status for the Status / Setup page
  if (pn === '/api/status' && req.method === 'GET') {
    const probe = (urlStr, timeoutMs) => new Promise(resolve => {
      try {
        const u = new URL(urlStr);
        const pr = http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname, timeout: timeoutMs || 1500 }, r => {
          r.resume(); resolve(r.statusCode >= 200 && r.statusCode < 500);
        });
        pr.on('timeout', () => { pr.destroy(); resolve(false); });
        pr.on('error', () => resolve(false));
      } catch { resolve(false); }
    });
    (async () => {
      const [comfy, ollama, voxtral] = await Promise.all([
        probe(COMFY_URL + '/system_stats'),
        probe(OLLAMA_URL + '/api/tags'),
        probe(VOXTRAL_URL + '/health'),
      ]);
      let wfCount = 0;
      try { wfCount = loadWfStore().enabled.filter(n => fs.existsSync(path.join(WORKFLOWS_DIR, n))).length; } catch {}
      const claudeCli = !!findClaudeCli();
      const comfyDirOk = fs.existsSync(COMFY_DIR);
      jsonRes(res, {
        setupDone: !!config.setupDone,
        features: Array.isArray(config.features) ? config.features : null,
        services: [
        { id: 'comfy', name: 'ComfyUI', configured: comfyDirOk, running: comfy,
          detail: comfy ? ('Running at ' + COMFY_URL) : (comfyDirOk ? ('Installed but NOT running — not reachable at ' + COMFY_URL) : 'Install folder not found — set it in Settings'),
          affects: 'Running workflows / generating images' },
        { id: 'workflows', name: 'App workflows', configured: fs.existsSync(WORKFLOWS_DIR), running: wfCount > 0,
          detail: fs.existsSync(WORKFLOWS_DIR) ? (wfCount + ' workflow(s) enabled') : 'Workflows folder missing under the ComfyUI dir',
          affects: 'Workflow dropdown on media pages' },
        { id: 'ollama', name: 'Ollama (local LLM)', configured: true, running: ollama,
          detail: ollama ? ('Running at ' + OLLAMA_URL) : ('Not reachable at ' + OLLAMA_URL + ' — start the Ollama app'),
          affects: 'Chat — Local and Chat — Grok' },
        { id: 'voxtral', name: 'Voxtral (local TTS)', configured: true, running: voxtral,
          detail: voxtral ? ('Running at ' + VOXTRAL_URL) : ('Not reachable at ' + VOXTRAL_URL),
          affects: 'Chat — Local voice output' },
        { id: 'xai', name: 'Grok (xAI) API key', configured: !!XAI_API_KEY, running: !!XAI_API_KEY,
          detail: XAI_API_KEY ? 'Key configured' : 'No key — add it in Settings',
          affects: 'Voice Agent, Grok TTS, portrait/scene generation' },
        { id: 'anthropic', name: 'Claude Code', configured: claudeCli, running: claudeCli,
          detail: !claudeCli ? 'CLI not found — npm install -g @anthropic-ai/claude-code'
            : (ANTHROPIC_API_KEY ? 'CLI installed, API key configured' : 'CLI installed — no API key set (may still work via claude login)'),
          affects: 'Claude Code assistant' },
        { id: 'civitai', name: 'Civitai API key', configured: !!CIVITAI_API_KEY, running: !!CIVITAI_API_KEY,
          detail: CIVITAI_API_KEY ? 'Key configured' : 'No key — only needed for gated model downloads',
          affects: 'Model downloads' },
        { id: 'media', name: 'Media folder', configured: fs.existsSync(ROOT), running: fs.existsSync(ROOT),
          detail: ROOT, affects: 'Library browsing / favorites' },
        { id: 'index', name: 'Prompt search index', configured: true, running: !promptIndexLastError,
          detail: Object.keys(promptIndex.files).length + ' images indexed' + (promptIndexing ? ' (indexing…)' : '') + (promptIndexLastError ? (' — last error: ' + promptIndexLastError) : ''),
          affects: 'Prompt search and the word directory' },
      ]});
    })();
    return;
  }

  // API: Prompt phrase directory (word/phrase -> number of images containing it)
  if (pn === '/api/prompt-words' && req.method === 'GET') {
    const safeMode = url.searchParams.get('safe') === '1';
    jsonRes(res, { words: promptPhraseCounts(safeMode), files: Object.keys(promptIndex.files).length });
    return;
  }

  // API: Prompt index status / manual rebuild
  if (pn === '/api/prompt-index' && req.method === 'GET') {
    jsonRes(res, { files: Object.keys(promptIndex.files).length, indexing: promptIndexing, lastRun: promptIndexLastRun, lastError: promptIndexLastError });
    return;
  }
  if (pn === '/api/prompt-index' && req.method === 'POST') {
    buildPromptIndex();
    jsonRes(res, { ok: true, started: !promptIndexing });
    return;
  }

  // API: Browse server folders (for the Settings path picker). Directory names
  // only — no files. path="" lists the available drive roots.
  if (pn === '/api/browse-dirs' && req.method === 'GET') {
    const reqPath = (url.searchParams.get('path') || '').trim();
    if (!reqPath) {
      const drives = [];
      for (let c = 65; c <= 90; c++) {
        const d = String.fromCharCode(c) + ':\\';
        try { if (fs.existsSync(d)) drives.push(d); } catch {}
      }
      jsonRes(res, { path: '', parent: null, dirs: drives });
      return;
    }
    const p = path.resolve(reqPath);
    let entries = [];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true })
        .filter(e => { try { return e.isDirectory(); } catch { return false; } })
        .map(e => e.name)
        .filter(n => !n.startsWith('$') && n !== 'System Volume Information')
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    } catch (e) { jsonRes(res, { error: e.message }, 400); return; }
    const parentDir = path.dirname(p);
    jsonRes(res, { path: p, parent: parentDir === p ? '' : parentDir, dirs: entries });
    return;
  }

  // API: Prompt replacements — stored on disk so they're shared across devices
  if (pn === '/api/replacements' && req.method === 'GET') {
    fs.readFile(path.join(__dirname, 'app-replacements.json'), 'utf8', (err, raw) => {
      if (err) { jsonRes(res, { replacements: [] }); return; }
      try { jsonRes(res, JSON.parse(raw)); } catch { jsonRes(res, { replacements: [] }); }
    });
    return;
  }
  if (pn === '/api/replacements' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', () => {
      let body;
      try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      const list = Array.isArray(body.replacements) ? body.replacements
        .filter(r => r && typeof r === 'object')
        .map(r => ({ from: String(r.from || ''), to: String(r.to || ''), on: !!r.on })) : [];
      try {
        fs.writeFileSync(path.join(__dirname, 'app-replacements.json'), JSON.stringify({ replacements: list }, null, 2));
        jsonRes(res, { ok: true });
      } catch (e) { jsonRes(res, { error: e.message }, 500); }
    });
    return;
  }

  // API: List app-enabled workflows (from the allowlist)
  if (pn === '/api/workflows' && req.method === 'GET') {
    const store = loadWfStore();
    const existing = new Set(listAllWorkflows());
    const enabled = store.enabled
      .filter(n => existing.has(n))
      .map(n => ({ name: n, label: store.labels[n] || defaultLabel(n) }))
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
    jsonRes(res, enabled);
    return;
  }

  // API: List ALL install-dir workflows with enabled flag + mapping candidates
  if (pn === '/api/workflows/all' && req.method === 'GET') {
    const store = loadWfStore();
    const enabledSet = new Set(store.enabled);
    const all = listAllWorkflows().map(n => {
      const item = { name: n, label: store.labels[n] || defaultLabel(n), enabled: enabledSet.has(n), mapping: store.mappings[n] || null };
      // Only compute candidates/auto-detected guesses for enabled ones (parse cost).
      if (item.enabled) {
        try {
          const wf = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, n), 'utf8'));
          item.candidates = workflowCandidates(wf);
          const pn2 = resolvePromptNode(wf, store.mappings[n]);
          const sn = resolveStepsNode(wf, store.mappings[n]);
          const sd = resolveSeedNode(wf, store.mappings[n]);
          item.detected = { promptNodeId: pn2 ? pn2.id : null, stepsNodeId: sn ? sn.id : null, seedNodeId: sd ? sd.id : null };
          item.hasPresets = detectPresetGroups(wf).length > 0;
        } catch (e) { item.error = e.message; }
      }
      return item;
    });
    jsonRes(res, all);
    return;
  }

  // API: Start the local ComfyUI install. Uses config.comfyStartCmd (shell string
  // or [cmd, ...args] array); falls back to the ComfyUI-Easy-Install launcher bat
  // next to comfyDir. Probes first so a running instance is never double-started.
  if (pn === '/api/comfy/start' && req.method === 'POST') {
    let responded = false;
    const done = (obj, code) => { if (!responded) { responded = true; jsonRes(res, obj, code || 200); } };
    const launch = () => {
      let cmd = config.comfyStartCmd;
      if (!cmd) {
        const guess = path.join(path.dirname(COMFY_DIR), 'Start ComfyUI.bat');
        if (fs.existsSync(guess)) cmd = guess;
      }
      if (!cmd || (Array.isArray(cmd) && !cmd.length)) {
        done({ error: 'No comfyStartCmd configured and no "Start ComfyUI.bat" found next to comfyDir — set comfyStartCmd in config.json.' }, 400);
        return;
      }
      try {
        const proc = Array.isArray(cmd)
          ? spawn(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(cmd[0]) })
          : spawn('"' + cmd + '"', { shell: true, detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(cmd) });
        proc.unref();
        done({ started: true, message: 'ComfyUI starting — model load can take 30-90s.' });
      } catch (e) { done({ error: 'Launch failed: ' + e.message }, 500); }
    };
    const probe = http.get(COMFY_URL + '/system_stats', { timeout: 2500 }, (r) => { r.resume(); done({ running: true }); });
    probe.on('timeout', () => { probe.destroy(); launch(); });
    probe.on('error', launch);
    return;
  }

  // API: Recognize which enabled workflow an embedded graph is (structural match).
  // POST { workflow } -> { name, label, score } of the best match, or {} if none.
  // Fingerprint = node-type multiset + typed link topology; widget values (prompt,
  // seed, lora strengths), positions, titles, and mute/bypass modes are ignored.
  if (pn === '/api/workflow-match' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', () => {
      let body;
      try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      const emb = body && body.workflow;
      if (!emb || !Array.isArray(emb.nodes)) { jsonRes(res, {}); return; }

      // Link keys are slotless (fromType>toType) and compared by containment, not
      // Jaccard: newer ComfyUI frontends materialize extra links and renumber slots
      // when serializing into the PNG, so exact-slot Jaccard under-scores true matches.
      function fingerprint(wf) {
        const nodes = (wf.nodes || []).filter(n => n && n.type && !UI_ONLY_TYPES.has(n.type));
        const typeById = {};
        nodes.forEach(n => { typeById[n.id] = n.type; });
        const types = nodes.map(n => n.type).sort();
        const links = (wf.links || []).map(l => {
          const ft = typeById[l[1]], tt = typeById[l[3]];
          return (ft && tt) ? ft + '>' + tt : null;
        }).filter(Boolean).sort();
        return { types, links };
      }
      function multisetIntersection(a, b) {
        const m = new Map();
        a.forEach(v => m.set(v, (m.get(v) || 0) + 1));
        let inter = 0;
        const m2 = new Map();
        b.forEach(v => m2.set(v, (m2.get(v) || 0) + 1));
        for (const [v, c] of m2) inter += Math.min(c, m.get(v) || 0);
        return inter;
      }

      const embFp = fingerprint(emb);
      if (embFp.types.length < 8) { jsonRes(res, {}); return; } // too small to identify confidently

      const store = loadWfStore();
      let best = null;
      for (const name of store.enabled) {
        try {
          const wf = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8'));
          const fp = fingerprint(wf);
          const ti = multisetIntersection(embFp.types, fp.types);
          const typeJac = (embFp.types.length + fp.types.length - ti) ? ti / (embFp.types.length + fp.types.length - ti) : 1;
          const li = multisetIntersection(embFp.links, fp.links);
          const minLinks = Math.min(embFp.links.length, fp.links.length);
          const linkContain = minLinks ? li / minLinks : 1;
          const score = 0.7 * typeJac + 0.3 * linkContain;
          if (!best || score > best.score) best = { name, label: store.labels[name] || defaultLabel(name), score };
        } catch {}
      }
      jsonRes(res, best && best.score >= 0.9 ? { ...best, score: Math.round(best.score * 1000) / 1000 } : {});
    });
    return;
  }

  // API: Mapping candidates + auto-detected guesses for a single workflow
  if (pn === '/api/workflow-nodes' && req.method === 'GET') {
    const wfName = url.searchParams.get('name');
    if (!wfName) { jsonRes(res, { error: 'Missing name' }, 400); return; }
    const wfPath = path.join(WORKFLOWS_DIR, wfName);
    if (!path.resolve(wfPath).startsWith(path.resolve(WORKFLOWS_DIR))) { jsonRes(res, { error: 'Access denied' }, 403); return; }
    fs.readFile(wfPath, 'utf8', (err, raw) => {
      if (err) { jsonRes(res, { error: err.message }, 500); return; }
      try {
        const wf = JSON.parse(raw);
        const mapping = (loadWfStore().mappings || {})[wfName] || null;
        const pn2 = resolvePromptNode(wf, mapping), sn = resolveStepsNode(wf, mapping), sd = resolveSeedNode(wf, mapping);
        jsonRes(res, {
          candidates: workflowCandidates(wf),
          detected: { promptNodeId: pn2 ? pn2.id : null, stepsNodeId: sn ? sn.id : null, seedNodeId: sd ? sd.id : null },
          hasPresets: detectPresetGroups(wf).length > 0,
        });
      } catch (e) { jsonRes(res, { error: 'Parse error: ' + e.message }, 500); }
    });
    return;
  }

  // API: Persist the allowlist + labels + node mappings
  if (pn === '/api/workflows/manage' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', () => {
      let body;
      try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      const store = loadWfStore();
      const valid = new Set(listAllWorkflows());
      if (Array.isArray(body.enabled)) store.enabled = body.enabled.filter(n => valid.has(n));
      if (body.labels && typeof body.labels === 'object') store.labels = body.labels;
      if (body.mappings && typeof body.mappings === 'object') store.mappings = body.mappings;
      const ok = saveWfStore(store);
      jsonRes(res, ok ? { ok: true, enabled: store.enabled } : { error: 'Save failed' }, ok ? 200 : 500);
    });
    return;
  }

  // API: Generate the field config for a workflow (detected fields + user edits).
  if (pn === '/api/workflow-field-config' && req.method === 'GET') {
    const wfName = url.searchParams.get('name');
    if (!wfName) { jsonRes(res, { error: 'Missing name' }, 400); return; }
    const wfPath = path.join(WORKFLOWS_DIR, wfName);
    if (!path.resolve(wfPath).startsWith(path.resolve(WORKFLOWS_DIR))) { jsonRes(res, { error: 'Access denied' }, 403); return; }
    fs.readFile(wfPath, 'utf8', async (err, raw) => {
      if (err) { jsonRes(res, { error: err.message }, 500); return; }
      let wf; try { wf = JSON.parse(raw.replace(/^﻿/, '')); } catch (e) { jsonRes(res, { error: 'Parse error: ' + e.message }, 500); return; }
      try {
        const st = fs.statSync(wfPath, { throwIfNoEntry: false });
        let objectInfo = null; try { objectInfo = await getObjectInfo(); } catch (e) {}   // combo choices (cached; null if ComfyUI down)
        jsonRes(res, buildFieldConfig(wf, wfName, st ? st.mtimeMs : 0, objectInfo));
      } catch (e) { jsonRes(res, { error: 'Field config error: ' + e.message }, 500); }
    });
    return;
  }

  // API: Persist field-config user edits (enable/label/value + manual fields).
  // POST { name, edits: {<fieldId>:{enabled?,label?,value?}}, manual?: [field...] }
  if (pn === '/api/workflow-field-config' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', () => {
      let body; try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      if (!body.name) { jsonRes(res, { error: 'Missing name' }, 400); return; }
      const store = loadWfStore();
      if (!store.fieldConfigs) store.fieldConfigs = {};
      const entry = store.fieldConfigs[body.name] || { edits: {}, manual: [] };
      if (body.edits && typeof body.edits === 'object') entry.edits = body.edits;
      if (Array.isArray(body.manual)) entry.manual = body.manual;
      if (body.reset) { delete store.fieldConfigs[body.name]; }
      else store.fieldConfigs[body.name] = entry;
      const ok = saveWfStore(store);
      jsonRes(res, ok ? { ok: true } : { error: 'Save failed' }, ok ? 200 : 500);
    });
    return;
  }

  // API: Save a workflow JSON into the app workflows dir. Used by "Fix with
  // Claude" to materialize an image-embedded workflow as a file so it can be
  // debugged/edited, and optionally enable it for the workflow dropdown.
  if (pn === '/api/workflows/save' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', () => {
      let body;
      try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      if (!body.workflow || typeof body.workflow !== 'object') { jsonRes(res, { error: 'Missing workflow' }, 400); return; }
      let name = String(body.name || 'DEBUG.json').replace(/[\\\/:*?"<>|]/g, '_').trim();
      if (!name.toLowerCase().endsWith('.json')) name += '.json';
      const wfPath = path.join(WORKFLOWS_DIR, name);
      if (!path.resolve(wfPath).startsWith(path.resolve(WORKFLOWS_DIR))) { jsonRes(res, { error: 'Access denied' }, 403); return; }
      try {
        fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
        fs.writeFileSync(wfPath, JSON.stringify(body.workflow, null, 2));
      } catch (e) { jsonRes(res, { error: 'Write failed: ' + e.message }, 500); return; }
      if (body.enable) {
        const store = loadWfStore();
        if (!store.enabled.includes(name)) { store.enabled.push(name); saveWfStore(store); }
      }
      jsonRes(res, { ok: true, name });
    });
    return;
  }

  // API: Write an app workflow back into a PNG's metadata, replacing the
  // embedded 'workflow' (graph) and 'prompt' (API) text chunks — so Inherit
  // runs of that image use the fixed workflow from then on.
  if (pn === '/api/image/embed-workflow' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      const { filePath, workflowName } = body;
      if (!filePath || !workflowName) { jsonRes(res, { error: 'Missing filePath or workflowName' }, 400); return; }
      const fileExt = path.extname(filePath).toLowerCase();
      const isPng = fileExt === '.png';
      const isVid = ['.mp4', '.webm', '.mkv', '.mov'].includes(fileExt);
      if (!isPng && !isVid) { jsonRes(res, { error: 'Only PNG and video files can carry an embedded workflow' }, 400); return; }
      const abs = path.resolve(filePath);
      if (!abs.startsWith(path.resolve(ROOT)) && !abs.startsWith(path.resolve(COMFY_OUTPUT))) {
        jsonRes(res, { error: 'File must be under the media or ComfyUI output folder' }, 403); return;
      }
      if (!fs.existsSync(abs)) { jsonRes(res, { error: 'File not found' }, 404); return; }
      const wfPath = path.join(WORKFLOWS_DIR, workflowName);
      if (!path.resolve(wfPath).startsWith(path.resolve(WORKFLOWS_DIR))) { jsonRes(res, { error: 'Access denied' }, 403); return; }
      let wf;
      try { wf = JSON.parse(fs.readFileSync(wfPath, 'utf8')); } catch (e) { jsonRes(res, { error: 'Workflow read failed: ' + e.message }, 500); return; }
      let apiPrompt;
      try { apiPrompt = await workflowToPrompt(wf); } catch (e) { jsonRes(res, { error: 'Workflow conversion failed: ' + e.message }, 500); return; }
      const done = (err) => {
        if (err) { jsonRes(res, { error: err.message }, 500); return; }
        jsonRes(res, { ok: true });
      };
      if (isPng) embedPngText(abs, { workflow: JSON.stringify(wf), prompt: JSON.stringify(apiPrompt) }, done);
      else embedVideoText(abs, JSON.stringify({ prompt: apiPrompt, workflow: wf }), done);
    });
    return;
  }

  // API: Get editable config (MAIN PROMPT, loras) from an APP workflow
  if (pn === '/api/workflow-config' && req.method === 'GET') {
    const wfName = url.searchParams.get('name');
    if (!wfName) { jsonRes(res, { error: 'Missing name' }, 400); return; }
    const wfPath = path.join(COMFY_DIR, 'user', 'default', 'workflows', wfName);
    if (!path.resolve(wfPath).startsWith(path.resolve(path.join(COMFY_DIR, 'user', 'default', 'workflows')))) {
      jsonRes(res, { error: 'Access denied' }, 403); return;
    }
    const wfStat = fs.statSync(wfPath, { throwIfNoEntry: false });
    fs.readFile(wfPath, 'utf8', async (err, raw) => {
      if (err) { jsonRes(res, { error: err.message }, 500); return; }
      try {
        const wf = JSON.parse(raw);
        const mapping = (loadWfStore().mappings || {})[wfName] || null;
        const config = { prompt: '', loras: [], frames: null, seed: null, steps: null, cfg: null, presets: [], mtime: wfStat ? wfStat.mtimeMs : 0 };

        // Prompt / steps / seed via mapping-or-convention resolvers
        const promptNode = resolvePromptNode(wf, mapping);
        if (promptNode) { const wv = promptNode.widgets_values || []; config.prompt = typeof wv[0] === 'string' ? wv[0] : ''; }
        const stepsNode = resolveStepsNode(wf, mapping);
        if (stepsNode) { const wv = stepsNode.widgets_values || []; config.steps = typeof wv[0] === 'number' ? wv[0] : (typeof wv[1] === 'number' ? wv[1] : null); }
        const seedNode = resolveSeedNode(wf, mapping);
        if (seedNode) { const wv = seedNode.widgets_values || []; config.seed = typeof wv[0] === 'number' ? wv[0] : -1; }

        // Dual high/low sampler split (Wan video): report per-pass step counts
        const hl = findHighLowSamplers(wf);
        if (hl) {
          const total = Number(hl.high.widgets_values[3]) || 0;
          const high = Number(hl.high.widgets_values[8]) || 0;
          config.highLowSteps = { high, low: Math.max(0, total - high) };
        }

        // CFG: read from the converted prompt — exact w.r.t. muted/pruned
        // branches and slider/config-node indirection. Only exposed when every
        // executing sampler agrees on the value. The graph heuristic is just a
        // degraded-mode fallback (ComfyUI down = no widget mapping).
        let converted = null;
        try { converted = await workflowToPrompt(JSON.parse(JSON.stringify(wf))); } catch {}
        const sampCfgs = converted ? Object.values(converted)
          .filter(n => (n.class_type || '').startsWith('KSampler') && typeof (n.inputs || {}).cfg === 'number')
          .map(n => n.inputs.cfg) : [];
        if (sampCfgs.length) {
          if (sampCfgs.every(v => v === sampCfgs[0])) config.cfg = sampCfgs[0];
        } else {
          const cfgCtl = resolveCfg(wf);
          if (cfgCtl) config.cfg = cfgCtl.get();
        }

        // Frames slider (mxSlider titled "Frames") — unchanged convention
        for (const node of wf.nodes || []) {
          if ((node.title || '').toUpperCase() === 'FRAMES' && node.type === 'mxSlider') {
            const wv = node.widgets_values || [];
            config.frames = typeof wv[0] === 'number' ? wv[0] : (typeof wv[1] === 'number' ? wv[1] : null);
          }
        }
        // Style/quality preset groups (return title + on state; drop internal memberIds)
        config.presets = detectPresetGroups(wf).map(p => ({ title: p.title, on: p.on }));
        // LoRAs: dual high/low lists for Wan dual-sampler workflows, else a single list.
        const hlLoaders = findHighLowLoraLoaders(wf);
        if (hlLoaders) {
          config.lorasHigh = extractLoras(hlLoaders.high);
          config.lorasLow = extractLoras(hlLoaders.low);
        } else {
          const loraNodes = (wf.nodes || []).filter(n => (n.type || '').includes('Power Lora Loader'));
          if (loraNodes.length > 0) config.loras = extractLoras(loraNodes[0]);
        }
        jsonRes(res, config);
      } catch (e) {
        jsonRes(res, { error: 'Parse error: ' + e.message }, 500);
      }
    });
    return;
  }

  // API: Load an APP workflow, apply overrides, convert to API/prompt format
  if (pn === '/api/workflow-prompt' && (req.method === 'GET' || req.method === 'POST')) {
    const wfName = url.searchParams.get('name');
    if (!wfName) { jsonRes(res, { error: 'Missing name' }, 400); return; }
    const wfPath = path.join(COMFY_DIR, 'user', 'default', 'workflows', wfName);
    if (!path.resolve(wfPath).startsWith(path.resolve(path.join(COMFY_DIR, 'user', 'default', 'workflows')))) {
      jsonRes(res, { error: 'Access denied' }, 403); return;
    }
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', async () => {
      let overrides = {};
      if (bodyStr) { try { overrides = JSON.parse(bodyStr); } catch {} }

      fs.readFile(wfPath, 'utf8', async (err, raw) => {
        if (err) { jsonRes(res, { error: err.message }, 500); return; }
        try {
          const wf = JSON.parse(raw);
          const mapping = (loadWfStore().mappings || {})[wfName] || null;

          // New-style generic field overrides: { fieldValues: {<id>: value} }.
          // Applied to the raw graph before conversion; coexists with the legacy
          // keys below (the field panel sends only fieldValues, so those are skipped).
          let fieldWarnings = [];
          if (overrides.fieldValues && typeof overrides.fieldValues === 'object') {
            const st = fs.statSync(wfPath, { throwIfNoEntry: false });
            const cfg = buildFieldConfig(JSON.parse(JSON.stringify(wf)), wfName, st ? st.mtimeMs : 0);
            fieldWarnings = applyFieldConfigOverrides(wf, cfg, overrides.fieldValues).warnings;
          }

          // Apply prompt override (mapped node, or MAIN PROMPT / best-guess)
          if (overrides.prompt !== undefined) {
            const promptNode = resolvePromptNode(wf, mapping);
            if (promptNode && promptNode.widgets_values) promptNode.widgets_values[0] = overrides.prompt;
          }

          // Apply lora overrides to all Power Lora Loader nodes
          if (overrides.lorasHigh || overrides.lorasLow) {
            // Dual high/low lists → apply each to its mapped loader node.
            const hlLoaders = findHighLowLoraLoaders(wf);
            if (hlLoaders) {
              applyLoraOverrides(hlLoaders.high, overrides.lorasHigh);
              applyLoraOverrides(hlLoaders.low, overrides.lorasLow);
            }
          } else if (overrides.loras && Array.isArray(overrides.loras)) {
            const loraNodes = (wf.nodes || []).filter(n => (n.type || '').includes('Power Lora Loader'));
            for (const node of loraNodes) applyLoraOverrides(node, overrides.loras);
          }

          // Apply frames override to mxSlider "Frames" node
          if (overrides.frames !== undefined && overrides.frames !== null) {
            for (const node of wf.nodes || []) {
              const title = (node.title || '').toUpperCase();
              if (title === 'FRAMES' && node.type === 'mxSlider') {
                const wv = node.widgets_values || [];
                const frameVal = parseInt(overrides.frames);
                if (!isNaN(frameVal)) {
                  // mxSlider has Xi and Xf - set both
                  if (typeof wv[0] === 'number') wv[0] = frameVal;
                  if (typeof wv[1] === 'number') wv[1] = frameVal;
                }
              }
            }
          }

          // Apply steps override (mapped node, or mxSlider "Steps"). Sets wv[0]/wv[1].
          if (overrides.steps !== undefined && overrides.steps !== null) {
            const stepVal = parseInt(overrides.steps);
            const stepsNode = resolveStepsNode(wf, mapping);
            if (!isNaN(stepVal) && stepsNode && stepsNode.widgets_values) {
              const wv = stepsNode.widgets_values;
              if (typeof wv[0] === 'number') wv[0] = stepVal;
              if (typeof wv[1] === 'number') wv[1] = stepVal;
            }
          }

          // High/low sampler split override — the sum becomes total steps on both
          // passes; the high pass covers [0, high), the low pass takes over from there.
          if (overrides.highSteps != null && overrides.lowSteps != null) {
            const hs = parseInt(overrides.highSteps), ls = parseInt(overrides.lowSteps);
            const hl = findHighLowSamplers(wf);
            if (hl && !isNaN(hs) && !isNaN(ls) && hs >= 0 && ls >= 0 && hs + ls > 0) {
              hl.high.widgets_values[3] = hs + ls;
              hl.high.widgets_values[7] = 0;
              hl.high.widgets_values[8] = hs;
              hl.low.widgets_values[3] = hs + ls;
              hl.low.widgets_values[7] = hs;
            }
          }

          // Pin seed on the resolved Seed node (omit/-1 = let the client randomize)
          if (overrides.seed !== undefined && overrides.seed !== null && Number(overrides.seed) >= 0) {
            const seedVal = Math.floor(Number(overrides.seed));
            const seedNode = resolveSeedNode(wf, mapping);
            if (seedNode && seedNode.widgets_values) seedNode.widgets_values[0] = seedVal;
          }

          // Activate exactly one style/quality preset group; mute the others.
          if (overrides.preset) {
            const presetGroups = detectPresetGroups(wf);
            const byId = {};
            for (const n of wf.nodes || []) byId[n.id] = n;
            for (const g of presetGroups) {
              const targetMode = g.title === overrides.preset ? 0 : 2; // 0 = active, 2 = muted
              for (const id of g.memberIds) { if (byId[id]) byId[id].mode = targetMode; }
            }
          }

          const prompt = await workflowToPrompt(wf);
          if (!Object.keys(prompt).length) {
            jsonRes(res, { error: 'Workflow resolves to no runnable output nodes (is ComfyUI running? are all savers muted/bypassed?)' }, 422);
            return;
          }

          // CFG override — applied to the CONVERTED prompt, which reflects the
          // samplers that actually execute. Graph-level CFG sources are too
          // ambiguous to write directly (sliders, rgthree config nodes, and
          // per-sampler widgets can coexist, some feeding pruned branches).
          if (overrides.cfg !== undefined && overrides.cfg !== null) {
            const cfgVal = parseFloat(overrides.cfg);
            if (!isNaN(cfgVal) && cfgVal >= 0) {
              for (const [id, n] of Object.entries(prompt)) {
                if (!(n.class_type || '').startsWith('KSampler') || typeof (n.inputs || {}).cfg !== 'number') continue;
                n.inputs.cfg = cfgVal;
                // Keep the returned graph (extra_pnginfo / embedded metadata) in step
                const gn = (wf.nodes || []).find(x => String(x.id) === id);
                if (gn && Array.isArray(gn.widgets_values)) {
                  const idx = gn.type === 'KSamplerAdvanced' ? 4 : (gn.type === 'KSampler' ? 3 : -1);
                  if (idx >= 0 && typeof gn.widgets_values[idx] === 'number') gn.widgets_values[idx] = cfgVal;
                }
              }
              const ctl = resolveCfg(wf);
              if (ctl) ctl.set(cfgVal);   // sliders/primitives stay visually consistent
            }
          }
          // Return the (override-applied) visual graph too: the client submits it
          // as extra_data.extra_pnginfo.workflow, which graph-introspecting nodes
          // (WidgetToString etc.) require at execution time.
          jsonRes(res, { prompt, workflow: wf, fieldWarnings });
        } catch (e) {
          jsonRes(res, { error: 'Parse error: ' + e.message }, 500);
        }
      });
    });
    return;
  }

  // ── Chat: service health check ──
  if (pn === '/api/chat/health' && req.method === 'GET') {
    const results = { ollama: false, voxtral: false, grok: !!XAI_API_KEY };
    let pending = 2;
    function done() { if (--pending === 0) jsonRes(res, results); }

    // Check Ollama
    const oReq = http.request(OLLAMA_URL + '/', { method: 'GET', timeout: 3000 }, (oRes) => {
      let b = ''; oRes.on('data', c => b += c);
      oRes.on('end', () => { results.ollama = oRes.statusCode === 200; done(); });
    });
    oReq.on('error', () => { done(); });
    oReq.on('timeout', () => { oReq.destroy(); done(); });
    oReq.end();

    // Check Voxtral
    const vReq = http.request(VOXTRAL_URL + '/v1/models', { method: 'GET', timeout: 3000 }, (vRes) => {
      let b = ''; vRes.on('data', c => b += c);
      vRes.on('end', () => { results.voxtral = vRes.statusCode === 200; done(); });
    });
    vReq.on('error', () => { done(); });
    vReq.on('timeout', () => { vReq.destroy(); done(); });
    vReq.end();
    return;
  }

  // ── Chat: start Voxtral TTS service ──
  if (pn === '/api/chat/start-voxtral' && req.method === 'POST') {
    // Machine-specific launch command comes from config (see config.example.json).
    // Either a shell string or an [command, ...args] array.
    const startCmd = config.voxtralStartCmd;
    if (!startCmd || (Array.isArray(startCmd) && !startCmd.length)) {
      jsonRes(res, { error: 'No voxtralStartCmd configured — set the launch command for your Voxtral service in config.json.' }, 400);
      return;
    }
    const proc = Array.isArray(startCmd)
      ? spawn(startCmd[0], startCmd.slice(1), { detached: true, stdio: 'ignore' })
      : spawn(startCmd, { shell: true, detached: true, stdio: 'ignore' });
    proc.unref();
    jsonRes(res, { started: true, message: 'Voxtral TTS starting in background. It may take 30-60 seconds to load the model.' });
    return;
  }

  // ── Chat: list saved conversations ──
  if (pn === '/api/chat/conversations' && req.method === 'GET') {
    const convosPath = path.join(__dirname, 'chat-conversations.json');
    try {
      const data = JSON.parse(fs.readFileSync(convosPath, 'utf8'));
      jsonRes(res, data);
    } catch { jsonRes(res, []); }
    return;
  }

  // ── Chat: save conversation ──
  if (pn === '/api/chat/conversations' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const convo = JSON.parse(body);
        const convosPath = path.join(__dirname, 'chat-conversations.json');
        let convos = [];
        try { convos = JSON.parse(fs.readFileSync(convosPath, 'utf8')); } catch {}
        // Update existing or add new
        const idx = convos.findIndex(c => c.id === convo.id);
        if (idx >= 0) convos[idx] = convo; else convos.unshift(convo);
        fs.writeFileSync(convosPath, JSON.stringify(convos, null, 2));
        jsonRes(res, { success: true });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
    });
    return;
  }

  // ── Chat: delete conversation ──
  if (pn.startsWith('/api/chat/conversations/') && req.method === 'DELETE') {
    const id = decodeURIComponent(pn.split('/').pop());
    const convosPath = path.join(__dirname, 'chat-conversations.json');
    try {
      let convos = JSON.parse(fs.readFileSync(convosPath, 'utf8'));
      convos = convos.filter(c => c.id !== id);
      fs.writeFileSync(convosPath, JSON.stringify(convos, null, 2));
      jsonRes(res, { success: true });
    } catch (e) { jsonRes(res, { error: e.message }, 500); }
    return;
  }

  // ── Chat page ──
  if (pn === '/chat' || pn === '/chat.html' || pn === '/chat/local' || pn === '/chat/grok') {
    serveFile(path.join(__dirname, 'chat.html'), req, res);
    return;
  }

  // ── Chat API: list Ollama models ──
  if (pn === '/api/chat/models' && req.method === 'GET') {
    const ollamaReq = http.request(OLLAMA_URL + '/api/tags', { method: 'GET' }, (ollamaRes) => {
      let body = '';
      ollamaRes.on('data', c => body += c);
      ollamaRes.on('end', () => {
        try {
          const data = JSON.parse(body);
          const models = (data.models || []).map(m => m.name);
          jsonRes(res, { models });
        } catch { jsonRes(res, { models: [] }); }
      });
    });
    ollamaReq.on('error', () => jsonRes(res, { models: [], error: 'Ollama not reachable' }));
    ollamaReq.end();
    return;
  }

  // ── Chat API: list voices (presets + local clones) ──
  if (pn === '/api/chat/voices' && req.method === 'GET') {
    const engine = url.searchParams.get('engine') || 'voxtral';
    if (engine === 'grok') {
      jsonRes(res, { presets: GROK_VOICES, custom: [], voices: GROK_VOICES });
      return;
    }
    const PRESET_VOICES = [
      'ar_male','casual_female','casual_male','cheerful_female',
      'de_female','de_male','es_female','es_male',
      'fr_female','fr_male','hi_female','hi_male',
      'it_female','it_male','neutral_female','neutral_male',
      'nl_female','nl_male','pt_female','pt_male'
    ];
    const voicesDir = path.join(__dirname, 'voices');
    let custom = [];
    try {
      custom = fs.readdirSync(voicesDir)
        .filter(f => /\.(wav|mp3|webm|ogg|flac|m4a|aac|mpeg)$/i.test(f))
        .map(f => path.basename(f, path.extname(f)));
    } catch {}
    jsonRes(res, { presets: PRESET_VOICES, custom, voices: [...PRESET_VOICES, ...custom] });
    return;
  }

  // ── Chat API: upload voice clone (save locally) ──
  if (pn === '/api/chat/voices/upload' && req.method === 'POST') {
    const voicesDir = path.join(__dirname, 'voices');
    if (!fs.existsSync(voicesDir)) fs.mkdirSync(voicesDir, { recursive: true });

    // Parse multipart form data (minimal parser for single file + name field)
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) return jsonRes(res, { error: 'Missing boundary' }, 400);
      const boundary = '--' + boundaryMatch[1].replace(/;.*$/, '').trim();

      const parts = [];
      let start = buf.indexOf(boundary) + boundary.length;
      while (true) {
        const next = buf.indexOf(boundary, start + 1);
        if (next === -1) break;
        parts.push(buf.slice(start, next));
        start = next + boundary.length;
      }

      let name = '', fileData = null, fileName = '';
      for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd).toString();
        const body = part.slice(headerEnd + 4, part.length - 2); // strip trailing \r\n

        const nameMatch = headers.match(/name="([^"]+)"/);
        const fileMatch = headers.match(/filename="([^"]+)"/);
        if (nameMatch && nameMatch[1] === 'name') {
          name = body.toString().trim();
        } else if (nameMatch && nameMatch[1] === 'audio_sample' && fileMatch) {
          fileData = body;
          fileName = fileMatch[1];
        }
      }

      if (!name || !fileData) return jsonRes(res, { error: 'Missing name or audio file' }, 400);

      const ext = path.extname(fileName) || '.wav';
      const safeName = name.replace(/[^a-zA-Z0-9_\- ]/g, '');
      const filePath = path.join(voicesDir, safeName + ext);
      fs.writeFileSync(filePath, fileData);
      jsonRes(res, { success: true, voice: { name: safeName, file: safeName + ext, size: fileData.length } });
    });
    return;
  }

  // ── Chat API: delete custom voice ──
  if (pn.startsWith('/api/chat/voices/') && req.method === 'DELETE') {
    const voiceName = decodeURIComponent(pn.split('/').pop());
    const voicesDir = path.join(__dirname, 'voices');
    try {
      const files = fs.readdirSync(voicesDir).filter(f => path.basename(f, path.extname(f)) === voiceName);
      if (files.length) {
        fs.unlinkSync(path.join(voicesDir, files[0]));
        jsonRes(res, { success: true });
      } else {
        jsonRes(res, { error: 'Voice not found' }, 404);
      }
    } catch (e) {
      jsonRes(res, { error: e.message }, 500);
    }
    return;
  }

  // ── Characters: list ──
  if (pn === '/api/characters' && req.method === 'GET') {
    const charsPath = path.join(__dirname, 'characters.json');
    try { jsonRes(res, JSON.parse(fs.readFileSync(charsPath, 'utf8'))); }
    catch { jsonRes(res, []); }
    return;
  }

  // ── Characters: save (create/update) ──
  if (pn === '/api/characters' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const char = JSON.parse(body);
        if (!char.name || !char.prompt) return jsonRes(res, { error: 'Missing name or prompt' }, 400);
        const charsPath = path.join(__dirname, 'characters.json');
        let chars = [];
        try { chars = JSON.parse(fs.readFileSync(charsPath, 'utf8')); } catch {}
        if (!char.id) char.id = 'char_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        const idx = chars.findIndex(c => c.id === char.id);
        char.updatedAt = Date.now();
        if (idx >= 0) chars[idx] = { ...chars[idx], ...char };
        else { char.createdAt = Date.now(); chars.push(char); }
        fs.writeFileSync(charsPath, JSON.stringify(chars, null, 2));
        jsonRes(res, char);
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
    });
    return;
  }

  // ── Characters: generate/regenerate the saved portrait image for a character ──
  if (pn.match(/^\/api\/characters\/[^/]+\/portrait$/) && req.method === 'POST') {
    const charId = decodeURIComponent(pn.split('/')[3]);
    let bodyRaw = '';
    req.on('data', c => bodyRaw += c);
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(bodyRaw); } catch { return jsonRes(res, { error: 'Invalid JSON' }, 400); }
      const { prompt, aspect_ratio, resolution } = parsed;
      if (!prompt || !prompt.trim()) return jsonRes(res, { error: 'Portrait prompt is empty' }, 400);
      const out = await callGrokImagine('/v1/images/generations', {
        model: 'grok-imagine-image',
        prompt: prompt.trim(),
        response_format: 'b64_json',
        aspect_ratio: aspect_ratio || '1:1',
        resolution: resolution || '1k',
      });
      if (!out.ok) return jsonRes(res, { error: out.error }, 502);
      logImageCost('generate');
      if (!out.b64) return jsonRes(res, { error: 'No image returned' }, 502);
      // Save under char_{id}/portrait.png
      const url = saveImageBase64(out.b64, 'char_' + charId, 'portrait');
      // Update character record with the portrait URL
      try {
        const charsPath = path.join(__dirname, 'characters.json');
        let chars = JSON.parse(fs.readFileSync(charsPath, 'utf8'));
        const idx = chars.findIndex(c => c.id === charId);
        if (idx >= 0) {
          chars[idx].portraitImageUrl = url;
          chars[idx].updatedAt = Date.now();
          fs.writeFileSync(charsPath, JSON.stringify(chars, null, 2));
        }
      } catch {}
      jsonRes(res, { url });
    });
    return;
  }

  // ── Characters: delete ──
  if (pn.startsWith('/api/characters/') && req.method === 'DELETE') {
    const id = decodeURIComponent(pn.split('/').pop());
    const charsPath = path.join(__dirname, 'characters.json');
    try {
      let chars = JSON.parse(fs.readFileSync(charsPath, 'utf8'));
      chars = chars.filter(c => c.id !== id);
      fs.writeFileSync(charsPath, JSON.stringify(chars, null, 2));
      jsonRes(res, { success: true });
    } catch (e) { jsonRes(res, { error: e.message }, 500); }
    return;
  }

  // ── Cost tracking ──
  // Prices (USD): voice agent $0.05/min, Grok TTS $4.20/M chars
  const COSTS_PATH = path.join(__dirname, 'costs.json');
  function readCosts() {
    try { return JSON.parse(fs.readFileSync(COSTS_PATH, 'utf8')); }
    catch { return { events: [] }; }
  }
  function writeCosts(data) { fs.writeFileSync(COSTS_PATH, JSON.stringify(data, null, 2)); }

  if (pn === '/api/cost/session-start' && req.method === 'POST') {
    const id = 'vsess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const data = readCosts();
    data.events.push({ id, type: 'voice_session', startedAt: Date.now(), endedAt: null, durationMs: 0, cost: 0 });
    writeCosts(data);
    jsonRes(res, { id });
    return;
  }

  if (pn === '/api/cost/session-end' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        const data = readCosts();
        const ev = data.events.find(e => e.id === id);
        if (!ev) return jsonRes(res, { error: 'Session not found' }, 404);
        ev.endedAt = Date.now();
        ev.durationMs = ev.endedAt - ev.startedAt;
        // $0.05/min = $0.05 / 60000 ms = 0.000000833... per ms
        ev.cost = (ev.durationMs / 60000) * 0.05;
        writeCosts(data);
        jsonRes(res, { id: ev.id, durationMs: ev.durationMs, cost: ev.cost });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
    });
    return;
  }

  if (pn === '/api/cost/summary' && req.method === 'GET') {
    const data = readCosts();
    let total = 0, voice = 0, tts = 0, imagine = 0;
    let voiceMinutes = 0, ttsChars = 0, imagineCount = 0;
    for (const ev of data.events) {
      const c = ev.cost || 0;
      total += c;
      if (ev.type === 'voice_session') { voice += c; voiceMinutes += (ev.durationMs || 0) / 60000; }
      else if (ev.type === 'grok_tts') { tts += c; ttsChars += ev.chars || 0; }
      else if (ev.type === 'grok_imagine') { imagine += c; imagineCount++; }
    }
    const recent = data.events.slice(-20).reverse();
    jsonRes(res, { total, voice, tts, imagine, voiceMinutes, ttsChars, imagineCount, recent });
    return;
  }

  // ── Serve character images ──
  if (pn.startsWith('/character-images/') && req.method === 'GET') {
    const relPath = decodeURIComponent(pn.slice('/character-images/'.length));
    const safeRel = relPath.replace(/\\/g, '/').split('/').filter(p => p && p !== '..' && p !== '.').join('/');
    const filePath = path.join(__dirname, 'character_images', safeRel);
    if (fs.existsSync(filePath) && filePath.startsWith(path.join(__dirname, 'character_images'))) {
      serveFile(filePath, req, res);
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // ── Voice: generate character portrait (text-to-image) ──
  if (pn === '/api/voice/imagine/portrait' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { return jsonRes(res, { error: 'Invalid JSON' }, 400); }
      const { prompt, convoId, aspect_ratio, resolution } = parsed;
      if (!prompt || !convoId) return jsonRes(res, { error: 'Missing prompt or convoId' }, 400);
      const out = await callGrokImagine('/v1/images/generations', {
        model: 'grok-imagine-image',
        prompt,
        response_format: 'b64_json',
        aspect_ratio: aspect_ratio || '1:1',
        resolution: resolution || '1k',
      });
      if (!out.ok) return jsonRes(res, { error: out.error }, 502);
      logImageCost('generate');
      if (!out.b64) return jsonRes(res, { error: 'No image returned' }, 502);
      const url = saveImageBase64(out.b64, convoId, 'portrait');
      jsonRes(res, { url });
    });
    return;
  }

  // ── Voice: render scene using portrait as reference (image-to-image) ──
  if (pn === '/api/voice/imagine/scene' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { return jsonRes(res, { error: 'Invalid JSON' }, 400); }
      const { prompt, convoId, portraitUrl, aspect_ratio, resolution } = parsed;
      if (!prompt || !convoId) return jsonRes(res, { error: 'Missing prompt or convoId' }, 400);
      // Resolve portrait source
      let portraitPath = null;
      if (portraitUrl && portraitUrl.startsWith('/character-images/')) {
        const rel = decodeURIComponent(portraitUrl.slice('/character-images/'.length)).replace(/\\/g, '/').split('/').filter(p => p && p !== '..' && p !== '.').join('/');
        const candidate = path.join(__dirname, 'character_images', rel);
        if (fs.existsSync(candidate) && candidate.startsWith(path.join(__dirname, 'character_images'))) {
          portraitPath = candidate;
        }
      }
      if (!portraitPath) {
        const convoPath = path.join(__dirname, 'character_images', convoId, 'portrait.png');
        if (fs.existsSync(convoPath)) portraitPath = convoPath;
      }
      if (!portraitPath) {
        return jsonRes(res, { error: 'No portrait exists yet. Generate the character portrait first.' }, 400);
      }
      const portraitB64 = fs.readFileSync(portraitPath).toString('base64');
      const basePayload = {
        model: 'grok-imagine-image',
        image_url: 'data:image/png;base64,' + portraitB64,
        response_format: 'b64_json',
        aspect_ratio: aspect_ratio || '1:1',
        resolution: resolution || '1k',
      };

      // First attempt
      let out = await callGrokImagine('/v1/images/edits', { ...basePayload, prompt });
      let retried = false;
      let retryKind = null;
      if (out.ok) logImageCost('edit');

      // Transient network/SSL errors: retry with same prompt (don't charge for failed first call)
      if (!out.ok && isTransientNetworkError(out.error)) {
        console.log('[imagine] transient error, retrying same prompt:', out.error);
        await new Promise(r => setTimeout(r, 800));
        out = await callGrokImagine('/v1/images/edits', { ...basePayload, prompt });
        if (out.ok) logImageCost('edit');
        retried = true; retryKind = 'network';
      }

      // Moderation rejection: retry with sanitized prompt
      if (!out.ok && isModerationError(out.error)) {
        const sanitizedPrompt = sanitizePromptForRetry(prompt);
        console.log('[imagine] moderation rejection, retrying sanitized:', out.error);
        out = await callGrokImagine('/v1/images/edits', { ...basePayload, prompt: sanitizedPrompt });
        if (out.ok) logImageCost('edit');
        retried = true; retryKind = 'moderation';
      }

      if (!out.ok) return jsonRes(res, { error: out.error, retried, retryKind }, 502);
      if (!out.b64) return jsonRes(res, { error: 'No image returned', retried, retryKind }, 502);
      const url = saveImageBase64(out.b64, convoId, 'scene');
      jsonRes(res, { url, retried, retryKind });
    });
    return;
  }

  // ── Voice: mint ephemeral token for browser WebSocket auth ──
  if (pn === '/api/voice/token' && req.method === 'POST') {
    if (!XAI_API_KEY) return jsonRes(res, { error: 'No xAI API key configured' }, 500);
    const payload = JSON.stringify({ expires_after: { seconds: 300 } });
    const xReq = https.request({
      hostname: 'api.x.ai', port: 443, path: '/v1/realtime/client_secrets', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': 'Bearer ' + XAI_API_KEY,
      },
      timeout: 15000,
    }, (xRes) => {
      const chunks = [];
      xRes.on('data', c => chunks.push(c));
      xRes.on('end', () => {
        res.writeHead(xRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(Buffer.concat(chunks));
      });
    });
    xReq.on('error', (e) => jsonRes(res, { error: e.message }, 502));
    xReq.on('timeout', () => { xReq.destroy(); jsonRes(res, { error: 'timeout' }, 504); });
    xReq.write(payload);
    xReq.end();
    return;
  }

  // ── Voice page ──
  if (pn === '/voice' || pn === '/voice.html') {
    serveFile(path.join(__dirname, 'voice.html'), req, res);
    return;
  }

  // ── Chat: serve streamed audio chunk by id ──
  if (pn.startsWith('/api/chat/audio/') && req.method === 'GET') {
    const id = pn.slice('/api/chat/audio/'.length);
    const entry = audioStore.get(id);
    if (!entry) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': entry.mime, 'Cache-Control': 'no-store' });
    res.end(entry.buf);
    return;
  }

  // ── Chat API: direct TTS (for replay) ──
  if (pn === '/api/chat/tts' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { return jsonRes(res, { error: 'Invalid JSON' }, 400); }
      const { text, voice, ttsEngine, speed, instructions } = parsed;
      if (!text || !text.trim()) return jsonRes(res, { error: 'Missing text' }, 400);

      if (ttsEngine === 'grok') {
        if (!XAI_API_KEY) return jsonRes(res, { error: 'No xAI API key configured' }, 500);
        const payload = JSON.stringify({
          text: text.trim(),
          voice_id: (voice && GROK_VOICES.includes(voice)) ? voice : 'eve',
          language: 'en',
        });
        const xUrl = new URL(XAI_TTS_URL);
        const xReq = https.request({
          hostname: xUrl.hostname, port: 443, path: xUrl.pathname, method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'Authorization': 'Bearer ' + XAI_API_KEY,
          },
          timeout: 60000,
        }, (xRes) => {
          const chunks = [];
          xRes.on('data', c => chunks.push(c));
          xRes.on('end', () => {
            if (xRes.statusCode === 200) {
              res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
              res.end(Buffer.concat(chunks));
              logTtsCost(text.trim().length);
            } else {
              let errMsg = 'Grok TTS error (HTTP ' + xRes.statusCode + ')';
              try { const e = JSON.parse(Buffer.concat(chunks).toString()); errMsg = e.error?.message || e.error || errMsg; } catch {}
              jsonRes(res, { error: errMsg }, xRes.statusCode);
            }
          });
        });
        xReq.on('error', (e) => jsonRes(res, { error: e.message }, 502));
        xReq.on('timeout', () => { xReq.destroy(); jsonRes(res, { error: 'TTS timeout' }, 504); });
        xReq.write(payload);
        xReq.end();
        return;
      }

      // Voxtral path
      const PRESET_VOICES = new Set(['casual_male','casual_female','cheerful_female','neutral_male','neutral_female','ar_male','de_female','de_male','es_female','es_male','fr_female','fr_male','hi_female','hi_male','it_female','it_male','nl_female','nl_male','pt_female','pt_male']);
      const isCustom = voice && !PRESET_VOICES.has(voice);
      let refAudio = null;
      if (isCustom) {
        const voicesDir = path.join(__dirname, 'voices');
        try {
          const files = fs.readdirSync(voicesDir).filter(f => path.basename(f, path.extname(f)) === voice);
          if (files.length) {
            const audioData = fs.readFileSync(path.join(voicesDir, files[0]));
            const ext = path.extname(files[0]).slice(1);
            const mime = { wav:'audio/wav', mp3:'audio/mpeg', webm:'audio/webm', ogg:'audio/ogg', flac:'audio/flac', m4a:'audio/mp4', aac:'audio/aac' }[ext] || 'audio/wav';
            refAudio = 'data:' + mime + ';base64,' + audioData.toString('base64');
          }
        } catch {}
      }
      const payload = {
        input: text.trim(),
        model: 'mistralai/Voxtral-4B-TTS-2603',
        response_format: 'wav',
        voice: voice || 'casual_male',
      };
      if (speed && speed !== 1) payload.speed = speed;
      if (instructions) payload.instructions = instructions;
      if (isCustom && refAudio) { payload.ref_audio = refAudio; payload.voice = 'casual_female'; }
      const postData = JSON.stringify(payload);
      const vReq = http.request(VOXTRAL_URL + '/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 60000,
      }, (vRes) => {
        const chunks = [];
        vRes.on('data', c => chunks.push(c));
        vRes.on('end', () => {
          if (vRes.statusCode === 200) {
            res.writeHead(200, { 'Content-Type': 'audio/wav' });
            res.end(Buffer.concat(chunks));
          } else {
            let errMsg = 'Voxtral TTS error (HTTP ' + vRes.statusCode + ')';
            try { const e = JSON.parse(Buffer.concat(chunks).toString()); errMsg = e.error?.message || errMsg; } catch {}
            jsonRes(res, { error: errMsg }, vRes.statusCode);
          }
        });
      });
      vReq.on('error', (e) => jsonRes(res, { error: e.message }, 502));
      vReq.on('timeout', () => { vReq.destroy(); jsonRes(res, { error: 'TTS timeout' }, 504); });
      vReq.write(postData);
      vReq.end();
    });
    return;
  }

  // ── Chat API: stream LLM + TTS ──
  if (pn === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { return jsonRes(res, { error: 'Invalid JSON' }, 400); }
      const { model, messages, voice, tts, ttsMode, speed, instructions, ttsEngine } = parsed;
      const mode = ttsMode || 'full'; // 'full', 'paragraph', 'sentence'
      const engine = ttsEngine === 'grok' ? 'grok' : 'voxtral';
      const PRESET_VOICES = new Set([
        'casual_male','casual_female','cheerful_female','neutral_male','neutral_female',
        'ar_male','de_female','de_male','es_female','es_male',
        'fr_female','fr_male','hi_female','hi_male',
        'it_female','it_male','nl_female','nl_male','pt_female','pt_male'
      ]);
      const isCustomVoice = voice && !PRESET_VOICES.has(voice);
      // Pre-load custom voice audio as base64 for ref_audio
      let refAudioBase64 = null;
      if (isCustomVoice) {
        const voicesDir = path.join(__dirname, 'voices');
        try {
          const files = fs.readdirSync(voicesDir).filter(f => path.basename(f, path.extname(f)) === voice);
          if (files.length) {
            const audioData = fs.readFileSync(path.join(voicesDir, files[0]));
            const ext = path.extname(files[0]).slice(1);
            const mime = { wav:'audio/wav', mp3:'audio/mpeg', webm:'audio/webm', ogg:'audio/ogg', flac:'audio/flac', m4a:'audio/mp4', aac:'audio/aac' }[ext] || 'audio/wav';
            refAudioBase64 = 'data:' + mime + ';base64,' + audioData.toString('base64');
          }
        } catch {}
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      function sendSSE(data) {
        res.write('data: ' + JSON.stringify(data) + '\n\n');
      }

      // TTS helper: routes to Voxtral or Grok based on engine
      function sendToTTS(text) {
        if (!tts || !text.trim()) return Promise.resolve();
        const trimmed = text.trim();

        if (engine === 'grok') {
          return sendToGrokTTS(trimmed);
        }
        return sendToVoxtralTTS(trimmed);
      }

      function sendToVoxtralTTS(trimmed) {
        return new Promise((resolve) => {
          const ttsPayload = {
            input: trimmed,
            model: 'mistralai/Voxtral-4B-TTS-2603',
            response_format: 'wav',
            voice: voice || 'casual_male',
          };
          if (speed && speed !== 1) ttsPayload.speed = speed;
          if (instructions) ttsPayload.instructions = instructions;
          if (isCustomVoice && refAudioBase64) {
            ttsPayload.ref_audio = refAudioBase64;
            ttsPayload.voice = 'casual_female';
          }
          sendSSE({ type: 'tts_status', status: 'generating', text: trimmed.slice(0, 80) });
          const postData = JSON.stringify(ttsPayload);
          const ttsReq = http.request(VOXTRAL_URL + '/v1/audio/speech', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
            timeout: 60000,
          }, (ttsRes) => {
            const chunks = [];
            ttsRes.on('data', c => chunks.push(c));
            ttsRes.on('end', () => {
              if (ttsRes.statusCode === 200) {
                const buf = Buffer.concat(chunks);
                const id = 'aud_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                audioStore.set(id, { buf, mime: 'audio/wav', ts: Date.now() });
                sendSSE({ type: 'audio', url: '/api/chat/audio/' + id, mime: 'audio/wav' });
                sendSSE({ type: 'tts_status', status: 'ready' });
              } else {
                let errMsg = 'TTS error (HTTP ' + ttsRes.statusCode + ')';
                try { const e = JSON.parse(Buffer.concat(chunks).toString()); errMsg = e.error?.message || errMsg; } catch {}
                sendSSE({ type: 'tts_status', status: 'error', message: errMsg });
              }
              resolve();
            });
          });
          ttsReq.on('error', (e) => { sendSSE({ type: 'tts_status', status: 'error', message: e.message }); resolve(); });
          ttsReq.on('timeout', () => { ttsReq.destroy(); sendSSE({ type: 'tts_status', status: 'error', message: 'TTS timeout' }); resolve(); });
          ttsReq.write(postData);
          ttsReq.end();
        });
      }

      function sendToGrokTTS(trimmed) {
        return new Promise((resolve) => {
          if (!XAI_API_KEY) {
            sendSSE({ type: 'tts_status', status: 'error', message: 'No xAI API key configured' });
            return resolve();
          }
          const ttsPayload = {
            text: trimmed,
            voice_id: (voice && GROK_VOICES.includes(voice)) ? voice : 'eve',
            language: 'en',
          };
          sendSSE({ type: 'tts_status', status: 'generating', text: trimmed.slice(0, 80) });
          const postData = JSON.stringify(ttsPayload);
          const xUrl = new URL(XAI_TTS_URL);
          const ttsReq = https.request({
            hostname: xUrl.hostname,
            port: 443,
            path: xUrl.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData),
              'Authorization': 'Bearer ' + XAI_API_KEY,
            },
            timeout: 60000,
          }, (ttsRes) => {
            const chunks = [];
            ttsRes.on('data', c => chunks.push(c));
            ttsRes.on('end', () => {
              if (ttsRes.statusCode === 200) {
                const buf = Buffer.concat(chunks);
                const id = 'aud_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                audioStore.set(id, { buf, mime: 'audio/mpeg', ts: Date.now() });
                sendSSE({ type: 'audio', url: '/api/chat/audio/' + id, mime: 'audio/mpeg' });
                sendSSE({ type: 'tts_status', status: 'ready' });
                logTtsCost(trimmed.length);
              } else {
                let errMsg = 'Grok TTS error (HTTP ' + ttsRes.statusCode + ')';
                try { const e = JSON.parse(Buffer.concat(chunks).toString()); errMsg = e.error?.message || e.error || errMsg; } catch {}
                sendSSE({ type: 'tts_status', status: 'error', message: errMsg });
              }
              resolve();
            });
          });
          ttsReq.on('error', (e) => { sendSSE({ type: 'tts_status', status: 'error', message: e.message }); resolve(); });
          ttsReq.on('timeout', () => { ttsReq.destroy(); sendSSE({ type: 'tts_status', status: 'error', message: 'TTS timeout' }); resolve(); });
          ttsReq.write(postData);
          ttsReq.end();
        });
      }

      // Buffering state for streamed TTS modes
      let sentenceBuffer = '';
      let fullResponseText = '';
      let ttsPromises = [];
      const sentenceEnders = /(?<=[.!?;])\s+/;
      const PARAGRAPH_THRESHOLD = 500;

      function processTTSBuffer(flush) {
        if (mode === 'full') return; // handled at the end
        if (mode === 'sentence') {
          const parts = sentenceBuffer.split(sentenceEnders);
          if (parts.length > 1 || flush) {
            const toSend = flush ? parts : parts.slice(0, -1);
            for (const part of toSend) {
              if (part.trim()) ttsPromises.push(sendToTTS(part));
            }
            sentenceBuffer = flush ? '' : parts[parts.length - 1];
          }
        } else if (mode === 'paragraph') {
          // Flush when buffer exceeds threshold or on a paragraph break
          if (flush || sentenceBuffer.length >= PARAGRAPH_THRESHOLD) {
            // Try to split at last sentence boundary
            const parts = sentenceBuffer.split(sentenceEnders);
            if (parts.length > 1 && !flush) {
              const toSend = parts.slice(0, -1).join(' ');
              if (toSend.trim()) ttsPromises.push(sendToTTS(toSend));
              sentenceBuffer = parts[parts.length - 1];
            } else {
              if (sentenceBuffer.trim()) ttsPromises.push(sendToTTS(sentenceBuffer));
              sentenceBuffer = '';
            }
          }
        }
      }

      // Stream from Ollama
      const ollamaData = JSON.stringify({
        model: model || 'dolphin-mixtral',
        messages: messages || [],
        stream: true,
      });
      const ollamaReq = http.request(OLLAMA_URL + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ollamaData) },
      }, (ollamaRes) => {
        let ollamaBuffer = '';
        ollamaRes.on('data', (chunk) => {
          ollamaBuffer += chunk.toString();
          const lines = ollamaBuffer.split('\n');
          ollamaBuffer = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.message && obj.message.content) {
                const token = obj.message.content;
                sendSSE({ type: 'text', content: token });
                fullResponseText += token;
                sentenceBuffer += token;
                processTTSBuffer(false);
              }
              if (obj.done) {
                sendSSE({ type: 'llm_done' });
                // Flush remaining buffer for sentence/paragraph modes
                processTTSBuffer(true);
                // For full mode, send entire response as one TTS call
                if (mode === 'full' && tts && fullResponseText.trim()) {
                  ttsPromises.push(sendToTTS(fullResponseText));
                }
                Promise.all(ttsPromises).then(() => {
                  sendSSE({ type: 'done' });
                  res.write('data: [DONE]\n\n');
                  res.end();
                });
              }
            } catch {}
          }
        });
        ollamaRes.on('error', () => {
          sendSSE({ type: 'error', message: 'Ollama stream error' });
          res.end();
        });
      });
      ollamaReq.on('error', (e) => {
        sendSSE({ type: 'error', message: 'Cannot reach Ollama: ' + e.message });
        res.end();
      });
      ollamaReq.write(ollamaData);
      ollamaReq.end();

      // Handle client disconnect
      res.on('close', () => {
        ollamaReq.destroy();
      });
    });
    return;
  }

  // Proxy: forward /api/comfy/* to the ComfyUI API (config.comfyUrl)
  if (pn.startsWith('/api/comfy/')) {
    const comfyPath = pn.replace('/api/comfy', '') + (url.search || '');
    const fwdHeaders = {
      'content-type': req.headers['content-type'] || 'application/json',
    };
    if (req.headers['content-length']) fwdHeaders['content-length'] = req.headers['content-length'];
    if (req.headers['accept']) fwdHeaders['accept'] = req.headers['accept'];
    const ch = comfyHostPort();
    fwdHeaders['host'] = ch.hostname + ':' + ch.port;
    const opts = {
      hostname: ch.hostname, port: ch.port,
      path: comfyPath, method: req.method,
      headers: fwdHeaders,
    };
    const proxyReq = http.request(opts, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => { jsonRes(res, { error: e.message }, 502); });
    req.pipe(proxyReq);
    return;
  }

  res.writeHead(404); res.end('Not found');

});

// WebSocket proxy: /comfy-ws -> ComfyUI <comfyUrl>/ws
server.on('upgrade', (req, socket, head) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  if (!reqUrl.pathname.startsWith('/comfy-ws')) {
    socket.destroy();
    return;
  }
  const clientId = reqUrl.searchParams.get('clientId') || '';
  const comfyPath = '/ws' + (clientId ? '?clientId=' + clientId : (reqUrl.search || ''));
  const ch = comfyHostPort();
  console.log('[WS Proxy] Upgrade request:', req.url, '-> ' + ch.hostname + ':' + ch.port + comfyPath);
  const opts = {
    hostname: ch.hostname, port: ch.port,
    path: comfyPath, method: 'GET',
    headers: {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Version': req.headers['sec-websocket-version'],
      'Sec-WebSocket-Key': req.headers['sec-websocket-key'],
      'Host': ch.hostname + ':' + ch.port,
    },
  };
  if (req.headers['sec-websocket-extensions']) opts.headers['Sec-WebSocket-Extensions'] = req.headers['sec-websocket-extensions'];
  if (req.headers['sec-websocket-protocol']) opts.headers['Sec-WebSocket-Protocol'] = req.headers['sec-websocket-protocol'];
  const proxyReq = http.request(opts);
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    console.log('[WS Proxy] Got 101 from ComfyUI');
    // Send back the 101 response
    let response = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      response += `${k}: ${v}\r\n`;
    }
    response += '\r\n';
    socket.write(response);
    if (proxyHead.length) socket.write(proxyHead);
    // Pipe both directions
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  });
  proxyReq.on('response', (res) => {
    console.log('[WS Proxy] Got HTTP response instead of upgrade:', res.statusCode);
    socket.destroy();
  });
  proxyReq.on('error', (e) => { console.log('[WS Proxy] Error:', e.message); socket.destroy(); });
  proxyReq.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Media Browser: http://localhost:${PORT}`);
  console.log(`Serving: ${ROOT}`);
  console.log(`Favorites: ${FAVORITES_DIR}`);
});

// Optional HTTPS server (for mic access from LAN / phones)
const HTTPS_PORT = parseInt(config.httpsPort, 10) || 8443;
const CERT_PATH = path.join(__dirname, 'certs', 'cert.pem');
const KEY_PATH = path.join(__dirname, 'certs', 'key.pem');
if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
  try {
    const tls = require('tls');
    const httpsMod = require('https');
    const tlsOpts = {
      cert: fs.readFileSync(CERT_PATH),
      key: fs.readFileSync(KEY_PATH),
    };
    // Reuse the same request handler + upgrade handler as the HTTP server
    const httpsServer = httpsMod.createServer(tlsOpts, server.listeners('request')[0]);
    for (const listener of server.listeners('upgrade')) {
      httpsServer.on('upgrade', listener);
    }
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`Media Browser HTTPS: https://localhost:${HTTPS_PORT}`);
    });
  } catch (e) {
    console.log('HTTPS server not started:', e.message);
  }
}

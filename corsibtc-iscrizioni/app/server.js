'use strict';
/*
 * Iscrizioni corsi - app self-hosted, zero dipendenze (solo Node >= 22.13).
 *  - Server PUBBLICO  (PUBLIC_PORT, default 3000): elenco corsi e modulo iscrizione.
 *  - Server ADMIN     (ADMIN_PORT,  default 3001): pannello privato, NON va esposto con il tunnel.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const qrcode = require('./lib/qrcode.js');

const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || 3000);
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 3001);
const DATA_DIR = process.env.DATA_DIR || '/data';

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'corsi.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    level TEXT NOT NULL,
    city TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    slots TEXT NOT NULL DEFAULT '',
    min_n INTEGER NOT NULL,
    max_n INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    confirmed_date TEXT NOT NULL DEFAULT '',
    notified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    slots TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    UNIQUE (course_id, email)
  );
`);
// colonne aggiunte nelle versioni successive: si aggiungono ai database già esistenti senza toccare i dati
function addColumns(table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, def] of Object.entries(cols)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}
const TXT = "TEXT NOT NULL DEFAULT ''";
const FLAG = 'INTEGER NOT NULL DEFAULT 0';
addColumns('courses', {
  teachers: TXT, deadline: TXT, schedule: TXT, price: TXT, requirements: TXT, program: TXT, contact_email: TXT,
  show_location: FLAG, phone_required: FLAG, prepay_text: TXT, btc_address: TXT, ln_address: TXT,
});
addColumns('courses', { cover: TXT, ask_company: FLAG, ask_source: FLAG, ask_waitlist: FLAG });
addColumns('registrations', { payment: TXT, paid: FLAG, company: TXT, source: TXT, waitlist: FLAG });
const COURSE_FIELDS = ['level', 'city', 'location', 'title', 'description', 'slots', 'min_n', 'max_n', 'teachers', 'deadline', 'schedule',
  'price', 'requirements', 'program', 'contact_email', 'show_location', 'phone_required', 'prepay_text', 'btc_address', 'ln_address', 'cover',
  'ask_company', 'ask_source', 'ask_waitlist'];
// "Come hai conosciuto questo corso?": le scelte del vecchio modulo; "Altro" ha un campo libero
const SOURCES = ['Amico o invito diretto', 'Telegram', 'Locandina', 'WhatsApp', 'Facebook o Instagram', 'Altro'];

/* ---------- immagini di copertina (salvate nella cartella dei dati, quindi nei backup) ---------- */
const IMG_DIR = path.join(DATA_DIR, 'img');
fs.mkdirSync(IMG_DIR, { recursive: true });
const MAX_IMG = 4 * 1024 * 1024;
const IMG_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const IMG_NAME = /^[0-9a-f]{20}\.(jpg|png|webp)$/;
// tipo riconosciuto dai primi byte del file, non dal nome
function imageExt(data) {
  if (data.length < 12) return '';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.readUInt32BE(0) === 0x89504e47) return 'png';
  if (data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}
function removeCover(name) {
  if (!IMG_NAME.test(name || '')) return;
  try { fs.unlinkSync(path.join(IMG_DIR, name)); } catch { /* già assente */ }
}
function copyCover(name) {
  if (!IMG_NAME.test(name || '')) return '';
  const copy = crypto.randomBytes(10).toString('hex') + path.extname(name);
  try { fs.copyFileSync(path.join(IMG_DIR, name), path.join(IMG_DIR, copy)); } catch { return ''; }
  return copy;
}
// controllo prima di leggere: così il browser riceve un messaggio chiaro invece di una connessione interrotta
const tooBig = (req) => {
  const big = Number(req.headers['content-length'] || 0) > MAX_IMG + 65536;
  if (big) req.resume(); // scarta il corpo, così la risposta arriva pulita al browser
  return big;
};
const TOO_BIG = 'Immagine troppo grande: massimo 4 MB. Riducila e riprova.';
// copertina dopo il salvataggio del modulo: file nuovo, oppure rimozione, oppure quella attuale
function coverFrom(f, current = '') {
  const up = f.files && f.files.cover;
  if (up) {
    const ext = imageExt(up.data);
    if (!ext) return { err: "L'immagine deve essere un file JPG, PNG o WebP." };
    if (up.data.length > MAX_IMG) return { err: 'Immagine troppo grande: massimo 4 MB.' };
    const name = crypto.randomBytes(10).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(IMG_DIR, name), up.data);
    removeCover(current);
    return { cover: name };
  }
  if (f.get('cover_remove') === 'on') { removeCover(current); return { cover: '' }; }
  return { cover: current };
}
function serveImage(res, p) {
  const m = p.match(/^\/img\/([0-9a-f]{20}\.(?:jpg|png|webp))$/);
  if (!m) return false;
  let buf;
  try { buf = fs.readFileSync(path.join(IMG_DIR, m[1])); } catch { return false; }
  res.writeHead(200, { 'Content-Type': IMG_TYPES[path.extname(m[1]).slice(1)], 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
  return true;
}

/* ---------- impostazioni ---------- */
const getSetting = (k, d = '') => {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  return r ? r.value : d;
};
const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

let SECRET = getSetting('secret');
if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); setSetting('secret', SECRET); }

/* ---------- utilità ---------- */
const LEVELS = { base: 'Base', medio: 'Medio', avanzato: 'Avanzato' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowIso = () => new Date().toISOString();
const fmtDate = (iso) => new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short' });
const newSlug = () => crypto.randomBytes(5).toString('hex');
const linesOf = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
const slotsOf = (c) => linesOf(c.slots);
const todayRome = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }); // AAAA-MM-GG
const fmtDay = (d) => (d ? d.split('-').reverse().join('/') : '');
const expired = (c) => !!c.deadline && c.deadline < todayRome();
const prepayOn = (c) => !!(c.btc_address || c.ln_address);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const courseName = (c) => `Corso ${LEVELS[c.level] || c.level}${c.title ? ' – ' + c.title : ''}`;
// iscritti = chi ha un posto; la lista d'attesa (waitlist = 1) non occupa posti e non conta per i minimi
const countRegs = (id) => db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE course_id = ? AND waitlist = 0').get(id).n;
const regsOf = (id) => db.prepare('SELECT * FROM registrations WHERE course_id = ? AND waitlist = 0 ORDER BY created_at').all(id);
const waitOf = (id) => db.prepare('SELECT * FROM registrations WHERE course_id = ? AND waitlist = 1 ORDER BY created_at').all(id);
const allRegsOf = (id) => db.prepare('SELECT * FROM registrations WHERE course_id = ? ORDER BY waitlist, created_at').all(id);
const publicBase = () => getSetting('public_url').replace(/\/+$/, '');

function readBodyBuf(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Richiesta troppo grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const readBody = async (req, limit = 65536) => (await readBodyBuf(req, limit)).toString('utf8');

// modulo con file (multipart/form-data): i campi di testo finiscono in URLSearchParams, i file in f.files
async function readMultipart(req, boundary, limit) {
  const buf = await readBodyBuf(req, limit);
  const f = new URLSearchParams();
  f.files = {};
  const delim = Buffer.from('--' + boundary);
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    pos += delim.length;
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // "--": fine
    pos += 2; // CRLF
    const hEnd = buf.indexOf('\r\n\r\n', pos);
    if (hEnd === -1) break;
    const next = buf.indexOf(delim, hEnd + 4);
    if (next === -1) break;
    const headers = buf.subarray(pos, hEnd).toString('utf8');
    const data = buf.subarray(hEnd + 4, Math.max(hEnd + 4, next - 2)); // senza il CRLF prima del delimitatore
    const name = /\bname="([^"]*)"/i.exec(headers)?.[1];
    const filename = /\bfilename="([^"]*)"/i.exec(headers)?.[1];
    if (name !== undefined) {
      if (filename !== undefined) { if (data.length) f.files[name] = { filename, data }; }
      else f.append(name, data.toString('utf8'));
    }
    pos = next;
  }
  return f;
}
async function readForm(req) {
  const m = /^multipart\/form-data;.*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(req.headers['content-type'] || '');
  if (m) return readMultipart(req, m[1] || m[2], MAX_IMG + 65536);
  const f = new URLSearchParams(await readBody(req));
  f.files = {};
  return f;
}

function isPrivateIp(ip) {
  const v4 = ip.replace(/^::ffff:/i, '');
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127); // 100.64/10 = indirizzi Tailscale
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || /^f[cd]/.test(l) || l.startsWith('fe80');
}
/*
 * Indirizzo del visitatore della pagina PUBBLICA (dietro il proxy di Umbrel e il tunnel Cloudflare).
 * Chi visita può scrivere quello che vuole in X-Forwarded-For, ma solo IN TESTA alla lista: i proxy
 * aggiungono in coda. Quindi si legge da destra e si prende il primo indirizzo pubblico.
 */
function clientIp(req) {
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter((s) => net.isIP(s.replace(/^::ffff:/i, '')));
  chain.push(req.socket.remoteAddress || '');
  for (let i = chain.length - 1; i >= 0; i--) if (chain[i] && !isPrivateIp(chain[i])) return chain[i];
  // nessun indirizzo pubblico (rete di casa): l'ultimo aggiunto dal proxy di Umbrel
  return chain[chain.length - 2] || chain[chain.length - 1] || 'unknown';
}

const hits = new Map(); // rate limit in memoria
function rateLimit(key, max, windowMs) {
  const t = Date.now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(t); hits.set(key, arr); return true;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some((x) => t - x < 3600000)) hits.delete(k); }, 600000).unref();

const sign = (v) => crypto.createHmac('sha256', SECRET).update(String(v)).digest('hex').slice(0, 24);
const timeToken = () => { const t = Date.now(); return `${t}.${sign(t)}`; };
function timeTokenAge(tok) {
  const [t, s] = String(tok || '').split('.');
  if (!t || !s || sign(t) !== s) return null;
  return Date.now() - Number(t);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [s, h] = stored.split(':');
  const a = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 32);
  const b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
function send(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(body);
}
const redirect = (res, to, extra = {}) => { res.writeHead(303, { Location: to, ...SEC_HEADERS, ...extra }); res.end(); };

/* ---------- caratteri (stessi di safe21.io, inclusi nell'app: nessun servizio esterno) ---------- */
const FONT_DIR = path.join(__dirname, 'fonts');
const FONTS = new Map();
try {
  for (const f of fs.readdirSync(FONT_DIR)) if (f.endsWith('.woff2')) FONTS.set(f, fs.readFileSync(path.join(FONT_DIR, f)));
} catch (e) { console.error('caratteri non trovati, uso quelli di sistema:', e.message); }
function serveFont(res, p) {
  const m = p.match(/^\/fonts\/([a-z0-9-]+\.woff2)$/);
  const buf = m && FONTS.get(m[1]);
  if (!buf) return false;
  res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
  return true;
}

/* ---------- Telegram ---------- */
async function telegram(text) {
  const token = getSetting('tg_token');
  const chat = getSetting('tg_chat');
  if (!token || !chat) return { ok: false, error: 'Telegram non configurato' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    return { ok: !!j.ok, error: j.description };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function slotStats(course, regs) {
  return slotsOf(course).map((label) => ({
    label,
    n: regs.filter((r) => JSON.parse(r.slots).includes(label)).length,
  }));
}

async function notifyThresholds(course) {
  const n = countRegs(course.id);
  const fresh = db.prepare('SELECT notified FROM courses WHERE id = ?').get(course.id);
  let level = 0;
  if (n >= course.max_n) level = 2; else if (n >= course.min_n) level = 1;
  if (level <= fresh.notified) return;
  db.prepare('UPDATE courses SET notified = ? WHERE id = ?').run(level, course.id);
  const stats = slotStats(course, regsOf(course.id)).map((s) => `• ${s.label}: ${s.n}`).join('\n');
  const head = level === 2
    ? `🔔 ${courseName(course)} (${course.city}): POSTI ESAURITI ${n}/${course.max_n}`
    : `✅ ${courseName(course)} (${course.city}): raggiunto il minimo, ${n} iscritti (min ${course.min_n}, max ${course.max_n})`;
  await telegram(`${head}\n\nDisponibilità:\n${stats || '(nessuna fascia indicata)'}\n\nApri il pannello admin per scegliere la data.`);
}

function resetNotified(courseId) {
  const c = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
  if (!c) return;
  const n = countRegs(courseId);
  const level = n >= c.max_n ? 2 : n >= c.min_n ? 1 : 0;
  if (level < c.notified) db.prepare('UPDATE courses SET notified = ? WHERE id = ?').run(level, courseId);
}

/* ---------- HTML ---------- */
// icone a tratto (stile Lucide), inline: nessun file esterno, nessuno script
const ICONS = {
  btc: '<path d="M11.767 19.089c4.924.868 6.14-6.025 1.216-6.894m-1.216 6.894L5.86 18.047m5.908 1.042-.347 1.97m1.563-8.864c4.924.869 6.14-6.025 1.215-6.893m-1.215 6.893-3.94-.694m5.155-6.2L8.29 4.26m5.908 1.042.348-1.97M7.48 20.364l3.126-17.727"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  map: '<polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><path d="M9 3v15M15 6v15"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  euro: '<path d="M4 10h12M4 14h9"/><path d="M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12a7.9 7.9 0 0 0 7.8 8 7.7 7.7 0 0 0 5.2-2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  hourglass: '<path d="M5 22h14M5 2h14M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4A2 2 0 0 0 7 17.8V22M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4A2 2 0 0 0 17 6.2V2"/>',
  cap: '<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkc: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 7L2 7"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.6a2 2 0 0 1-.5 2.1L8.1 9.7a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.7a2 2 0 0 1 1.7 2z"/>',
  back: '<path d="m12 19-7-7 7-7M19 12H5"/>',
  arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  pen: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  down: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3M21 14v3h-3v4M14 21h3"/>',
  chart: '<path d="M3 3v18h18M7 15l4-4 4 4 5-6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  phonem: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  laptop: '<rect x="4" y="4" width="16" height="11" rx="2"/><path d="M2 19h20"/>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>',
  battery: '<rect x="2" y="7" width="16" height="10" rx="2"/><path d="M22 11v2M6 11v2M10 11v2"/>',
  usb: '<rect x="7" y="2" width="10" height="9" rx="1"/><path d="M5 11h14v4a7 7 0 0 1-14 0zM10 5v2M14 5v2"/>',
  idcard: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="12" r="2"/><path d="M14 10h4M14 14h4"/>',
  wallet: '<path d="M20 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-4a2 2 0 0 0 0 4h4v3a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V5"/>',
  note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  food: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
};
const icon = (n, cls = '') => `<svg class="i${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
// livello: tre barrette, piene in base al livello
const levelIcon = (lv) => {
  const k = { base: 1, medio: 2, avanzato: 3 }[lv] || 1;
  return `<svg class="i" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${[0, 1, 2].map((i) => `<rect x="${3 + i * 7}" y="${15 - i * 5}" width="5" height="${7 + i * 5}" rx="1"${i < k ? '' : ' opacity=".28"'}/>`).join('')}</svg>`;
};
const REQ_ICONS = [
  [/hotspot|connession|internet|wi-?fi|rete\b/i, 'wifi'],
  [/smartphone|cellulare|telefon|\bapp\b/i, 'phonem'],
  [/computer|portatile|notebook|laptop|\bpc\b|windows|linux|mac\b/i, 'laptop'],
  [/caricabatter|batteri|alimentator|presa/i, 'battery'],
  [/chiavetta|usb|hardware wallet/i, 'usb'],
  [/penna|matita|scriver/i, 'pen'],
  [/quaderno|foglio|carta|bloc/i, 'note'],
  [/documento|carta d'identit|tessera/i, 'idcard'],
  [/wallet|portafoglio|seed/i, 'wallet'],
  [/password|chiave|codice/i, 'key'],
  [/corso|esperienza|dimestichezza|conoscenz/i, 'cap'],
  [/pranzo|merenda|acqua|cibo/i, 'food'],
  [/soldi|contant|euro|€|sats|bitcoin/i, 'btc'],
];
const reqIcon = (t) => (REQ_ICONS.find(([re]) => re.test(t)) || [null, 'check'])[1];
const pill = (txt, cls = '', ic = '') => `<span class="pill${cls ? ' ' + cls : ''}">${ic ? icon(ic) : ''}${txt}</span>`;
const levelPill = (c) => `<span class="pill lvl">${levelIcon(c.level)}Livello ${esc(LEVELS[c.level])}</span>`;
const msg = (kind, html) => `<div class="msg ${kind}">${icon({ ok: 'checkc', err: 'alert', warn: 'info' }[kind])}<div>${html}</div></div>`;
const h2 = (txt, ic) => `<h2>${icon(ic)}${txt}</h2>`;
// link alla mappa: apre l'indirizzo in Google Maps (funziona anche senza account; su telefono apre l'app mappe)
const mapLink = (q) => `<a class="maplink" href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(q)}" target="_blank" rel="noopener noreferrer" title="Apri sulla mappa">${icon('map')}Apri la mappa</a>`;

const CSS = `
@font-face{font-family:Inter;src:url(/fonts/inter-latin-wght-normal.woff2) format('woff2');font-weight:100 900;font-display:swap}
@font-face{font-family:'Space Grotesk';src:url(/fonts/space-grotesk-latin-wght-normal.woff2) format('woff2');font-weight:300 700;font-display:swap}
@font-face{font-family:'Space Mono';src:url(/fonts/space-mono-latin-400-normal.woff2) format('woff2');font-weight:400;font-display:swap}
:root{--bg:#F4F6F9;--panel:#FFFFFF;--line:#D3DBE6;--title:#0A0F1C;--body:#1E2735;--mut:#54637A;--teal:#0A7568;--teald:#085E54;--tsoft:#E1F2EE;--soft:#E8EDF4;--err:#B3261E;--esoft:#FBECEA;--warn:#8A5200;--wsoft:#FBF2E3;--shadow:0 1px 2px rgba(10,15,28,.05),0 6px 18px rgba(10,15,28,.04)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--body);font:16px/1.6 Inter,'Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:720px;margin:0 auto;padding:12px 16px 64px}
main.wide{max-width:1040px}
h1,h2,h3{font-family:'Space Grotesk',Inter,'Segoe UI',Arial,sans-serif;font-weight:600;color:var(--title);line-height:1.2}
h1{font-size:1.85rem;margin:.3em 0 .3em}
h2{font-size:1.2rem;margin:1.8em 0 .6em;display:flex;align-items:center;gap:8px}
h2 .i{color:var(--teal);width:1.05em;height:1.05em}
h3{font-size:1rem;margin:1.2em 0 .4em}
a{color:var(--teal)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
.i{width:1.1em;height:1.1em;vertical-align:-.2em;flex:none}
.sub{color:var(--mut);margin:0 0 1.2em}
.top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 16px;padding:10px 0 14px;margin-bottom:22px;border-bottom:1px solid var(--line)}
.brand{display:inline-flex;align-items:center;gap:10px;font:600 1.05rem 'Space Grotesk',Inter,sans-serif;color:var(--title);text-decoration:none}
.brand .mark{width:34px;height:34px;border-radius:9px;background:#fff;border:1px solid var(--line);overflow:hidden;display:inline-flex;flex:none}
.brand .mark img{width:100%;height:100%;display:block}
.brand small{font-weight:500;color:var(--mut);margin-left:2px}
.nav{display:flex;gap:2px;flex-wrap:wrap;align-items:center}
.nav a,.nav button{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;color:var(--body);background:none;border:0;font:500 .93rem/1.4 Inter,'Segoe UI',Arial,sans-serif;text-decoration:none;cursor:pointer}
.nav a:hover,.nav button:hover{background:var(--soft);color:var(--title)}
.nav .i{color:var(--teal)}
.back{display:inline-flex;align-items:center;gap:6px;color:var(--mut);text-decoration:none;font-size:.93rem;margin:0 0 12px}
.back:hover{color:var(--teal)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;margin:14px 0;box-shadow:var(--shadow)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 11px;border-radius:999px;font-size:.82rem;font-weight:500;background:var(--soft);color:var(--mut);white-space:nowrap}
.pill .i{width:.95em;height:.95em}
.pill.ok,.pill.on{background:var(--tsoft);color:var(--teald)}
.pill.lvl{background:#fff;border:1px solid var(--line);color:var(--title)}
.pill.lvl .i{color:var(--teal)}
.chip{display:inline-block;padding:2px 10px;border-radius:6px;font-size:.875rem;margin:2px 6px 2px 0;background:var(--soft);color:var(--body)}
.bar{height:6px;background:var(--soft);border-radius:3px;overflow:hidden;margin:10px 0 4px}
.bar>i{display:block;height:100%;background:var(--teal);border-radius:3px}
label{display:block;font-weight:500;margin:16px 0 4px;color:var(--title)}
label small{font-weight:400;color:var(--mut)}
input[type=text],input[type=email],input[type=tel],input[type=number],input[type=password],input[type=url],input[type=date],select,textarea{width:100%;padding:10px 12px;font:inherit;color:var(--title);border:1px solid var(--line);border-radius:8px;background:#fff}
input:focus,select:focus,textarea:focus{border-color:var(--teal)}
textarea{min-height:90px}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:400;margin:8px 0;color:var(--body)}
.check input{width:20px;height:20px;margin-top:3px;flex:none;accent-color:var(--teal)}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:var(--teal);color:#fff;border:1px solid var(--teal);border-radius:8px;padding:10px 18px;font:500 15px/1.4 Inter,'Segoe UI',Arial,sans-serif;cursor:pointer;text-decoration:none}
button:hover,.btn:hover{background:var(--teald);border-color:var(--teald)}
.btn.sec,button.sec{background:#fff;color:var(--title);border-color:var(--line)}
.btn.sec:hover,button.sec:hover{background:#fff;border-color:var(--teal);color:var(--teal)}
.btn.sec .i,button.sec .i{color:var(--teal)}
.btn.del,button.del{background:#fff;color:var(--err);border-color:#E7C2BE}
.btn.del:hover,button.del:hover{background:var(--esoft);border-color:var(--err);color:var(--err)}
.btn.sm,button.sm{padding:4px 10px;font-size:.88rem;white-space:nowrap}
button.paid{color:var(--teald);border-color:var(--tsoft);background:var(--tsoft)}
.msg{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:10px;margin:12px 0;border:1px solid var(--line);background:var(--panel);color:var(--title)}
.msg .i{margin-top:.22em}
.msg.ok{border-color:#BFE3DA;background:var(--tsoft)}.msg.ok .i{color:var(--teald)}
.msg.err{border-color:#E7C2BE;background:var(--esoft)}.msg.err .i{color:var(--err)}
.msg.warn{border-color:#EAD3A8;background:var(--wsoft)}.msg.warn .i{color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em}
tr:last-child td{border-bottom:0}
.hp{position:absolute;left:-5000px;height:0;overflow:hidden}
.qr{width:180px;height:180px;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#fff}
.qr svg{width:100%;height:100%;display:block}
.mono{font-family:'Space Mono',ui-monospace,Menlo,Consolas,monospace;font-size:.85rem;word-break:break-all;color:var(--title)}
.lv-base{--lv:#0A7568;--lv2:#17A08C}
.lv-medio{--lv:#1D5C96;--lv2:#3F88C9}
.lv-avanzato{--lv:#2C3359;--lv2:#5762A8}
.hero{position:relative;overflow:hidden;border-radius:16px;padding:34px 32px;margin:4px 0 22px;background:linear-gradient(120deg,#0A7568,#0E8678 60%,#13988A);color:#fff}
.hero::before,.hero::after{content:'';position:absolute;border-radius:50%;background:rgba(255,255,255,.07)}
.hero::before{width:280px;height:280px;right:-70px;top:-110px}
.hero::after{width:180px;height:180px;right:90px;bottom:-110px}
.hero>*{position:relative}
.hero h1{color:#fff;font-size:clamp(2rem,5vw,2.8rem);margin:0 0 .3em}
.hero p{margin:0;max-width:560px;font-size:1.08rem;color:rgba(255,255,255,.9)}
.hero .stats{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}
.hero .pill{background:rgba(255,255,255,.16);color:#fff;font-size:.85rem}
.hero .pill .i{color:#fff}
.steps{list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(230px,100%),1fr));gap:12px;margin:0 0 8px;padding:0}
.steps li{display:flex;gap:12px;align-items:flex-start;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.steps .ic{flex:none;width:38px;height:38px;border-radius:10px;background:var(--tsoft);color:var(--teal);display:flex;align-items:center;justify-content:center}
.steps .ic .i{width:19px;height:19px;vertical-align:0}
.steps b{display:block;color:var(--title);font-weight:600;line-height:1.3}
.steps .t{display:block;font-size:.9rem;color:var(--mut);line-height:1.45;margin-top:2px}
.gh{margin:32px 0 14px}
.gh .pill{margin-left:4px;background:var(--soft);color:var(--mut)}
.empty{display:flex;gap:14px;align-items:center;color:var(--mut)}
.empty .i{width:28px;height:28px;color:var(--teal)}
.empty p{margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(330px,100%),1fr));gap:22px}
.media{position:relative;height:168px;overflow:hidden;flex:none;background:linear-gradient(135deg,var(--lv),var(--lv2))}
.media img.cover{display:block;width:100%;height:100%;object-fit:cover}
.media .deco{position:absolute;right:-18px;bottom:-34px;width:150px;height:150px;color:rgba(255,255,255,.17)}
.media .deco .i{width:100%;height:100%;vertical-align:0}
.media .pills{position:absolute;left:12px;top:12px;right:12px;display:flex;flex-wrap:wrap;gap:6px}
.media .pill{background:rgba(255,255,255,.96);color:var(--title);box-shadow:0 1px 3px rgba(10,15,28,.18)}
.media .pill .i{color:var(--lv)}
.media .pill.ok,.media .pill.on{color:var(--teald)}
.course{position:relative;display:flex;flex-direction:column;margin:0;padding:0;overflow:hidden;transition:transform .15s,box-shadow .15s,border-color .15s}
.course:hover{transform:translateY(-2px);border-color:#B9C6D6;box-shadow:0 2px 4px rgba(10,15,28,.06),0 14px 30px rgba(10,15,28,.09)}
.course .body{display:flex;flex-direction:column;flex:1;padding:18px 20px 20px}
.course h2{font-size:1.3rem;margin:0 0 10px;display:block}
.course-meta{display:grid;gap:6px;color:var(--body);margin:0 0 14px;font-size:.95rem}
.course-meta span{display:flex;align-items:center;gap:8px}
.course-meta .i{color:var(--lv,var(--teal))}
.course-slots{margin:0 0 14px}
.course-progress{margin-top:auto}
.course .btn{display:flex;margin-top:16px}
.course .btn::after{content:'';position:absolute;inset:0}
.media.big{height:150px;border-radius:16px;margin:0 0 18px}
.media.big.has-cover{height:auto;background:var(--soft)}
.media.big img.cover{height:auto;max-height:380px}
.media.big .deco{width:200px;height:200px;right:-20px;bottom:-56px}
.ch{margin:0 0 8px;font-size:clamp(1.6rem,4vw,2.15rem)}
.pr{margin:0 0 12px}
.course-meta.row2{display:flex;flex-wrap:wrap;gap:6px 20px;margin:0 0 22px;font-size:1rem}
.cwrap{display:grid;grid-template-columns:minmax(0,1fr);gap:18px}
.cmain>:first-child{margin-top:0}
.aside{margin:0;padding:18px 20px}
.aside h2{margin:0 0 6px;font-size:1.05rem}
.aside .dl{display:flex;gap:8px;align-items:center;color:var(--mut);font-size:.92rem;margin:10px 0 0}
.aside .dl .i{color:var(--lv,var(--teal))}
.btn.big,button.big{width:100%;padding:13px 20px;font-size:1rem}
.aside .btn.big{margin-top:14px}
@media (min-width:940px){.cwrap{grid-template-columns:minmax(0,1fr) 320px;gap:36px;align-items:start}.aside{grid-column:2;grid-row:1;position:sticky;top:18px}.cmain{grid-column:1;grid-row:1}}
.foot{display:flex;gap:8px;align-items:center;justify-content:center;text-align:center;color:var(--mut);font-size:.85rem;margin-top:44px;padding-top:18px;border-top:1px solid var(--line)}
.foot .i{color:var(--teal);flex:none}
.intro{font-size:1.1rem;color:var(--body);margin:4px 0 20px;white-space:pre-wrap}
.facts{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(270px,100%),1fr));gap:18px 24px}
.fact{display:flex;gap:12px;align-items:flex-start}
.fact .ic{flex:none;width:38px;height:38px;border-radius:10px;background:var(--tsoft);color:var(--teal);display:flex;align-items:center;justify-content:center}
.fact .ic .i{width:19px;height:19px;vertical-align:0}
.fact b{display:block;font-size:.76rem;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);font-weight:600}
.fact .v{display:block;color:var(--title);white-space:pre-wrap;margin-top:2px}
.maplink{display:inline-flex;align-items:center;gap:5px;margin-top:8px;font-size:.88rem;font-weight:500;color:var(--teal);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:3px 11px 3px 8px;background:#fff;white-space:nowrap}
.maplink:hover{border-color:var(--teal);background:var(--tsoft)}
.req{list-style:none;margin:0;padding:0}
.req li{display:flex;gap:14px;align-items:center;padding:10px 0}
.req li+li{border-top:1px solid var(--line)}
.req .ic{flex:none;width:38px;height:38px;border-radius:10px;background:var(--tsoft);color:var(--teal);display:flex;align-items:center;justify-content:center}
.req .ic .i{width:19px;height:19px;vertical-align:0}
.prog p{margin:.35em 0;white-space:pre-wrap}
.prog h3{margin:1.1em 0 .3em;color:var(--teal);font-size:.82rem;letter-spacing:.07em;text-transform:uppercase}
.prog h3:first-child{margin-top:0}
.prog ul{margin:.2em 0 .6em;padding-left:1.3em}.prog li{margin:3px 0}
.pre{white-space:pre-wrap}
.paywrap{display:none;margin:14px 0 0}
form:has(#pay-pre:checked) .paywrap{display:block}
.srcwrap{display:none;margin:10px 0 0}
form:has(#src-other:checked) .srcwrap{display:block}
.paybox{border:1px solid var(--line);border-radius:10px;padding:16px;background:var(--bg)}
.pay-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:16px}
.pay b{display:inline-flex;align-items:center;gap:6px}.pay b .i{color:var(--teal)}
.pay .qr{margin:8px 0}
fieldset.fs{border:0;border-top:1px solid var(--line);margin:28px 0 0;padding:8px 0 0}
fieldset.fs:first-child{border-top:0;margin-top:0}
.fs legend{font:600 1.05rem 'Space Grotesk',Inter,sans-serif;color:var(--title);padding:0 10px 0 0;display:flex;align-items:center;gap:8px}
.fs legend .i{color:var(--teal)}
.contact{display:flex;align-items:center;gap:8px;color:var(--mut);margin-top:28px}
.ql{display:flex;gap:20px;flex-wrap:wrap;align-items:center}
.cover{display:block;width:100%;object-fit:cover;background:var(--soft)}
.cover-now{margin:0 0 10px}.cover-now .cover{max-height:160px;margin:0 0 4px;border:1px solid var(--line);border-radius:10px}
input[type=file]{font:inherit;color:var(--mut);max-width:100%}
.enroll{scroll-margin-top:16px}
.enrollform{padding:22px}
.fgrid{display:grid;grid-template-columns:1fr;gap:0 16px}
@media (min-width:640px){.fgrid{grid-template-columns:1fr 1fr}.fgrid .full{grid-column:1/-1}}
.fld label{margin:14px 0 6px;font-size:.93rem}
.fld .opt{font-weight:400;color:var(--mut);font-size:.78rem;margin-left:8px;background:var(--soft);border-radius:999px;padding:1px 9px}
.star{color:var(--teal)}
.inp{position:relative}
.inp>.i{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#7C8BA1;width:18px;height:18px;pointer-events:none}
.inp:focus-within>.i{color:var(--teal)}
.inp input{padding-left:40px}
.hint{margin:5px 0 0;font-size:.82rem;color:var(--mut)}
fieldset.qs{border:0;padding:0;margin:24px 0 0;min-width:0}
.qs legend{padding:0;margin:0 0 10px;font-weight:600;color:var(--title)}
.qs legend small{display:block;font-weight:400;color:var(--mut);font-size:.85rem}
.tiles{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr))}
.tiles.sm{grid-template-columns:repeat(auto-fit,minmax(min(165px,100%),1fr))}
.tile{display:flex;gap:10px;align-items:flex-start;margin:0;padding:11px 14px;border:1px solid var(--line);border-radius:10px;background:#fff;cursor:pointer;font-weight:400;color:var(--body);transition:border-color .12s,background .12s}
.tile:hover{border-color:#9FB0C4}
.tile input{width:18px;height:18px;margin:3px 0 0;flex:none;accent-color:var(--teal)}
.tile b{display:block;color:var(--title);font-weight:600}
.tile small{display:block;color:var(--mut);font-weight:400}
.tile:has(input:checked){border-color:var(--teal);background:var(--tsoft);box-shadow:0 0 0 1px var(--teal) inset}
.consent{display:flex;gap:12px;align-items:flex-start;margin:26px 0 0;padding:14px 16px;border-radius:10px;background:var(--bg);border:1px solid var(--line);font-weight:400;font-size:.9rem;color:var(--mut)}
.consent input{width:20px;height:20px;margin:2px 0 0;flex:none;accent-color:var(--teal)}
.enrollform .btn.big{margin-top:18px}
@media (max-width:640px){.steps{gap:0;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}.steps li{border:0;border-radius:0;padding:11px 14px;align-items:center}.steps li+li{border-top:1px solid var(--line)}.steps .ic{width:34px;height:34px}.steps .t{font-size:.85rem}.gh{margin-top:26px}}
@media (max-width:480px){main{padding-top:4px}.hero{padding:26px 20px}.hero h1{font-size:2rem}.enrollform{padding:18px}}
@media print{.top,.nav,button,.btn,.back,.maplink{display:none}body{background:#fff}.card{box-shadow:none}}
`;

const ICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" width=\"256\" height=\"256\">\n  <rect width=\"256\" height=\"256\" fill=\"#FFFFFF\"/>\n  <g transform=\"translate(128 128) scale(.96) translate(-128 -131)\" fill=\"none\" stroke-width=\"9\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n    <g stroke=\"#0D9488\">\n      <rect x=\"58\" y=\"62\" width=\"140\" height=\"168\" rx=\"12\"/>\n      <rect x=\"91\" y=\"32\" width=\"74\" height=\"52\" rx=\"14\" fill=\"#FFFFFF\"/>\n      <rect x=\"108\" y=\"50\" width=\"40\" height=\"20\" rx=\"9\"/>\n    </g>\n    <g stroke=\"#FF6F1F\" transform=\"translate(122.5 162)\">\n      <path d=\"M-20 -36V36\"/>\n      <path d=\"M-20 -36H8a17 17 0 0 1 0 34H-20\"/>\n      <path d=\"M-20 -2H12a19 19 0 0 1 0 38H-20\"/>\n      <path d=\"M-8 -36V-48M8 -36V-48M-8 36V48M8 36V48\"/>\n    </g>\n  </g>\n</svg>\n";
function serveIcon(res, p) {
  if (p !== '/icon.svg') return false;
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  res.end(ICON_SVG);
  return true;
}

const FOOT = `<footer class="foot">${icon('shield')}<span>I dati degli iscritti non vengono ceduti a terzi e vengono cancellati dopo il corso.</span></footer>`;

function page(title, body, { admin = false, wide = false } = {}) {
  const brand = `<a class="brand" href="/"><span class="mark"><img src="/icon.svg" alt="" width="34" height="34"></span>Corsi Bitcoin${admin ? '<small>· Admin</small>' : ''}</a>`;
  const nav = admin
    ? `<nav class="nav"><a href="/">${icon('list')}Corsi</a><a href="/corso/nuovo">${icon('plus')}Nuovo corso</a><a href="/impostazioni">${icon('cog')}Impostazioni</a>
       <form method="post" action="/logout"><button type="submit">${icon('out')}Esci</button></form></nav>`
    : '';
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><link rel="icon" type="image/svg+xml" href="/icon.svg">
<title>${esc(title)}</title><style>${CSS}</style></head><body><main${wide ? ' class="wide"' : ''}><header class="top">${brand}${nav}</header>${body}${admin ? '' : FOOT}</main></body></html>`;
}

function qrSvg(url) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function counter(c, n) {
  // corso già confermato: non serve più contare verso il minimo, contano i posti rimasti
  const confirmed = c.status === 'confirmed';
  const pct = Math.min(100, Math.round((n / (confirmed ? c.max_n : c.min_n)) * 100));
  let txt;
  if (n >= c.max_n) txt = `Posti esauriti (${n}/${c.max_n})`;
  else if (confirmed) txt = `${n} iscritti, ancora ${c.max_n - n} posti`;
  else if (n >= c.min_n) txt = `Raggiunto il minimo: ${n} iscritti, ancora ${c.max_n - n} posti`;
  else txt = `${n} su ${c.min_n} iscritti per confermare il corso`;
  return `<div class="bar"><i style="width:${pct}%"></i></div><div class="sub" style="margin:0">${esc(txt)}</div>`;
}

// withDate=false sulle pagine pubbliche, dove la data confermata è già scritta accanto alla città
function statusBadge(c, n, withDate = true) {
  if (c.status === 'closed') return pill('Chiuso', 'off', 'lock');
  if (n >= c.max_n) return pill('Completo', 'off', 'users');
  if (expired(c)) return pill('Prenotazioni chiuse', 'off', 'hourglass');
  if (c.status === 'confirmed') return pill(withDate ? `Confermato: ${esc(c.confirmed_date)}` : 'Confermato', 'ok', 'checkc');
  return pill('Iscrizioni aperte', 'on', 'pen');
}

/* ---------- pagine pubbliche ---------- */
// classe di colore in base al livello (base = verde, medio = blu, avanzato = blu notte)
const levelClass = (c) => `lv-${LEVELS[c.level] ? c.level : 'base'}`;

// immagine in alto: la copertina se c'è, altrimenti una fascia colorata con il simbolo del livello
// con la copertina le etichette stanno sotto l'immagine (per non coprire le scritte); sulla fascia colorata stanno sopra
function mediaBlock(c, n, big = false) {
  const inner = c.cover
    ? `<img class="cover" src="/img/${esc(c.cover)}" alt="">`
    : `<span class="deco">${levelIcon(c.level)}</span><div class="pills">${levelPill(c)}${statusBadge(c, n, false)}</div>`;
  return `<div class="media${big ? ' big' : ''}${c.cover ? ' has-cover' : ''}">${inner}</div>`;
}
const pillsRow = (c, n) => (c.cover ? `<div class="row pr">${levelPill(c)}${statusBadge(c, n, false)}</div>` : '');

function courseCard(c) {
  const n = countRegs(c.id);
  const slots = slotsOf(c);
  return `<article class="card course ${levelClass(c)}">
    ${mediaBlock(c, n)}
    <div class="body">
      ${pillsRow(c, n)}
      <h2>${esc(c.title || `Corso ${LEVELS[c.level]}`)}</h2>
      <p class="course-meta"><span>${icon('pin')}${esc(c.city)}</span>${c.status === 'confirmed' ? `<span>${icon('calendar')}${esc(c.confirmed_date)}</span>` : ''}${c.deadline && !expired(c) ? `<span>${icon('hourglass')}Prenotazioni entro il ${fmtDay(c.deadline)}</span>` : ''}</p>
      ${slots.length ? `<div class="course-slots">${slots.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}
      <div class="course-progress">${counter(c, n)}</div>
      <a class="btn" href="/c/${c.slug}">${n >= c.max_n ? (c.ask_waitlist && !expired(c) && c.status !== 'closed' ? "Dettagli e lista d'attesa" : 'Dettagli') : 'Dettagli e iscrizione'}${icon('arrow')}</a>
    </div>
  </article>`;
}

function renderList() {
  const all = db.prepare("SELECT * FROM courses WHERE status IN ('open','confirmed') ORDER BY created_at DESC").all();
  const confirmed = all.filter((c) => c.status === 'confirmed');
  const open = all.filter((c) => c.status !== 'confirmed');
  const cities = new Set(all.map((c) => c.city.trim().toLowerCase())).size;
  const group = (title, ic, list) => (list.length
    ? `<h2 class="gh">${icon(ic)}${title}<span class="pill">${list.length}</span></h2><div class="grid">${list.map(courseCard).join('')}</div>` : '');
  const steps = [
    ['list', 'Scegli il corso', 'Il livello e la città più comodi per te.'],
    ['calendar', 'Indica quando puoi', 'Seleziona tutte le fasce che vanno bene.'],
    ['mail', 'Ti scriviamo noi', 'Raggiunto il minimo, scegliamo la data in base alle disponibilità.'],
  ];
  return page('Corsi Bitcoin', `<header class="hero"><h1>Corsi Bitcoin</h1>
    <p>Corsi in piccoli gruppi, nella tua città. Scegli il livello e dicci quando potresti esserci.</p>
    ${all.length ? `<div class="stats"><span class="pill">${icon('book')}${all.length} ${all.length === 1 ? 'corso' : 'corsi'}</span><span class="pill">${icon('pin')}${cities} ${cities === 1 ? 'città' : 'città'}</span></div>` : ''}</header>
    <ol class="steps">${steps.map(([ic, t, d]) => `<li><span class="ic">${icon(ic)}</span><span><b>${t}</b><span class="t">${d}</span></span></li>`).join('')}</ol>
    ${all.length
      ? group('Corsi confermati', 'checkc', confirmed) + group('Iscrizioni aperte', 'pen', open)
      : `<div class="card empty">${icon('calendar')}<p>Al momento non ci sono corsi aperti. Torna a trovarci presto.</p></div>`}`, { wide: true });
}

const payItem = (label, ic, addr, uri) => `<div class="pay"><b>${icon(ic)}${label}</b><div class="qr">${qrSvg(uri)}</div><div class="mono">${esc(addr)}</div></div>`;
function payBox(c) {
  return `<div class="paybox">
    ${c.prepay_text ? `<p class="pre" style="margin:0 0 14px">${esc(c.prepay_text)}</p>` : ''}
    <div class="pay-grid">
      ${c.btc_address ? payItem('Bitcoin', 'btc', c.btc_address, 'bitcoin:' + c.btc_address) : ''}
      ${c.ln_address ? payItem('Lightning', 'zap', c.ln_address, 'lightning:' + c.ln_address) : ''}
    </div>
    ${c.contact_email ? `<p style="margin:14px 0 0">${icon('mail')} Dopo il pagamento mandaci la prova a <a href="mailto:${esc(c.contact_email)}">${esc(c.contact_email)}</a>.</p>` : ''}
  </div>`;
}

// indirizzo da cercare sulla mappa: prima riga del luogo (se pubblico) più la città, altrimenti solo la città
function mapQuery(c, showLocation = c.show_location) {
  const first = showLocation ? linesOf(c.location)[0] || '' : '';
  if (!first) return c.city;
  return first.toLowerCase().includes(c.city.toLowerCase()) ? first : `${first}, ${c.city}`;
}

function courseFacts(c) {
  const where = [c.city, c.show_location ? c.location : ''].filter(Boolean).join('\n');
  const rows = [
    ['calendar', 'Quando', c.status === 'confirmed' ? c.confirmed_date : (slotsOf(c).length ? 'Data da scegliere in base alle disponibilità' : '')],
    ['pin', 'Dove', where, mapLink(mapQuery(c))],
    ['clock', 'Orari', c.schedule],
    ['euro', 'Contributo', c.price],
    ['users', 'Partecipanti', c.min_n === c.max_n ? `${c.max_n}` : `Minimo ${c.min_n}, massimo ${c.max_n}`],
    ['hourglass', 'Prenotazioni entro', fmtDay(c.deadline)],
    ['cap', 'Docenti', c.teachers],
  ].filter(([, , v]) => v);
  return `<ul class="facts">${rows.map(([ic, k, v, extra = '']) => `<li class="fact"><span class="ic">${icon(ic)}</span><div><b>${k}</b><span class="v">${esc(v)}</span>${extra}</div></li>`).join('')}</ul>`;
}

// programma: righe in MAIUSCOLO diventano titoletti, righe che iniziano con "-" diventano elenchi
function renderProgram(text) {
  const out = [];
  let list = [];
  const flush = () => { if (list.length) { out.push(`<ul>${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`); list = []; } };
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim();
    if (!l) { flush(); continue; }
    const m = /^[-•*]\s+(.+)$/.exec(l);
    if (m) { list.push(m[1]); continue; }
    flush();
    // titoletto: riga tutta in maiuscolo, oppure che inizia con una parola in maiuscolo seguita da "–", "-" o ":" (es. "MATTINO – Teoria")
    if (l.length <= 80 && ((l === l.toUpperCase() && /[A-ZÀ-Ý]{3}/.test(l)) || /^[A-ZÀ-Ý][A-ZÀ-Ý0-9 ]{2,}(\s[–\-:]\s|:\s)/.test(l))) out.push(`<h3>${esc(l)}</h3>`);
    else out.push(`<p>${esc(l)}</p>`);
  }
  flush();
  return `<div class="prog">${out.join('')}</div>`;
}

function renderCourse(c, { error = '', ok = false, paid = false, wait = false, values = {} } = {}) {
  const n = countRegs(c.id);
  const full = n >= c.max_n;
  const closed = c.status === 'closed';
  const late = expired(c);
  const slots = slotsOf(c);
  const chosen = values.slots || [];
  const reqs = linesOf(c.requirements);
  // a posti esauriti, se il corso lo prevede, ci si può mettere in lista d'attesa
  const canWait = full && !closed && !late && !!c.ask_waitlist;
  const stop = closed ? 'Le iscrizioni per questo corso sono chiuse.' : (full && !canWait) ? 'Il corso è al completo.' : late ? `Le prenotazioni si sono chiuse il ${fmtDay(c.deadline)}.` : '';
  const srcSel = String(values.source || '').startsWith('Altro') ? 'Altro' : values.source;
  const srcOther = values.source_other || String(values.source || '').replace(/^Altro:\s*/, '').replace(/^Altro$/, '');
  // campo di testo con icona: etichetta, casella, suggerimento
  const fld = (id, label, ic, input, hint = '', optional = false, cls = '') =>
    `<div class="fld${cls ? ' ' + cls : ''}"><label for="${id}">${label}${optional ? '<span class="opt">facoltativo</span>' : ' <b class="star">*</b>'}</label><div class="inp">${icon(ic)}${input}</div>${hint ? `<p class="hint">${hint}</p>` : ''}</div>`;
  const form = `
  ${h2(canWait ? "Lista d'attesa" : 'Iscriviti', canWait ? 'users' : 'pen')}
  ${canWait ? msg('warn', "<b>Il corso è al completo.</b> Puoi metterti in lista d'attesa prioritaria: avrai la precedenza se si libera un posto o per il prossimo corso.") : ''}
  <form method="post" action="/c/${c.slug}#iscrizione" class="card enrollform" autocomplete="on">
    <div class="fgrid">
      ${fld('email', 'Email', 'mail', `<input type="email" id="email" name="email" required maxlength="120" value="${esc(values.email)}" autocomplete="email">`)}
      ${fld('name', 'Nome e cognome (o nickname)', 'user', `<input type="text" id="name" name="name" required maxlength="80" value="${esc(values.name)}" autocomplete="name">`, 'Rispettiamo la tua privacy.')}
      ${c.phone_required
        ? fld('phone', 'Telefono', 'phone', `<input type="tel" id="phone" name="phone" required maxlength="30" value="${esc(values.phone)}" autocomplete="tel">`, 'Ci serve per confermarti il corso.')
        : fld('phone', 'Telefono', 'phone', `<input type="tel" id="phone" name="phone" maxlength="30" value="${esc(values.phone)}" autocomplete="tel">`, 'Solo per contattarti via WhatsApp.', true)}
      ${fld('city', 'Città', 'pin', `<input type="text" id="city" name="city" maxlength="80" value="${esc(values.city)}" autocomplete="address-level2">`, 'Se vieni da lontano possiamo consigliarti corsi più vicini.', true)}
      ${c.ask_company ? fld('company', 'Azienda', 'briefcase', `<input type="text" id="company" name="company" maxlength="80" value="${esc(values.company)}" autocomplete="organization">`, 'Possiamo indicarti opportunità per la tua attività.', true, 'full') : ''}
    </div>
    ${slots.length ? `<fieldset class="qs"><legend>Quando potresti esserci? <b class="star">*</b><small>Scegli tutte le fasce che vanno bene.</small></legend>
      <div class="tiles">${slots.map((s) => `<label class="tile"><input type="checkbox" name="slot" value="${esc(s)}" ${chosen.includes(s) ? 'checked' : ''}><span>${esc(s)}</span></label>`).join('')}</div></fieldset>` : ''}
    ${prepayOn(c) && !canWait ? `<fieldset class="qs"><legend>Come preferisci pagare il contributo? <b class="star">*</b></legend>
      <div class="tiles">
        <label class="tile"><input type="radio" name="payment" value="corso" ${values.payment !== 'anticipo' ? 'checked' : ''}><span><b>Il giorno del corso</b><small>Pago all'accoglienza</small></span></label>
        <label class="tile"><input type="radio" name="payment" id="pay-pre" value="anticipo" ${values.payment === 'anticipo' ? 'checked' : ''}><span><b>In anticipo</b><small>Blocco subito il posto</small></span></label>
      </div>
      <div class="paywrap">${payBox(c)}</div></fieldset>` : ''}
    ${c.ask_source ? `<fieldset class="qs"><legend>Come hai conosciuto questo corso? <b class="star">*</b></legend>
      <div class="tiles sm">${SOURCES.map((s) => `<label class="tile"><input type="radio" name="source" value="${esc(s)}" required ${s === 'Altro' ? 'id="src-other"' : ''} ${srcSel === s ? 'checked' : ''}><span>${esc(s)}</span></label>`).join('')}</div>
      <div class="srcwrap"><input type="text" name="source_other" maxlength="80" placeholder="Scrivi qui" aria-label="Altro: specifica" value="${esc(srcOther)}"></div></fieldset>` : ''}
    <label class="consent"><input type="checkbox" name="consent" required><span>Acconsento al trattamento dei miei dati (email, nome, telefono, città${c.ask_company ? ', azienda' : ''}) al solo scopo di organizzare il corso. I dati non vengono ceduti a terzi e vengono cancellati dopo il corso. *</span></label>
    <div class="hp" aria-hidden="true"><label>Non compilare<input type="text" name="sito" tabindex="-1" autocomplete="off"></label></div>
    <input type="hidden" name="t" value="${timeToken()}">
    <button type="submit" class="btn big">${icon('send')}${canWait ? "Mettimi in lista d'attesa" : 'Invia iscrizione'}</button>
  </form>`;
  const done = `${wait ? msg('ok', "<b>Sei in lista d'attesa, grazie!</b> Ti scriviamo se si libera un posto o per il prossimo corso.") : msg('ok', `<b>Iscrizione ricevuta, grazie!</b> ${c.status === 'confirmed'
    ? 'Ti aspettiamo al corso: dai un\'occhiata ai requisiti prima di partire.'
    : 'Ti scriveremo non appena il corso sarà confermato, con data e luogo definitivi.'}`)}
    ${paid && !wait && prepayOn(c) ? `${h2('Pagamento in anticipo', 'btc')}${payBox(c)}` : ''}
    <p><a class="btn sec" href="/">${icon('back')}Tutti i corsi</a></p>`;
  const enroll = ok ? done : `${error ? msg('err', esc(error)) : ''}${stop ? msg('warn', stop) : form}`;
  return page(courseName(c), `
    <div class="${levelClass(c)}">
    <a class="back" href="/">${icon('back')}Tutti i corsi</a>
    ${mediaBlock(c, n, true)}
    ${pillsRow(c, n)}
    <h1 class="ch">${esc(courseName(c))}</h1>
    <p class="course-meta row2"><span>${icon('pin')}${esc(c.city)}</span>${c.status === 'confirmed' ? `<span>${icon('calendar')}${esc(c.confirmed_date)}</span>` : ''}</p>
    <div class="cwrap">
      <aside class="aside card">
        <h2>${icon('users')}Iscrizioni</h2>
        ${counter(c, n)}
        ${c.deadline && !late ? `<p class="dl">${icon('hourglass')}Prenotazioni entro il ${fmtDay(c.deadline)}</p>` : ''}
        ${ok || stop ? '' : `<a class="btn big" href="#iscrizione">${icon(canWait ? 'users' : 'pen')}${canWait ? "Mettiti in lista d'attesa" : 'Iscriviti ora'}</a>`}
      </aside>
      <div class="cmain">
        ${c.description ? `<p class="intro">${esc(c.description)}</p>` : ''}
        <div class="card">${courseFacts(c)}</div>
        ${slots.length && c.status !== 'confirmed' ? `${h2('Date indicative', 'calendar')}<p class="sub">La data definitiva sarà scelta in base alle disponibilità di chi si iscrive.</p><div>${slots.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}
        ${reqs.length ? `${h2('Requisiti per partecipare', 'list')}<div class="card"><ol class="req">${reqs.map((r) => `<li><span class="ic">${icon(reqIcon(r))}</span><span>${esc(r)}</span></li>`).join('')}</ol></div>` : ''}
        ${c.program ? `${h2('Programma', 'book')}<div class="card">${renderProgram(c.program)}</div>` : ''}
        <section id="iscrizione" class="enroll">${enroll}</section>
        ${c.contact_email ? `<p class="contact">${icon('mail')}<span>Per informazioni scrivi a <a href="mailto:${esc(c.contact_email)}">${esc(c.contact_email)}</a>.</span></p>` : ''}
      </div>
    </div>
    </div>`, { wide: true });
}

async function handlePublic(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/health') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
  if (req.method === 'GET' && (serveFont(res, p) || serveImage(res, p) || serveIcon(res, p))) return;
  if (req.method === 'GET' && p === '/') return send(res, 200, renderList());

  const m = p.match(/^\/c\/([0-9a-f]{10})$/);
  if (!m) return send(res, 404, page('Non trovato', '<h1>Pagina non trovata</h1><p><a href="/">Torna ai corsi</a></p>'));
  const course = db.prepare('SELECT * FROM courses WHERE slug = ?').get(m[1]);
  if (!course) return send(res, 404, page('Non trovato', '<h1>Corso non trovato</h1><p><a href="/">Torna ai corsi</a></p>'));

  if (req.method === 'GET') return send(res, 200, renderCourse(course, { ok: url.searchParams.get('ok') === '1', paid: url.searchParams.get('pay') === '1', wait: url.searchParams.get('wl') === '1' }));
  if (req.method !== 'POST') return send(res, 405, 'Metodo non consentito', { 'Content-Type': 'text/plain' });

  const f = await readForm(req);
  const values = {
    email: (f.get('email') || '').trim().toLowerCase(),
    name: (f.get('name') || '').trim(),
    phone: (f.get('phone') || '').trim(),
    city: (f.get('city') || '').trim(),
    slots: f.getAll('slot'),
    payment: prepayOn(course) ? (f.get('payment') === 'anticipo' ? 'anticipo' : 'corso') : '',
    company: course.ask_company ? (f.get('company') || '').trim() : '',
    source: course.ask_source ? (f.get('source') || '').trim() : '',
    source_other: (f.get('source_other') || '').trim(),
  };
  const fail = (msg) => send(res, 400, renderCourse(course, { error: msg, values }));

  // anti-spam silenzioso: honeypot e tempo minimo di compilazione
  const age = timeTokenAge(f.get('t'));
  if (f.get('sito') || age === null || age < 3000 || age > 86400000) return fail('Invio non valido: ricarica la pagina e riprova.');
  if (!rateLimit('reg:' + clientIp(req), 20, 3600000)) return fail('Troppi tentativi, riprova più tardi.');
  // tetto complessivo: limita i danni anche se qualcuno riuscisse a cambiare indirizzo a ogni invio
  if (!rateLimit('reg:*', 200, 3600000)) return fail('Troppe iscrizioni in questo momento, riprova più tardi.');

  if (course.status === 'closed') return fail('Le iscrizioni per questo corso sono chiuse.');
  if (expired(course)) return fail(`Le prenotazioni si sono chiuse il ${fmtDay(course.deadline)}.`);
  if (!EMAIL_RE.test(values.email) || values.email.length > 120) return fail('Inserisci un indirizzo email valido.');
  if (values.name.length < 2 || values.name.length > 80) return fail('Inserisci il tuo nome (o un nickname).');
  if (course.phone_required && !values.phone) return fail('Inserisci il tuo numero di telefono.');
  if (values.phone && !/^[0-9+()\-\s.]{5,30}$/.test(values.phone)) return fail('Il numero di telefono non sembra valido.');
  if (values.city.length > 80) return fail('Il nome della città è troppo lungo.');
  if (values.company.length > 80) return fail('Il nome dell\'azienda è troppo lungo.');
  if (course.ask_source) {
    if (!SOURCES.includes(values.source)) return fail('Dicci come hai conosciuto questo corso.');
    if (values.source === 'Altro' && values.source_other) values.source = 'Altro: ' + values.source_other.slice(0, 80);
  }
  const valid = slotsOf(course);
  values.slots = values.slots.filter((s) => valid.includes(s));
  if (valid.length && !values.slots.length) return fail('Scegli almeno una fascia in cui potresti esserci.');
  if (f.get('consent') !== 'on') return fail('Per iscriverti devi acconsentire al trattamento dei dati.');

  let error = '';
  let waiting = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const isFull = countRegs(course.id) >= course.max_n;
    if (isFull && !course.ask_waitlist) error = 'Il corso è al completo.';
    else {
      waiting = isFull ? 1 : 0; // posti finiti: finisce in lista d'attesa, senza pagamento in anticipo
      if (waiting) values.payment = '';
      db.prepare('INSERT INTO registrations (course_id, email, name, phone, city, slots, payment, company, source, waitlist, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(course.id, values.email, values.name, values.phone, values.city, JSON.stringify(values.slots), values.payment, values.company, values.source, waiting, nowIso());
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    error = /UNIQUE/.test(String(e.message)) ? 'Questa email è già iscritta a questo corso.' : 'Errore imprevisto, riprova.';
    if (!/UNIQUE/.test(String(e.message))) console.error(e);
  }
  if (error) return fail(error);
  if (waiting) {
    telegram(`⏳ ${courseName(course)} (${course.city}): nuova persona in lista d'attesa (${waitOf(course.id).length})`).catch(() => {});
    return redirect(res, `/c/${course.slug}?ok=1&wl=1`);
  }
  notifyThresholds(course).catch((e) => console.error('notify', e));
  return redirect(res, `/c/${course.slug}?ok=1${values.payment === 'anticipo' ? '&pay=1' : ''}`);
}

/* ---------- admin ---------- */
const MIN_PW = 10;
const sessions = new Map();
const SESSION_MS = 12 * 3600 * 1000;
function sessionOf(req) {
  const m = /(?:^|;\s*)sid=([0-9a-f]{48})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const exp = sessions.get(m[1]);
  if (!exp || exp < Date.now()) { sessions.delete(m[1]); return null; }
  return m[1];
}
const cookie = (v, maxAge) => `sid=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;

function loginPage(err = '') {
  const first = !getSetting('admin_hash');
  return page('Accesso admin', `<h1>${first ? 'Imposta la password admin' : 'Accesso admin'}</h1>
    <p class="sub">${first ? `Prima volta: scegli una password (minimo ${MIN_PW} caratteri).` : 'Pannello riservato.'}</p>
    ${err ? msg('err', esc(err)) : ''}
    <form method="post" action="/login" class="card">
      <label for="pw">Password</label><input type="password" id="pw" name="pw" required autofocus>
      ${first ? '<label for="pw2">Ripeti la password</label><input type="password" id="pw2" name="pw2" required>' : ''}
      <p><button>${icon('lock')}${first ? 'Salva e accedi' : 'Entra'}</button></p></form>`);
}

// testo libero con lunghezza massima; i campi multiriga tengono gli a capo
const field = (f, k, max) => (f.get(k) || '').replace(/\r\n?/g, '\n').trim().slice(0, max);

function parseCourseForm(f) {
  const level = f.get('level');
  const out = {
    level, city: field(f, 'city', 80), location: field(f, 'location', 200),
    title: field(f, 'title', 80), description: field(f, 'description', 4000),
    slots: linesOf(f.get('slots')).slice(0, 12).map((s) => s.slice(0, 60)).join('\n'),
    min_n: parseInt(f.get('min_n'), 10), max_n: parseInt(f.get('max_n'), 10),
    teachers: field(f, 'teachers', 120), deadline: field(f, 'deadline', 10), schedule: field(f, 'schedule', 1000),
    price: field(f, 'price', 300), requirements: field(f, 'requirements', 2000), program: field(f, 'program', 6000),
    contact_email: field(f, 'contact_email', 120).toLowerCase(),
    show_location: f.get('show_location') === 'on' ? 1 : 0, phone_required: f.get('phone_required') === 'on' ? 1 : 0,
    ask_company: f.get('ask_company') === 'on' ? 1 : 0, ask_source: f.get('ask_source') === 'on' ? 1 : 0, ask_waitlist: f.get('ask_waitlist') === 'on' ? 1 : 0,
    prepay_text: field(f, 'prepay_text', 1000), btc_address: field(f, 'btc_address', 100), ln_address: field(f, 'ln_address', 600),
    cover: '', // decisa dopo, da coverFrom()
  };
  let err = '';
  if (!LEVELS[level]) err = 'Scegli il livello.';
  else if (!out.city) err = 'Inserisci la città.';
  else if (!(out.min_n >= 1 && out.max_n >= out.min_n && out.max_n <= 200)) err = 'Minimo e massimo non validi (il massimo deve essere almeno pari al minimo).';
  else if (out.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(out.deadline)) err = 'La data di chiusura delle prenotazioni non è valida.';
  else if (out.contact_email && !EMAIL_RE.test(out.contact_email)) err = 'L\'email per le informazioni non è valida.';
  else if (out.btc_address && !/^(bc1|tb1)[a-z0-9]{20,90}$|^[13mn2][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(out.btc_address)) err = 'L\'indirizzo Bitcoin non sembra valido.';
  else if (out.ln_address && !(EMAIL_RE.test(out.ln_address) || /^lnurl[a-z0-9]{20,}$/i.test(out.ln_address))) err = 'L\'indirizzo Lightning deve essere un Lightning address (nome@dominio) o un LNURL.';
  return { out, err };
}

function courseFormHtml(v, action, button) {
  const chk = (name, label) => `<label class="check"><input type="checkbox" name="${name}" ${v[name] ? 'checked' : ''}><span>${label}</span></label>`;
  return `<form method="post" action="${action}" class="card" enctype="multipart/form-data">
    <fieldset class="fs"><legend>${icon('book')}Il corso</legend>
    <label>Livello *</label><select name="level">${Object.entries(LEVELS).map(([k, l]) => `<option value="${k}" ${v.level === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <label>Titolo <small>facoltativo, es. "Don't Trust, Verify"</small></label><input type="text" name="title" maxlength="80" value="${esc(v.title)}">
    <label>Presentazione <small>due righe in cima alla pagina, es. "Dall'open source al wallet Electrum: come creare la propria cassaforte Bitcoin."</small></label><textarea name="description" maxlength="4000">${esc(v.description)}</textarea>
    <label>Docenti <small>facoltativo</small></label><input type="text" name="teachers" maxlength="120" value="${esc(v.teachers)}">
    <label>Immagine di copertina <small>facoltativa: JPG, PNG o WebP, massimo 4 MB, meglio orizzontale (es. 1200×400)</small></label>
    ${v.cover ? `<div class="cover-now"><img class="cover" src="/img/${esc(v.cover)}" alt="Copertina attuale">${chk('cover_remove', 'Togli questa immagine')}</div>` : ''}
    <input type="file" name="cover" accept="image/jpeg,image/png,image/webp">
    </fieldset>

    <fieldset class="fs"><legend>${icon('pin')}Dove e quando</legend>
    <label>Città *</label><input type="text" name="city" required maxlength="80" value="${esc(v.city)}">
    <label>Luogo preciso <small>indirizzo, sala, parcheggio...</small></label><textarea name="location" maxlength="200" style="min-height:70px">${esc(v.location)}</textarea>
    ${chk('show_location', 'Mostra il luogo preciso sulla pagina pubblica (altrimenti lo vedi solo tu)')}
    <label>Fasce indicative <small>una per riga, es. "Sabato pomeriggio" (max 12). Lasciale vuote se la data è già decisa: la scrivi in "Conferma corso".</small></label><textarea name="slots">${esc(v.slots)}</textarea>
    <label>Orari <small>una riga per voce, es. "Accoglienza 9.15"</small></label><textarea name="schedule" maxlength="1000">${esc(v.schedule)}</textarea>
    <label>Prenotazioni entro <small>facoltativo: dopo questa data il modulo si chiude da solo</small></label><input type="date" name="deadline" value="${esc(v.deadline)}">
    </fieldset>

    <fieldset class="fs"><legend>${icon('users')}Partecipanti</legend>
    <div class="row"><div style="flex:1"><label>Minimo iscritti *</label><input type="number" name="min_n" min="1" max="200" required value="${esc(v.min_n ?? 8)}"></div>
    <div style="flex:1"><label>Massimo iscritti *</label><input type="number" name="max_n" min="1" max="200" required value="${esc(v.max_n ?? 12)}"></div></div>
    <label>Requisiti per partecipare <small>uno per riga: l'icona viene scelta dalle parole (penna, smartphone, computer, connessione, corso...)</small></label><textarea name="requirements" maxlength="2000">${esc(v.requirements)}</textarea>
    ${chk('phone_required', 'Telefono obbligatorio nel modulo di iscrizione')}
    ${chk('ask_company', 'Chiedi l\'azienda (facoltativa, per chi vuole opportunità per la propria attività)')}
    ${chk('ask_source', 'Chiedi "Come hai conosciuto questo corso?" (amico, Telegram, locandina, WhatsApp, social, altro)')}
    ${chk('ask_waitlist', 'A posti esauriti accetta iscrizioni in lista d\'attesa (chi si iscrive ha la precedenza se si libera un posto o per il prossimo corso)')}
    </fieldset>

    <fieldset class="fs"><legend>${icon('euro')}Contributo e pagamento</legend>
    <label>Contributo <small>es. "80 € in Bitcoin o Lightning, 130 € in contanti"</small></label><textarea name="price" maxlength="300" style="min-height:70px">${esc(v.price)}</textarea>
    <label>Indirizzo Bitcoin <small>facoltativo: se c'è un indirizzo, chi si iscrive può scegliere di pagare in anticipo</small></label><input type="text" name="btc_address" maxlength="100" class="mono" value="${esc(v.btc_address)}">
    <label>Indirizzo Lightning <small>Lightning address (nome@dominio) o LNURL</small></label><input type="text" name="ln_address" maxlength="600" class="mono" value="${esc(v.ln_address)}">
    <label>Testo sul pagamento in anticipo <small>sconto, rimborso se il corso salta...</small></label><textarea name="prepay_text" maxlength="1000">${esc(v.prepay_text)}</textarea>
    <label>Email per informazioni e prove di pagamento</label><input type="email" name="contact_email" maxlength="120" value="${esc(v.contact_email)}">
    </fieldset>

    <fieldset class="fs"><legend>${icon('list')}Programma</legend>
    <label>Programma della giornata <small>una riga tutta in MAIUSCOLO diventa un titoletto, le righe che iniziano con "-" un elenco</small></label><textarea name="program" maxlength="6000" style="min-height:220px">${esc(v.program)}</textarea>
    </fieldset>
    <p style="margin-top:24px"><button>${icon('check')}${button}</button></p></form>`;
}

const insertCourse = (slug, v) => db.prepare(`INSERT INTO courses (slug, created_at, ${COURSE_FIELDS.join(', ')}) VALUES (?, ?, ${COURSE_FIELDS.map(() => '?').join(', ')})`)
  .run(slug, nowIso(), ...COURSE_FIELDS.map((k) => v[k] ?? ''));

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita che Excel lo legga come formula
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const PAY_LABEL = { corso: 'Al corso', anticipo: 'In anticipo' };

function adminDashboard(flash = '') {
  const courses = db.prepare('SELECT * FROM courses ORDER BY created_at DESC').all();
  const base = publicBase();
  const rows = courses.map((c) => {
    const n = countRegs(c.id);
    return `<div class="card"><div class="row">${levelPill(c)}${statusBadge(c, n)}
      ${n >= c.min_n && c.status === 'open' ? pill('Minimo raggiunto: scegli la data', 'ok', 'bell') : ''}${waitOf(c.id).length ? pill(`${waitOf(c.id).length} in lista d'attesa`, '', 'users') : ''}</div>
      <h2 style="margin:.5em 0 0;display:block">${esc(courseName(c))} – ${esc(c.city)}</h2>
      ${counter(c, n)}
      <p style="margin:12px 0 0"><a class="btn" href="/corso/${c.slug}">Apri${icon('arrow')}</a></p></div>`;
  }).join('');
  return page('Admin corsi', `<h1>Corsi</h1>
    ${flash ? msg('ok', esc(flash)) : ''}
    ${base ? '' : msg('warn', 'Per avere link e QR code corretti imposta l\'indirizzo pubblico in <a href="/impostazioni">Impostazioni</a>.')}
    ${rows || '<div class="card">Nessun corso. <a href="/corso/nuovo">Creane uno</a>.</div>'}
    ${base ? `${h2('Pagina con tutti i corsi', 'qr')}<div class="card ql"><div class="qr">${qrSvg(base + '/')}</div><div><div class="mono">${esc(base)}/</div><p class="sub">Condividi il link o stampa il QR code.</p></div></div>` : ''}`, { admin: true });
}

function adminCourse(c, flash = '') {
  const regs = regsOf(c.id);
  const wait = waitOf(c.id);
  const n = regs.length;
  const base = publicBase();
  const link = base ? `${base}/c/${c.slug}` : '';
  const stats = slotStats(c, regs);
  const best = Math.max(0, ...stats.map((s) => s.n));
  const emails = regs.map((r) => r.email).join(', ');
  const phones = regs.filter((r) => r.phone).map((r) => `${r.name}: ${r.phone}`).join('\n');
  // colonne extra: se il corso le chiede, o se qualche iscritto le ha compilate quando erano attive
  const showCo = c.ask_company || regs.some((r) => r.company);
  const showSrc = c.ask_source || regs.some((r) => r.source);
  const srcCount = new Map();
  for (const r of regs) if (r.source) { const k = r.source.startsWith('Altro') ? 'Altro' : r.source; srcCount.set(k, (srcCount.get(k) || 0) + 1); }
  const srcSummary = [...srcCount].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(k)} <b>${n}</b>`).join(' · ');
  return page(courseName(c), `
    <a class="back" href="/">${icon('back')}Tutti i corsi</a>
    ${c.cover ? `<img class="cover" src="/img/${esc(c.cover)}" alt="">` : ''}
    <div class="row">${levelPill(c)}${statusBadge(c, n)}</div>
    <h1>${esc(courseName(c))} – ${esc(c.city)}</h1>
    ${c.location ? `<p class="sub pre">${icon('pin')} ${c.show_location ? 'Luogo' : 'Luogo (privato, non mostrato sulla pagina pubblica)'}: ${esc(c.location)} ${mapLink(mapQuery(c, true))}</p>` : ''}
    ${flash ? msg('ok', esc(flash)) : ''}
    ${counter(c, n)}
    ${wait.length ? `<p class="sub">In lista d'attesa: <b>${wait.length}</b></p>` : ''}
    ${wait.length && n < c.max_n ? msg('ok', `C'è un posto libero e ${wait.length} ${wait.length === 1 ? 'persona' : 'persone'} in lista d'attesa: puoi promuovere la prima.`) : ''}

    ${h2('Disponibilità per fascia', 'chart')}
    ${stats.length ? `<div class="card"><table>${stats.map((s) => `<tr><td>${esc(s.label)}</td><td style="width:40%"><div class="bar" style="margin:4px 0"><i style="width:${n ? Math.round((s.n / n) * 100) : 0}%"></i></div></td><td><b>${s.n}</b>/${n}${s.n === best && best > 0 ? ' · la migliore' : ''}</td></tr>`).join('')}</table></div>` : '<p class="sub">Nessuna fascia indicata per questo corso.</p>'}

    ${h2('Conferma corso', 'calendar')}
    <form method="post" action="/corso/${c.slug}/conferma" class="card">
      ${n < c.min_n ? msg('warn', `Il minimo (${c.min_n}) non è ancora raggiunto: puoi confermare comunque.`) : ''}
      <label>Data definitiva <small>testo libero, es. "sabato 21 marzo 2026, 9.30–17.00"</small></label>
      <input type="text" name="date" required maxlength="120" value="${esc(c.confirmed_date)}">
      <p><button>${icon('checkc')}${c.status === 'confirmed' ? 'Aggiorna data' : 'Conferma corso'}</button></p></form>

    ${h2(`Iscritti (${n})`, 'users')}
    ${regs.length ? `<p class="sub">Pagati: <b>${regs.filter((r) => r.paid).length}</b> su ${n}${prepayOn(c) ? ` · hanno scelto di pagare in anticipo: ${regs.filter((r) => r.payment === 'anticipo').length}` : ''}</p>
      ${srcSummary ? `<p class="sub">Come ci hanno conosciuto: ${srcSummary}</p>` : ''}
      <div class="card" style="overflow-x:auto"><table><tr><th>Nome</th><th>Email</th><th>Telefono</th><th>Città</th>${showCo ? '<th>Azienda</th>' : ''}${showSrc ? '<th>Conosciuto da</th>' : ''}<th>Fasce</th><th>Contributo</th><th></th></tr>
      ${regs.map((r) => `<tr><td>${esc(r.name)}<br><small>${fmtDate(r.created_at)}</small></td><td>${esc(r.email)}</td><td>${esc(r.phone)}</td><td>${esc(r.city)}</td>
        ${showCo ? `<td>${esc(r.company)}</td>` : ''}${showSrc ? `<td>${esc(r.source)}</td>` : ''}
        <td>${JSON.parse(r.slots).map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</td>
        <td>${PAY_LABEL[r.payment] ? `<small>${PAY_LABEL[r.payment]}</small><br>` : ''}<form method="post" action="/iscritto/${r.id}/pagato"><button class="sec sm${r.paid ? ' paid' : ''}" title="${r.paid ? 'Segna come non pagato' : 'Segna come pagato'}">${r.paid ? `${icon('checkc')}Pagato` : `${icon('check')}Segna pagato`}</button></form></td>
        <td><a class="btn del sm" href="/iscritto/${r.id}/elimina" title="Elimina iscritto" aria-label="Elimina iscritto">${icon('trash')}</a></td></tr>`).join('')}</table></div>
      <div class="row"><a class="btn sec" href="/corso/${c.slug}/iscritti.csv">${icon('down')}Scarica elenco (Excel/CSV)</a>
      <a class="btn sec" href="mailto:?bcc=${encodeURIComponent(regs.map((r) => r.email).join(','))}&subject=${encodeURIComponent(courseName(c))}">${icon('mail')}Scrivi a tutti</a></div>
      <label>Tutte le email <small>da copiare nel campo CCN</small></label><textarea readonly rows="2">${esc(emails)}</textarea>
      ${phones ? `<label>Telefoni</label><textarea readonly rows="${Math.min(8, phones.split('\n').length + 1)}">${esc(phones)}</textarea>` : ''}`
      : '<div class="card">Ancora nessun iscritto.</div>'}

    ${wait.length || c.ask_waitlist ? `${h2(`Lista d'attesa (${wait.length})`, 'hourglass')}
      ${wait.length ? `<div class="card" style="overflow-x:auto"><table><tr><th>Nome</th><th>Email</th><th>Telefono</th><th>Città</th><th>Fasce</th><th></th></tr>
      ${wait.map((r) => `<tr><td>${esc(r.name)}<br><small>${fmtDate(r.created_at)}</small></td><td>${esc(r.email)}</td><td>${esc(r.phone)}</td><td>${esc(r.city)}</td>
        <td>${JSON.parse(r.slots).map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</td>
        <td><div class="row"><form method="post" action="/iscritto/${r.id}/promuovi"><button class="sec sm" title="Passa tra gli iscritti">${icon('check')}Promuovi</button></form><a class="btn del sm" href="/iscritto/${r.id}/elimina" title="Elimina" aria-label="Elimina">${icon('trash')}</a></div></td></tr>`).join('')}</table></div>
      <label>Email della lista d'attesa <small>da copiare nel campo CCN</small></label><textarea readonly rows="2">${esc(wait.map((r) => r.email).join(', '))}</textarea>` : '<div class="card">Nessuno in lista d\'attesa.</div>'}` : ''}

    ${h2('Link e QR code', 'qr')}
    ${link ? `<div class="card ql"><div class="qr">${qrSvg(link)}</div><div><div class="mono">${esc(link)}</div><p><a href="/corso/${c.slug}/qr.svg" class="btn sec">${icon('down')}Scarica QR (SVG)</a></p></div></div>`
      : msg('warn', 'Imposta l\'indirizzo pubblico in <a href="/impostazioni">Impostazioni</a> per vedere link e QR.')}

    ${h2('Gestione', 'cog')}
    <div class="row">
      <a class="btn sec" href="/corso/${c.slug}/modifica">${icon('pen')}Modifica corso</a>
      <form method="post" action="/corso/${c.slug}/duplica"><button class="sec" title="Crea un nuovo corso con gli stessi testi, senza iscritti">${icon('copy')}Duplica corso</button></form>
      ${link ? `<a class="btn sec" href="${esc(link)}" target="_blank" rel="noopener">${icon('eye')}Vedi pagina pubblica</a>` : ''}
      <form method="post" action="/corso/${c.slug}/stato"><input type="hidden" name="action" value="${c.status === 'closed' ? 'reopen' : 'close'}"><button class="sec">${c.status === 'closed' ? `${icon('unlock')}Riapri iscrizioni` : `${icon('lock')}Chiudi iscrizioni`}</button></form>
    </div>
    ${h2('Zona pericolosa', 'alert')}
    <form method="post" action="/corso/${c.slug}/elimina" class="card">
      <label class="check"><input type="checkbox" name="sure" required><span>Elimina il corso e tutti i suoi iscritti (non si può annullare)</span></label>
      <button class="del">${icon('trash')}Elimina corso</button></form>`, { admin: true });
}

function settingsPage(flash = '', kind = 'ok') {
  const tg = getSetting('tg_token') && getSetting('tg_chat');
  return page('Impostazioni', `<h1>Impostazioni</h1>
    ${flash ? msg(kind, esc(flash)) : ''}
    <form method="post" action="/impostazioni" class="card">
      <label>Indirizzo pubblico del sito <small>quello del tunnel Cloudflare, es. https://corsi.tuodominio.it</small></label>
      <input type="url" name="public_url" value="${esc(getSetting('public_url'))}" placeholder="https://...">
      <label>Telegram – token del bot ${getSetting('tg_token') ? '<small>(già impostato: lascia vuoto per non cambiarlo)</small>' : ''}</label>
      <input type="text" name="tg_token" autocomplete="off" placeholder="${getSetting('tg_token') ? '••••••••' : '123456:ABC...'}">
      <label>Telegram – chat ID</label>
      <input type="text" name="tg_chat" autocomplete="off" value="${esc(getSetting('tg_chat'))}">
      <p><button>${icon('check')}Salva</button></p></form>
    <form method="post" action="/impostazioni/test-telegram" class="card"><b>Prova Telegram</b>
      <p class="sub">Invia un messaggio di prova ${tg ? '' : '(prima salva token e chat ID)'}.</p><button class="sec">${icon('send')}Invia messaggio di prova</button></form>
    <form method="post" action="/impostazioni/password" class="card"><b>Cambia password</b>
      <label>Nuova password</label><input type="password" name="pw" required><label>Ripeti</label><input type="password" name="pw2" required>
      <p><button class="sec">${icon('key')}Cambia password</button></p></form>`, { admin: true });
}

async function handleAdmin(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let ok = false;
      try { ok = new URL(origin).host === req.headers.host; } catch { ok = false; }
      if (!ok) return send(res, 403, 'Origine non consentita', { 'Content-Type': 'text/plain' });
    }
  }

  if (p === '/health') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
  if (req.method === 'GET' && (serveFont(res, p) || serveImage(res, p) || serveIcon(res, p))) return; // le copertine sono comunque pubbliche

  if (p === '/login') {
    if (req.method === 'GET') return send(res, 200, loginPage());
    // il pannello admin non sta dietro un proxy: si usa solo l'indirizzo vero della connessione,
    // mai X-Forwarded-For (altrimenti cambiandolo si aggirerebbe il blocco dopo 5 tentativi)
    const ip = req.socket.remoteAddress || 'unknown';
    const f = await readForm(req);
    const pw = f.get('pw') || '';
    const stored = getSetting('admin_hash');
    if (!stored) {
      if (pw.length < MIN_PW) return send(res, 400, loginPage(`La password deve avere almeno ${MIN_PW} caratteri.`));
      if (pw !== f.get('pw2')) return send(res, 400, loginPage('Le due password non coincidono.'));
      setSetting('admin_hash', hashPassword(pw));
    } else {
      if (!rateLimit('login:' + ip, 5, 600000)) return send(res, 429, loginPage('Troppi tentativi. Riprova tra 10 minuti.'));
      if (!checkPassword(pw, stored)) return send(res, 401, loginPage('Password errata.'));
    }
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, Date.now() + SESSION_MS);
    return redirect(res, '/', { 'Set-Cookie': cookie(sid, SESSION_MS / 1000) });
  }

  const sid = sessionOf(req);
  if (!sid) return redirect(res, '/login');
  if (p === '/logout' && req.method === 'POST') { sessions.delete(sid); return redirect(res, '/login', { 'Set-Cookie': cookie('', 0) }); }

  const flash = url.searchParams.get('m') || '';
  const back = (to, m) => redirect(res, m ? `${to}?m=${encodeURIComponent(m)}` : to);

  if (req.method === 'GET' && p === '/') return send(res, 200, adminDashboard(flash));
  if (p === '/impostazioni' && req.method === 'GET') return send(res, 200, settingsPage(flash));

  if (p === '/impostazioni' && req.method === 'POST') {
    const f = await readForm(req);
    const u = (f.get('public_url') || '').trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(u)) return send(res, 400, settingsPage('Indirizzo non valido: deve iniziare con https://', 'err'));
    setSetting('public_url', u);
    const tok = (f.get('tg_token') || '').trim();
    if (tok) setSetting('tg_token', tok);
    setSetting('tg_chat', (f.get('tg_chat') || '').trim());
    return back('/impostazioni', 'Impostazioni salvate.');
  }
  if (p === '/impostazioni/test-telegram' && req.method === 'POST') {
    const r = await telegram('✅ Prova: il collegamento con Telegram funziona.');
    return send(res, 200, settingsPage(r.ok ? 'Messaggio di prova inviato.' : `Invio non riuscito: ${r.error}`, r.ok ? 'ok' : 'err'));
  }
  if (p === '/impostazioni/password' && req.method === 'POST') {
    const f = await readForm(req);
    const pw = f.get('pw') || '';
    if (pw.length < MIN_PW) return send(res, 400, settingsPage(`La password deve avere almeno ${MIN_PW} caratteri.`, 'err'));
    if (pw !== f.get('pw2')) return send(res, 400, settingsPage('Le due password non coincidono.', 'err'));
    setSetting('admin_hash', hashPassword(pw));
    return back('/impostazioni', 'Password cambiata.');
  }

  if (p === '/corso/nuovo') {
    if (req.method === 'GET') {
      const v = {
        level: 'base', ask_waitlist: 1, slots: 'Sabato mattina\nSabato pomeriggio\nDomenica',
        prepay_text: 'Se vuoi bloccare subito il posto, puoi inviare il contributo in anticipo in Bitcoin o Lightning.\nSe per qualsiasi motivo il corso dovesse saltare, ti rimborsiamo i bitcoin inviati.',
      };
      return send(res, 200, page('Nuovo corso', `<h1>Nuovo corso</h1><p class="sub">Per riusare un corso già fatto, aprilo e usa "Duplica corso".</p>${courseFormHtml(v, '/corso/nuovo', 'Crea corso')}`, { admin: true }));
    }
    if (tooBig(req)) return send(res, 413, page('Nuovo corso', `<h1>Nuovo corso</h1>${msg('err', TOO_BIG)}<p><a href="/corso/nuovo">Torna al modulo</a></p>`, { admin: true }));
    const f = await readForm(req);
    let { out, err } = parseCourseForm(f);
    if (!err) { const cv = coverFrom(f); if (cv.err) err = cv.err; else out.cover = cv.cover; }
    if (err) return send(res, 400, page('Nuovo corso', `<h1>Nuovo corso</h1>${msg('err', esc(err))}${courseFormHtml(out, '/corso/nuovo', 'Crea corso')}`, { admin: true }));
    const slug = newSlug();
    insertCourse(slug, out);
    return back(`/corso/${slug}`, 'Corso creato.');
  }

  const paidm = p.match(/^\/iscritto\/(\d+)\/pagato$/);
  if (paidm && req.method === 'POST') {
    const r = db.prepare('SELECT r.id, c.slug FROM registrations r JOIN courses c ON c.id = r.course_id WHERE r.id = ?').get(Number(paidm[1]));
    if (!r) return send(res, 404, page('Non trovato', '<h1>Iscritto non trovato</h1>', { admin: true }));
    db.prepare('UPDATE registrations SET paid = 1 - paid WHERE id = ?').run(r.id);
    return back(`/corso/${r.slug}`);
  }

  const promo = p.match(/^\/iscritto\/(\d+)\/promuovi$/);
  if (promo && req.method === 'POST') {
    const r = db.prepare('SELECT r.id, r.waitlist, r.course_id, c.slug, c.max_n FROM registrations r JOIN courses c ON c.id = r.course_id WHERE r.id = ?').get(Number(promo[1]));
    if (!r) return send(res, 404, page('Non trovato', '<h1>Iscritto non trovato</h1>', { admin: true }));
    if (!r.waitlist) return back(`/corso/${r.slug}`);
    if (countRegs(r.course_id) >= r.max_n) return back(`/corso/${r.slug}`, 'Non ci sono posti liberi: aumenta il massimo o elimina un iscritto, poi promuovi.');
    db.prepare('UPDATE registrations SET waitlist = 0 WHERE id = ?').run(r.id);
    notifyThresholds(db.prepare('SELECT * FROM courses WHERE id = ?').get(r.course_id)).catch((e) => console.error('notify', e));
    return back(`/corso/${r.slug}`, 'Promosso: ora è tra gli iscritti.');
  }

  const iscr = p.match(/^\/iscritto\/(\d+)\/elimina$/);
  if (iscr) {
    const r = db.prepare('SELECT r.id, r.course_id, r.name, r.email, c.slug FROM registrations r JOIN courses c ON c.id = r.course_id WHERE r.id = ?').get(Number(iscr[1]));
    if (!r) return send(res, 404, page('Non trovato', '<h1>Iscritto non trovato</h1>', { admin: true }));
    if (req.method === 'GET') {
      return send(res, 200, page('Elimina iscritto', `<h1>Eliminare questo iscritto?</h1>
        <div class="card"><b>${esc(r.name)}</b><br>${esc(r.email)}</div>
        <form method="post" action="/iscritto/${r.id}/elimina" class="row"><button class="del">${icon('trash')}Sì, elimina</button>
        <a class="btn sec" href="/corso/${r.slug}">Annulla</a></form>`, { admin: true }));
    }
    db.prepare('DELETE FROM registrations WHERE id = ?').run(r.id);
    resetNotified(r.course_id);
    return back(`/corso/${r.slug}`, 'Iscritto eliminato.');
  }

  const cm = p.match(/^\/corso\/([0-9a-f]{10})(\/[a-z.]+)?$/);
  if (cm) {
    const c = db.prepare('SELECT * FROM courses WHERE slug = ?').get(cm[1]);
    if (!c) return send(res, 404, page('Non trovato', '<h1>Corso non trovato</h1>', { admin: true }));
    const sub = cm[2] || '';

    if (!sub && req.method === 'GET') return send(res, 200, adminCourse(c, flash));

    if (sub === '/qr.svg' && req.method === 'GET') {
      if (!publicBase()) return back(`/corso/${c.slug}`);
      return send(res, 200, qrSvg(`${publicBase()}/c/${c.slug}`), { 'Content-Type': 'image/svg+xml', 'Content-Disposition': `attachment; filename="corso-${c.slug}.svg"` });
    }
    if (sub === '/modifica') {
      if (req.method === 'GET') return send(res, 200, page('Modifica corso', `<a class="back" href="/corso/${c.slug}">${icon('back')}Torna al corso</a><h1>Modifica corso</h1>${flash ? msg('ok', esc(flash)) : ''}${courseFormHtml(c, `/corso/${c.slug}/modifica`, 'Salva')}`, { admin: true }));
      if (tooBig(req)) return send(res, 413, page('Modifica corso', `<h1>Modifica corso</h1>${msg('err', TOO_BIG)}<p><a href="/corso/${c.slug}/modifica">Torna al modulo</a></p>`, { admin: true }));
      const f = await readForm(req);
      let { out, err } = parseCourseForm(f);
      if (!err) { const cv = coverFrom(f, c.cover); if (cv.err) err = cv.err; else out.cover = cv.cover; }
      if (err) return send(res, 400, page('Modifica corso', `<h1>Modifica corso</h1>${msg('err', esc(err))}${courseFormHtml({ ...out, cover: c.cover }, `/corso/${c.slug}/modifica`, 'Salva')}`, { admin: true }));
      db.prepare(`UPDATE courses SET ${COURSE_FIELDS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...COURSE_FIELDS.map((k) => out[k]), c.id);
      resetNotified(c.id);
      return back(`/corso/${c.slug}`, 'Corso aggiornato.');
    }
    if (sub === '/duplica' && req.method === 'POST') {
      // stessi testi, nessun iscritto, iscrizioni aperte; la scadenza va riscritta perché quella vecchia è passata
      const slug = newSlug();
      insertCourse(slug, { ...c, deadline: '', cover: copyCover(c.cover) });
      return back(`/corso/${slug}/modifica`, 'Copia creata, ancora senza iscritti. Controlla città, fasce e scadenza, poi salva.');
    }
    if (sub === '/iscritti.csv' && req.method === 'GET') {
      const head = ['Nome', 'Email', 'Telefono', 'Città', 'Azienda', 'Conosciuto da', 'Fasce', 'Contributo', 'Pagato', 'Iscritto il', 'Stato'];
      const lines = allRegsOf(c.id).map((r) => [r.name, r.email, r.phone, r.city, r.company, r.source, JSON.parse(r.slots).join(', '), PAY_LABEL[r.payment] || '',
        r.paid ? 'sì' : 'no', fmtDate(r.created_at), r.waitlist ? "Lista d'attesa" : 'Iscritto'].map(csvCell).join(';'));
      const body = '﻿' + [head.join(';'), ...lines].join('\r\n') + '\r\n';
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="iscritti-${c.slug}.csv"`, 'Cache-Control': 'no-store', ...SEC_HEADERS });
      return res.end(body);
    }
    if (sub === '/conferma' && req.method === 'POST') {
      const date = ((await readForm(req)).get('date') || '').trim().slice(0, 120);
      if (!date) return back(`/corso/${c.slug}`, 'Inserisci la data.');
      db.prepare("UPDATE courses SET status = 'confirmed', confirmed_date = ? WHERE id = ?").run(date, c.id);
      return back(`/corso/${c.slug}`, 'Corso confermato. Ora scrivi agli iscritti con data e luogo.');
    }
    if (sub === '/stato' && req.method === 'POST') {
      const a = (await readForm(req)).get('action');
      if (a === 'close') db.prepare("UPDATE courses SET status = 'closed' WHERE id = ?").run(c.id);
      else if (a === 'reopen') db.prepare('UPDATE courses SET status = ? WHERE id = ?').run(c.confirmed_date ? 'confirmed' : 'open', c.id);
      return back(`/corso/${c.slug}`, a === 'close' ? 'Iscrizioni chiuse.' : 'Iscrizioni riaperte.');
    }
    if (sub === '/elimina' && req.method === 'POST') {
      if ((await readForm(req)).get('sure') !== 'on') return back(`/corso/${c.slug}`);
      db.prepare('DELETE FROM courses WHERE id = ?').run(c.id);
      removeCover(c.cover);
      return back('/', 'Corso eliminato.');
    }
  }

  return send(res, 404, page('Non trovato', '<h1>Pagina non trovata</h1><p><a href="/">Torna ai corsi</a></p>', { admin: true }));
}

/* ---------- avvio ---------- */
function wrap(handler) {
  return (req, res) => {
    handler(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, page('Errore', '<h1>Si è verificato un errore</h1><p>Riprova tra poco.</p>'));
      else res.end();
    });
  };
}
const pub = http.createServer(wrap(handlePublic));
const adm = http.createServer(wrap(handleAdmin));
for (const s of [pub, adm]) { s.headersTimeout = 15000; s.requestTimeout = 20000; }
pub.listen(PUBLIC_PORT, '0.0.0.0', () => console.log(`Pubblico su :${PUBLIC_PORT}`));
adm.listen(ADMIN_PORT, '0.0.0.0', () => console.log(`Admin su :${ADMIN_PORT}`));

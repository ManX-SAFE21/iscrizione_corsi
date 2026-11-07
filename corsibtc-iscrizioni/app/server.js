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
const dns = require('node:dns');
const { AsyncLocalStorage } = require('node:async_hooks');
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
addColumns('courses', { poster: TXT });
addColumns('courses', { ev_date: TXT, ev_start: TXT, ev_end: TXT, when_mode: TXT });
addColumns('registrations', { payment: TXT, paid: FLAG, company: TXT, source: TXT, waitlist: FLAG });
const COURSE_FIELDS = ['when_mode', 'ev_date', 'ev_start', 'ev_end', 'level', 'city', 'location', 'title', 'description', 'slots', 'min_n', 'max_n', 'teachers', 'deadline', 'schedule',
  'price', 'requirements', 'program', 'contact_email', 'show_location', 'phone_required', 'prepay_text', 'btc_address', 'ln_address', 'cover',
  'ask_company', 'ask_source', 'ask_waitlist', 'poster'];
// "Come hai conosciuto questo corso?": le scelte del vecchio modulo; "Altro" ha un campo libero
const SOURCES = ['Amico o invito diretto', 'Telegram', 'Locandina', 'WhatsApp', 'Facebook o Instagram', 'Altro'];

/* ---------- immagini di copertina (salvate nella cartella dei dati, quindi nei backup) ---------- */
const IMG_DIR = path.join(DATA_DIR, 'img');
fs.mkdirSync(IMG_DIR, { recursive: true });
const MAX_IMG = 4 * 1024 * 1024;
const IMG_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const IMG_NAME = /^[0-9a-f]{20}\.(jpg|png|webp)$/;
const FILE_NAME = /^[0-9a-f]{20}\.(jpg|png|webp|pdf)$/; // copertine e locandine
const MAX_POSTER = 10 * 1024 * 1024;
const MAX_UPLOAD = MAX_IMG + MAX_POSTER + 65536;
// tipo riconosciuto dai primi byte del file, non dal nome
function imageExt(data) {
  if (data.length < 12) return '';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.readUInt32BE(0) === 0x89504e47) return 'png';
  if (data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}
const isPdf = (data) => data.length > 8 && data.toString('latin1', 0, 5) === '%PDF-';
function removeCover(name) {
  if (!FILE_NAME.test(name || '')) return;
  try { fs.unlinkSync(path.join(IMG_DIR, name)); } catch { /* già assente */ }
}
function copyCover(name) {
  if (!FILE_NAME.test(name || '')) return '';
  const copy = crypto.randomBytes(10).toString('hex') + path.extname(name);
  try { fs.copyFileSync(path.join(IMG_DIR, name), path.join(IMG_DIR, copy)); } catch { return ''; }
  return copy;
}
// controllo prima di leggere: così il browser riceve un messaggio chiaro invece di una connessione interrotta
const tooBig = (req) => {
  const big = Number(req.headers['content-length'] || 0) > MAX_UPLOAD;
  if (big) req.resume(); // scarta il corpo, così la risposta arriva pulita al browser
  return big;
};
const TOO_BIG = 'File troppo grandi: copertina massimo 4 MB, locandina massimo 10 MB. Riducili e riprova.';
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
// locandina dopo il salvataggio del modulo: come la copertina, ma accetta anche un PDF
function posterFrom(f, current = '') {
  const up = f.files && f.files.poster;
  if (up) {
    const ext = isPdf(up.data) ? 'pdf' : imageExt(up.data);
    if (!ext) return { err: "La locandina deve essere un PDF oppure un'immagine JPG, PNG o WebP." };
    if (up.data.length > MAX_POSTER) return { err: 'Locandina troppo grande: massimo 10 MB.' };
    const name = crypto.randomBytes(10).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(IMG_DIR, name), up.data);
    removeCover(current);
    return { poster: name };
  }
  if (f.get('poster_remove') === 'on') { removeCover(current); return { poster: '' }; }
  return { poster: current };
}
// copertina e locandina insieme, per Nuovo corso e Modifica corso
function filesFrom(f, out, c = {}) {
  const cv = coverFrom(f, c.cover || '');
  if (cv.err) return cv.err;
  const pv = posterFrom(f, c.poster || '');
  if (pv.err) return pv.err;
  out.cover = cv.cover;
  out.poster = pv.poster;
  return '';
}
const posterExt = (c) => (FILE_NAME.test(c.poster || '') ? path.extname(c.poster).slice(1) : '');
// la locandina si apre nel browser con il nome del corso, es. "locandina-corso-base-thiene.pdf"
function servePoster(res, c) {
  const ext = posterExt(c);
  let buf = null;
  try { if (ext) buf = fs.readFileSync(path.join(IMG_DIR, c.poster)); } catch { /* file mancante */ }
  if (!buf) return false;
  const nice = `locandina-${courseName(c)}-${c.city}`.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  res.writeHead(200, { 'Content-Type': ext === 'pdf' ? 'application/pdf' : IMG_TYPES[ext], 'Content-Disposition': `inline; filename="${nice}.${ext}"`,
    'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
  return true;
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
const LEVELS = { base: 'Base', medio: 'Medio', avanzato: 'Avanzato', evento: 'Evento' };
// tipi come si scelgono nel modulo
const KINDS = { base: 'Corso Base', medio: 'Corso Medio', avanzato: 'Corso Avanzato', evento: 'Evento' };
const isEvent = (c) => c.level === 'evento';
const kindName = (c) => (isEvent(c) ? 'Evento' : `Corso ${LEVELS[c.level] || c.level}`);
// nome del gruppo e del filtro: "Livello Base" / "Eventi"
const groupName = (k) => (k === 'evento' ? 'Eventi' : `Livello ${LEVELS[k]}`);
const chipName = (k) => (k === 'evento' ? 'Eventi' : LEVELS[k]);
// testi pensati per un corso, voltati per un evento (solo frasi fisse, mai i testi scritti dal gestore)
const EV_WORDS = [
  [/\bil prossimo corso\b/g, 'il prossimo evento'], [/\bIl corso\b/g, "L'evento"], [/\bil corso\b/g, "l'evento"],
  [/\bal corso\b/g, "all'evento"], [/\bdel corso\b/g, "dell'evento"], [/\bQuesto corso\b/g, 'Questo evento'],
  [/\bquesto corso\b/g, 'questo evento'], [/\bCorso concluso\b/g, 'Evento concluso'],
];
const evWords = (c, t) => (isEvent(c) ? EV_WORDS.reduce((acc, [re, w]) => acc.replace(re, w), t) : t);
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
const courseName = (c) => `${kindName(c)}${c.title ? ' – ' + c.title : ''}`;
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
  if (m) return readMultipart(req, m[1] || m[2], MAX_UPLOAD);
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
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/>',
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
  if (lv === 'evento') return icon('mic');
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
const levelPill = (c) => `<span class="pill lvl">${levelIcon(c.level)}${isEvent(c) ? 'Evento' : `Livello ${esc(LEVELS[c.level])}`}</span>`;
const msg = (kind, html) => `<div class="msg ${kind}">${icon({ ok: 'checkc', err: 'alert', warn: 'info' }[kind])}<div>${html}</div></div>`;
const h2 = (txt, ic) => `<h2>${icon(ic)}${txt}</h2>`;
// link alla mappa: apre l'indirizzo in Google Maps (funziona anche senza account; su telefono apre l'app mappe)
const mapLink = (q) => `<a class="maplink" href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(q)}" target="_blank" rel="noopener noreferrer" title="Apri sulla mappa">${icon('map')}Apri la mappa</a>`;

const CSS = `
@font-face{font-family:Roboto;src:url(/fonts/roboto-latin-wght-normal.woff2) format('woff2');font-weight:100 900;font-display:swap}
@font-face{font-family:'Space Mono';src:url(/fonts/space-mono-latin-400-normal.woff2) format('woff2');font-weight:400;font-display:swap}
:root{--bg:#F1EFE9;--panel:#FCFBF8;--line:#DCD8CE;--title:#0A0F1C;--body:#1E2735;--mut:#54637A;--teal:#3D8477;--teald:#30695E;--tsoft:#E4EEEA;--soft:#EAE7DF;--err:#B3261E;--esoft:#FBECEA;--warn:#8A5200;--wsoft:#FBF2E3;--shadow:none}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--body);font:16px/1.6 Roboto,'Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:720px;margin:0 auto;padding:12px 16px 64px}
/* pagine larghe: colonna chiara (come un foglio) che contiene tutto, larga 1100 px di contenuto */
main.wide{max-width:calc(1100px + 72px);padding:20px 36px 64px;background:#F9F8F4;border-left:1px solid var(--line);border-right:1px solid var(--line);box-shadow:0 0 40px rgba(30,42,47,.05);min-height:100vh}
@media (max-width:640px){main.wide{padding:12px 16px 48px;border:0;box-shadow:none}}
h1,h2,h3{font-family:Roboto,'Segoe UI',Arial,sans-serif;font-weight:500;color:var(--title);line-height:1.2}
h1{font-size:1.85rem;margin:.3em 0 .3em}
h2{font-size:1.2rem;margin:1.8em 0 .6em;display:flex;align-items:center;gap:8px}
h2 .i{color:var(--teal);width:1.05em;height:1.05em}
h3{font-size:1rem;margin:1.2em 0 .4em}
a{color:var(--teal)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
.i{width:1.1em;height:1.1em;vertical-align:-.2em;flex:none}
.sub{color:var(--mut);margin:0 0 1.2em}
.top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 16px;padding:8px 0 10px;margin-bottom:14px;border-bottom:1px solid var(--line)}
.brand{display:inline-flex;align-items:center;gap:10px;font:600 1.05rem Roboto,sans-serif;color:var(--title);text-decoration:none}
.brand .mark{width:36px;height:36px;border-radius:10px;overflow:hidden;display:inline-flex;flex:none}
.brand .mark img{width:100%;height:100%;display:block}
.brand small{font-weight:500;color:var(--mut);margin-left:2px}
.brand .bname{display:flex;flex-direction:column;line-height:1.15}
.brand .bname small{margin:0;font-size:.66rem;letter-spacing:.1em;text-transform:uppercase}
.nav{display:flex;gap:2px;flex-wrap:wrap;align-items:center}
.nav a,.nav button{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;color:var(--body);background:none;border:0;font:500 .93rem/1.4 Roboto,'Segoe UI',Arial,sans-serif;text-decoration:none;cursor:pointer}
.nav a:hover,.nav button:hover{background:var(--soft);color:var(--title)}
.nav .i{color:var(--teal)}
.back{display:inline-flex;align-items:center;gap:6px;color:var(--mut);text-decoration:none;font-size:.93rem;margin:0 0 12px}
.back:hover{color:var(--teal)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;margin:14px 0;box-shadow:var(--shadow)}
/* pulsante Salva del modulo corso: resta in fondo allo schermo mentre si scorre */
.savebar{position:sticky;bottom:0;z-index:5;display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:24px -20px -20px;padding:12px 20px;background:var(--panel);border-top:1px solid var(--line);border-radius:0 0 12px 12px;box-shadow:0 -6px 14px rgba(10,15,28,.06)}
.savebar small{color:var(--mut);font-size:.85rem}
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
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:var(--teal);color:#fff;border:1px solid var(--teal);border-radius:8px;padding:10px 18px;font:500 15px/1.4 Roboto,'Segoe UI',Arial,sans-serif;cursor:pointer;text-decoration:none}
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
.msg.done{gap:14px;padding:20px 22px;border:2px solid var(--teal);font-size:1.05rem}
.msg.done .i{width:30px;height:30px;margin-top:0}
.msg.done p{margin:0 0 8px}.msg.done p:last-child{margin:0}
.msg.done .dt{font-size:1.35rem;font-weight:700;color:var(--teald);margin-bottom:10px}
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
.lv-base{--lv:#3D8477;--lv2:#5FA092}
.lv-medio{--lv:#4A79A6;--lv2:#6E9BC4}
.lv-avanzato{--lv:#565E8A;--lv2:#7A82B2}
.lv-evento{--lv:#A87436;--lv2:#C4955C}
.hero{position:relative;overflow:hidden;border-radius:16px;padding:20px 28px 22px;margin:0 0 14px;background:linear-gradient(120deg,#DDE9E4,#E6EFEA 60%,#EEF3F0);color:var(--body);border:1px solid var(--line)}
.hero::before,.hero::after{content:'';position:absolute;border-radius:50%;background:rgba(61,132,119,.08)}
.hero::before{width:280px;height:280px;right:-70px;top:-110px}
.hero::after{width:180px;height:180px;right:90px;bottom:-110px}
.hero>*{position:relative}
.hero .hrow{display:flex;align-items:center;flex-wrap:wrap;gap:6px 16px;margin:0 0 6px}
.hero h1{color:var(--title);font-size:clamp(1.7rem,4.5vw,2.1rem);margin:0}
.hero p{margin:0;max-width:560px;font-size:1rem;color:var(--body)}
.hero .stats{display:flex;gap:8px;flex-wrap:wrap}
.hero .pill{background:rgba(255,255,255,.7);color:var(--title);font-size:.85rem}
.hero .pill .i{color:var(--teal)}
.gh{margin:28px 0 10px;font-size:1.15rem;color:var(--lv,var(--title))}
.gh .i{color:var(--lv,var(--teal))}
.gh .pill{margin-left:4px;background:var(--soft);color:var(--mut)}
.empty{display:flex;gap:14px;align-items:center;color:var(--mut)}
.empty .i{width:28px;height:28px;color:var(--teal)}
.empty p{margin:0}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 4px}
.filters a{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--body);text-decoration:none;font-size:.92rem;font-weight:500}
.filters a .i{color:var(--lv,var(--teal))}
.filters a small{color:var(--mut);font-weight:400}
.filters a:hover{border-color:var(--lv,var(--teal))}
.filters a.sel{background:var(--lv,var(--teal));border-color:var(--lv,var(--teal));color:#fff}
.filters a.sel .i,.filters a.sel small{color:#fff}
main.wide:has(.adm){max-width:1280px}
.rowact{display:flex;gap:6px;justify-content:flex-end}.rowact .btn{margin:0}
.whenq{grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));margin:4px 0 8px}
.whenbox{display:none;margin:4px 0 6px}
form:has(input[name=when_mode][value=date]:checked) .wb-date,form:has(input[name=when_mode][value=slots]:checked) .wb-slots{display:block}
.mailbox h3{display:flex;align-items:center;gap:8px;margin:0 0 6px;font-size:1.05rem}.mailbox h3 .i{color:var(--teal)}.mailbox details summary{cursor:pointer;color:var(--teald);font-weight:500;margin:6px 0}
.adm{display:grid;grid-template-columns:minmax(0,1fr) 230px;gap:28px;align-items:start}
.adm-main{min-width:0}
.adm-side{position:sticky;top:12px;grid-column:2;grid-row:1;display:grid;gap:10px;max-height:calc(100vh - 24px);overflow-y:auto;align-content:start}
.adm-box{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px}
.adm-box .qr{width:100%;max-width:130px;margin:0 auto 8px}
.adm-box .qr svg{display:block;width:100%;height:auto}
.adm-box .mono{font-size:.78rem;word-break:break-all;text-align:center;margin:0 0 8px}
.adm-box p{margin:0}
.adm-box.danger form{margin:0}.adm-box.danger label.check{margin:0 0 10px;font-size:.9rem}.adm-box.danger .del{display:flex;width:100%;justify-content:center;box-sizing:border-box}
.adm-box .btn{display:flex;width:100%;justify-content:center;box-sizing:border-box}
.adm-side h2{display:flex;align-items:center;gap:8px;font-size:1rem;margin:0 0 8px}
.adm-side h2 .i{color:var(--teal)}
.adm-btns{display:grid;gap:6px}.adm-box .btn,.adm-box button{padding-top:8px;padding-bottom:8px;font-size:.9rem}
.adm-btns form{margin:0}
.adm-btns .btn,.adm-btns button{display:flex;align-items:center;gap:8px;width:100%;justify-content:flex-start;margin:0;box-sizing:border-box}
@media (max-width:820px){.adm{grid-template-columns:1fr}.adm-side{position:static;grid-column:1;grid-row:auto}}
.hero .filters,.filters.seg{display:inline-flex;flex-wrap:nowrap;gap:2px;margin:14px 0 0;padding:4px;background:rgba(255,255,255,.6);border:1px solid rgba(61,132,119,.16);border-radius:999px}
.hero .filters a,.filters.seg a{border:0;background:none;padding:7px 16px;white-space:nowrap}
.hero .filters a:hover,.filters.seg a:hover{background:rgba(255,255,255,.7)}
.hero .filters a.sel,.filters.seg a.sel{background:var(--lv,var(--teal));box-shadow:0 1px 3px rgba(10,15,28,.18)}
@media (max-width:400px){.hero .filters a{padding:7px 11px;font-size:.88rem}}
.dhead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 14px}.dhead h1{margin:0}.dhead .filters.seg{margin:0 auto 0 8px;background:var(--panel);border-color:var(--line)}.dhead .filters.seg a:hover{background:var(--soft)}
.ccard .calert{display:flex;flex-wrap:wrap;gap:6px}
/* pagina pubblica: schede sovrapposte in 3D. Davanti a sinistra la più recente, le altre dietro verso destra.
   Tutte nella stessa cella della griglia: il mazzo prende l'altezza della scheda più alta.
   Passandoci sopra una scheda viene davanti; uscendo torna al suo posto e scende dietro piano piano. Solo CSS. */
.fan{--w:320px;display:grid;grid-template-columns:var(--w);container-type:inline-size;perspective:1400px;padding:10px 0 22px;margin:0 0 18px}
.fan>.ccard{grid-area:1/1;--step:min(250px,calc((100cqw - var(--w) - 24px) / max(var(--n) - 1,1)));
  --rest:translateX(calc(var(--i) * var(--step))) translateZ(calc(var(--i) * -60px)) rotateY(-14deg);
  --up:translateX(calc(var(--i) * var(--step))) translateY(-8px) translateZ(50px) rotateY(0);
  transform-origin:0 50%;transform:var(--rest);z-index:calc(10 - var(--i));
  box-shadow:-10px 12px 26px rgba(30,42,47,.13),-2px 2px 6px rgba(30,42,47,.08);
  filter:brightness(calc(1 - var(--i) * .035)) saturate(calc(1 - var(--i) * .12));
  transition:transform .22s cubic-bezier(.2,.8,.3,1),filter .22s,box-shadow .22s,z-index .22s steps(30,end)}
.fan>.ccard:first-child{--rest:translateZ(0) rotateY(0);box-shadow:0 14px 30px rgba(30,42,47,.14),0 2px 6px rgba(30,42,47,.08)}
.fan>.ccard:hover,.fan>.ccard:focus-visible{transform:var(--up);z-index:40;filter:none;border-color:var(--line);box-shadow:0 22px 44px rgba(30,42,47,.2);
  transition:transform .22s cubic-bezier(.2,.8,.3,1),filter .22s,box-shadow .22s,z-index 0s}
/* telefono: le schede scendono in verticale, la più recente in alto e sopra; ognuna copre solo il bordo della successiva */
@media (max-width:640px){
  .fan{display:flex;flex-direction:column;padding:6px 0 10px}
  .fan>.ccard,.fan>.ccard:first-child{--rest:translateZ(0);--up:translateY(-8px) translateZ(24px)}
  .fan>.ccard+.ccard{margin-top:-44px}
}
@media (prefers-reduced-motion:reduce){.fan>.ccard,.fan>.ccard:hover{transition:none}}
/* bacheca: 4 colonne affiancate, una per tipo; dentro, le schede scendono e si coprono un po' (in alto la più recente) */
.board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;align-items:start;margin:0 0 18px}
.board.one{grid-template-columns:minmax(0,360px);justify-content:center}
.board .gh{margin:0 0 10px;font-size:1.05rem}
.board .fan{display:flex;flex-direction:column;padding:4px 0 10px;margin:0;container-type:normal}
.board .fan>.ccard,.board .fan>.ccard:first-child{grid-area:auto;width:auto;transform-origin:50% 0;--rest:translateZ(0);--up:translateY(-8px) translateZ(24px)}
.board .fan>.ccard+.ccard{margin-top:-44px}
.board .ccard{padding:16px 16px 14px}
.board .ccard .cban{margin:-16px -16px -66px}
.board .ccard b{font-size:1.05rem}
.bempty{padding:22px 14px;border:1px dashed var(--line);border-radius:12px;color:var(--mut);font-size:.92rem;text-align:center;background:rgba(255,255,255,.4)}
@media (max-width:1000px){.board{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:640px){.board{grid-template-columns:1fr}}
.cgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:16px}
.ccard{display:flex;flex-direction:column;gap:10px;padding:18px 20px 16px;background:var(--panel);border:1px solid var(--line);border-top:5px solid var(--lv);border-radius:12px;color:inherit;text-decoration:none;box-shadow:var(--shadow);transition:transform .15s,box-shadow .15s}
.ccard:hover{border-color:#C5CFDC}
.ccard .chead{display:flex;align-items:center;gap:10px}
.ccard .cic{width:42px;height:42px;border-radius:10px;background:var(--lv);color:#fff;display:flex;align-items:center;justify-content:center;flex:none;overflow:hidden}
.ccard .cic .i{width:22px;height:22px;vertical-align:0}
.ccard .cban{display:block;margin:-18px -20px 0;height:186px;margin-bottom:-66px;overflow:hidden;background:var(--panel);border-radius:7px 7px 0 0}
.ccard .cban img{display:block;width:100%;height:100%;object-fit:cover;object-position:center 30%;-webkit-mask-image:linear-gradient(to bottom,rgba(0,0,0,.7) 0%,rgba(0,0,0,.45) 35%,transparent 100%);mask-image:linear-gradient(to bottom,rgba(0,0,0,.7) 0%,rgba(0,0,0,.45) 35%,transparent 100%)}
.ccard .cban{position:relative}
.ccard .cban~b,.ccard .cban~.cmeta{position:relative}
.ccard .cpill{position:absolute;left:12px;top:12px}
.ccard .cpill .pill{background:rgba(255,255,255,.95);box-shadow:0 1px 3px rgba(10,15,28,.18)}
.ccard .pill.lvl{border-color:var(--lv);color:var(--lv)}.ccard .pill.lvl .i{color:var(--lv)}
.ccard b{display:block;color:var(--title);font-weight:600;font-size:1.15rem;line-height:1.3}
.ccard .cmeta{display:grid;gap:5px;font-size:.95rem;color:var(--body)}
.ccard .cmeta>span{display:flex;align-items:center;gap:8px}
.ccard .cmeta .i{color:var(--lv)}
.ccard .cseat{margin-top:auto}
.ccard .cseat .bar{margin:0 0 4px}.ccard .cseat .bar>i{background:var(--lv)}
.ccard .cseat small{display:block;font-size:.85rem;color:var(--mut)}
.ccard .cfoot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:4px;padding-top:12px;border-top:1px solid var(--line)}
.ccard .cgo{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:var(--lv)}
/* sezioni apribili con un clic (senza script): dettagli, requisiti, programma, corsi fatti */
details.sec{margin:14px 0}
.sec summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;padding:14px 18px;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);font-size:1.1rem;font-weight:500;color:var(--title)}
.sec summary::-webkit-details-marker{display:none}
.sec summary .i{color:var(--lv,var(--teal))}
.sec summary small{color:var(--mut);font-weight:400}
.sec summary .tg{margin-left:auto;font-size:.88rem;color:var(--lv,var(--teal));font-weight:500;white-space:nowrap}
.sec summary .tg::after{content:'Mostra'}.sec[open] summary .tg::after{content:'Nascondi'}
.sec[open] summary{border-radius:12px 12px 0 0}
.sec .card{margin:0;border-radius:0 0 12px 12px;border-top:0}
.sec.past{margin-top:36px}
.secs{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin:14px 0}
.secs .sec{margin:0}.secs .sec summary{border:0;border-radius:0;background:none}
.secs .sec+.sec{border-top:1px solid var(--line)}
.secs .sec .card{border:0;border-radius:0;background:var(--bg);border-top:1px solid var(--line)}
.pl{list-style:none;margin:0;padding:0}
.pl li{display:flex;gap:14px;align-items:center;padding:12px 0}
.pl li+li{border-top:1px solid var(--line)}
.pl a{color:inherit;text-decoration:none;min-width:0}
.pl a:hover b{color:var(--lv)}
.pl b{display:block;color:var(--title);font-weight:600}
.pl .cmeta{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:.9rem;color:var(--mut)}
.pl .cmeta span{display:inline-flex;align-items:center;gap:5px}.pl .cmeta .i{color:var(--lv)}
.pl .pill.lvl{flex:none}
/* pagina corso: i 3-4 riquadri in alto */
.keys{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:12px 24px;margin:0 0 26px}
.key{display:flex;gap:12px;align-items:center;padding:4px 0;min-width:0}
.key .ic{flex:none;width:40px;height:40px;border-radius:10px;background:var(--lv,var(--teal));color:#fff;display:flex;align-items:center;justify-content:center}
.key .ic .i{width:20px;height:20px;vertical-align:0}
.key b{display:block;font-size:.74rem;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);font-weight:600}
.key .v{display:block;color:var(--title);font-weight:600;font-size:1.02rem;line-height:1.3;overflow-wrap:anywhere;white-space:pre-line}
@media (max-width:640px){.keys{grid-template-columns:1fr 1fr;gap:8px}.key:last-child:nth-child(odd){grid-column:1/-1}.key{gap:10px}.key .ic{width:34px;height:34px}.key .ic .i{width:17px;height:17px}.key .v{font-size:.95rem}}
.media{position:relative;height:168px;overflow:hidden;flex:none;background:linear-gradient(135deg,var(--lv),var(--lv2))}
.media img.cover{display:block;width:100%;height:100%;object-fit:cover}
.media .deco{position:absolute;right:-18px;bottom:-34px;width:150px;height:150px;color:rgba(255,255,255,.17)}
.media .deco .i{width:100%;height:100%;vertical-align:0}
.media .pills{position:absolute;left:12px;top:12px;right:12px;display:flex;flex-wrap:wrap;gap:6px}
.media .pill{background:rgba(255,255,255,.96);color:var(--title);box-shadow:0 1px 3px rgba(10,15,28,.18)}
.media .pill .i{color:var(--lv)}
.media .pill.ok,.media .pill.on{color:var(--teald)}
.course{position:relative;display:flex;flex-direction:column;margin:0;padding:0;overflow:hidden;transition:transform .15s,box-shadow .15s,border-color .15s}
.course:hover{border-color:#C5CFDC}
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
.media.big img.cover{height:auto;max-height:300px}
.media.big .deco{width:200px;height:200px;right:-20px;bottom:-56px}
.ch{margin:0 0 8px;font-size:clamp(1.6rem,4vw,2.15rem)}
.cstrip{height:8px;border-radius:8px;background:linear-gradient(90deg,var(--lv),var(--lv2));margin:0 0 20px}
.chead2{margin:0 0 26px;padding:0 0 20px;border-bottom:1px solid var(--line)}
.chead2 .eyebrow{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 10px;color:var(--lv);font-weight:600;font-size:.82rem;letter-spacing:.08em;text-transform:uppercase}
.chead2 .eyebrow>.i{width:18px;height:18px}
.chead2 .eyebrow .pill{text-transform:none;letter-spacing:0;font-weight:500;margin-left:4px}
.chead2 .ch{font-size:clamp(1.5rem,3.4vw,2rem);line-height:1.2;margin:0 0 12px;max-width:34ch}
.chead2 .subline{display:flex;flex-wrap:wrap;gap:8px 22px;margin:0;color:var(--body);font-size:1.02rem}
.chead2 .subline span{display:inline-flex;align-items:center;gap:8px}
.chead2 .subline .i{color:var(--lv)}
.psec{margin:0 0 22px}.psec>h2{margin:0 0 10px}.psec>.card{margin:0}
.pr{margin:0 0 12px}
.course-meta.row2{display:flex;flex-wrap:wrap;gap:6px 20px;margin:0 0 22px;font-size:1rem}
.cwrap{display:grid;grid-template-columns:minmax(0,1fr);gap:18px}
.cmain>:first-child{margin-top:0}
.aside{margin:0}
.abox{margin:0;padding:18px 20px}
.toc{display:none}
@media (min-width:940px){
  .aside{margin-top:calc(1.2rem * 1.3 + 8px);position:sticky;top:14px;max-height:calc(100vh - 28px);overflow-y:auto}
  .toc{display:grid;gap:2px;margin:14px 0 0;padding:12px 8px;background:var(--panel);border:1px solid var(--line);border-radius:12px}
  .toc>b{font-size:.74rem;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);font-weight:600;padding:0 10px 6px}
  .toc a{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;border-left:3px solid transparent;color:var(--body);text-decoration:none;font-size:.93rem}
  .toc a .i{color:var(--mut)}
  .toc a:hover{background:var(--soft)}
  /* la voce si colora mentre la sua sezione passa sulla linea a 15% dall alto dello schermo */
  @supports (animation-timeline:view()){
    .toc a{animation:tocOn linear both;animation-fill-mode:none;animation-range:cover 85vh cover calc(100% - 15vh)}
  }
}
@keyframes tocOn{from,to{background:var(--tsoft);border-left-color:var(--lv,var(--teal));color:var(--title);font-weight:600}}
.psec,.enroll{scroll-margin-top:16px}
.aside h2{margin:0 0 6px;font-size:1.05rem}
.aside .dl{display:flex;gap:8px;align-items:center;color:var(--mut);font-size:.92rem;margin:10px 0 0}
.aside .dl .i{color:var(--lv,var(--teal))}
.btn.big,button.big{width:100%;padding:13px 20px;font-size:1rem}
.aside .btn.sec.big{margin-top:10px}
.share{margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}
.share>b{display:flex;align-items:center;gap:6px;font-size:.92rem;color:var(--title);margin:0 0 8px}
.share>b .i{color:var(--lv,var(--teal))}
.share div{display:flex;flex-wrap:wrap;gap:6px}
.share a{padding:5px 12px;border:1px solid var(--line);border-radius:999px;font-size:.86rem;color:var(--body);text-decoration:none;background:var(--panel)}
.share a:hover{border-color:var(--lv,var(--teal));color:var(--lv,var(--teal))}
.share .mono{margin:10px 0 0;font-size:.78rem;color:var(--mut);user-select:all}
.aside .btn.big{margin-top:14px}
@media (min-width:940px){.cwrap{grid-template-columns:minmax(0,1fr) 230px;gap:32px;align-items:start}.aside{grid-column:2;grid-row:1}.cmain{grid-column:1;grid-row:1}}
.foot{display:flex;gap:8px;align-items:center;justify-content:center;text-align:center;color:var(--mut);font-size:.85rem;margin-top:44px;padding-top:18px;border-top:1px solid var(--line)}
.foot .i{color:var(--teal);flex:none}
.intro{font-size:1.1rem;color:var(--body);margin:4px 0 20px;white-space:pre-wrap}
.calm{margin-top:12px}
.calm>summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--title);font-weight:500;font-size:.95rem}
.calm>summary::-webkit-details-marker{display:none}
.calm>summary .i{color:var(--lv,var(--teal))}
.calm[open]>summary{border-color:var(--lv,var(--teal))}
.calm-list{display:grid;gap:2px;margin-top:6px;padding:6px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
.calm-list a{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;color:var(--body);text-decoration:none;font-size:.93rem}
.calm-list a:hover{background:var(--soft)}
.calm-list a .i{flex:none;color:var(--lv,var(--teal))}
.calm-list small{display:block;color:var(--mut);font-size:.78rem}
.calafter{max-width:340px;margin:0 0 16px}
.calrow{display:flex;flex-wrap:wrap;gap:10px 16px;margin-top:10px}.calrow label{display:grid;gap:4px;margin:0}
.chead2 .desc{font-size:1.2rem;line-height:1.55;color:var(--body);margin:0 0 14px;max-width:72ch;white-space:pre-wrap}
.chead2 .intro{font-size:clamp(1.3rem,2.6vw,1.6rem);line-height:1.4;color:var(--title);margin:0 0 14px;max-width:62ch}
/* due colonne che si riempiono dall'alto (come un giornale): niente buchi sotto le caselle corte */
.facts{list-style:none;margin:0;padding:0;columns:2 260px;column-gap:36px}
.facts>li{break-inside:avoid;margin:0 0 28px}.facts>li:last-child{margin-bottom:0}
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
.fs legend{font:600 1.05rem Roboto,sans-serif;color:var(--title);padding:0 10px 0 0;display:flex;align-items:center;gap:8px}
.fs legend .i{color:var(--teal)}
.contact{display:flex;align-items:center;gap:8px;color:var(--mut);margin-top:28px}
.ql{display:flex;gap:20px;flex-wrap:wrap;align-items:center}
.cover{display:block;width:100%;object-fit:cover;background:var(--soft)}
.cover-now{margin:0 0 10px}.cover-now .cover{max-height:160px;margin:0 0 4px;border:1px solid var(--line);border-radius:10px}
input[type=file]{font:inherit;color:var(--mut);max-width:100%}
.enroll{scroll-margin-top:16px}
.enrollform{padding:22px}
.fgrid{display:grid;grid-template-columns:1fr}
.fld label{margin:14px 0 6px;font-size:.97rem}
.fld:first-child label{margin-top:0}
.step{padding:22px 0;border-top:1px solid var(--line)}
.step:first-child{border-top:0;padding-top:0}
.sl{display:flex;align-items:flex-start;gap:12px;margin:0 0 10px}
.sn{flex:none;width:34px;height:34px;border-radius:50%;background:var(--teal);color:#fff;font-weight:700;font-size:1.05rem;display:flex;align-items:center;justify-content:center}
.sl h3{margin:4px 0 0;font-size:1.15rem;font-weight:600;color:var(--title)}
.sl small{display:block;font-weight:400;color:var(--mut);font-size:.92rem;margin-top:2px}
.sb{padding-left:46px}
@media (max-width:480px){.sb{padding-left:0}}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.fld .opt{font-weight:400;color:var(--mut);font-size:.78rem;margin-left:8px;background:var(--soft);border-radius:999px;padding:1px 9px}
.star{color:var(--teal)}
.inp{position:relative}
.inp>.i{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#7C8BA1;width:18px;height:18px;pointer-events:none}
.inp:focus-within>.i{color:var(--teal)}
.inp input{padding:12px 12px 12px 42px;font-size:1.02rem}
.hint{margin:5px 0 0;font-size:.82rem;color:var(--mut)}
fieldset.qs{border:0;padding:0;margin:0;min-width:0}
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
.tiles.pay .tile:has(input:checked){box-shadow:0 0 0 2px var(--teal) inset}.consent{display:flex;gap:12px;align-items:flex-start;margin:0;padding:14px 16px;border-radius:10px;background:var(--bg);border:1px solid var(--line);font-weight:400;font-size:.9rem;color:var(--mut)}
.consent input{width:20px;height:20px;margin:2px 0 0;flex:none;accent-color:var(--teal)}
.enrollform .btn.big{margin-top:16px;font-size:1.08rem;padding:15px 20px}
@media (max-width:480px){main{padding-top:4px}.hero{padding:16px 18px 18px}.hero h1{font-size:1.6rem}.enrollform{padding:18px}}
@media print{.top,.nav,button,.btn,.back,.maplink{display:none}body{background:#fff}.card{box-shadow:none}}
`;

const ICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" width=\"256\" height=\"256\">\n  <rect width=\"256\" height=\"256\" fill=\"#3D8477\"/>\n  <rect x=\"50\" y=\"64\" width=\"156\" height=\"146\" rx=\"22\" fill=\"#FCFBF8\"/>\n  <path d=\"M50 86a22 22 0 0 1 22-22h112a22 22 0 0 1 22 22v18H50z\" fill=\"#2B5F55\"/>\n  <rect x=\"86\" y=\"44\" width=\"16\" height=\"38\" rx=\"8\" fill=\"#FCFBF8\" stroke=\"#2B5F55\" stroke-width=\"6\"/>\n  <rect x=\"154\" y=\"44\" width=\"16\" height=\"38\" rx=\"8\" fill=\"#FCFBF8\" stroke=\"#2B5F55\" stroke-width=\"6\"/>\n  <g transform=\"translate(124 158) scale(.66)\" fill=\"none\" stroke=\"#E8892B\" stroke-width=\"15\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n    <path d=\"M-20 -36V36\"/>\n    <path d=\"M-20 -36H8a17 17 0 0 1 0 34H-20\"/>\n    <path d=\"M-20 -2H12a19 19 0 0 1 0 38H-20\"/>\n    <path d=\"M-8 -36V-48M8 -36V-48M-8 36V48M8 36V48\"/>\n  </g>\n</svg>\n";
function serveIcon(res, p) {
  if (p !== '/icon.svg') return false;
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  res.end(ICON_SVG);
  return true;
}

const FOOT = `<footer class="foot">${icon('shield')}<span>I dati degli iscritti non vengono ceduti a terzi e vengono cancellati dopo il corso.</span></footer>`;

function page(title, body, { admin = false, wide = false, head = '' } = {}) {
  const brand = `<a class="brand" href="/"><span class="mark"><img src="/icon.svg?v=2" alt="" width="34" height="34"></span><span class="bname">Eventi e Corsi<small>Bitcoin</small></span>${admin ? '<small>· Admin</small>' : ''}</a>`;
  const nav = admin
    ? `<nav class="nav"><a href="/">${icon('list')}Corsi</a><a href="/corso/nuovo">${icon('plus')}Nuovo evento</a><a href="/impostazioni">${icon('cog')}Impostazioni</a>
       ${adminCtx.getStore()?.umbrel ? '' : `<form method="post" action="/logout"><button type="submit">${icon('out')}Esci</button></form>`}</nav>`
    : '';
  // <!--email_off-->: Cloudflare non deve nascondere le email (e gli indirizzi Lightning): lo script che le ricompone sarebbe bloccato dalla CSP
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><link rel="icon" type="image/svg+xml" href="/icon.svg?v=2">${head}
<title>${esc(title)}</title><style>${CSS}</style></head><body><!--email_off--><main${wide ? ' class="wide"' : ''}><header class="top">${brand}${nav}</header>${body}${admin ? '' : FOOT}</main><!--/email_off--></body></html>`;
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
  if (c.status === 'done') return pill('Concluso', 'off', 'checkc');
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

// posti in breve, per la riga della lista
function seatsShort(c, n) {
  const confirmed = c.status === 'confirmed';
  const pct = Math.min(100, Math.round((n / (confirmed ? c.max_n : c.min_n)) * 100));
  const txt = n >= c.max_n ? `Completo (${n}/${c.max_n})`
    : confirmed || n >= c.min_n ? `${c.max_n - n} posti liberi su ${c.max_n}`
      : `${n} su ${c.min_n} per partire`;
  return `<div class="bar"><i style="width:${pct}%"></i></div><small>${esc(txt)}</small>`;
}

function courseRow(c, admin = false, pos = null) {
  const n = countRegs(c.id);
  const wait = n >= c.max_n && c.ask_waitlist && !expired(c) && c.status !== 'closed';
  const when = whenText(c) ? `<span>${icon('calendar')}${esc(whenText(c))}</span>`
    : slotsOf(c).length ? `<span>${icon('calendar')}Data da scegliere insieme</span>` : '';
  const dl = c.deadline && !expired(c) ? `<span>${icon('hourglass')}Iscrizioni entro il ${fmtDay(c.deadline)}</span>` : '';
  const nw = admin ? waitOf(c.id).length : 0;
  const alerts = admin ? [
    n >= c.min_n && c.status === 'open' ? pill('Minimo raggiunto: scegli la data', 'ok', 'bell') : '',
    nw ? pill(`${nw} in lista d'attesa`, '', 'hourglass') : '',
  ].join('') : '';
  return `<a class="ccard ${levelClass(c)}" href="${admin ? '/corso/' : '/c/'}${c.slug}"${pos === null ? '' : ` style="--i:${pos}"`}>
    ${c.cover ? `<span class="cban"><img src="/img/${esc(c.cover)}" alt=""><span class="cpill">${levelPill(c)}</span></span>` : `<span class="chead"><span class="cic">${levelIcon(c.level)}</span>${levelPill(c)}</span>`}
    <b>${esc(c.title || kindName(c))}</b>
    <span class="cmeta"><span>${icon('pin')}${esc(c.city)}</span>${when}${dl}</span>
    ${alerts ? `<span class="calert">${alerts}</span>` : ''}
    <span class="cseat">${seatsShort(c, n)}</span>
    <span class="cfoot">${wait ? pill("Lista d'attesa aperta", 'on', 'users') : statusBadge(c, n, false)}<span class="cgo">${admin ? 'Gestisci' : isEvent(c) ? "Vedi l'evento" : 'Vedi il corso'}${icon('arrow')}</span></span>
  </a>`;
}

// corso già fatto: una riga nell'elenco in fondo alla pagina, con il link alla sua pagina (senza modulo)
function pastRow(c) {
  return `<li class="${levelClass(c)}">${levelPill(c)}<a href="/c/${c.slug}"><b>${esc(c.title || kindName(c))}</b>
    <span class="cmeta"><span>${icon('pin')}${esc(c.city)}</span>${c.confirmed_date ? `<span>${icon('calendar')}${esc(c.confirmed_date)}</span>` : ''}</span></a></li>`;
}

// REGOLA: gestione e pagina pubblica mostrano i corsi con la stessa grafica e lo stesso ordine.
// Tutte e due passano da qui: cambiare il disegno o l'ordine solo in questa funzione.
const GROUP_ORDER = ['evento', 'base', 'medio', 'avanzato'];
function courseGroups(list, only, admin) {
  // list arriva già dal più recente al più vecchio (ORDER BY created_at DESC)
  const lv = (c) => (LEVELS[c.level] ? c.level : 'base');
  const levels = GROUP_ORDER.filter((k) => list.some((c) => lv(c) === k));
  if (!levels.includes(only)) only = '';
  const byLevel = (k) => list.filter((c) => lv(c) === k);
  const chip = (k, label, n, cls = '') => `<a class="${cls}${only === k ? ' sel' : ''}" href="${k ? `/?livello=${k}` : '/'}">${k ? levelIcon(k) : icon('book')}${label} <small>${n}</small></a>`;
  const filters = levels.length > 1
    ? `<nav class="filters${admin ? ' seg' : ''}">${chip('', 'Tutti', list.length)}${levels.map((k) => chip(k, chipName(k), byLevel(k).length, levelClass({ level: k }))).join('')}</nav>` : '';
  // colonna vuota: si vede lo stesso, così i 4 tipi stanno sempre in fila
  const empty = (k) => `<div class="bempty">${k === 'evento' ? 'Nessun evento in programma' : 'Nessun corso in programma'}</div>`;
  const cols = (only ? [only] : GROUP_ORDER).map((k) => `<section class="bcol ${levelClass({ level: k })}"><h2 class="gh">${levelIcon(k)}${groupName(k)}</h2>
    ${byLevel(k).length ? `<div class="fan" style="--n:${byLevel(k).length}">${byLevel(k).map((c, i) => courseRow(c, admin, i)).join('')}</div>` : empty(k)}</section>`).join('');
  const html = list.length ? `<div class="board${only ? ' one' : ''}">${cols}</div>` : '';
  return { filters, html };
}

function renderList(only = '') {
  const all = db.prepare("SELECT * FROM courses WHERE status IN ('open','confirmed') ORDER BY created_at DESC").all();
  const past = getSetting('show_past', '1') === '1' ? db.prepare("SELECT * FROM courses WHERE status = 'done' ORDER BY created_at DESC").all() : [];
  const cities = new Set(all.map((c) => c.city.trim().toLowerCase())).size;
  const { filters, html: groups } = courseGroups(all, only, false);
  return page('Eventi e Corsi Bitcoin', `<header class="hero"><div class="hrow"><h1>Eventi e Corsi</h1>
    ${all.length ? `<div class="stats"><span class="pill">${icon('book')}${all.length} in programma</span><span class="pill">${icon('pin')}${cities} città</span></div>` : ''}</div>
    <p>Eventi e corsi su Bitcoin, in piccoli gruppi, nella tua città. Scegli quello giusto per te.</p>${filters}</header>
    ${all.length
      ? groups
      : `<div class="card empty">${icon('calendar')}<p>Al momento non ci sono corsi aperti. Torna a trovarci presto.</p></div>`}
    ${past.length ? `<details class="sec past"><summary>${icon('checkc')}Corsi già fatti <small>${past.length}</small><span class="tg"></span></summary><div class="card"><ul class="pl">${past.map(pastRow).join('')}</ul></div></details>` : ''}`, { wide: true });
}

const payItem = (label, ic, addr, uri) => `<div class="pay"><b>${icon(ic)}${label}</b><div class="qr">${qrSvg(uri)}</div><div class="mono">${esc(addr)}</div></div>`;
function payBox(c) {
  return `<div class="paybox">
    ${c.prepay_text ? `<p class="pre" style="margin:0 0 14px">${esc(c.prepay_text)}</p>` : ''}
    <div class="pay-grid">
      ${c.btc_address ? payItem('Bitcoin', 'btc', c.btc_address, 'bitcoin:' + c.btc_address) : ''}
      ${c.ln_address ? payItem('Lightning', 'zap', c.ln_address, 'lightning:' + c.ln_address) : ''}
    </div>
    ${c.contact_email ? `<p style="margin:14px 0 0">${icon('mail')} Dopo il pagamento, inviaci la transazione effettuata a <a href="mailto:${esc(c.contact_email)}">${esc(c.contact_email)}</a>.</p>` : ''}
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
    ['calendar', 'Quando', whenText(c) || (slotsOf(c).length ? 'Data da scegliere in base alle disponibilità' : '')],
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

// come appare il link sui social (WhatsApp, Telegram, Facebook, X): titolo, descrizione e immagine
function socialHead(c) {
  const base = publicBase();
  if (!base) return '';
  const when = c.status === 'confirmed' ? c.confirmed_date : slotsOf(c).join(', ');
  const desc = [`${c.city}${when ? ' · ' + when : ''}`, c.description].filter(Boolean).join(' – ').replace(/\s+/g, ' ');
  const short = desc.length > 200 ? desc.slice(0, 200).replace(/\s+\S*$/, '') + '…' : desc; // taglio a parola intera
  const img = c.cover ? `${base}/img/${c.cover}` : ['jpg', 'png', 'webp'].includes(posterExt(c)) ? `${base}/c/${c.slug}/locandina` : '';
  const m = (k, v) => `<meta property="${k}" content="${esc(v)}">`;
  return '\n' + [m('og:type', 'website'), m('og:site_name', 'Eventi e Corsi Bitcoin'), m('og:title', courseName(c)), m('og:description', short),
    m('og:url', `${base}/c/${c.slug}`), img ? m('og:image', img) : '', `<meta name="twitter:card" content="${img ? 'summary_large_image' : 'summary'}">`].join('');
}
// link di condivisione: semplici indirizzi, nessuno script e nessun servizio caricato nella pagina
function shareBox(c) {
  const base = publicBase();
  if (!base) return '';
  const link = `${base}/c/${c.slug}`;
  const text = `${courseName(c)} a ${c.city}`;
  const u = encodeURIComponent(link), t = encodeURIComponent(text);
  const a = (href, label) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  return `<div class="share"><b>${icon('send')}Condividi</b><div>${a(`https://wa.me/?text=${encodeURIComponent(text + ' ' + link)}`, 'WhatsApp')}${a(`https://t.me/share/url?url=${u}&amp;text=${t}`, 'Telegram')}${a(`https://www.facebook.com/sharer/sharer.php?u=${u}`, 'Facebook')}${a(`https://x.com/intent/post?url=${u}&amp;text=${t}`, 'X')}</div><p class="mono">${esc(link)}</p></div>`;
}

// sezione apribile con un clic: icona, titolo, eventuale numero, contenuto dentro una scheda
// sezione sempre aperta della pagina del corso
// data fissata, scritta per esteso in italiano (solo se c'è giorno e ora di inizio)
function fixedWhen(c) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.ev_date || '') || !/^\d{2}:\d{2}$/.test(c.ev_start || '')) return '';
  const [y, m, d] = c.ev_date.split('-').map(Number);
  const day = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  const t = (x) => x.replace(/^0/, '').replace(':', '.');
  return `${day}, ${t(c.ev_start)}${/^\d{2}:\d{2}$/.test(c.ev_end || '') ? '–' + t(c.ev_end) : ''}`;
}
// data da mostrare: quella confermata, altrimenti quella fissata nel modulo
const whenText = (c) => (c.status === 'confirmed' && c.confirmed_date) || (c.when_mode === 'date' ? fixedWhen(c) : '');

// ---- Aggiungi al calendario ----
// ora locale italiana (con ora legale) -> istante UTC
function romeToUtc(date, time) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let t = want;
  for (let k = 0; k < 2; k++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    t += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return new Date(t);
}
// dati dell'evento per il calendario: solo se confermato con giorno e ora di inizio
function calInfo(c) {
  if (!(c.status === 'confirmed' || (c.when_mode === 'date' && ['open', 'closed'].includes(c.status))) || !/^\d{4}-\d{2}-\d{2}$/.test(c.ev_date || '') || !/^\d{2}:\d{2}$/.test(c.ev_start || '')) return null;
  const start = romeToUtc(c.ev_date, c.ev_start);
  let end = /^\d{2}:\d{2}$/.test(c.ev_end || '') ? romeToUtc(c.ev_date, c.ev_end) : null;
  if (!end || end <= start) end = new Date(start.getTime() + 2 * 3600e3);
  const base = publicBase();
  const url = base ? `${base}/c/${c.slug}` : '';
  const intro = String(c.description || '').trim().split(/\n\s*\n|\n/)[0] || '';
  return { start, end, title: courseName(c), location: mapQuery(c), details: [intro, url].filter(Boolean).join('\n\n'), url };
}
const icsTime = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (t) => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// righe del file .ics lunghe al massimo 75 byte (regola del formato)
function icsFold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}
function icsFile(c, ev) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Eventi e Corsi Bitcoin//Iscrizioni//IT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${c.slug}@corsi-bitcoin`, `DTSTAMP:${icsTime(new Date())}`, `DTSTART:${icsTime(ev.start)}`, `DTEND:${icsTime(ev.end)}`,
    `SUMMARY:${icsText(ev.title)}`, `LOCATION:${icsText(ev.location)}`, `DESCRIPTION:${icsText(ev.details)}`, ...(ev.url ? [`URL:${ev.url}`] : []),
    'END:VEVENT', 'END:VCALENDAR'];
  return lines.map(icsFold).join('\r\n') + '\r\n';
}
function calLinks(c, ev) {
  const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const ms = { subject: ev.title, startdt: ev.start.toISOString(), enddt: ev.end.toISOString(), body: ev.details, location: ev.location, path: '/calendar/action/compose', rru: 'addevent' };
  return {
    ics: `/c/${c.slug}/calendario.ics`,
    google: `https://calendar.google.com/calendar/render?${q({ action: 'TEMPLATE', text: ev.title, dates: `${icsTime(ev.start)}/${icsTime(ev.end)}`, details: ev.details, location: ev.location })}`,
    outlook: `https://outlook.live.com/calendar/0/deeplink/compose?${q(ms)}`,
    office: `https://outlook.office.com/calendar/0/deeplink/compose?${q(ms)}`,
  };
}
// menu "Aggiungi al calendario": si apre con un clic, nessuno script
function calMenu(c) {
  const ev = calInfo(c);
  if (!ev) return '';
  const l = calLinks(c, ev);
  const out = 'target="_blank" rel="noopener noreferrer"';
  return `<details class="calm"><summary>${icon('calendar')}Aggiungi al calendario</summary><div class="calm-list">
    <a href="${l.ics}" download>${icon('down')}<span>Scarica file .ics<small>iPhone, Mac, Outlook sul computer</small></span></a>
    <a href="${esc(l.google)}" ${out}>${icon('calendar')}<span>Google Calendar</span></a>
    <a href="${esc(l.outlook)}" ${out}>${icon('calendar')}<span>Outlook.com</span></a>
    <a href="${esc(l.office)}" ${out}>${icon('calendar')}<span>Office 365</span></a>
  </div></details>`;
}

// descrizione: il primo paragrafo è il sottotitolo (grande), il resto è testo normale.
// I paragrafi sono separati da una riga vuota; senza righe vuote il sottotitolo è la prima riga.
function descParts(d) {
  const t = String(d || '').trim();
  if (!t) return '';
  const m = t.match(/^([\s\S]*?)\n\s*\n([\s\S]*)$/) || t.match(/^([^\n]*)\n([\s\S]*)$/);
  const first = m ? m[1].trim() : t;
  const rest = m ? m[2].trim() : '';
  return `<p class="intro">${esc(first)}</p>${rest ? `<p class="desc">${esc(rest)}</p>` : ''}`;
}
// sezione sempre aperta della pagina del corso; id e numero servono all'indice a destra
const psec = (ic, title, html, id = '', k = 0) => `<section class="psec"${id ? ` id="${id}" style="view-timeline-name:--v${k}"` : ''}>${h2(title, ic)}<div class="card">${html}</div></section>`;
// indice delle sezioni (come Google Moduli): la voce della parte che stai leggendo si colora, solo CSS
const tocNav = (items) => `<nav class="toc" aria-label="In questa pagina"><b>In questa pagina</b>${items.map(([id, label, ic], i) => `<a href="#${id}" style="animation-timeline:--v${i + 1}">${icon(ic)}${label}</a>`).join('')}</nav>`;
const sec = (ic, title, html, count = 0) => `<details class="sec"><summary>${icon(ic)}${title}${count ? `<small>${count}</small>` : ''}<span class="tg"></span></summary><div class="card">${html}</div></details>`;

function renderCourse(c, { error = '', ok = false, paid = false, wait = false, values = {} } = {}) {
  const n = countRegs(c.id);
  const full = n >= c.max_n;
  const closed = c.status === 'closed';
  const done = c.status === 'done';
  const late = expired(c);
  const slots = slotsOf(c);
  const chosen = values.slots || [];
  const reqs = linesOf(c.requirements);
  // a posti esauriti, se il corso lo prevede, ci si può mettere in lista d'attesa
  const canWait = full && !closed && !late && !!c.ask_waitlist;
  const stop = done ? `Questo corso si è già svolto${c.confirmed_date ? ' il ' + esc(c.confirmed_date) : ''}. Dai un'occhiata ai <a href="/">prossimi corsi</a>.` : closed ? 'Le iscrizioni per questo corso sono chiuse.' : (full && !canWait) ? 'Il corso è al completo.' : late ? `Le prenotazioni si sono chiuse il ${fmtDay(c.deadline)}.` : '';
  const srcSel = String(values.source || '').startsWith('Altro') ? 'Altro' : values.source;
  const srcOther = values.source_other || String(values.source || '').replace(/^Altro:\s*/, '').replace(/^Altro$/, '');
  // campo di testo con icona: etichetta, casella, suggerimento
  const fld = (id, label, ic, input, hint = '', optional = false, cls = '') =>
    `<div class="fld${cls ? ' ' + cls : ''}"><label for="${id}">${label}${optional ? '<span class="opt">facoltativo</span>' : ' <b class="star">*</b>'}</label><div class="inp">${icon(ic)}${input}</div>${hint ? `<p class="hint">${hint}</p>` : ''}</div>`;
  // tappe del modulo: titolo, riga di spiegazione, contenuto; le tappe assenti (fasce, pagamento, fonte) non vengono contate
  const steps = [
    ['I tuoi dati', 'Ci servono solo per confermarti il corso.', `<div class="fgrid">
      ${fld('email', 'Email', 'mail', `<input type="email" id="email" name="email" required maxlength="120" value="${esc(values.email)}" autocomplete="email">`)}
      ${fld('name', 'Nome e cognome (o nickname)', 'user', `<input type="text" id="name" name="name" required maxlength="80" value="${esc(values.name)}" autocomplete="name">`, 'Rispettiamo la tua privacy.')}
      ${c.phone_required
        ? fld('phone', 'Telefono', 'phone', `<input type="tel" id="phone" name="phone" required maxlength="30" value="${esc(values.phone)}" autocomplete="tel">`, 'Ci serve per confermarti il corso.')
        : fld('phone', 'Telefono', 'phone', `<input type="tel" id="phone" name="phone" maxlength="30" value="${esc(values.phone)}" autocomplete="tel">`, 'Solo per contattarti via WhatsApp.', true)}
      ${fld('city', 'Città', 'pin', `<input type="text" id="city" name="city" maxlength="80" value="${esc(values.city)}" autocomplete="address-level2">`, 'Se vieni da lontano possiamo consigliarti corsi più vicini.', true)}
      ${c.ask_company ? fld('company', 'Azienda', 'briefcase', `<input type="text" id="company" name="company" maxlength="80" value="${esc(values.company)}" autocomplete="organization">`, 'Possiamo indicarti opportunità per la tua attività.', true) : ''}
    </div>`],
    slots.length ? ['Quando puoi venire <b class="star">*</b>', 'Segna tutte le fasce che ti vanno bene: la data la scegliamo in base alle disponibilità.', `<fieldset class="qs"><legend class="vh">Quando potresti esserci?</legend>
      <div class="tiles">${slots.map((s) => `<label class="tile"><input type="checkbox" name="slot" value="${esc(s)}" ${chosen.includes(s) ? 'checked' : ''}><span>${esc(s)}</span></label>`).join('')}</div></fieldset>`] : null,
    prepayOn(c) && !canWait ? ['Come vuoi pagare il contributo <b class="star">*</b>', 'Scegli una delle due.', `<fieldset class="qs"><legend class="vh">Come preferisci pagare il contributo?</legend>
      <div class="tiles pay">
        <label class="tile"><input type="radio" name="payment" value="corso" ${values.payment !== 'anticipo' ? 'checked' : ''}><span><b>Il giorno del corso</b><small>Pago all'accoglienza</small></span></label>
        <label class="tile"><input type="radio" name="payment" id="pay-pre" value="anticipo" ${values.payment === 'anticipo' ? 'checked' : ''}><span><b>In anticipo</b><small>Blocco subito il posto</small></span></label>
      </div>
      <div class="paywrap">${payBox(c)}</div></fieldset>`] : null,
    c.ask_source ? ['Come hai conosciuto questo corso? <b class="star">*</b>', 'Una curiosità che ci aiuta a farci conoscere.', `<fieldset class="qs"><legend class="vh">Come hai conosciuto questo corso?</legend>
      <div class="tiles sm">${SOURCES.map((s) => `<label class="tile"><input type="radio" name="source" value="${esc(s)}" required ${s === 'Altro' ? 'id="src-other"' : ''} ${srcSel === s ? 'checked' : ''}><span>${esc(s)}</span></label>`).join('')}</div>
      <div class="srcwrap"><input type="text" name="source_other" maxlength="80" placeholder="Scrivi qui" aria-label="Altro: specifica" value="${esc(srcOther)}"></div></fieldset>`] : null,
    ['Consenso e invio', '', `<label class="consent"><input type="checkbox" name="consent" required><span>Acconsento al trattamento dei miei dati (email, nome, telefono, città${c.ask_company ? ', azienda' : ''}) al solo scopo di organizzare il corso. I dati non vengono ceduti a terzi e vengono cancellati dopo il corso. *</span></label>
    <button type="submit" class="btn big">${icon('send')}${canWait ? "Mettimi in lista d'attesa" : 'Invia iscrizione'}</button>`],
  ].filter(Boolean);
  const form = `
  ${h2(canWait ? "Lista d'attesa" : 'Iscriviti', canWait ? 'users' : 'pen')}
  ${canWait ? msg('warn', "<b>Il corso è al completo.</b> Puoi metterti in lista d'attesa prioritaria: avrai la precedenza se si libera un posto o per il prossimo corso.") : ''}
  <form method="post" action="/c/${c.slug}#iscrizione" class="card enrollform" autocomplete="on">
    ${steps.map(([title, hint, body], i) => `<div class="step"><div class="sl"><span class="sn">${i + 1}</span><h3>${title}${hint ? `<small>${hint}</small>` : ''}</h3></div><div class="sb">${body}</div></div>`).join('')}
    <div class="hp" aria-hidden="true"><label>Non compilare<input type="text" name="sito" tabindex="-1" autocomplete="off"></label></div>
    <input type="hidden" name="t" value="${timeToken()}">
  </form>`;
  // ricorda la scelta di pagamento: chi ha cliccato quella sbagliata se ne accorge subito
  const fix = c.contact_email ? ` Hai sbagliato? Scrivici a <a href="mailto:${esc(c.contact_email)}">${esc(c.contact_email)}</a>.` : '';
  const payChoice = wait || !prepayOn(c) ? '' : paid
    ? `<p>Hai scelto di pagare <b>in anticipo</b>: qui sotto trovi come fare.${fix}</p>`
    : `<p>Hai scelto di pagare <b>il giorno del corso</b>, all'accoglienza.${fix}</p>`;
  const finished = `${wait ? msg('ok', "<b>Sei in lista d'attesa, grazie!</b> Ti scriviamo se si libera un posto o per il prossimo corso.") : `<div class="msg ok done">${icon('checkc')}<div>
    <p class="dt">Iscrizione ricevuta, grazie!</p>
    <p>${c.status === 'confirmed'
    ? `Ci vediamo ${esc(c.confirmed_date)}.${reqs.length ? ' Prima di venire dai un\'occhiata ai requisiti qui sopra.' : ''}`
    : 'Appena fissiamo la data ti scriviamo con giorno, orario e luogo, al più tardi 7 giorni prima del corso.'}</p>
    ${payChoice}</div></div>`}
    ${!wait && calInfo(c) ? `<div class="calafter">${calMenu(c)}</div>` : ''}
    ${paid && !wait && prepayOn(c) ? `${h2('Pagamento in anticipo', 'btc')}${payBox(c)}` : ''}
    <p><a class="btn sec" href="/">${icon('back')}Tutti gli eventi e i corsi</a></p>`;
  const enroll = ok ? finished : `${error ? msg('err', esc(error)) : ''}${stop ? msg('warn', stop) : form}`;
  const cta = `<a class="btn big" href="#iscrizione">${icon(canWait ? 'users' : 'pen')}${canWait ? "Mettiti in lista d'attesa" : 'Iscriviti ora'}</a>`;
  // i riquadri in alto: le cose che contano a colpo d'occhio
  const key = (ic, k, v) => `<div class="key"><span class="ic">${icon(ic)}</span><div><b>${k}</b><span class="v">${esc(v)}</span></div></div>`;
  const when = done ? c.confirmed_date || fixedWhen(c) || 'Già svolto' : whenText(c) || (slots.length ? 'Da scegliere insieme' : 'Da confermare');
  const keys = `<div class="keys">${key('pin', 'Dove', c.city)}${key('calendar', 'Quando', when)}${c.price ? key('euro', 'Contributo', c.price) : ''}</div>`;
  // testata: sopra "EVENTO · THIENE" (o "CORSO BASE · THIENE") e lo stato, poi il titolo da solo, poi quando e contributo
  const kindUp = isEvent(c) ? 'Evento' : `Corso ${LEVELS[c.level] || ''}`;
  const head = `<header class="chead2">
      <p class="eyebrow">${levelIcon(c.level)}<span>${esc(kindUp)} · ${esc(c.city)}</span>${statusBadge(c, n, false)}</p>
      <h1 class="ch">${esc(c.title || kindName(c))}</h1>
      ${descParts(c.description)}
      <p class="subline"><span>${icon('calendar')}${esc(when)}</span>${c.price ? `<span>${icon('euro')}${esc(linesOf(c.price)[0])}</span>` : ''}</p>
    </header>`;
  const tocItems = [
    slots.length && c.status === 'open' ? ['sez-date', 'Date possibili', 'calendar'] : null,
    ['sez-dettagli', 'Dettagli', 'info'],
    reqs.length ? ['sez-requisiti', 'Requisiti', 'list'] : null,
    c.program ? ['sez-programma', 'Programma', 'book'] : null,
    ['iscrizione', ok ? 'Iscrizione' : canWait ? "Lista d'attesa" : 'Iscriviti', 'pen'],
  ].filter(Boolean);
  const tk = (id) => tocItems.findIndex(([x]) => x === id) + 1;
  return page(courseName(c), evWords(c, `
    <div class="${levelClass(c)}">
    <a class="back" href="/">${icon('back')}Tutti gli eventi e i corsi</a>
    ${c.cover ? `<div class="media big has-cover"><img class="cover" src="/img/${esc(c.cover)}" alt=""></div>` : '<div class="cstrip"></div>'}
    ${head}
    <div class="cwrap" style="timeline-scope:${tocItems.map((_, i) => `--v${i + 1}`).join(',')}">
      <aside class="aside"><div class="card abox">
        ${done ? `<h2>${icon('checkc')}Corso concluso</h2><p class="sub" style="margin:0">Questo corso si è già svolto.</p><a class="btn big" href="/">${icon('book')}Vedi i prossimi corsi</a>` : `<h2>${icon('users')}Iscrizioni</h2>
        ${counter(c, n)}
        ${c.deadline && !late ? `<p class="dl">${icon('hourglass')}Prenotazioni entro il ${fmtDay(c.deadline)}</p>` : ''}
        ${ok || stop ? '' : cta}
        ${calMenu(c)}`}
        ${posterExt(c) ? `<a class="btn sec big" href="/c/${c.slug}/locandina" target="_blank" rel="noopener">${icon('down')}Scarica la locandina</a>` : ''}
        ${shareBox(c)}
    </div>${tocNav(tocItems)}</aside>
      <div class="cmain">
        ${slots.length && c.status === 'open' ? psec('calendar', 'Date possibili', `<p class="sub" style="margin-top:0">La data definitiva sarà scelta in base alle disponibilità di chi si iscrive.</p><div>${slots.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>`, 'sez-date', tk('sez-date')) : ''}
        ${psec('info', 'Tutti i dettagli', courseFacts(c), 'sez-dettagli', tk('sez-dettagli'))}
        ${reqs.length ? psec('list', 'Requisiti per partecipare', `<ol class="req">${reqs.map((r) => `<li><span class="ic">${icon(reqIcon(r))}</span><span>${esc(r)}</span></li>`).join('')}</ol>`, 'sez-requisiti', tk('sez-requisiti')) : ''}
        ${c.program ? psec('book', 'Programma', renderProgram(c.program), 'sez-programma', tk('sez-programma')) : ''}
        <section id="iscrizione" class="enroll" style="view-timeline-name:--v${tk('iscrizione')}">${enroll}</section>
        ${c.contact_email ? `<p class="contact">${icon('mail')}<span>Per informazioni scrivi a <a href="mailto:${esc(c.contact_email)}">${esc(c.contact_email)}</a>.</span></p>` : ''}
      </div>
    </div>
    </div>`), { wide: true, head: socialHead(c) });
}

async function handlePublic(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/health') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
  if (req.method === 'GET' && (serveFont(res, p) || serveImage(res, p) || serveIcon(res, p))) return;
  if (req.method === 'GET' && p === '/') return send(res, 200, renderList(url.searchParams.get('livello') || ''));

  const cm = p.match(/^\/c\/([0-9a-f]{10})\/calendario\.ics$/);
  if (cm && req.method === 'GET') {
    const cc = db.prepare('SELECT * FROM courses WHERE slug = ?').get(cm[1]);
    const ev = cc && calInfo(cc);
    if (!ev) return send(res, 404, page('Non trovato', '<h1>Data non ancora fissata</h1><p><a href="/">Torna ai corsi</a></p>'));
    return send(res, 200, icsFile(cc, ev), { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${isEvent(cc) ? 'evento' : 'corso'}-${cc.slug}.ics"` });
  }
  const pm = p.match(/^\/c\/([0-9a-f]{10})\/locandina$/);
  if (pm && req.method === 'GET') {
    const pc = db.prepare('SELECT * FROM courses WHERE slug = ?').get(pm[1]);
    if (pc && servePoster(res, pc)) return;
    return send(res, 404, page('Non trovato', '<h1>Locandina non trovata</h1><p><a href="/">Torna ai corsi</a></p>'));
  }
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

  if (course.status === 'closed' || course.status === 'done') return fail('Le iscrizioni per questo corso sono chiuse.');
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
// L'icona di Umbrel apre il pannello passando dal suo app_proxy, che chiede il login di Umbrel
// (PROXY_AUTH_ADD). Le richieste che arrivano da quel container non chiedono la password dell'app.
// Il container si riconosce dall'indirizzo vero della connessione, mai da intestazioni come X-Forwarded-For.
const TRUSTED_PROXY_HOST = process.env.TRUSTED_PROXY_HOST || '';
let proxyIp = { at: 0, ips: [] };
async function fromUmbrel(req) {
  if (!TRUSTED_PROXY_HOST) return false;
  if (Date.now() - proxyIp.at > 60000) {
    try { proxyIp = { at: Date.now(), ips: (await dns.promises.lookup(TRUSTED_PROXY_HOST, { all: true })).map((a) => a.address) }; } catch { proxyIp = { at: Date.now(), ips: [] }; }
  }
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return proxyIp.ips.includes(ip);
}
const adminCtx = new AsyncLocalStorage(); // { umbrel: true } durante le richieste arrivate dall'icona di Umbrel

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
    cover: '', poster: '', // decise dopo, da filesFrom()
  };
  // "Quando si fa?": data già decisa (giorno e ore), fasce da scegliere con gli iscritti, oppure più avanti.
  // Moduli vecchi senza la domanda: casella use_slots (slots_toggle) o solo le fasce.
  let mode = f.get('when_mode');
  if (!['date', 'slots', 'later'].includes(mode)) mode = f.get('slots_toggle') ? (f.get('use_slots') === 'on' ? 'slots' : 'later') : (out.slots ? 'slots' : 'later');
  out.when_mode = mode;
  if (mode !== 'slots') out.slots = '';
  const okv = (v, re) => (re.test(v || '') ? v : '');
  if (mode === 'date') {
    out.ev_date = okv(f.get('ev_date'), /^\d{4}-\d{2}-\d{2}$/);
    out.ev_start = okv(f.get('ev_start'), /^\d{2}:\d{2}$/);
    out.ev_end = okv(f.get('ev_end'), /^\d{2}:\d{2}$/);
  }
  // con gli altri modi giorno e ore restano quelli già salvati (per esempio da "Conferma corso")
  let err = '';
  if (!LEVELS[level]) err = 'Scegli il tipo: corso base, medio, avanzato o evento.';
  else if (out.when_mode === 'date' && !(out.ev_date && out.ev_start)) err = 'Data già decisa: scegli il giorno e l\'ora di inizio.';
  else if (!out.city) err = 'Inserisci la città.';
  else if (!(out.min_n >= 1 && out.max_n >= out.min_n && out.max_n <= 200)) err = 'Minimo e massimo non validi (il massimo deve essere almeno pari al minimo).';
  else if (out.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(out.deadline)) err = 'La data di chiusura delle prenotazioni non è valida.';
  else if (out.contact_email && !EMAIL_RE.test(out.contact_email)) err = 'L\'email per le informazioni non è valida.';
  else if (out.btc_address && !/^(bc1|tb1)[a-z0-9]{20,90}$|^[13mn2][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(out.btc_address)) err = 'L\'indirizzo Bitcoin non sembra valido.';
  else if (out.ln_address && !(EMAIL_RE.test(out.ln_address) || /^lnurl[a-z0-9]{20,}$/i.test(out.ln_address))) err = 'L\'indirizzo Lightning deve essere un Lightning address (nome@dominio) o un LNURL.';
  return { out, err };
}

function courseFormHtml(v, action, button) {
  // modo di "Quando si fa?": quello salvato, altrimenti dedotto (giorno fissato, fasce, oppure più avanti)
  const wm = ['date', 'slots', 'later'].includes(v.when_mode) ? v.when_mode : v.ev_date && v.status !== 'confirmed' ? 'date' : v.slots ? 'slots' : 'later';
  const chk = (name, label) => `<label class="check"><input type="checkbox" name="${name}" ${v[name] ? 'checked' : ''}><span>${label}</span></label>`;
  return `<form method="post" action="${action}" class="card" enctype="multipart/form-data">
    <fieldset class="fs"><legend>${icon('book')}Il corso</legend>
    <label>Tipo *</label><select name="level">${Object.entries(KINDS).map(([k, l]) => `<option value="${k}" ${v.level === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <label>Titolo <small>facoltativo, es. "Don't Trust, Verify"</small></label><input type="text" name="title" maxlength="80" value="${esc(v.title)}">
    <label>Presentazione <small>due righe in cima alla pagina, es. "Dall'open source al wallet Electrum: come creare la propria cassaforte Bitcoin."</small></label><textarea name="description" maxlength="4000">${esc(v.description)}</textarea>
    <label>Docenti <small>facoltativo</small></label><input type="text" name="teachers" maxlength="120" value="${esc(v.teachers)}">
    <label>Immagine di copertina <small>facoltativa: JPG, PNG o WebP, massimo 4 MB, meglio orizzontale (es. 1200×400)</small></label>
    ${v.cover ? `<div class="cover-now"><img class="cover" src="/img/${esc(v.cover)}" alt="Copertina attuale">${chk('cover_remove', 'Togli questa immagine')}</div>` : ''}
    <input type="file" name="cover" accept="image/jpeg,image/png,image/webp">
    <label>Locandina <small>facoltativa: PDF oppure immagine JPG, PNG o WebP, massimo 10 MB. Chi visita il corso la può scaricare</small></label>
    ${v.poster && v.slug ? `<div class="cover-now"><p><a class="btn sec" href="/corso/${v.slug}/locandina" target="_blank" rel="noopener">${icon('down')}Apri la locandina attuale</a></p>${chk('poster_remove', 'Togli la locandina')}</div>` : ''}
    <input type="file" name="poster" accept="application/pdf,image/jpeg,image/png,image/webp">
    </fieldset>

    <fieldset class="fs"><legend>${icon('pin')}Dove e quando</legend>
    <label>Città *</label><input type="text" name="city" required maxlength="80" value="${esc(v.city)}">
    <label>Luogo preciso <small>indirizzo, sala, parcheggio...</small></label><textarea name="location" maxlength="200" style="min-height:70px">${esc(v.location)}</textarea>
    ${chk('show_location', 'Mostra il luogo preciso sulla pagina pubblica (altrimenti lo vedi solo tu)')}
    <label>Quando si fa? *</label>
    <div class="tiles whenq">
      <label class="tile"><input type="radio" name="when_mode" value="date" ${wm === 'date' ? 'checked' : ''}><span><b>Data già decisa</b><small>Scegli giorno e ora</small></span></label>
      <label class="tile"><input type="radio" name="when_mode" value="slots" ${wm === 'slots' ? 'checked' : ''}><span><b>Da scegliere con gli iscritti</b><small>Proponi delle fasce orarie</small></span></label>
      <label class="tile"><input type="radio" name="when_mode" value="later" ${wm === 'later' ? 'checked' : ''}><span><b>Da decidere più avanti</b><small>La metti poi in "Conferma corso"</small></span></label>
    </div>
    <div class="whenbox wb-date"><div class="calrow">
      <label>Giorno<input type="date" name="ev_date" value="${esc(v.ev_date)}"></label>
      <label>Inizio<input type="time" name="ev_start" value="${esc(v.ev_start)}"></label>
      <label>Fine <small>facoltativa</small><input type="time" name="ev_end" value="${esc(v.ev_end)}"></label>
    </div><p class="sub" style="margin:6px 0 0">Nella pagina compare subito la data, con "Aggiungi al calendario".</p></div>
    <div class="whenbox wb-slots"><label>Fasce indicative <small>una per riga, es. "Sabato pomeriggio" (max 12): chi si iscrive segna quelle che gli vanno bene</small></label><textarea name="slots">${esc(v.slots)}</textarea></div>
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
    <p class="savebar"><button>${icon('check')}${button}</button><small>Le modifiche si salvano solo con questo pulsante.</small></p></form>`;
}

const insertCourse = (slug, v) => db.prepare(`INSERT INTO courses (slug, created_at, ${COURSE_FIELDS.join(', ')}) VALUES (?, ?, ${COURSE_FIELDS.map(() => '?').join(', ')})`)
  .run(slug, nowIso(), ...COURSE_FIELDS.map((k) => v[k] ?? ''));

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita che Excel lo legga come formula
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const PAY_LABEL = { corso: 'Al corso', anticipo: 'In anticipo' };

function adminDashboard(flash = '', only = '') {
  const all = db.prepare('SELECT * FROM courses ORDER BY created_at DESC').all();
  const courses = all.filter((c) => c.status !== 'done');
  const past = all.filter((c) => c.status === 'done');
  const base = publicBase();
  const pastRows = past.map((c) => `<li class="${levelClass(c)}">${levelPill(c)}<a href="/corso/${c.slug}"><b>${esc(courseName(c))} – ${esc(c.city)}</b>
    <span class="cmeta">${c.confirmed_date ? `<span>${icon('calendar')}${esc(c.confirmed_date)}</span>` : ''}<span>${icon('users')}${countRegs(c.id)} iscritti</span></span></a></li>`).join('');
  const { filters, html: rows } = courseGroups(courses, only, true);
  return page('Admin corsi', `<div class="dhead"><h1>Corsi</h1>${filters}<a class="btn" href="/corso/nuovo">${icon('plus')}Nuovo evento</a></div>
    ${flash ? msg('ok', esc(flash)) : ''}
    ${base ? '' : msg('warn', 'Per avere link e QR code corretti imposta l\'indirizzo pubblico in <a href="/impostazioni">Impostazioni</a>.')}
    ${rows || '<div class="card">Nessun corso. <a href="/corso/nuovo">Creane uno</a>.</div>'}
    ${past.length ? `<details class="sec past"><summary>${icon('checkc')}Corsi conclusi <small>${past.length}</small><span class="tg"></span></summary><div class="card"><ul class="pl">${pastRows}</ul></div></details>` : ''}
    ${base ? `${h2('Pagina con tutti i corsi', 'qr')}<div class="card ql"><div class="qr">${qrSvg(base + '/')}</div><div><div class="mono">${esc(base)}/</div><p class="sub">Condividi il link o stampa il QR code.</p></div></div>` : ''}`, { admin: true, wide: true });
}

// email di conferma per gli iscritti: la apre il programma di posta di chi gestisce, gli iscritti in copia nascosta
function confirmMailText(c, name = '') {
  const addr = linesOf(c.location).join(', ');
  const where = !addr ? c.city : addr.toLowerCase().includes(c.city.toLowerCase()) ? addr : `${addr} – ${c.city}`;
  const lines = [
    name ? `Ciao ${name},` : 'Ciao,',
    '',
    `il corso "${courseName(c)}" è confermato. Ti aspettiamo!`,
    '',
    `Quando: ${c.confirmed_date}`,
    c.schedule ? `Orari: ${linesOf(c.schedule).join(', ')}` : '',
    `Dove: ${where}`,
    `Mappa: https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery(c, true))}`,
    calInfo(c) && publicBase() ? `Aggiungi al calendario: ${publicBase()}/c/${c.slug}/calendario.ics` : '',
    c.price ? `Contributo: ${linesOf(c.price).join(' oppure ')}` : '',
    c.teachers ? `Docenti: ${linesOf(c.teachers).join(', ')}` : '',
  ].filter((l, i) => l !== '' || i === 1 || i === 3);
  if (c.requirements) lines.push('', 'Requisiti e cosa portare:', ...linesOf(c.requirements).map((l) => `- ${l.replace(/^[-•*]\s*/, '')}`));
  lines.push('', c.contact_email ? `Per qualsiasi domanda scrivi a ${c.contact_email} o rispondi a questa email.` : 'Per qualsiasi domanda rispondi a questa email.', '', 'A presto!');
  return evWords(c, lines.join('\n'));
}

function receivedMailText(c, reg) {
  const slots = JSON.parse(reg.slots || '[]');
  const lines = [
    `Ciao ${reg.name},`,
    '',
    `abbiamo ricevuto la tua iscrizione al corso "${courseName(c)}" a ${c.city}. Grazie!`,
    '',
    'Appena fissiamo la data definitiva ti scriviamo con tutti i dettagli.',
  ];
  if (slots.length) lines.push('', 'Le fasce che ci hai indicato:', ...slots.map((x) => `- ${x}`));
  if (c.price) lines.push('', `Contributo: ${linesOf(c.price).join(' oppure ')}`);
  if (c.requirements) lines.push('', 'Requisiti e cosa portare:', ...linesOf(c.requirements).map((l) => `- ${l.replace(/^[-•*]\s*/, '')}`));
  lines.push('', c.contact_email ? `Per qualsiasi domanda scrivi a ${c.contact_email} o rispondi a questa email.` : 'Per qualsiasi domanda rispondi a questa email.', '', 'A presto!');
  return evWords(c, lines.join('\n'));
}
const mailTo = (to, subject, body) => `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\n/g, '\r\n'))}`;
function regMailHref(c, reg) {
  return c.status === 'confirmed' && c.confirmed_date
    ? mailTo(reg.email, `Corso confermato: ${courseName(c)} – ${c.confirmed_date}`, confirmMailText(c, reg.name))
    : mailTo(reg.email, `Iscrizione ricevuta: ${courseName(c)} – ${c.city}`, receivedMailText(c, reg));
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
    <a class="back" href="/">${icon('back')}Tutti gli eventi e i corsi</a>
    <div class="adm"><div class="adm-main">
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
      <input type="text" name="date" required maxlength="120" value="${esc(c.confirmed_date || fixedWhen(c))}">
      <div class="calrow">
        <label>Giorno <small>per "Aggiungi al calendario"</small><input type="date" name="ev_date" value="${esc(c.ev_date)}"></label>
        <label>Inizio<input type="time" name="ev_start" value="${esc(c.ev_start)}"></label>
        <label>Fine<input type="time" name="ev_end" value="${esc(c.ev_end)}"></label>
      </div>
      <p class="sub" style="margin:4px 0 0">Con giorno e ora di inizio, nella pagina e nell'email compare "Aggiungi al calendario".</p>
      <p><button>${icon('checkc')}${c.status === 'confirmed' ? 'Aggiorna data' : 'Conferma corso'}</button></p></form>
    ${c.status === 'confirmed' && c.confirmed_date && regs.length ? (() => {
    const body = confirmMailText(c);
    const href = `mailto:?bcc=${encodeURIComponent(regs.map((r) => r.email).join(','))}&subject=${encodeURIComponent(`Corso confermato: ${courseName(c)} – ${c.confirmed_date}`)}&body=${encodeURIComponent(body.replace(/\n/g, '\r\n'))}`;
    return `<div class="card mailbox"><h3>${icon('mail')}Avvisa gli iscritti</h3>
      <p class="sub">Si apre il tuo programma di posta con l'email già scritta e i ${regs.length} iscritti in copia nascosta: controlla e premi Invia.</p>
      <p><a class="btn" href="${esc(href)}">${icon('mail')}Prepara l'email di conferma</a></p>
      <details><summary>Vedi il testo dell'email</summary><textarea readonly rows="${Math.min(18, body.split('\n').length + 1)}">${esc(body)}</textarea>
      <p class="sub">Se il programma di posta non si apre, copia questo testo e incollalo in una nuova email.</p></details></div>`;
  })() : ''}

    ${h2(`Iscritti (${n})`, 'users')}
    ${regs.length ? `<p class="sub">Pagati: <b>${regs.filter((r) => r.paid).length}</b> su ${n}${prepayOn(c) ? ` · hanno scelto di pagare in anticipo: ${regs.filter((r) => r.payment === 'anticipo').length}` : ''}</p>
      ${srcSummary ? `<p class="sub">Come ci hanno conosciuto: ${srcSummary}</p>` : ''}
      <div class="card" style="overflow-x:auto"><table><tr><th>Nome</th><th>Email</th><th>Telefono</th><th>Città</th>${showCo ? '<th>Azienda</th>' : ''}${showSrc ? '<th>Conosciuto da</th>' : ''}<th>Fasce</th><th>Contributo</th><th></th></tr>
      ${regs.map((r) => `<tr><td>${esc(r.name)}<br><small>${fmtDate(r.created_at)}</small></td><td>${esc(r.email)}</td><td>${esc(r.phone)}</td><td>${esc(r.city)}</td>
        ${showCo ? `<td>${esc(r.company)}</td>` : ''}${showSrc ? `<td>${esc(r.source)}</td>` : ''}
        <td>${JSON.parse(r.slots).map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</td>
        <td>${PAY_LABEL[r.payment] ? `<small>${PAY_LABEL[r.payment]}</small><br>` : ''}<form method="post" action="/iscritto/${r.id}/pagato"><button class="sec sm${r.paid ? ' paid' : ''}" title="${r.paid ? 'Segna come non pagato' : 'Segna come pagato'}">${r.paid ? `${icon('checkc')}Pagato` : `${icon('check')}Segna pagato`}</button></form></td>
        <td><div class="rowact"><a class="btn sec sm" href="${esc(regMailHref(c, r))}" title="Scrivi a ${esc(r.name)}: email già pronta" aria-label="Scrivi a ${esc(r.name)}">${icon('mail')}</a><a class="btn del sm" href="/iscritto/${r.id}/elimina" title="Elimina iscritto" aria-label="Elimina iscritto">${icon('trash')}</a></div></td></tr>`).join('')}</table></div>
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

</div>
    <aside class="adm-side"><div class="adm-box"><h2>${icon('cog')}Gestione</h2><div class="adm-btns">
      <a class="btn sec" href="/corso/${c.slug}/modifica">${icon('pen')}Modifica corso</a>
      <form method="post" action="/corso/${c.slug}/duplica"><button class="sec" title="Crea un nuovo corso con gli stessi testi, senza iscritti">${icon('copy')}Duplica corso</button></form>
      ${link ? `<a class="btn sec" href="${esc(link)}" target="_blank" rel="noopener">${icon('eye')}Vedi pagina pubblica</a>` : ''}
      ${c.status === 'done'
    ? `<form method="post" action="/corso/${c.slug}/stato"><input type="hidden" name="action" value="reopen"><button class="sec">${icon('unlock')}Riporta tra i corsi attivi</button></form>`
    : `<form method="post" action="/corso/${c.slug}/stato"><input type="hidden" name="action" value="${c.status === 'closed' ? 'reopen' : 'close'}"><button class="sec">${c.status === 'closed' ? `${icon('unlock')}Riapri iscrizioni` : `${icon('lock')}Chiudi iscrizioni`}</button></form>
      <form method="post" action="/corso/${c.slug}/stato"><input type="hidden" name="action" value="done"><button class="sec" title="Il corso si è svolto: finisce tra i corsi conclusi e, sul sito, tra i corsi già fatti">${icon('checkc')}${isEvent(c) ? 'Evento fatto' : 'Corso fatto'}</button></form>`}
    </div></div>
    <div class="adm-box"><h2>${icon('qr')}Link e QR code</h2>${link
      ? `<div class="qr">${qrSvg(link)}</div><div class="mono">${esc(link)}</div><p><a href="/corso/${c.slug}/qr.svg" class="btn sec">${icon('down')}Scarica QR (SVG)</a></p>`
      : msg('warn', 'Imposta l&rsquo;indirizzo pubblico in <a href="/impostazioni">Impostazioni</a> per vedere link e QR.')}</div>
      <div class="adm-box danger"><h2>${icon('alert')}Zona pericolosa</h2><form method="post" action="/corso/${c.slug}/elimina" >
      <label class="check"><input type="checkbox" name="sure" required><span>Elimina il corso e tutti i suoi iscritti (non si può annullare)</span></label>
      <button class="del">${icon('trash')}Elimina corso</button></form></div>
    </aside>
  </div>`, { admin: true, wide: true });
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
      <label class="check" style="margin-top:18px"><input type="checkbox" name="show_past" ${getSetting('show_past', '1') === '1' ? 'checked' : ''}><span>Mostra i corsi già fatti sul sito pubblico <small>(in fondo alla pagina dei corsi, senza modulo d'iscrizione)</small></span></label>
      <p><button>${icon('check')}Salva</button></p></form>
    <form method="post" action="/impostazioni/test-telegram" class="card"><b>Prova Telegram</b>
      <p class="sub">Invia un messaggio di prova ${tg ? '' : '(prima salva token e chat ID)'}.</p><button class="sec">${icon('send')}Invia messaggio di prova</button></form>
    <form method="post" action="/impostazioni/password" class="card"><b>Cambia password</b>
      <label>Nuova password</label><input type="password" name="pw" required><label>Ripeti</label><input type="password" name="pw2" required>
      <p><button class="sec">${icon('key')}Cambia password</button></p></form>`, { admin: true });
}

async function handleAdmin(req, res) {
  const umbrel = await fromUmbrel(req);
  return adminCtx.run({ umbrel }, () => adminRoutes(req, res, umbrel));
}
async function adminRoutes(req, res, umbrel) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'POST') {
    const origin = req.headers.origin;
    // dietro il proxy di Umbrel l'indirizzo visto dal browser può essere riscritto: lì vale Sec-Fetch-Site,
    // che il browser manda da solo e indica se il modulo viene dalla stessa pagina
    const site = umbrel ? req.headers['sec-fetch-site'] : '';
    if (site) {
      if (site !== 'same-origin') return send(res, 403, 'Origine non consentita', { 'Content-Type': 'text/plain' });
    } else if (origin && origin !== 'null') {
      const host = (umbrel && req.headers['x-forwarded-host']) || req.headers.host;
      let ok = false;
      try { ok = new URL(origin).host === host; } catch { ok = false; }
      if (!ok) return send(res, 403, 'Origine non consentita', { 'Content-Type': 'text/plain' });
    }
  }

  if (p === '/health') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
  if (req.method === 'GET' && (serveFont(res, p) || serveImage(res, p) || serveIcon(res, p))) return; // le copertine sono comunque pubbliche

  if (umbrel && (p === '/login' || p === '/logout')) return redirect(res, '/'); // dall'icona di Umbrel si è già dentro
  if (p === '/login') {
    if (req.method === 'GET') return send(res, 200, loginPage());
    // qui si arriva solo dalla porta 9150 (diretta, senza proxy): si usa l'indirizzo vero della connessione,
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

  const sid = umbrel ? 'umbrel' : sessionOf(req);
  if (!sid) return redirect(res, '/login');
  if (p === '/logout' && req.method === 'POST') { sessions.delete(sid); return redirect(res, '/login', { 'Set-Cookie': cookie('', 0) }); }

  const flash = url.searchParams.get('m') || '';
  const back = (to, m) => redirect(res, m ? `${to}?m=${encodeURIComponent(m)}` : to);

  if (req.method === 'GET' && p === '/') return send(res, 200, adminDashboard(flash, url.searchParams.get('livello') || ''));
  if (p === '/impostazioni' && req.method === 'GET') return send(res, 200, settingsPage(flash));

  if (p === '/impostazioni' && req.method === 'POST') {
    const f = await readForm(req);
    const u = (f.get('public_url') || '').trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(u)) return send(res, 400, settingsPage('Indirizzo non valido: deve iniziare con https://', 'err'));
    setSetting('public_url', u);
    const tok = (f.get('tg_token') || '').trim();
    if (tok) setSetting('tg_token', tok);
    setSetting('tg_chat', (f.get('tg_chat') || '').trim());
    setSetting('show_past', f.get('show_past') === 'on' ? '1' : '0');
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
        level: 'base', ask_waitlist: 1, when_mode: 'date', slots: 'Sabato mattina\nSabato pomeriggio\nDomenica',
        prepay_text: 'Se vuoi bloccare subito il posto, puoi inviare il contributo in anticipo in Bitcoin o Lightning.\nSe per qualsiasi motivo il corso dovesse saltare, ti rimborsiamo i bitcoin inviati.',
      };
      return send(res, 200, page('Nuovo evento', `<h1>Nuovo evento</h1><p class="sub">Scegli se è un corso (base, medio, avanzato) o un evento, come una presentazione. Per riusarne uno già fatto, aprilo e usa "Duplica".</p>${courseFormHtml(v, '/corso/nuovo', 'Crea')}`, { admin: true }));
    }
    if (tooBig(req)) return send(res, 413, page('Nuovo evento', `<h1>Nuovo evento</h1>${msg('err', TOO_BIG)}<p><a href="/corso/nuovo">Torna al modulo</a></p>`, { admin: true }));
    const f = await readForm(req);
    let { out, err } = parseCourseForm(f);
    if (!err) err = filesFrom(f, out);
    if (err) return send(res, 400, page('Nuovo evento', `<h1>Nuovo evento</h1>${msg('err', esc(err))}${courseFormHtml(out, '/corso/nuovo', 'Crea')}`, { admin: true }));
    const slug = newSlug();
    insertCourse(slug, out);
    return back(`/corso/${slug}`, isEvent(out) ? 'Evento creato.' : 'Corso creato.');
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
    if (sub === '/locandina' && req.method === 'GET') {
      if (servePoster(res, c)) return;
      return back(`/corso/${c.slug}`, 'Questo corso non ha una locandina.');
    }
    if (sub === '/modifica') {
      if (req.method === 'GET') return send(res, 200, page('Modifica corso', `<a class="back" href="/corso/${c.slug}">${icon('back')}Torna al corso</a><h1>Modifica corso</h1>${flash ? msg('ok', esc(flash)) : ''}${courseFormHtml(c, `/corso/${c.slug}/modifica`, 'Salva')}`, { admin: true }));
      if (tooBig(req)) return send(res, 413, page('Modifica corso', `<h1>Modifica corso</h1>${msg('err', TOO_BIG)}<p><a href="/corso/${c.slug}/modifica">Torna al modulo</a></p>`, { admin: true }));
      const f = await readForm(req);
      let { out, err } = parseCourseForm(f);
      if (!err) err = filesFrom(f, out, c);
      if (err) return send(res, 400, page('Modifica corso', `<h1>Modifica corso</h1>${msg('err', esc(err))}${courseFormHtml({ ...out, cover: c.cover, poster: c.poster, slug: c.slug }, `/corso/${c.slug}/modifica`, 'Salva')}`, { admin: true }));
      for (const k of COURSE_FIELDS) if (out[k] === undefined) out[k] = c[k] ?? '';
      db.prepare(`UPDATE courses SET ${COURSE_FIELDS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...COURSE_FIELDS.map((k) => out[k]), c.id);
      resetNotified(c.id);
      return back(`/corso/${c.slug}`, 'Corso aggiornato.');
    }
    if (sub === '/duplica' && req.method === 'POST') {
      // stessi testi, nessun iscritto, iscrizioni aperte; la scadenza va riscritta perché quella vecchia è passata
      const slug = newSlug();
      insertCourse(slug, { ...c, deadline: '', ev_date: '', ev_start: '', ev_end: '', when_mode: c.when_mode === 'date' ? 'later' : c.when_mode, cover: copyCover(c.cover), poster: copyCover(c.poster) });
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
      const cf = await readForm(req);
      const date = (cf.get('date') || '').trim().slice(0, 120);
      if (!date) return back(`/corso/${c.slug}`, 'Inserisci la data.');
      const okv = (v, re) => (re.test(v || '') ? v : '');
      const evDate = okv(cf.get('ev_date'), /^\d{4}-\d{2}-\d{2}$/);
      const evStart = okv(cf.get('ev_start'), /^\d{2}:\d{2}$/);
      const evEnd = okv(cf.get('ev_end'), /^\d{2}:\d{2}$/);
      db.prepare("UPDATE courses SET status = 'confirmed', confirmed_date = ?, ev_date = ?, ev_start = ?, ev_end = ? WHERE id = ?").run(date, evDate, evStart, evEnd, c.id);
      return back(`/corso/${c.slug}`, `${isEvent(c) ? 'Evento confermato' : 'Corso confermato'}. Ora scrivi agli iscritti con data e luogo.`);
    }
    if (sub === '/stato' && req.method === 'POST') {
      const a = (await readForm(req)).get('action');
      if (a === 'close') db.prepare("UPDATE courses SET status = 'closed' WHERE id = ?").run(c.id);
      else if (a === 'done') db.prepare("UPDATE courses SET status = 'done' WHERE id = ?").run(c.id);
      else if (a === 'reopen') db.prepare('UPDATE courses SET status = ? WHERE id = ?').run(c.confirmed_date ? 'confirmed' : 'open', c.id);
      return back(`/corso/${c.slug}`, a === 'close' ? 'Iscrizioni chiuse.' : a === 'done' ? `${isEvent(c) ? 'Evento' : 'Corso'} segnato come concluso: sul sito compare tra quelli già fatti.` : 'Iscrizioni riaperte.');
    }
    if (sub === '/elimina' && req.method === 'POST') {
      if ((await readForm(req)).get('sure') !== 'on') return back(`/corso/${c.slug}`);
      db.prepare('DELETE FROM courses WHERE id = ?').run(c.id);
      removeCover(c.cover);
      removeCover(c.poster);
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

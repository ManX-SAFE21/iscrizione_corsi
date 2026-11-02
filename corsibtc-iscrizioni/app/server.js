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
const slotsOf = (c) => c.slots.split('\n').map((s) => s.trim()).filter(Boolean);
const courseName = (c) => `Corso ${LEVELS[c.level] || c.level}${c.title ? ' – ' + c.title : ''}`;
const countRegs = (id) => db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE course_id = ?').get(id).n;
const regsOf = (id) => db.prepare('SELECT * FROM registrations WHERE course_id = ? ORDER BY created_at').all(id);
const publicBase = () => getSetting('public_url').replace(/\/+$/, '');

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Richiesta troppo grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const readForm = async (req) => new URLSearchParams(await readBody(req));

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
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
const CSS = `
@font-face{font-family:Inter;src:url(/fonts/inter-latin-wght-normal.woff2) format('woff2');font-weight:100 900;font-display:swap}
@font-face{font-family:'Space Grotesk';src:url(/fonts/space-grotesk-latin-wght-normal.woff2) format('woff2');font-weight:300 700;font-display:swap}
@font-face{font-family:'Space Mono';src:url(/fonts/space-mono-latin-400-normal.woff2) format('woff2');font-weight:400;font-display:swap}
:root{--bg:#F4F6F9;--panel:#FFFFFF;--line:#D3DBE6;--title:#0A0F1C;--body:#1E2735;--mut:#54637A;--teal:#0A7568;--teald:#085E54;--soft:#E8EDF4;--err:#B3261E}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--body);font:16px/1.6 Inter,'Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}
h1,h2{font-family:'Space Grotesk',Inter,'Segoe UI',Arial,sans-serif;font-weight:600;color:var(--title);line-height:1.2}
h1{font-size:1.75rem;margin:.2em 0 .3em}h2{font-size:1.15rem;margin:1.6em 0 .5em}
a{color:var(--teal)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
.sub{color:var(--mut);margin:0 0 1.2em}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:20px;margin:14px 0}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.badge{display:inline-block;font-size:.85rem;font-weight:500;color:var(--mut)}
.badge+.badge::before{content:'·';margin-right:8px}
.badge.ok{color:var(--teal)}.badge.off{color:var(--mut)}
.chip{display:inline-block;padding:1px 10px;border-radius:6px;font-size:.875rem;margin:2px 4px 2px 0;background:var(--soft);color:var(--body)}
.bar{height:6px;background:var(--soft);border-radius:3px;overflow:hidden;margin:10px 0 4px}
.bar>i{display:block;height:100%;background:var(--teal)}
label{display:block;font-weight:500;margin:16px 0 4px;color:var(--title)}
label small{font-weight:400;color:var(--mut)}
input[type=text],input[type=email],input[type=tel],input[type=number],input[type=password],input[type=url],select,textarea{width:100%;padding:10px 12px;font:inherit;color:var(--title);border:1px solid var(--line);border-radius:8px;background:#fff}
input:focus,select:focus,textarea:focus{border-color:var(--teal)}
textarea{min-height:90px}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:400;margin:8px 0;color:var(--body)}
.check input{width:20px;height:20px;margin-top:3px;flex:none;accent-color:var(--teal)}
button,.btn{display:inline-block;background:var(--teal);color:#fff;border:1px solid var(--teal);border-radius:8px;padding:10px 18px;font:500 15px/1.4 Inter,'Segoe UI',Arial,sans-serif;cursor:pointer;text-decoration:none}
button:hover,.btn:hover{background:var(--teald);border-color:var(--teald)}
.btn.sec,button.sec{background:#fff;color:var(--title);border-color:var(--line)}
.btn.sec:hover,button.sec:hover{background:#fff;border-color:var(--teal)}
.btn.del,button.del{background:#fff;color:var(--err);border-color:var(--err)}
.btn.del:hover,button.del:hover{background:#fff;color:var(--err);border-color:var(--err);text-decoration:underline}
.msg{padding:12px 14px;border-radius:8px;margin:12px 0;border:1px solid var(--line);background:var(--panel);color:var(--title)}
.msg.ok{border-left:3px solid var(--teal)}.msg.err{border-left:3px solid var(--err)}.msg.warn{border-left:3px solid #9A5B00}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:500}
.hp{position:absolute;left:-5000px;height:0;overflow:hidden}
.qr{width:180px;height:180px;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#fff}
.qr svg{width:100%;height:100%;display:block}
.nav{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:10px;font-size:.95rem}
.mono{font-family:'Space Mono',ui-monospace,Menlo,Consolas,monospace;font-size:.85rem;word-break:break-all;color:var(--title)}
footer{margin-top:40px;color:var(--mut);font-size:.85rem}
main.wide{max-width:1040px}
.hero{max-width:640px;margin:16px 0 32px}
.hero h1{font-size:clamp(2rem,5vw,2.75rem);margin:0 0 .3em}
.hero p{font-size:1.1rem;color:var(--mut);margin:0}
.steps{list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:24px;margin:0 0 40px;padding:20px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);counter-reset:passo}
.steps li{counter-increment:passo;display:flex;gap:12px;font-size:.95rem;color:var(--mut)}
.steps li::before{content:counter(passo);flex:none;width:28px;height:28px;border-radius:50%;background:var(--soft);color:var(--teal);font-weight:600;font-size:.875rem;display:flex;align-items:center;justify-content:center}
.steps b{display:block;color:var(--title);font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr));gap:20px}
.course{display:flex;flex-direction:column;margin:0;padding:24px}
.course-head{display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px 12px}
.course-head .badge::before{content:none}
.course-level{color:var(--teal);font-weight:600}
.course h2{font-size:1.35rem;margin:10px 0 2px}
.course-city{color:var(--mut);margin:0 0 16px}
.course-slots{margin:0 0 20px}
.course-progress{margin-top:auto}
.course .btn{display:block;text-align:center;margin-top:18px}
@media print{.nav,button,.btn{display:none}body{background:#fff}}
`;

function page(title, body, { admin = false, wide = false } = {}) {
  const nav = admin
    ? `<div class="nav"><a href="/">Corsi</a><a href="/corso/nuovo">+ Nuovo corso</a><a href="/impostazioni">Impostazioni</a>
       <form method="post" action="/logout" style="margin-left:auto"><button class="sec" style="padding:4px 12px">Esci</button></form></div>`
    : '';
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${CSS}</style></head><body><main${wide ? ' class="wide"' : ''}>${nav}${body}</main></body></html>`;
}

function qrSvg(url) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function counter(c, n) {
  const pct = Math.min(100, Math.round((n / c.min_n) * 100));
  let txt;
  if (n >= c.max_n) txt = `Posti esauriti (${n}/${c.max_n})`;
  else if (n >= c.min_n) txt = `Raggiunto il minimo: ${n} iscritti, ancora ${c.max_n - n} posti`;
  else txt = `${n} su ${c.min_n} iscritti per confermare il corso`;
  return `<div class="bar"><i style="width:${pct}%"></i></div><div class="sub" style="margin:0">${esc(txt)}</div>`;
}

function statusBadge(c, n) {
  if (c.status === 'closed') return '<span class="badge off">Chiuso</span>';
  if (n >= c.max_n) return '<span class="badge off">Completo</span>';
  if (c.status === 'confirmed') return `<span class="badge ok">Confermato: ${esc(c.confirmed_date)}</span>`;
  return '<span class="badge">Iscrizioni aperte</span>';
}

/* ---------- pagine pubbliche ---------- */
function renderList() {
  const courses = db.prepare("SELECT * FROM courses WHERE status IN ('open','confirmed') ORDER BY created_at DESC").all();
  const cards = courses.map((c) => {
    const n = countRegs(c.id);
    return `<article class="card course">
      <div class="course-head"><span class="badge course-level">Livello ${esc(LEVELS[c.level])}</span> ${statusBadge(c, n)}</div>
      <h2>${esc(c.title || `Corso ${LEVELS[c.level]}`)}</h2>
      <p class="course-city">${esc(c.city)}</p>
      ${slotsOf(c).length ? `<div class="course-slots">${slotsOf(c).map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}
      <div class="course-progress">${counter(c, n)}</div>
      <a class="btn" href="/c/${c.slug}">${n >= c.max_n ? 'Dettagli' : 'Dettagli e iscrizione'}</a>
    </article>`;
  }).join('');
  return page('Corsi Bitcoin', `<header class="hero"><h1>Corsi Bitcoin</h1>
    <p>Corsi in piccoli gruppi, nella tua città. Scegli il livello e dicci quando potresti esserci.</p></header>
    <ol class="steps">
      <li><span><b>Scegli il corso</b>Base, medio o avanzato, nella città più comoda.</span></li>
      <li><span><b>Indica quando puoi</b>Seleziona tutte le fasce che vanno bene.</span></li>
      <li><span><b>Ti scriviamo noi</b>Raggiunto il minimo di iscritti, scegliamo la data in base alle disponibilità.</span></li>
    </ol>
    ${cards ? `<div class="grid">${cards}</div>` : '<div class="card">Al momento non ci sono corsi aperti. Torna a trovarci presto.</div>'}`, { wide: true });
}

function renderCourse(c, { error = '', ok = false, values = {} } = {}) {
  const n = countRegs(c.id);
  const full = n >= c.max_n;
  const closed = c.status === 'closed';
  const slots = slotsOf(c);
  const chosen = values.slots || [];
  const form = (full || closed) ? `<div class="msg warn">${closed ? 'Le iscrizioni per questo corso sono chiuse.' : 'Il corso è al completo.'}</div>` : `
  <h2>Iscriviti</h2>
  <form method="post" action="/c/${c.slug}" class="card" autocomplete="on">
    <label for="email">Email *</label>
    <input type="email" id="email" name="email" required maxlength="120" value="${esc(values.email)}">
    <label for="name">Nome e cognome (o nickname) * <small>rispettiamo la tua privacy</small></label>
    <input type="text" id="name" name="name" required maxlength="80" value="${esc(values.name)}">
    <label for="phone">Telefono <small>facoltativo, solo per contattarti via WhatsApp</small></label>
    <input type="tel" id="phone" name="phone" maxlength="30" value="${esc(values.phone)}">
    <label for="city">Città <small>facoltativo</small></label>
    <input type="text" id="city" name="city" maxlength="80" value="${esc(values.city)}">
    ${slots.length ? `<label>Quando potresti esserci? * <small>scegli tutte le fasce che vanno bene</small></label>
      ${slots.map((s, i) => `<label class="check"><input type="checkbox" name="slot" value="${esc(s)}" ${chosen.includes(s) ? 'checked' : ''}><span>${esc(s)}</span></label>`).join('')}` : ''}
    <label class="check"><input type="checkbox" name="consent" required><span>Acconsento al trattamento dei miei dati (email, nome, telefono, città) al solo scopo di organizzare il corso. I dati non vengono ceduti a terzi e vengono cancellati dopo il corso. *</span></label>
    <div class="hp" aria-hidden="true"><label>Non compilare<input type="text" name="sito" tabindex="-1" autocomplete="off"></label></div>
    <input type="hidden" name="t" value="${timeToken()}">
    <p><button type="submit">Invia iscrizione</button></p>
  </form>`;
  return page(courseName(c), `
    <p class="nav"><a href="/">← Tutti i corsi</a></p>
    <div class="row"><span class="badge">${esc(LEVELS[c.level])}</span> ${statusBadge(c, n)}</div>
    <h1>${esc(courseName(c))}</h1>
    <p class="sub">${esc(c.city)}</p>
    ${ok ? '<div class="msg ok"><b>Iscrizione ricevuta, grazie!</b> Ti scriveremo non appena il corso sarà confermato, con data e luogo definitivi.</div>' : ''}
    ${error ? `<div class="msg err">${esc(error)}</div>` : ''}
    ${c.description ? `<div class="card" style="white-space:pre-wrap">${esc(c.description)}</div>` : ''}
    ${slots.length ? `<h2>Date indicative</h2><p class="sub">La data definitiva sarà scelta in base alle disponibilità di chi si iscrive.</p><div>${slots.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}
    <h2>Iscritti</h2>
    ${counter(c, n)}
    ${form}`);
}

async function handlePublic(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/health') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
  if (req.method === 'GET' && serveFont(res, p)) return;
  if (req.method === 'GET' && p === '/') return send(res, 200, renderList());

  const m = p.match(/^\/c\/([0-9a-f]{10})$/);
  if (!m) return send(res, 404, page('Non trovato', '<h1>Pagina non trovata</h1><p><a href="/">Torna ai corsi</a></p>'));
  const course = db.prepare('SELECT * FROM courses WHERE slug = ?').get(m[1]);
  if (!course) return send(res, 404, page('Non trovato', '<h1>Corso non trovato</h1><p><a href="/">Torna ai corsi</a></p>'));

  if (req.method === 'GET') return send(res, 200, renderCourse(course, { ok: url.searchParams.get('ok') === '1' }));
  if (req.method !== 'POST') return send(res, 405, 'Metodo non consentito', { 'Content-Type': 'text/plain' });

  const f = await readForm(req);
  const values = {
    email: (f.get('email') || '').trim().toLowerCase(),
    name: (f.get('name') || '').trim(),
    phone: (f.get('phone') || '').trim(),
    city: (f.get('city') || '').trim(),
    slots: f.getAll('slot'),
  };
  const fail = (msg) => send(res, 400, renderCourse(course, { error: msg, values }));

  // anti-spam silenzioso: honeypot e tempo minimo di compilazione
  const age = timeTokenAge(f.get('t'));
  if (f.get('sito') || age === null || age < 3000 || age > 86400000) return fail('Invio non valido: ricarica la pagina e riprova.');
  if (!rateLimit('reg:' + clientIp(req), 20, 3600000)) return fail('Troppi tentativi, riprova più tardi.');
  // tetto complessivo: limita i danni anche se qualcuno riuscisse a cambiare indirizzo a ogni invio
  if (!rateLimit('reg:*', 200, 3600000)) return fail('Troppe iscrizioni in questo momento, riprova più tardi.');

  if (course.status === 'closed') return fail('Le iscrizioni per questo corso sono chiuse.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email) || values.email.length > 120) return fail('Inserisci un indirizzo email valido.');
  if (values.name.length < 2 || values.name.length > 80) return fail('Inserisci il tuo nome (o un nickname).');
  if (values.phone && !/^[0-9+()\-\s.]{5,30}$/.test(values.phone)) return fail('Il numero di telefono non sembra valido.');
  if (values.city.length > 80) return fail('Il nome della città è troppo lungo.');
  const valid = slotsOf(course);
  values.slots = values.slots.filter((s) => valid.includes(s));
  if (valid.length && !values.slots.length) return fail('Scegli almeno una fascia in cui potresti esserci.');
  if (f.get('consent') !== 'on') return fail('Per iscriverti devi acconsentire al trattamento dei dati.');

  let error = '';
  db.exec('BEGIN IMMEDIATE');
  try {
    if (countRegs(course.id) >= course.max_n) error = 'Il corso è al completo.';
    else {
      db.prepare('INSERT INTO registrations (course_id, email, name, phone, city, slots, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(course.id, values.email, values.name, values.phone, values.city, JSON.stringify(values.slots), nowIso());
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    error = /UNIQUE/.test(String(e.message)) ? 'Questa email è già iscritta a questo corso.' : 'Errore imprevisto, riprova.';
    if (!/UNIQUE/.test(String(e.message))) console.error(e);
  }
  if (error) return fail(error);
  notifyThresholds(course).catch((e) => console.error('notify', e));
  return redirect(res, `/c/${course.slug}?ok=1`);
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

function loginPage(msg = '') {
  const first = !getSetting('admin_hash');
  return page('Accesso admin', `<h1>${first ? 'Imposta la password admin' : 'Accesso admin'}</h1>
    <p class="sub">${first ? `Prima volta: scegli una password (minimo ${MIN_PW} caratteri).` : 'Pannello riservato.'}</p>
    ${msg ? `<div class="msg err">${esc(msg)}</div>` : ''}
    <form method="post" action="/login" class="card">
      <label for="pw">Password</label><input type="password" id="pw" name="pw" required autofocus>
      ${first ? '<label for="pw2">Ripeti la password</label><input type="password" id="pw2" name="pw2" required>' : ''}
      <p><button>${first ? 'Salva e accedi' : 'Entra'}</button></p></form>`);
}

function parseCourseForm(f) {
  const level = f.get('level');
  const out = {
    level, city: (f.get('city') || '').trim(), location: (f.get('location') || '').trim(),
    title: (f.get('title') || '').trim(), description: (f.get('description') || '').trim(),
    slots: (f.get('slots') || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 12).map((s) => s.slice(0, 60)).join('\n'),
    min_n: parseInt(f.get('min_n'), 10), max_n: parseInt(f.get('max_n'), 10),
  };
  let err = '';
  if (!LEVELS[level]) err = 'Scegli il livello.';
  else if (!out.city) err = 'Inserisci la città.';
  else if (!(out.min_n >= 1 && out.max_n >= out.min_n && out.max_n <= 200)) err = 'Minimo e massimo non validi (il massimo deve essere almeno pari al minimo).';
  return { out, err };
}

function courseFormHtml(v, action, button) {
  return `<form method="post" action="${action}" class="card">
    <label>Livello *</label><select name="level">${Object.entries(LEVELS).map(([k, l]) => `<option value="${k}" ${v.level === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <label>Città * <small>è l'unico luogo mostrato pubblicamente</small></label><input type="text" name="city" required maxlength="80" value="${esc(v.city)}">
    <label>Luogo preciso <small>privato, lo vedi solo tu (indirizzo, sala...)</small></label><input type="text" name="location" maxlength="200" value="${esc(v.location)}">
    <label>Titolo <small>facoltativo, es. "Don't Trust, Verify"</small></label><input type="text" name="title" maxlength="80" value="${esc(v.title)}">
    <label>Descrizione <small>programma, requisiti, contributo... (testo semplice)</small></label><textarea name="description" maxlength="4000" style="min-height:160px">${esc(v.description)}</textarea>
    <label>Fasce indicative <small>una per riga, es. "Sabato pomeriggio" (max 12)</small></label><textarea name="slots">${esc(v.slots)}</textarea>
    <div class="row"><div style="flex:1"><label>Minimo iscritti *</label><input type="number" name="min_n" min="1" max="200" required value="${esc(v.min_n ?? 8)}"></div>
    <div style="flex:1"><label>Massimo iscritti *</label><input type="number" name="max_n" min="1" max="200" required value="${esc(v.max_n ?? 12)}"></div></div>
    <p><button>${button}</button></p></form>`;
}

function adminDashboard(msg = '') {
  const courses = db.prepare('SELECT * FROM courses ORDER BY created_at DESC').all();
  const base = publicBase();
  const rows = courses.map((c) => {
    const n = countRegs(c.id);
    return `<div class="card"><div class="row"><span class="badge">${esc(LEVELS[c.level])}</span> ${statusBadge(c, n)}
      ${n >= c.min_n && c.status === 'open' ? '<span class="badge ok">Minimo raggiunto: scegli la data</span>' : ''}</div>
      <h2 style="margin:.4em 0 0">${esc(courseName(c))} – ${esc(c.city)}</h2>
      ${counter(c, n)}
      <p style="margin:12px 0 0"><a class="btn" href="/corso/${c.slug}">Apri</a></p></div>`;
  }).join('');
  return page('Admin corsi', `<h1>Corsi</h1>
    ${msg ? `<div class="msg ok">${esc(msg)}</div>` : ''}
    ${base ? '' : '<div class="msg warn">Per avere link e QR code corretti imposta l\'indirizzo pubblico in <a href="/impostazioni">Impostazioni</a>.</div>'}
    ${rows || '<div class="card">Nessun corso. <a href="/corso/nuovo">Creane uno</a>.</div>'}
    ${base ? `<h2>Pagina con tutti i corsi</h2><div class="card row"><div class="qr">${qrSvg(base + '/')}</div><div><div class="mono">${esc(base)}/</div><p class="sub">Condividi il link o stampa il QR code.</p></div></div>` : ''}`, { admin: true });
}

function adminCourse(c, msg = '') {
  const regs = regsOf(c.id);
  const n = regs.length;
  const base = publicBase();
  const link = base ? `${base}/c/${c.slug}` : '';
  const stats = slotStats(c, regs);
  const best = Math.max(0, ...stats.map((s) => s.n));
  const emails = regs.map((r) => r.email).join(', ');
  const phones = regs.filter((r) => r.phone).map((r) => `${r.name}: ${r.phone}`).join('\n');
  return page(courseName(c), `
    <div class="row"><span class="badge">${esc(LEVELS[c.level])}</span> ${statusBadge(c, n)}</div>
    <h1>${esc(courseName(c))} – ${esc(c.city)}</h1>
    ${c.location ? `<p class="sub">Luogo (privato): ${esc(c.location)}</p>` : ''}
    ${msg ? `<div class="msg ok">${esc(msg)}</div>` : ''}
    ${counter(c, n)}

    <h2>Disponibilità per fascia</h2>
    ${stats.length ? `<div class="card"><table>${stats.map((s) => `<tr><td>${esc(s.label)}</td><td style="width:40%"><div class="bar" style="margin:4px 0"><i style="width:${n ? Math.round((s.n / n) * 100) : 0}%"></i></div></td><td><b>${s.n}</b>/${n}${s.n === best && best > 0 ? ' · la migliore' : ''}</td></tr>`).join('')}</table></div>` : '<p class="sub">Nessuna fascia indicata per questo corso.</p>'}

    <h2>Conferma corso</h2>
    <form method="post" action="/corso/${c.slug}/conferma" class="card">
      ${n < c.min_n ? `<div class="msg warn">Il minimo (${c.min_n}) non è ancora raggiunto: puoi confermare comunque.</div>` : ''}
      <label>Data definitiva <small>testo libero, es. "sabato 21 marzo 2026, 9.30–17.00"</small></label>
      <input type="text" name="date" required maxlength="120" value="${esc(c.confirmed_date)}">
      <p><button>${c.status === 'confirmed' ? 'Aggiorna data' : 'Conferma corso'}</button></p></form>

    <h2>Iscritti (${n})</h2>
    ${regs.length ? `<div class="card" style="overflow-x:auto"><table><tr><th>Nome</th><th>Email</th><th>Telefono</th><th>Città</th><th>Fasce</th><th></th></tr>
      ${regs.map((r) => `<tr><td>${esc(r.name)}<br><small>${fmtDate(r.created_at)}</small></td><td>${esc(r.email)}</td><td>${esc(r.phone)}</td><td>${esc(r.city)}</td>
        <td>${JSON.parse(r.slots).map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</td>
        <td><a class="btn del" style="padding:4px 10px" href="/iscritto/${r.id}/elimina" title="Elimina">✕</a></td></tr>`).join('')}</table></div>
      <label>Tutte le email <small>da copiare nel campo CCN</small></label><textarea readonly rows="2">${esc(emails)}</textarea>
      <p><a class="btn sec" href="mailto:?bcc=${encodeURIComponent(regs.map((r) => r.email).join(','))}&subject=${encodeURIComponent(courseName(c))}">Scrivi a tutti</a></p>
      ${phones ? `<label>Telefoni</label><textarea readonly rows="${Math.min(8, phones.split('\n').length + 1)}">${esc(phones)}</textarea>` : ''}`
      : '<div class="card">Ancora nessun iscritto.</div>'}

    <h2>Link e QR code</h2>
    ${link ? `<div class="card row"><div class="qr">${qrSvg(link)}</div><div><div class="mono">${esc(link)}</div><p><a href="/corso/${c.slug}/qr.svg" class="btn sec">Scarica QR (SVG)</a></p></div></div>`
      : '<div class="msg warn">Imposta l\'indirizzo pubblico in <a href="/impostazioni">Impostazioni</a> per vedere link e QR.</div>'}

    <h2>Gestione</h2>
    <div class="row">
      <a class="btn sec" href="/corso/${c.slug}/modifica">Modifica corso</a>
      <form method="post" action="/corso/${c.slug}/stato"><input type="hidden" name="action" value="${c.status === 'closed' ? 'reopen' : 'close'}"><button class="sec">${c.status === 'closed' ? 'Riapri iscrizioni' : 'Chiudi iscrizioni'}</button></form>
    </div>
    <h2>Zona pericolosa</h2>
    <form method="post" action="/corso/${c.slug}/elimina" class="card">
      <label class="check"><input type="checkbox" name="sure" required><span>Elimina il corso e tutti i suoi iscritti (non si può annullare)</span></label>
      <button class="del">Elimina corso</button></form>`, { admin: true });
}

function settingsPage(msg = '', kind = 'ok') {
  const tg = getSetting('tg_token') && getSetting('tg_chat');
  return page('Impostazioni', `<h1>Impostazioni</h1>
    ${msg ? `<div class="msg ${kind}">${esc(msg)}</div>` : ''}
    <form method="post" action="/impostazioni" class="card">
      <label>Indirizzo pubblico del sito <small>quello del tunnel Cloudflare, es. https://corsi.tuodominio.it</small></label>
      <input type="url" name="public_url" value="${esc(getSetting('public_url'))}" placeholder="https://...">
      <label>Telegram – token del bot ${getSetting('tg_token') ? '<small>(già impostato: lascia vuoto per non cambiarlo)</small>' : ''}</label>
      <input type="text" name="tg_token" autocomplete="off" placeholder="${getSetting('tg_token') ? '••••••••' : '123456:ABC...'}">
      <label>Telegram – chat ID</label>
      <input type="text" name="tg_chat" autocomplete="off" value="${esc(getSetting('tg_chat'))}">
      <p><button>Salva</button></p></form>
    <form method="post" action="/impostazioni/test-telegram" class="card"><b>Prova Telegram</b>
      <p class="sub">Invia un messaggio di prova ${tg ? '' : '(prima salva token e chat ID)'}.</p><button class="sec">Invia messaggio di prova</button></form>
    <form method="post" action="/impostazioni/password" class="card"><b>Cambia password</b>
      <label>Nuova password</label><input type="password" name="pw" required><label>Ripeti</label><input type="password" name="pw2" required>
      <p><button class="sec">Cambia password</button></p></form>`, { admin: true });
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
  if (req.method === 'GET' && serveFont(res, p)) return;

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
    if (req.method === 'GET') return send(res, 200, page('Nuovo corso', `<h1>Nuovo corso</h1>${courseFormHtml({ level: 'base', slots: 'Sabato mattina\nSabato pomeriggio\nDomenica' }, '/corso/nuovo', 'Crea corso')}`, { admin: true }));
    const { out, err } = parseCourseForm(await readForm(req));
    if (err) return send(res, 400, page('Nuovo corso', `<h1>Nuovo corso</h1><div class="msg err">${esc(err)}</div>${courseFormHtml(out, '/corso/nuovo', 'Crea corso')}`, { admin: true }));
    const slug = newSlug();
    db.prepare('INSERT INTO courses (slug, level, city, location, title, description, slots, min_n, max_n, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(slug, out.level, out.city, out.location, out.title, out.description, out.slots, out.min_n, out.max_n, nowIso());
    return back(`/corso/${slug}`, 'Corso creato.');
  }

  const iscr = p.match(/^\/iscritto\/(\d+)\/elimina$/);
  if (iscr) {
    const r = db.prepare('SELECT r.id, r.course_id, r.name, r.email, c.slug FROM registrations r JOIN courses c ON c.id = r.course_id WHERE r.id = ?').get(Number(iscr[1]));
    if (!r) return send(res, 404, page('Non trovato', '<h1>Iscritto non trovato</h1>', { admin: true }));
    if (req.method === 'GET') {
      return send(res, 200, page('Elimina iscritto', `<h1>Eliminare questo iscritto?</h1>
        <div class="card"><b>${esc(r.name)}</b><br>${esc(r.email)}</div>
        <form method="post" action="/iscritto/${r.id}/elimina" class="row"><button class="del">Sì, elimina</button>
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
      if (req.method === 'GET') return send(res, 200, page('Modifica corso', `<h1>Modifica corso</h1>${courseFormHtml(c, `/corso/${c.slug}/modifica`, 'Salva')}`, { admin: true }));
      const { out, err } = parseCourseForm(await readForm(req));
      if (err) return send(res, 400, page('Modifica corso', `<h1>Modifica corso</h1><div class="msg err">${esc(err)}</div>${courseFormHtml(out, `/corso/${c.slug}/modifica`, 'Salva')}`, { admin: true }));
      db.prepare('UPDATE courses SET level=?, city=?, location=?, title=?, description=?, slots=?, min_n=?, max_n=? WHERE id=?')
        .run(out.level, out.city, out.location, out.title, out.description, out.slots, out.min_n, out.max_n, c.id);
      resetNotified(c.id);
      return back(`/corso/${c.slug}`, 'Corso aggiornato.');
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

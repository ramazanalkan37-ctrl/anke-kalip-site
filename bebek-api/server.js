// Oğlumuz İçin Hazırlık Paneli – ortak liste sunucusu (Railway + Postgres)
// Sayfa GitHub Pages'te durur, bu sunucu iki kullanıcının ortak verisini tutar.
'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { Pool } = require('pg');
const DEFAULT_ITEMS = require('./defaults.json');

const PORT = Number(process.env.PORT) || 8080;
const KURULUM_KODU = (process.env.KURULUM_KODU || '').trim();
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'Bebek Listesi <onboarding@resend.dev>';

const USERS = {
  baba: { name: 'Aslanın Babası', email: (process.env.BABA_EMAIL || '').trim() },
  anne: { name: 'Aslanın Annesi', email: (process.env.ANNE_EMAIL || '').trim() }
};

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL tanımlı değil. Railway\'de Postgres ekleyip DATABASE_URL değişkenini bağlayın.');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /sslmode=require/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined
});
const q = (text, params) => pool.query(text, params);

let TOKEN_SECRET = '';

// ---------------------------------------------------------------- Veritabanı
async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, password_hash TEXT, updated_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      search_query TEXT NOT NULL DEFAULT '',
      price INTEGER NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'normal',
      checked BOOLEAN NOT NULL DEFAULT FALSE,
      user_note TEXT NOT NULL DEFAULT '',
      ord BIGINT NOT NULL DEFAULT 0,
      created_by TEXT, created_at BIGINT,
      checked_by TEXT, checked_at BIGINT,
      updated_by TEXT, updated_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY, item_id TEXT NOT NULL, user_id TEXT NOT NULL,
      text TEXT NOT NULL, created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS comments_item ON comments(item_id);
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL, created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity (
      id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL,
      item_id TEXT, item_label TEXT, detail TEXT, created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reset_codes (
      user_id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at BIGINT NOT NULL, tries INTEGER NOT NULL DEFAULT 0
    );
  `);
  for (const id of Object.keys(USERS)) {
    await q('INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  }
  // Oturum imzalama anahtarı: ilk açılışta üretilip veritabanında saklanır
  const r = await q("SELECT value FROM meta WHERE key='token_secret'");
  if (r.rows.length) TOKEN_SECRET = r.rows[0].value;
  else {
    TOKEN_SECRET = crypto.randomBytes(32).toString('hex');
    await q("INSERT INTO meta (key, value) VALUES ('token_secret', $1)", [TOKEN_SECRET]);
  }
  // Liste ilk kez oluşturuluyorsa varsayılan kalemleri ekle
  const seeded = await q("SELECT 1 FROM meta WHERE key='seeded'");
  if (!seeded.rows.length) {
    await insertItems(DEFAULT_ITEMS, null);
    await q("INSERT INTO meta (key, value) VALUES ('seeded', $1)", [String(Date.now())]);
  }
}

async function insertItems(list, userId) {
  const now = Date.now();
  for (const it of list) {
    await q(`INSERT INTO items (id, category, label, note, search_query, price, priority, checked, user_note, ord,
               created_by, created_at, checked_by, checked_at, updated_by, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$11,$12)
             ON CONFLICT (id) DO NOTHING`,
      [it.id, it.category, it.label, it.note || '', it.searchQuery || '', toPrice(it.price), it.priority || 'normal',
       !!it.checked, it.userNote || '', Number(it.order) || 0, userId, now,
       it.checked ? userId : null, it.checked ? now : null]);
  }
}

const toPrice = (v) => Math.max(0, Math.min(10_000_000, Math.round(Number(v) || 0)));
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

function rowToItem(r) {
  return {
    id: r.id, category: r.category, label: r.label, note: r.note, searchQuery: r.search_query,
    price: r.price, priority: r.priority, checked: r.checked, userNote: r.user_note, order: Number(r.ord),
    createdBy: r.created_by, createdAt: r.created_at ? Number(r.created_at) : null,
    checkedBy: r.checked_by, checkedAt: r.checked_at ? Number(r.checked_at) : null,
    updatedBy: r.updated_by, updatedAt: r.updated_at ? Number(r.updated_at) : null
  };
}

async function logActivity(userId, action, item, detail) {
  await q('INSERT INTO activity (user_id, action, item_id, item_label, detail, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [userId, action, item ? item.id : null, item ? item.label : null, detail || null, Date.now()]);
}

// ---------------------------------------------------------------- Şifre ve oturum
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(sha(String(a))), y = Buffer.from(sha(String(b)));
  return crypto.timingSafeEqual(x, y);
};

// Jeton: kullanıcı.bitiş.şifreSürümü.imza  (şifre değişince eski jetonlar geçersiz olur)
function makeToken(userId, pwHash) {
  const exp = Date.now() + 180 * 24 * 3600 * 1000;
  const ver = sha(pwHash || '').slice(0, 12);
  const body = `${userId}.${exp}.${ver}`;
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('hex');
  return `${body}.${sig}`;
}
async function verifyToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 4) return null;
  const [userId, exp, ver, sig] = parts;
  if (!USERS[userId] || Number(exp) < Date.now()) return null;
  const expect = crypto.createHmac('sha256', TOKEN_SECRET).update(`${userId}.${exp}.${ver}`).digest('hex');
  if (!safeEq(sig, expect)) return null;
  const r = await q('SELECT password_hash FROM users WHERE id=$1', [userId]);
  if (!r.rows.length || sha(r.rows[0].password_hash || '').slice(0, 12) !== ver) return null;
  return userId;
}

// Basit deneme sınırı (kaba kuvvet denemelerine karşı)
const attempts = new Map();
function tooMany(key) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(key, a);
  return a.length >= 10;
}
function recordFail(key) { (attempts.get(key) || attempts.set(key, []).get(key)).push(Date.now()); }

async function sendResetEmail(userId, code) {
  const to = USERS[userId].email;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM, to: [to],
      subject: `Bebek Listesi şifre kodu: ${code}`,
      text: `Merhaba ${USERS[userId].name},\n\nŞifre oluşturma / yenileme kodunuz: ${code}\n\nKod 15 dakika geçerlidir. Bu isteği siz yapmadıysanız bu e-postayı yok sayın.`
    })
  });
  if (!res.ok) throw new Error('E-posta gönderilemedi: ' + res.status + ' ' + (await res.text()).slice(0, 200));
}

// ---------------------------------------------------------------- Canlı güncelleme (SSE)
const streams = new Set();
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of streams) { try { res.write(data); } catch (e) { streams.delete(res); } }
}
setInterval(() => { for (const res of streams) { try { res.write(': ping\n\n'); } catch (e) {} } }, 25000);

// ---------------------------------------------------------------- HTTP yardımcıları
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 2_000_000) { reject(new HttpError(413, 'Çok büyük istek')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new HttpError(400, 'Geçersiz JSON')); }
    });
    req.on('error', reject);
  });
}
async function requireUser(req) {
  const h = req.headers.authorization || '';
  const user = await verifyToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!user) throw new HttpError(401, 'Oturum geçersiz, tekrar giriş yapın');
  return user;
}

async function getState() {
  const [items, comments, messages, activity] = await Promise.all([
    q('SELECT * FROM items ORDER BY ord ASC, created_at ASC'),
    q('SELECT * FROM comments ORDER BY created_at ASC'),
    q('SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 300) m ORDER BY id ASC'),
    q('SELECT * FROM activity ORDER BY id DESC LIMIT 300')
  ]);
  const map = (r) => ({ ...r, created_at: Number(r.created_at) });
  return {
    users: Object.fromEntries(Object.entries(USERS).map(([id, u]) => [id, { name: u.name }])),
    items: items.rows.map(rowToItem),
    comments: comments.rows.map(r => ({ id: r.id, itemId: r.item_id, userId: r.user_id, text: r.text, createdAt: Number(r.created_at) })),
    messages: messages.rows.map(r => ({ id: r.id, userId: r.user_id, text: r.text, createdAt: Number(r.created_at) })),
    activity: activity.rows.map(map).map(r => ({ id: r.id, userId: r.user_id, action: r.action, itemId: r.item_id, itemLabel: r.item_label, detail: r.detail, createdAt: r.created_at }))
  };
}

// ---------------------------------------------------------------- Uç noktalar
async function route(req, res, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;

  if (m === 'GET' && (p === '/' || p === '/api/health')) {
    await q('SELECT 1');
    return send(res, 200, { ok: true, service: 'bebek-api' });
  }

  if (m === 'GET' && p === '/api/config') {
    const r = await q('SELECT id, password_hash IS NOT NULL AS has FROM users');
    return send(res, 200, {
      users: Object.fromEntries(r.rows.map(x => [x.id, { name: USERS[x.id].name, hasPassword: x.has, emailReset: !!(RESEND_API_KEY && USERS[x.id].email) }])),
      setupCodeEnabled: !!KURULUM_KODU
    });
  }

  if (m === 'POST' && p === '/api/login') {
    const b = await readBody(req);
    const userId = String(b.user || '');
    if (!USERS[userId]) throw new HttpError(400, 'Kullanıcı seçin');
    const key = 'login:' + userId;
    if (tooMany(key)) throw new HttpError(429, 'Çok fazla deneme. 15 dakika sonra tekrar deneyin.');
    const r = await q('SELECT password_hash FROM users WHERE id=$1', [userId]);
    const stored = r.rows[0] && r.rows[0].password_hash;
    if (!stored) throw new HttpError(400, 'Bu kullanıcının henüz şifresi yok. "İlk şifre / Şifremi unuttum" ile oluşturun.');
    if (!checkPassword(String(b.password || ''), stored)) { recordFail(key); throw new HttpError(401, 'Şifre hatalı'); }
    attempts.delete(key);
    return send(res, 200, { token: makeToken(userId, stored), user: userId, name: USERS[userId].name });
  }

  if (m === 'POST' && p === '/api/password/request-code') {
    const b = await readBody(req);
    const userId = String(b.user || '');
    if (!USERS[userId]) throw new HttpError(400, 'Kullanıcı seçin');
    if (!RESEND_API_KEY || !USERS[userId].email) throw new HttpError(400, 'E-posta ile kod gönderimi kurulu değil. Aile kurulum kodunu kullanın.');
    if (tooMany('code:' + userId)) throw new HttpError(429, 'Çok fazla istek. 15 dakika sonra tekrar deneyin.');
    recordFail('code:' + userId);
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await q(`INSERT INTO reset_codes (user_id, code_hash, expires_at, tries) VALUES ($1,$2,$3,0)
             ON CONFLICT (user_id) DO UPDATE SET code_hash=EXCLUDED.code_hash, expires_at=EXCLUDED.expires_at, tries=0`,
      [userId, sha(code), Date.now() + 15 * 60 * 1000]);
    await sendResetEmail(userId, code);
    const em = USERS[userId].email.replace(/^(.).*?(@.*)$/, '$1***$2');
    return send(res, 200, { ok: true, sentTo: em });
  }

  if (m === 'POST' && p === '/api/password/set') {
    const b = await readBody(req);
    const userId = String(b.user || '');
    const code = String(b.code || '').trim();
    const pw = String(b.newPassword || '');
    if (!USERS[userId]) throw new HttpError(400, 'Kullanıcı seçin');
    if (pw.length < 6) throw new HttpError(400, 'Şifre en az 6 karakter olmalı');
    const key = 'set:' + userId;
    if (tooMany(key)) throw new HttpError(429, 'Çok fazla deneme. 15 dakika sonra tekrar deneyin.');
    let ok = false;
    if (KURULUM_KODU && code && safeEq(code, KURULUM_KODU)) ok = true;
    if (!ok && /^\d{6}$/.test(code)) {
      const r = await q('SELECT * FROM reset_codes WHERE user_id=$1', [userId]);
      const row = r.rows[0];
      if (row && Number(row.expires_at) > Date.now() && row.tries < 5) {
        if (safeEq(sha(code), row.code_hash)) ok = true;
        else await q('UPDATE reset_codes SET tries=tries+1 WHERE user_id=$1', [userId]);
      }
    }
    if (!ok) { recordFail(key); throw new HttpError(401, 'Kod hatalı veya süresi dolmuş'); }
    const hash = hashPassword(pw);
    await q('UPDATE users SET password_hash=$1, updated_at=$2 WHERE id=$3', [hash, Date.now(), userId]);
    await q('DELETE FROM reset_codes WHERE user_id=$1', [userId]);
    attempts.delete(key); attempts.delete('login:' + userId);
    await logActivity(userId, 'password', null, null);
    return send(res, 200, { token: makeToken(userId, hash), user: userId, name: USERS[userId].name });
  }

  if (m === 'GET' && p === '/api/events') {
    const userId = await verifyToken(url.searchParams.get('token'));
    if (!userId) throw new HttpError(401, 'Oturum geçersiz');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }

  // --- Buradan sonrası giriş gerektirir
  const user = await requireUser(req);

  if (m === 'GET' && p === '/api/state') return send(res, 200, await getState());

  if (m === 'POST' && p === '/api/items') {
    const b = await readBody(req);
    const label = clip(b.label, 300).trim();
    if (!label) throw new HttpError(400, 'Ürün adı boş olamaz');
    const item = {
      id: 'custom_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'),
      category: clip(b.category, 40) || 'uyku', label, note: clip(b.note, 1000) || 'Özel eklenen ihtiyaç kalemi.',
      searchQuery: clip(b.searchQuery || label, 200), price: toPrice(b.price),
      priority: ['urgent', 'normal', 'later'].includes(b.priority) ? b.priority : 'normal',
      checked: false, userNote: '', order: -Date.now()
    };
    await insertItems([item], user);
    await logActivity(user, 'add', item, `${item.price.toLocaleString('tr-TR')} ₺`);
    broadcast({ type: 'changed', by: user });
    return send(res, 200, { ok: true, id: item.id });
  }

  let mm;
  if ((mm = p.match(/^\/api\/items\/([^/]+)$/)) && (m === 'PATCH' || m === 'DELETE')) {
    const id = decodeURIComponent(mm[1]);
    const r = await q('SELECT * FROM items WHERE id=$1', [id]);
    if (!r.rows.length) throw new HttpError(404, 'Kalem bulunamadı (silinmiş olabilir)');
    const old = rowToItem(r.rows[0]);
    const now = Date.now();
    if (m === 'DELETE') {
      await q('DELETE FROM items WHERE id=$1', [id]);
      await q('DELETE FROM comments WHERE item_id=$1', [id]);
      await logActivity(user, 'delete', old, null);
      broadcast({ type: 'changed', by: user });
      return send(res, 200, { ok: true });
    }
    const b = await readBody(req);
    if (typeof b.checked === 'boolean' && b.checked !== old.checked) {
      await q('UPDATE items SET checked=$1, checked_by=$2, checked_at=$3, updated_by=$2, updated_at=$3 WHERE id=$4',
        [b.checked, b.checked ? user : null, b.checked ? now : null, id]);
      await logActivity(user, b.checked ? 'check' : 'uncheck', old, null);
    }
    if (b.price !== undefined && toPrice(b.price) !== old.price) {
      await q('UPDATE items SET price=$1, updated_by=$2, updated_at=$3 WHERE id=$4', [toPrice(b.price), user, now, id]);
      await logActivity(user, 'price', old, `${old.price.toLocaleString('tr-TR')} ₺ → ${toPrice(b.price).toLocaleString('tr-TR')} ₺`);
    }
    if (b.userNote !== undefined && clip(b.userNote, 500).trim() !== old.userNote) {
      const note = clip(b.userNote, 500).trim();
      await q('UPDATE items SET user_note=$1, updated_by=$2, updated_at=$3 WHERE id=$4', [note, user, now, id]);
      await logActivity(user, 'note', old, note);
    }
    broadcast({ type: 'changed', by: user });
    return send(res, 200, { ok: true });
  }

  if ((mm = p.match(/^\/api\/items\/([^/]+)\/comments$/)) && m === 'POST') {
    const id = decodeURIComponent(mm[1]);
    const b = await readBody(req);
    const text = clip(b.text, 2000).trim();
    if (!text) throw new HttpError(400, 'Yorum boş olamaz');
    const r = await q('SELECT * FROM items WHERE id=$1', [id]);
    if (!r.rows.length) throw new HttpError(404, 'Kalem bulunamadı');
    await q('INSERT INTO comments (item_id, user_id, text, created_at) VALUES ($1,$2,$3,$4)', [id, user, text, Date.now()]);
    await logActivity(user, 'comment', rowToItem(r.rows[0]), text);
    broadcast({ type: 'changed', by: user });
    return send(res, 200, { ok: true });
  }

  if ((mm = p.match(/^\/api\/comments\/(\d+)$/)) && m === 'DELETE') {
    const r = await q('DELETE FROM comments WHERE id=$1 AND user_id=$2 RETURNING id', [Number(mm[1]), user]);
    if (!r.rows.length) throw new HttpError(403, 'Sadece kendi yorumunuzu silebilirsiniz');
    broadcast({ type: 'changed', by: user });
    return send(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/messages') {
    const b = await readBody(req);
    const text = clip(b.text, 4000).trim();
    if (!text) throw new HttpError(400, 'Mesaj boş olamaz');
    await q('INSERT INTO messages (user_id, text, created_at) VALUES ($1,$2,$3)', [user, text, Date.now()]);
    broadcast({ type: 'message', by: user });
    return send(res, 200, { ok: true });
  }

  if (m === 'POST' && (p === '/api/reset-list' || p === '/api/import')) {
    const b = p === '/api/import' ? await readBody(req) : {};
    let list = DEFAULT_ITEMS;
    if (p === '/api/import') {
      if (!Array.isArray(b.items) || !b.items.length) throw new HttpError(400, 'Yedek dosyasında liste yok');
      list = b.items.slice(0, 1000).map((it, i) => ({
        id: clip(it.id || ('imp_' + i + '_' + Date.now()), 80).replace(/[^A-Za-z0-9_-]/g, '_'), category: clip(it.category, 40) || 'uyku',
        label: clip(it.label || it.title, 300) || 'İsimsiz kalem', note: clip(it.note || it.desc, 1000),
        searchQuery: clip(it.searchQuery || it.query || it.label, 200), price: toPrice(it.price),
        priority: ['urgent', 'normal', 'later'].includes(it.priority) ? it.priority : 'normal',
        checked: !!it.checked, userNote: clip(it.userNote, 500), order: Number(it.order) || i
      }));
    }
    await q('DELETE FROM items');
    await insertItems(list, user);
    await q('DELETE FROM comments WHERE item_id NOT IN (SELECT id FROM items)');
    await logActivity(user, p === '/api/import' ? 'import' : 'reset', null, `${list.length} kalem`);
    broadcast({ type: 'changed', by: user });
    return send(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Bulunamadı');
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  try {
    await route(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status >= 500 ? 'Sunucu hatası' : e.message });
    else res.end();
  }
});

migrate().then(() => {
  server.listen(PORT, () => console.log(`bebek-api ${PORT} portunda çalışıyor`));
}).catch((e) => { console.error('Veritabanı hazırlanamadı:', e); process.exit(1); });

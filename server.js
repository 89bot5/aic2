'use strict';
// Minimal self-hosted text chat for any OpenAI-compatible API.
// One process, one SQLite file, one password. No configuration needed to start:
// the first visit asks you to create a password, and the API key is set in the app.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

// ---------- config (all optional) ----------
const cfg = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3000),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')),
  apiBase: (process.env.API_BASE_URL || 'https://api.abliteration.ai/v1').replace(/\/+$/, ''),
  defaultModel: process.env.MODEL || 'abliterated-model-large-v2',
  // URL prefix when served under a subpath, e.g. /aic. Empty means the site root.
  base: (process.env.BASE_PATH || '').replace(/\/+$/, '').replace(/^(?=[^/])/, '/'),
};

// ---------- database ----------
fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
const db = new Database(path.join(cfg.dataDir, 'chat.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chats (
    id               TEXT PRIMARY KEY,
    title            TEXT NOT NULL DEFAULT 'New chat',
    system_prompt    TEXT,
    reasoning_effort TEXT,
    created_at       TEXT NOT NULL DEFAULT (${NOW}),
    updated_at       TEXT NOT NULL DEFAULT (${NOW})
  );
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    reasoning  TEXT,
    created_at TEXT NOT NULL DEFAULT (${NOW})
  );
  CREATE INDEX IF NOT EXISTS messages_chat_idx ON messages (chat_id, id);
`);

const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
function setSetting(k, v) {
  if (v === null || v === undefined) db.prepare('DELETE FROM settings WHERE key = ?').run(k);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
}

// `npm run reset-password`: forget the password so the next visit asks for a new one.
if (process.argv.includes('--reset-password')) {
  setSetting('password_hash', null);
  console.log('Password cleared. Open the app to set a new one.');
  process.exit(0);
}

// Random secret for signing login cookies, created once and kept in the database.
if (!getSetting('session_secret')) setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
const sessionSecret = getSetting('session_secret');

// ---------- passwords ----------
const MIN_PASSWORD = 8;
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [kind, saltHex, hashHex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
const passwordIsSet = () => !!getSetting('password_hash');

// ---------- auth (stateless signed cookie) ----------
const COOKIE = 'session';
const SESSION_DAYS = 30;

function sign(value) {
  // The password hash is mixed in, so setting a new password logs out every session.
  return crypto.createHmac('sha256', sessionSecret).update(value + '|' + (getSetting('password_hash') || '')).digest('base64url');
}
function makeToken() {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  return exp + '.' + sign(exp);
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
function isAuthed(req) {
  if (!passwordIsSet()) return false;
  const tok = getCookie(req, COOKIE);
  if (!tok) return false;
  const [exp, sig] = tok.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp));
}
// Mark the cookie Secure when the page was reached over HTTPS (directly or via a proxy).
function isHttps(req) {
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function cookieHeader(req, value, maxAge) {
  return `${COOKIE}=${value}; Path=${cfg.base || '/'}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

// Login throttling: 5 failures per IP locks that IP out for 15 minutes.
const failures = new Map();
function clientIp(req) {
  // X-Forwarded-For is only trustworthy because we bind to localhost behind a proxy.
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}
function lockedOut(ip) {
  const f = failures.get(ip);
  return f && f.count >= 5 && f.until > Date.now();
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + 15 * 60e3 });
  else f.count++;
}

// ---------- static files ----------
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const files = {
  '/static/app.js': path.join(PUB, 'app.js'),
  '/static/style.css': path.join(PUB, 'style.css'),
  '/static/icon.svg': path.join(PUB, 'icon.svg'),
  '/vendor/marked.js': path.join(__dirname, 'node_modules/marked/lib/marked.umd.js'),
  '/vendor/purify.js': path.join(__dirname, 'node_modules/dompurify/dist/purify.min.js'),
};
const LOGIN_HTML = path.join(PUB, 'login.html');
const SETUP_HTML = path.join(PUB, 'setup.html');
const APP_HTML = path.join(PUB, 'index.html');

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function sendFile(res, file, status = 200) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}
function sendHtml(res, file, error = '') {
  const html = fs.readFileSync(file, 'utf8')
    .replaceAll('{{BASE}}', cfg.base)
    .replaceAll('{{MIN_PASSWORD}}', String(MIN_PASSWORD))
    .replace('{{ERROR}}', error ? `<p class="login-error">${error}</p>` : '');
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}
const LOGIN_ERRORS = { locked: 'Too many attempts. Try again in 15 minutes.', 1: 'Wrong password.' };
const SETUP_ERRORS = { short: `Use at least ${MIN_PASSWORD} characters.`, mismatch: "The passwords don't match." };

function json(res, status, obj) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function redirect(res, to, extra = {}) {
  res.writeHead(303, { Location: cfg.base + to, ...extra });
  res.end();
}
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  try { return JSON.parse((await readBody(req)) || '{}'); }
  catch (e) { throw Object.assign(new Error(e.status ? e.message : 'Invalid JSON'), { status: e.status || 400 }); }
}

// Allowed values for a chat's reasoning effort; null means "don't send it, use the model default".
const EFFORTS = ['low', 'high', 'max'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const touchChat = (id) => db.prepare(`UPDATE chats SET updated_at = ${NOW} WHERE id = ?`).run(id);
const currentModel = () => getSetting('model') || cfg.defaultModel;

// ---------- model streaming ----------
// Replies in progress, by chat, so the Stop button can end one cleanly on the server.
const activeStreams = new Map();

async function streamReply(res, chatId, userMessageId = null) {
  const rows = db.prepare('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id').all(chatId);
  const chat = db.prepare('SELECT system_prompt, reasoning_effort FROM chats WHERE id = ?').get(chatId) || {};
  const messages = [];
  if (chat.system_prompt) messages.push({ role: 'system', content: chat.system_prompt });
  for (const r of rows) messages.push({ role: r.role, content: r.content });

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    'X-Accel-Buffering': 'no', // tell nginx not to buffer
  });
  const send = (obj) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  // Stop (POST /stop) or a closed tab cancels the upstream request. With Stop the
  // response stays open, so the browser still learns the saved reply's id.
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  activeStreams.set(chatId, ac);
  if (userMessageId) send({ u: userMessageId });

  let content = '', reasoning = '', error = null;
  const apiKey = getSetting('api_key');
  try {
    if (!apiKey) throw new Error('No API key yet. Click the key icon at the bottom left to add one, then press Retry.');
    const up = await fetch(`${cfg.apiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: currentModel(), messages, stream: true, ...(chat.reasoning_effort ? { reasoning_effort: chat.reasoning_effort } : {}) }),
      signal: ac.signal,
    });
    if (!up.ok) {
      const text = await up.text().catch(() => '');
      throw new Error(up.status === 401 ? 'The API rejected the key (401). Check it via the key icon at the bottom left.'
        : `API returned ${up.status}: ${text.slice(0, 500)}`);
    }
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of up.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(data); } catch { continue; }
        if (evt.error) throw new Error(evt.error.message || JSON.stringify(evt.error));
        const delta = evt.choices?.[0]?.delta || {};
        const r = delta.reasoning_content || delta.reasoning;
        if (r) { reasoning += r; send({ r }); }
        if (delta.content) { content += delta.content; send({ c: delta.content }); }
      }
    }
  } catch (e) {
    if (!ac.signal.aborted) { error = e.message || String(e); console.error('Upstream error:', error); }
  }

  // Save whatever arrived, including a partial reply after Stop.
  let id = null;
  if (content || reasoning) {
    id = db.prepare('INSERT INTO messages (chat_id, role, content, reasoning) VALUES (?, ?, ?, ?)')
      .run(chatId, 'assistant', content, reasoning || null).lastInsertRowid;
  }
  if (activeStreams.get(chatId) === ac) activeStreams.delete(chatId);
  touchChat(chatId);
  if (error) send({ error });
  send({ done: true, id: id === null ? null : Number(id) });
  res.end();
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname;
  const m = req.method;

  // Strip the subpath prefix (the proxy passes the full path through).
  if (cfg.base) {
    if (p === cfg.base) return redirect(res, '/');
    if (!p.startsWith(cfg.base + '/')) { res.writeHead(404); return res.end('Not found'); }
    p = p.slice(cfg.base.length);
  }

  // Public routes
  if (m === 'GET' && p === '/static/style.css') return sendFile(res, files[p]);
  if (m === 'GET' && p === '/static/icon.svg') return sendFile(res, files[p]);

  // First run: no password yet, so every page leads to "create a password".
  if (!passwordIsSet()) {
    if (m === 'POST' && p === '/setup') {
      const form = new URLSearchParams(await readBody(req, 10 * 1024));
      const pw = form.get('password') || '';
      if (pw.length < MIN_PASSWORD) return redirect(res, '/?e=short');
      if (pw !== form.get('confirm')) return redirect(res, '/?e=mismatch');
      if (passwordIsSet()) return redirect(res, '/'); // someone else finished setup first
      setSetting('password_hash', hashPassword(pw));
      console.log('Password created.');
      return redirect(res, '/', { 'Set-Cookie': cookieHeader(req, makeToken(), SESSION_DAYS * 86400) });
    }
    if (p.startsWith('/api/')) return json(res, 401, { error: 'Not logged in' });
    if (m === 'GET' && (p === '/' || p.startsWith('/c/'))) return sendHtml(res, SETUP_HTML, SETUP_ERRORS[url.searchParams.get('e')] || '');
    return redirect(res, '/');
  }

  if (m === 'POST' && p === '/login') {
    const ip = clientIp(req);
    if (lockedOut(ip)) return redirect(res, '/?e=locked');
    const form = new URLSearchParams(await readBody(req, 10 * 1024));
    if (verifyPassword(form.get('password') || '', getSetting('password_hash'))) {
      failures.delete(ip);
      return redirect(res, '/', { 'Set-Cookie': cookieHeader(req, makeToken(), SESSION_DAYS * 86400) });
    }
    noteFailure(ip);
    console.warn(`Failed login from ${ip}`);
    return redirect(res, '/?e=1');
  }
  if (m === 'POST' && p === '/logout') return redirect(res, '/', { 'Set-Cookie': cookieHeader(req, '', 0) });

  if (!isAuthed(req)) {
    if (p.startsWith('/api/')) return json(res, 401, { error: 'Not logged in' });
    if (m === 'GET' && (p === '/' || p.startsWith('/c/'))) return sendHtml(res, LOGIN_HTML, LOGIN_ERRORS[url.searchParams.get('e')] || '');
    return redirect(res, '/');
  }

  // Authenticated routes
  if (m === 'GET' && files[p]) return sendFile(res, files[p]);
  if (m === 'GET' && (p === '/' || /^\/c\/[0-9a-f-]+$/i.test(p))) return sendHtml(res, APP_HTML);

  if (p === '/api/settings' && m === 'GET') {
    const key = getSetting('api_key');
    // The key itself never goes back to the browser, only its last 4 characters.
    return json(res, 200, { has_key: !!key, key_hint: key ? key.slice(-4) : null, model: currentModel(), default_model: cfg.defaultModel });
  }
  if (p === '/api/settings' && m === 'PUT') {
    const body = await readJson(req);
    if ('api_key' in body) {
      const key = String(body.api_key ?? '').trim();
      if (/\s/.test(key)) return json(res, 400, { error: 'The key should not contain spaces.' });
      setSetting('api_key', key || null);
    }
    if ('model' in body) {
      const model = String(body.model ?? '').trim();
      setSetting('model', model && model !== cfg.defaultModel ? model.slice(0, 200) : null);
    }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/chats' && m === 'GET') {
    // Remove untouched empty chats (no messages, no settings, never renamed), except the one being viewed.
    const keep = url.searchParams.get('keep');
    db.prepare(`DELETE FROM chats WHERE title = 'New chat' AND system_prompt IS NULL AND reasoning_effort IS NULL
                  AND id IS NOT ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = chats.id)`)
      .run(keep && UUID_RE.test(keep) ? keep : null);
    const rows = db.prepare(
      `SELECT id, title, updated_at, reasoning_effort, system_prompt IS NOT NULL AS has_prompt,
              EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = chats.id) AS has_messages
         FROM chats ORDER BY updated_at DESC LIMIT 500`).all();
    return json(res, 200, rows.map((r) => ({ ...r, has_prompt: !!r.has_prompt, has_messages: !!r.has_messages })));
  }
  if (p === '/api/chats' && m === 'POST') {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO chats (id) VALUES (?)').run(id);
    return json(res, 201, db.prepare('SELECT id, title, updated_at FROM chats WHERE id = ?').get(id));
  }

  const cm = p.match(/^\/api\/chats\/([^/]+)(\/messages|\/regenerate|\/stop)?(?:\/(\d+))?$/);
  if (cm) {
    const id = cm[1];
    if (!UUID_RE.test(id)) return json(res, 404, { error: 'Not found' });
    const chat = db.prepare('SELECT id, title, system_prompt, reasoning_effort FROM chats WHERE id = ?').get(id);
    if (!chat) return json(res, 404, { error: 'Not found' });
    const sub = cm[2];
    const msgId = cm[3];
    if (msgId && !(sub === '/messages' && m === 'DELETE')) return json(res, 404, { error: 'Not found' });

    if (sub === '/messages' && msgId && m === 'DELETE') {
      db.prepare('DELETE FROM messages WHERE id = ? AND chat_id = ?').run(Number(msgId), id);
      touchChat(id);
      return json(res, 200, { ok: true });
    }
    if (sub === '/stop' && m === 'POST') {
      activeStreams.get(id)?.abort();
      return json(res, 200, { ok: true });
    }

    if (!sub && m === 'GET') {
      const rows = db.prepare('SELECT id, role, content, reasoning FROM messages WHERE chat_id = ? ORDER BY id').all(id);
      return json(res, 200, { id, title: chat.title, system_prompt: chat.system_prompt, reasoning_effort: chat.reasoning_effort, messages: rows });
    }
    if (!sub && m === 'PATCH') {
      const body = await readJson(req);
      if ('reasoning_effort' in body && body.reasoning_effort !== null && !EFFORTS.includes(body.reasoning_effort)) {
        return json(res, 400, { error: 'Invalid reasoning effort' });
      }
      if ('title' in body) {
        const title = String(body.title || '').trim().slice(0, 200);
        if (!title) return json(res, 400, { error: 'Title required' });
        db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(title, id);
      }
      if ('system_prompt' in body) {
        // Blank clears it.
        const sp = String(body.system_prompt ?? '').trim() ? String(body.system_prompt) : null;
        db.prepare('UPDATE chats SET system_prompt = ? WHERE id = ?').run(sp, id);
      }
      if ('reasoning_effort' in body) {
        db.prepare('UPDATE chats SET reasoning_effort = ? WHERE id = ?').run(body.reasoning_effort, id);
      }
      return json(res, 200, { ok: true });
    }
    if (!sub && m === 'DELETE') {
      db.prepare('DELETE FROM chats WHERE id = ?').run(id);
      return json(res, 200, { ok: true });
    }
    if (sub === '/messages' && m === 'POST') {
      const body = await readJson(req);
      const content = String(body.content || '');
      if (!content.trim()) return json(res, 400, { error: 'Message is empty' });
      const userId = db.prepare('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)').run(id, 'user', content).lastInsertRowid;
      if (chat.title === 'New chat') {
        db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(content.trim().replace(/\s+/g, ' ').slice(0, 60), id);
      }
      return streamReply(res, id, Number(userId));
    }
    if (sub === '/regenerate' && m === 'POST') {
      // Drop the last assistant reply (if any) and ask again.
      db.prepare(`DELETE FROM messages WHERE id = (SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1) AND role = 'assistant'`).run(id);
      const last = db.prepare('SELECT role FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(id);
      if (!last || last.role !== 'user') return json(res, 400, { error: 'Nothing to regenerate' });
      return streamReply(res, id);
    }
  }

  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    else res.end();
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${cfg.port} is already in use. Start with a different one, e.g. PORT=3001 npm start`);
  else console.error(e.message);
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  const shown = cfg.host === '127.0.0.1' || cfg.host === '0.0.0.0' ? 'localhost' : cfg.host;
  console.log(`Chat is running. Open http://${shown}:${cfg.port}${cfg.base}/ in your browser.`);
  console.log(`Data is stored in ${cfg.dataDir}`);
  if (!passwordIsSet()) console.log('First run: the page will ask you to create a password.');
});

function shutdown() {
  server.close();
  try { db.close(); } catch { /* already closed */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

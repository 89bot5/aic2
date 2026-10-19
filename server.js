'use strict';
// Minimal self-hosted text chat for any OpenAI-compatible API.
// One process, one Postgres database, one password.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

// ---------- config ----------
const cfg = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3000),
  password: process.env.APP_PASSWORD,
  secret: process.env.SESSION_SECRET,
  apiBase: (process.env.API_BASE_URL || 'https://api.abliteration.ai/v1').replace(/\/+$/, ''),
  apiKey: process.env.API_KEY,
  model: process.env.MODEL || 'abliterated-model',
  systemPrompt: process.env.SYSTEM_PROMPT || '',
  // URL prefix when served under a subpath, e.g. /aic. Empty means the site root.
  base: (process.env.BASE_PATH || '').replace(/\/+$/, '').replace(/^(?=[^/])/, '/'),
  // Set INSECURE_COOKIE=1 only for local testing over plain http.
  secureCookie: process.env.INSECURE_COOKIE !== '1',
};
for (const [key, env] of [['password', 'APP_PASSWORD'], ['secret', 'SESSION_SECRET'], ['apiKey', 'API_KEY']]) {
  if (!cfg[key]) { console.error(`Missing required environment variable ${env}`); process.exit(1); }
}
if (!process.env.DATABASE_URL) { console.error('Missing required environment variable DATABASE_URL'); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chats (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title      text NOT NULL DEFAULT 'New chat',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id         bigserial PRIMARY KEY,
      chat_id    uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role       text NOT NULL CHECK (role IN ('user', 'assistant')),
      content    text NOT NULL,
      reasoning  text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS messages_chat_idx ON messages (chat_id, id);
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS system_prompt text;
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS reasoning_effort text;
  `);
}

// ---------- auth (stateless signed cookie) ----------
const COOKIE = 'session';
const SESSION_DAYS = 30;

function sign(value) {
  // Password is mixed in, so changing APP_PASSWORD logs out every session.
  return crypto.createHmac('sha256', cfg.secret).update(value + '|' + cfg.password).digest('base64url');
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
  const tok = getCookie(req, COOKIE);
  if (!tok) return false;
  const [exp, sig] = tok.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp));
}
function cookieHeader(value, maxAge) {
  return `${COOKIE}=${value}; Path=${cfg.base || '/'}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cfg.secureCookie ? '; Secure' : ''}`;
}

// Login throttling: 5 failures per IP locks that IP out for 15 minutes.
const failures = new Map();
function clientIp(req) {
  // Only trust X-Forwarded-For because we bind to localhost behind nginx.
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
    .replace('{{ERROR}}', error ? `<p class="login-error">${error}</p>` : '');
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}
function sendLogin(res, err) {
  sendHtml(res, LOGIN_HTML, err === 'locked' ? 'Too many attempts. Try again in 15 minutes.' : err ? 'Wrong password.' : '');
}
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

// ---------- model streaming ----------
// Replies in progress, by chat, so the Stop button can end one cleanly on the server.
const activeStreams = new Map();

async function streamReply(res, chatId, userMessageId = null) {
  const { rows } = await pool.query('SELECT role, content FROM messages WHERE chat_id = $1 ORDER BY id', [chatId]);
  const chat = await pool.query('SELECT system_prompt, reasoning_effort FROM chats WHERE id = $1', [chatId]);
  const effort = chat.rows[0]?.reasoning_effort;
  // The chat's own prompt wins; SYSTEM_PROMPT in the env file is only a fallback.
  const systemPrompt = chat.rows[0]?.system_prompt || cfg.systemPrompt;
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
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
  try {
    const up = await fetch(`${cfg.apiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages, stream: true, ...(effort ? { reasoning_effort: effort } : {}) }),
      signal: ac.signal,
    });
    if (!up.ok) {
      const text = await up.text().catch(() => '');
      throw new Error(`API returned ${up.status}: ${text.slice(0, 500)}`);
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
    const r = await pool.query(
      'INSERT INTO messages (chat_id, role, content, reasoning) VALUES ($1, $2, $3, $4) RETURNING id',
      [chatId, 'assistant', content, reasoning || null]);
    id = r.rows[0].id;
  }
  if (activeStreams.get(chatId) === ac) activeStreams.delete(chatId);
  await pool.query('UPDATE chats SET updated_at = now() WHERE id = $1', [chatId]);
  if (error) send({ error });
  send({ done: true, id });
  res.end();
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname;
  const m = req.method;

  // Strip the subpath prefix (nginx passes the full path through).
  if (cfg.base) {
    if (p === cfg.base) return redirect(res, '/');
    if (!p.startsWith(cfg.base + '/')) { res.writeHead(404); return res.end('Not found'); }
    p = p.slice(cfg.base.length);
  }

  // Public routes
  if (m === 'GET' && p === '/static/style.css') return sendFile(res, files[p]);
  if (m === 'GET' && p === '/static/icon.svg') return sendFile(res, files[p]);

  if (m === 'POST' && p === '/login') {
    const ip = clientIp(req);
    if (lockedOut(ip)) return redirect(res, '/?e=locked');
    const form = new URLSearchParams(await readBody(req, 10 * 1024));
    if (safeEqual(form.get('password') || '', cfg.password)) {
      failures.delete(ip);
      return redirect(res, '/', { 'Set-Cookie': cookieHeader(makeToken(), SESSION_DAYS * 86400) });
    }
    noteFailure(ip);
    console.warn(`Failed login from ${ip}`);
    return redirect(res, '/?e=1');
  }
  if (m === 'POST' && p === '/logout') return redirect(res, '/', { 'Set-Cookie': cookieHeader('', 0) });

  if (!isAuthed(req)) {
    if (p.startsWith('/api/')) return json(res, 401, { error: 'Not logged in' });
    if (m === 'GET' && (p === '/' || p.startsWith('/c/'))) return sendLogin(res, url.searchParams.get('e'));
    return redirect(res, '/');
  }

  // Authenticated routes
  if (m === 'GET' && files[p]) return sendFile(res, files[p]);
  if (m === 'GET' && (p === '/' || /^\/c\/[0-9a-f-]+$/i.test(p))) return sendHtml(res, APP_HTML);

  if (p === '/api/chats' && m === 'GET') {
    // Remove untouched empty chats (no messages, no prompt, never renamed), except the one being viewed.
    const keep = url.searchParams.get('keep');
    await pool.query(
      `DELETE FROM chats c WHERE c.title = 'New chat' AND c.system_prompt IS NULL AND c.reasoning_effort IS NULL
         AND c.id IS DISTINCT FROM $1::uuid
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id)`,
      [keep && UUID_RE.test(keep) ? keep : null]);
    const { rows } = await pool.query(
      `SELECT id, title, updated_at, reasoning_effort, system_prompt IS NOT NULL AS has_prompt,
              EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = chats.id) AS has_messages
         FROM chats ORDER BY updated_at DESC LIMIT 500`);
    return json(res, 200, rows);
  }
  if (p === '/api/chats' && m === 'POST') {
    const { rows } = await pool.query('INSERT INTO chats DEFAULT VALUES RETURNING id, title, updated_at');
    return json(res, 201, rows[0]);
  }

  const cm = p.match(/^\/api\/chats\/([^/]+)(\/messages|\/regenerate|\/stop)?(?:\/(\d+))?$/);
  if (cm) {
    const id = cm[1];
    if (!UUID_RE.test(id)) return json(res, 404, { error: 'Not found' });
    const exists = await pool.query('SELECT id, title, system_prompt, reasoning_effort FROM chats WHERE id = $1', [id]);
    if (!exists.rowCount) return json(res, 404, { error: 'Not found' });
    const chat = exists.rows[0];
    const sub = cm[2];
    const msgId = cm[3];
    if (msgId && !(sub === '/messages' && m === 'DELETE')) return json(res, 404, { error: 'Not found' });

    if (sub === '/messages' && msgId && m === 'DELETE') {
      await pool.query('DELETE FROM messages WHERE id = $1 AND chat_id = $2', [msgId, id]);
      await pool.query('UPDATE chats SET updated_at = now() WHERE id = $1', [id]);
      return json(res, 200, { ok: true });
    }
    if (sub === '/stop' && m === 'POST') {
      activeStreams.get(id)?.abort();
      return json(res, 200, { ok: true });
    }

    if (!sub && m === 'GET') {
      const { rows } = await pool.query('SELECT id, role, content, reasoning FROM messages WHERE chat_id = $1 ORDER BY id', [id]);
      return json(res, 200, { id, title: chat.title, system_prompt: chat.system_prompt, reasoning_effort: chat.reasoning_effort, messages: rows });
    }
    if (!sub && m === 'PATCH') {
      const body = await readJson(req);
      if ('title' in body) {
        const title = String(body.title || '').trim().slice(0, 200);
        if (!title) return json(res, 400, { error: 'Title required' });
        await pool.query('UPDATE chats SET title = $2 WHERE id = $1', [id, title]);
      }
      if ('system_prompt' in body) {
        // Blank clears it.
        const sp = String(body.system_prompt ?? '').trim() ? String(body.system_prompt) : null;
        await pool.query('UPDATE chats SET system_prompt = $2 WHERE id = $1', [id, sp]);
      }
      if ('reasoning_effort' in body) {
        const e = body.reasoning_effort;
        if (e !== null && !EFFORTS.includes(e)) return json(res, 400, { error: 'Invalid reasoning effort' });
        await pool.query('UPDATE chats SET reasoning_effort = $2 WHERE id = $1', [id, e]);
      }
      return json(res, 200, { ok: true });
    }
    if (!sub && m === 'DELETE') {
      await pool.query('DELETE FROM chats WHERE id = $1', [id]);
      return json(res, 200, { ok: true });
    }
    if (sub === '/messages' && m === 'POST') {
      const body = await readJson(req);
      const content = String(body.content || '');
      if (!content.trim()) return json(res, 400, { error: 'Message is empty' });
      const ins = await pool.query('INSERT INTO messages (chat_id, role, content) VALUES ($1, $2, $3) RETURNING id', [id, 'user', content]);
      if (chat.title === 'New chat') {
        const title = content.trim().replace(/\s+/g, ' ').slice(0, 60);
        await pool.query('UPDATE chats SET title = $2 WHERE id = $1', [id, title]);
      }
      return streamReply(res, id, ins.rows[0].id);
    }
    if (sub === '/regenerate' && m === 'POST') {
      // Drop the last assistant reply (if any) and ask again.
      await pool.query(
        `DELETE FROM messages WHERE id = (SELECT id FROM messages WHERE chat_id = $1 ORDER BY id DESC LIMIT 1) AND role = 'assistant'`, [id]);
      const last = await pool.query('SELECT role FROM messages WHERE chat_id = $1 ORDER BY id DESC LIMIT 1', [id]);
      if (!last.rowCount || last.rows[0].role !== 'user') return json(res, 400, { error: 'Nothing to regenerate' });
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

initDb()
  .then(() => server.listen(cfg.port, cfg.host, () => console.log(`Chat listening on http://${cfg.host}:${cfg.port}${cfg.base}/ (model: ${cfg.model})`)))
  .catch((e) => { console.error('Database setup failed:', e.message); process.exit(1); });

process.on('SIGTERM', () => { server.close(); pool.end().finally(() => process.exit(0)); });

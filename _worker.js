/**
 * Queued — Cloudflare Pages single-worker backend.
 *
 * Handles /api/* and passes everything else through to the static site.
 * Bindings expected (set in the Pages dashboard — see DEPLOY.md):
 *   env.DB                → D1 database
 *   env.TMDB_KEY          → your TMDB v3 API key (secret)
 *   env.SESSION_SECRET    → long random string for signing session cookies (secret)
 *   env.GOOGLE_CLIENT_ID  → Google OAuth client ID (plain var; also used by the client)
 */

const COOKIE = 'q_session';
const SESSION_DAYS = 60;
const enc = new TextEncoder();
const dec = new TextDecoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === '/api/config')            return json({ googleClientId: env.GOOGLE_CLIENT_ID || '', tmdbProxy: !!env.TMDB_KEY });
      if (p === '/api/auth/signup')       return await signup(request, env);
      if (p === '/api/auth/login')        return await login(request, env);
      if (p === '/api/auth/google')       return await googleAuth(request, env);
      if (p === '/api/auth/logout')       return logout();
      if (p === '/api/auth/me')           return await me(request, env);
      if (p === '/api/sync')              return await sync(request, env);
      if (p.startsWith('/api/tmdb/'))     return await tmdbProxy(request, env);
      if (p.startsWith('/api/'))          return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
    // Static assets (the app)
    return env.ASSETS.fetch(request);
  }
};

/* ───────────────────────── helpers ───────────────────────── */
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
  });
}
function b64urlFromBytes(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ───────────────────────── password hashing (PBKDF2) ───────────────────────── */
async function hashPassword(password, saltBytes) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, keyMaterial, 256);
  return { hash: b64urlFromBytes(new Uint8Array(bits)), salt: b64urlFromBytes(salt) };
}
async function verifyPassword(password, hashB64, saltB64) {
  const { hash } = await hashPassword(password, b64urlToBytes(saltB64));
  // constant-time-ish compare
  if (hash.length !== hashB64.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ hashB64.charCodeAt(i);
  return diff === 0;
}

/* ───────────────────────── session JWT (HS256) ───────────────────────── */
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signSession(payload, secret) {
  const header = b64urlFromBytes(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64urlFromBytes(enc.encode(JSON.stringify(payload)));
  const data = header + '.' + body;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return data + '.' + b64urlFromBytes(new Uint8Array(sig));
}
async function verifySession(token, secret) {
  if (!token || token.split('.').length !== 3) return null;
  const [h, b, s] = token.split('.');
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(s), enc.encode(h + '.' + b));
  if (!ok) return null;
  const payload = JSON.parse(dec.decode(b64urlToBytes(b)));
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}
function sessionCookie(token) {
  const maxAge = SESSION_DAYS * 86400;
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
function readCookie(request, name) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
async function currentUser(request, env) {
  const tok = readCookie(request, COOKIE);
  if (!tok) return null;
  const payload = await verifySession(tok, env.SESSION_SECRET);
  if (!payload) return null;
  const row = await env.DB.prepare('SELECT id, email, name FROM users WHERE id = ?').bind(payload.uid).first();
  return row || null;
}
async function issue(user, env) {
  const payload = { uid: user.id, email: user.email, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 };
  const token = await signSession(payload, env.SESSION_SECRET);
  return json({ user: { id: user.id, email: user.email, name: user.name } }, 200, { 'Set-Cookie': sessionCookie(token) });
}

/* ───────────────────────── auth endpoints ───────────────────────── */
async function signup(request, env) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  const { email, password, name } = await request.json();
  const e = (email || '').trim().toLowerCase();
  if (!e || !e.includes('@') || !password || password.length < 8) return json({ error: 'Enter a valid email and a password of at least 8 characters.' }, 400);
  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(e).first();
  if (exists) return json({ error: 'An account with that email already exists.' }, 409);
  const { hash, salt } = await hashPassword(password);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, email, pass_hash, pass_salt, name, created_at) VALUES (?,?,?,?,?,?)')
    .bind(id, e, hash, salt, (name || e.split('@')[0]), Date.now()).run();
  return issue({ id, email: e, name: name || e.split('@')[0] }, env);
}
async function login(request, env) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  const { email, password } = await request.json();
  const e = (email || '').trim().toLowerCase();
  const row = await env.DB.prepare('SELECT id, email, name, pass_hash, pass_salt FROM users WHERE email = ?').bind(e).first();
  if (!row || !row.pass_hash) return json({ error: 'No account with that email, or wrong sign-in method.' }, 401);
  const ok = await verifyPassword(password || '', row.pass_hash, row.pass_salt);
  if (!ok) return json({ error: 'Incorrect email or password.' }, 401);
  return issue(row, env);
}
async function googleAuth(request, env) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  const { credential } = await request.json();
  if (!credential) return json({ error: 'Missing Google credential.' }, 400);
  // Verify the Google ID token via Google's tokeninfo endpoint (no extra libs needed).
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!r.ok) return json({ error: 'Could not verify Google sign-in.' }, 401);
  const info = await r.json();
  if (env.GOOGLE_CLIENT_ID && info.aud !== env.GOOGLE_CLIENT_ID) return json({ error: 'Google client mismatch.' }, 401);
  if (info.email_verified !== 'true' && info.email_verified !== true) return json({ error: 'Google email not verified.' }, 401);
  const sub = info.sub, email = (info.email || '').toLowerCase(), name = info.name || (email ? email.split('@')[0] : 'Member');
  let row = await env.DB.prepare('SELECT id, email, name FROM users WHERE google_sub = ? OR email = ?').bind(sub, email).first();
  if (!row) {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO users (id, email, google_sub, name, created_at) VALUES (?,?,?,?,?)')
      .bind(id, email, sub, name, Date.now()).run();
    row = { id, email, name };
  } else if (!row.google_sub) {
    await env.DB.prepare('UPDATE users SET google_sub = ? WHERE id = ?').bind(sub, row.id).run();
  }
  return issue(row, env);
}
function logout() {
  return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` });
}
async function me(request, env) {
  const u = await currentUser(request, env);
  return json({ user: u ? { id: u.id, email: u.email, name: u.name } : null });
}

/* ───────────────────────── sync (per-user JSON snapshot) ───────────────────────── */
async function sync(request, env) {
  const u = await currentUser(request, env);
  if (!u) return json({ error: 'Not signed in.' }, 401);
  if (request.method === 'GET') {
    const row = await env.DB.prepare('SELECT json, updated_at FROM state WHERE user_id = ?').bind(u.id).first();
    return json({ json: row ? row.json : null, updatedAt: row ? row.updated_at : 0 });
  }
  if (request.method === 'PUT') {
    const body = await request.json();
    const data = typeof body.json === 'string' ? body.json : JSON.stringify(body.json || {});
    if (data.length > 4_000_000) return json({ error: 'Data too large.' }, 413);
    const now = Date.now();
    await env.DB.prepare('INSERT INTO state (user_id, json, updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .bind(u.id, data, now).run();
    return json({ ok: true, updatedAt: now });
  }
  return json({ error: 'method' }, 405);
}

/* ───────────────────────── TMDB proxy ───────────────────────── */
async function tmdbProxy(request, env) {
  if (!env.TMDB_KEY) return json({ error: 'TMDB not configured on server.' }, 503);
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/tmdb', ''); // e.g. /search/movie
  const target = new URL('https://api.themoviedb.org/3' + path);
  url.searchParams.forEach((v, k) => { if (k !== 'api_key') target.searchParams.set(k, v); });
  target.searchParams.set('api_key', env.TMDB_KEY);

  // Cache GETs at the edge to cut TMDB calls and latency (free).
  const cache = caches.default;
  const cacheKey = new Request(target.toString().replace(env.TMDB_KEY, 'KEY'), { method: 'GET' });
  let resp = await cache.match(cacheKey);
  if (resp) return resp;

  const upstream = await fetch(target.toString(), { headers: { 'Accept': 'application/json' } });
  resp = new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=21600' }
  });
  if (upstream.ok) await cache.put(cacheKey, resp.clone());
  return resp;
}

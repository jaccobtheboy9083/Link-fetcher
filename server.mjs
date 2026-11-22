import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import pg from 'pg';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const adminToken = process.env.ADMIN_TOKEN || '';
const databaseUrl = process.env.DATABASE_URL || '';
const pool = databaseUrl ? new pg.Pool({
  connectionString: databaseUrl,
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
}) : null;
const memory = new Map();

if (pool) {
  await pool.query([
    'CREATE TABLE IF NOT EXISTS link_fetcher_links (',
    ' id TEXT PRIMARY KEY,',
    ' url TEXT NOT NULL UNIQUE,',
    ' label TEXT NOT NULL DEFAULT \'\',',
    ' category TEXT NOT NULL DEFAULT \'Unsorted\',',
    ' notes TEXT NOT NULL DEFAULT \'\',',
    ' added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
    ')'
  ].join(''));
}
const mode = pool ? 'postgres' : 'memory';

function send(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(data);
}
function authorized(req) {
  if (!adminToken) return false;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice(7), 'utf8');
  const expected = Buffer.from(adminToken, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
function text(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Link must be an object');
  let raw = text(input.url, 2049);
  if (raw && !/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('Only HTTP and HTTPS URLs are supported');
  if (parsed.username || parsed.password) throw new Error('URLs containing login credentials are not allowed');
  const url = parsed.toString();
  if (url.length > 2048) throw new Error('URL exceeds 2048 characters');
  return {
    id: randomUUID(),
    url,
    label: text(input.label, 120),
    category: text(input.category, 60) || 'Unsorted',
    notes: text(input.notes, 600),
    added_at: new Date().toISOString()
  };
}
async function listLinks() {
  if (pool) {
    const result = await pool.query('SELECT id,url,label,category,notes,added_at FROM link_fetcher_links ORDER BY added_at DESC, id DESC LIMIT 5000');
    return result.rows;
  }
  return [...memory.values()].sort((a, b) => b.added_at.localeCompare(a.added_at)).slice(0, 5000);
}
async function addLinks(inputs) {
  const added = [];
  const duplicates = [];
  const errors = [];
  for (let i = 0; i < inputs.length; i++) {
    let item;
    try { item = validate(inputs[i]); }
    catch (error) { errors.push({ line: i + 1, message: error.message }); continue; }
    if (pool) {
      const result = await pool.query(
        'INSERT INTO link_fetcher_links (id,url,label,category,notes,added_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (url) DO NOTHING RETURNING id,url,label,category,notes,added_at',
        [item.id, item.url, item.label, item.category, item.notes, item.added_at]
      );
      if (result.rowCount) added.push(result.rows[0]);
      else duplicates.push(item.url);
    } else {
      if ([...memory.values()].some(old => old.url === item.url)) duplicates.push(item.url);
      else { memory.set(item.id, item); added.push(item); }
    }
  }
  return { added, duplicates, errors };
}
async function deleteLink(id) {
  if (pool) {
    const result = await pool.query('DELETE FROM link_fetcher_links WHERE id=$1 RETURNING id', [id]);
    return result.rowCount > 0;
  }
  return memory.delete(id);
}
async function readBody(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 300000) throw Object.assign(new Error('Request is too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.method === 'GET' && staticFiles.has(path)) {
      const [filename, contentType] = staticFiles.get(path);
      const body = await readFile(join(root, 'public', filename));
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
      });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && path === '/health') {
      send(res, 200, { ok: true, service: 'link-fetcher', storage: mode, adminConfigured: Boolean(adminToken) });
      return;
    }
    if (path.startsWith('/api/')) {
      if (!adminToken) { send(res, 503, { error: 'ADMIN_TOKEN is not configured on the server' }); return; }
      if (!authorized(req)) {
        send(res, 401, { error: 'Incorrect access key' }, { 'WWW-Authenticate': 'Bearer realm="Link Fetcher"' });
        return;
      }
      if (req.method === 'GET' && path === '/api/links') {
        send(res, 200, { links: await listLinks(), storage: mode, updatedAt: new Date().toISOString() });
        return;
      }
      if (req.method === 'POST' && path === '/api/links') {
        const body = await readBody(req);
        const entries = Array.isArray(body?.links) ? body.links : [body];
        if (!entries.length || entries.length > 250) { send(res, 400, { error: 'Submit 1–250 links at a time' }); return; }
        const result = await addLinks(entries);
        send(res, 200, { ...result, addedCount: result.added.length, duplicateCount: result.duplicates.length });
        return;
      }
      const remove = /^\/api\/links\/([a-f0-9-]{36})$/.exec(path);
      if (req.method === 'DELETE' && remove) {
        const deleted = await deleteLink(remove[1]);
        send(res, deleted ? 200 : 404, { deleted, error: deleted ? undefined : 'Link not found' });
        return;
      }
    }
    if (req.method === 'GET' && path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    send(res, 404, { error: 'Route not found' });
  } catch (error) {
    console.error('Link Fetcher request error:', error);
    send(res, error.status || 500, { error: error.status ? error.message : 'Server error' });
  }
});
server.listen(port, '0.0.0.0', () => {
  console.log('Link Fetcher listening on port ' + port + ' (' + mode + ' storage)');
  if (!adminToken) console.warn('ADMIN_TOKEN is missing: the dashboard is locked until configured');
  if (!pool) console.warn('DATABASE_URL is missing: links will disappear on process restart');
});
const shutdown = async () => { server.close(); if (pool) await pool.end(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

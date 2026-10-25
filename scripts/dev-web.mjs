#!/usr/bin/env node
// Local stand-in for the Vercel deployment of the website:
//
//   node scripts/dev-web.mjs            -> http://127.0.0.1:4330
//
// Serves site/ as static files (with vercel.json's cleanUrls, redirects and headers) and
// routes /api/<name> to the GET handler exported by api/<name>.mjs, the same
// way Vercel runs them. Loopback only.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE = join(ROOT, 'site');
const PORT = Number(process.env.PORT || 4330);
const config = JSON.parse(await readFile(join(ROOT, 'vercel.json'), 'utf8'));
const headers = Object.fromEntries((config.headers?.[0]?.headers || []).map((x) => [x.key, x.value]));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

async function staticFile(pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const candidates = [rel, `${rel}.html`, join(rel, 'index.html')];
  for (const c of candidates) {
    const p = resolve(SITE, c);
    if (p !== SITE && !p.startsWith(SITE + '/')) continue;
    try { if ((await stat(p)).isFile()) return { body: await readFile(p), type: TYPES[extname(p)] || 'application/octet-stream' }; } catch {}
  }
  return null;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    const m = url.pathname.match(/^\/api\/([a-z-]+)$/);
    if (m) {
      const mod = await import(pathToFileURL(join(ROOT, 'api', `${m[1]}.mjs`)).href).catch(() => null);
      if (!mod?.GET || req.method !== 'GET') { res.writeHead(404, headers).end('{"error":"Not found"}'); return; }
      const out = await mod.GET(new Request(url.href, { headers: req.headers }));
      res.writeHead(out.status, { ...headers, ...Object.fromEntries(out.headers) });
      res.end(Buffer.from(await out.arrayBuffer()));
      return;
    }
    const redirect = (config.redirects || []).find((r) => r.source === url.pathname);
    if (redirect) { res.writeHead(redirect.permanent ? 308 : 307, { ...headers, Location: redirect.destination }).end(); return; }
    const file = await staticFile(url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file) { res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { ...headers, 'Content-Type': file.type, 'Cache-Control': 'no-cache' }).end(file.body);
  } catch (e) {
    console.error(e);
    res.writeHead(500, headers).end('{"error":"Internal error"}');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`AIJobNinja web (dev) → http://127.0.0.1:${PORT}`));

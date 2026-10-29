import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ClipError, cutClip, type ClipFormat } from './clip.ts';
import { PORT, WEB_DIST } from './config.ts';
import { libraryStats, listTopics, openDb } from './db.ts';
import { expandWindow, searchLibrary } from './sources/library.ts';
import { searchTv } from './sources/gdelt.ts';
import { modelAvailable } from './whisper.ts';

const conn = openDb();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Serves a file with Range support so the browser can seek inside clips. */
function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, extra: Record<string, string> = {}): void {
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file)] ?? 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return void res.end();
    }
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`, ...extra,
    });
    return void fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', ...extra });
  fs.createReadStream(file).pipe(res);
}

const intParam = (v: string | null, d: number, min: number, max: number) => {
  const n = v === null ? d : Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const p = url.searchParams;

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, library: libraryStats(conn), whisperModel: modelAvailable() });
  }

  if (url.pathname === '/api/topics') return sendJson(res, 200, listTopics(conn));

  if (url.pathname === '/api/search') {
    const q = (p.get('q') ?? '').trim();
    const source = p.get('source') ?? 'library';
    const limit = intParam(p.get('limit'), 20, 1, 50);
    if (!q) return sendJson(res, 400, { error: 'Missing q' });
    if (source === 'library') {
      const topics = (p.get('topics') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      return sendJson(res, 200, searchLibrary(conn, q, topics, limit, intParam(p.get('context'), 1, 0, 6)));
    }
    if (source === 'tv') return sendJson(res, 200, await searchTv(q, limit));
    return sendJson(res, 400, { error: `Unknown source "${source}"` });
  }

  if (url.pathname === '/api/context') {
    const win = expandWindow(
      conn,
      intParam(p.get('episode'), 0, 0, 1e9),
      intParam(p.get('first'), 0, 0, 1e9),
      intParam(p.get('last'), 0, 0, 1e9),
      intParam(p.get('before'), 0, 0, 20),
      intParam(p.get('after'), 0, 0, 20),
    );
    return win ? sendJson(res, 200, win) : sendJson(res, 404, { error: 'Segment not found' });
  }

  if (url.pathname === '/api/clip') {
    const format: ClipFormat = p.get('fmt') === 'wav' ? 'wav' : 'mp3';
    const file = await cutClip(
      conn,
      p.get('ref') ?? '',
      Number(p.get('start')),
      Number(p.get('end')),
      format,
    );
    const name = (p.get('name') ?? 'clip').replace(/[^\w .-]+/g, '').slice(0, 80) || 'clip';
    const extra: Record<string, string> = p.get('download')
      ? { 'Content-Disposition': `attachment; filename="${name}.${format}"` }
      : {};
    return sendFile(req, res, file, extra);
  }

  sendJson(res, 404, { error: 'Not found' });
}

function serveWeb(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  if (!fs.existsSync(WEB_DIST)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return void res.end('telly API is running. Start the UI with `npm run dev`, or build it with `npm run build`.');
  }
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(WEB_DIST, rel);
  if (!file.startsWith(WEB_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(WEB_DIST, 'index.html');
  }
  sendFile(req, res, file);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveWeb(req, res, url);
  } catch (err) {
    const status = err instanceof ClipError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 500) console.error(`${req.method} ${req.url}:`, message);
    if (!res.headersSent) sendJson(res, status, { error: message });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const s = libraryStats(conn);
  console.log(`telly API on http://127.0.0.1:${PORT}  (${s.episodes} recordings, ${s.segments} segments indexed)`);
});

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bounce, parseBounce } from './bounce.ts';
import { ClipError, cutClip, warmSource, type ClipFormat } from './clip.ts';
import { PORT, WEB_DIST } from './config.ts';
import { MAX_FADE_MS } from './fade.ts';
import { getSegmentsBetween, libraryStats, listTopics, openDb } from './db.ts';
import { expandWindow, searchLibrary } from './sources/library.ts';
import { searchTv } from './sources/gdelt.ts';
import {
  addClip, createTimeline, deleteTimeline, duplicateTimeline, getTimeline, listTimelines, removeClip, renameTimeline,
  TimelineError,
} from './timelines.ts';
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

const MAX_BODY_BYTES = 1_000_000;

/**
 * Reads a JSON request body. Only `application/json` is accepted: a web page on another site
 * cannot send that to this server without a CORS preflight, which the server never answers, so
 * other sites cannot change your timelines.
 */
async function readJson(req: http.IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new TimelineError(415, 'Send application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new TimelineError(413, 'Request body is too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new TimelineError(400, 'Body is not valid JSON');
  }
}

/** /api/timelines, /api/timelines/:id, /api/timelines/:id/duplicate and /api/timelines/:id/clips. */
async function handleTimelines(req: http.IncomingMessage, res: http.ServerResponse, url: URL, idText: string | undefined, sub: string | undefined): Promise<void> {
  const method = req.method ?? 'GET';
  const id = idText === undefined ? null : Number(idText);
  const body = async () => (await readJson(req)) as Record<string, unknown> | null;
  const notAllowed = () => new TimelineError(405, `${method} is not supported here`);

  if (id === null) {
    if (method === 'GET') return sendJson(res, 200, listTimelines(conn));
    if (method === 'POST') {
      const b = await body();
      return sendJson(res, 201, createTimeline(conn, b?.name, Array.isArray(b?.clips) ? b.clips : []));
    }
    throw notAllowed();
  }
  if (sub === undefined) {
    if (method === 'GET') return sendJson(res, 200, getTimeline(conn, id));
    if (method === 'PATCH') return sendJson(res, 200, renameTimeline(conn, id, (await body())?.name));
    if (method === 'DELETE') {
      deleteTimeline(conn, id);
      return sendJson(res, 200, { ok: true });
    }
    throw notAllowed();
  }
  if (sub === 'duplicate' && method === 'POST') return sendJson(res, 201, duplicateTimeline(conn, id));
  if (sub === 'clips') {
    if (method === 'POST') return sendJson(res, 201, addClip(conn, id, await body()));
    if (method === 'DELETE') return sendJson(res, 200, removeClip(conn, id, url.searchParams.get('key') ?? ''));
  }
  throw notAllowed();
}

const intParam = (v: string | null, d: number, min: number, max: number) => {
  const n = v === null ? d : Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const p = url.searchParams;

  const timelines = /^\/api\/timelines(?:\/(\d+))?(?:\/(duplicate|clips))?$/.exec(url.pathname);
  if (timelines) return handleTimelines(req, res, url, timelines[1], timelines[2]);

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
      const found = searchLibrary(conn, q, topics, limit, intParam(p.get('context'), 1, 0, 6));
      // Resolve the audio address of the best hits now (one small request each), so playing one is quick.
      for (const ref of [...new Set(found.hits.map((h) => h.ref))].slice(0, 3)) warmSource(conn, ref);
      return sendJson(res, 200, found);
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

  if (url.pathname === '/api/segments') {
    const episode = intParam(p.get('episode'), 0, 0, 1e9);
    const from = intParam(p.get('from'), 0, 0, 1e10);
    const to = intParam(p.get('to'), from, from, 1e10);
    return sendJson(res, 200, getSegmentsBetween(conn, episode, from, to));
  }

  if (url.pathname === '/api/bounce') {
    const spec = parseBounce(p.get('clips'), p.get('gap'), p.get('fmt'));
    const file = await bounce(conn, spec);
    const name = (p.get('name') ?? 'story').replace(/[^\w .-]+/g, '').slice(0, 80) || 'story';
    const extra: Record<string, string> = p.get('download')
      ? { 'Content-Disposition': `attachment; filename="${name}.${spec.format}"` }
      : {};
    return sendFile(req, res, file, extra);
  }

  if (url.pathname === '/api/clip') {
    const format: ClipFormat = p.get('fmt') === 'wav' ? 'wav' : 'mp3';
    const file = await cutClip(
      conn,
      p.get('ref') ?? '',
      Number(p.get('start')),
      Number(p.get('end')),
      format,
      { inMs: intParam(p.get('fi'), 0, 0, MAX_FADE_MS), outMs: intParam(p.get('fo'), 0, 0, MAX_FADE_MS) },
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
    return void res.end('Back then API is running. Start the UI with `npm run dev`, or build it with `npm run build`.');
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
    const status = err instanceof ClipError || err instanceof TimelineError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 500) console.error(`${req.method} ${req.url}:`, message);
    if (!res.headersSent) sendJson(res, status, { error: message });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const s = libraryStats(conn);
  console.log(`Back then API on http://127.0.0.1:${PORT}  (${s.episodes} recordings, ${s.segments} segments indexed)`);
});

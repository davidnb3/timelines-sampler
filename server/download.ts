import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { USER_AGENT } from './config.ts';

export interface DownloadOptions {
  signal?: AbortSignal;
  /** Called as bytes arrive; `total` is 0 when the server did not say how big the file is. */
  onProgress?: (done: number, total: number) => void;
}

/** Downloads a file to `dest`, through a temporary name so an interrupted download is never mistaken for a whole one. */
export async function downloadTo(url: string, dest: string, opts: DownloadOptions = {}): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal: opts.signal });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let done = 0;
  let lastReport = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length;
      const now = Date.now();
      if (opts.onProgress && now - lastReport > 250) {
        lastReport = now;
        opts.onProgress(done, total);
      }
      cb(null, chunk);
    },
  });
  const tmp = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as never), counter, fs.createWriteStream(tmp), opts.signal ? { signal: opts.signal } : {});
    opts.onProgress?.(done, total || done);
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

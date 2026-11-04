import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { searchTv } from './gdelt.ts';

const clip = {
  preview_url: 'https://archive.org/download/x?offset=120',
  ia_show_id: 'CNNW_20200101_000000_Show',
  date: '2020-01-01T00:00:00Z',
  station: 'CNN',
  show: 'Show',
  show_date: '2020-01-01',
  snippet: 'hello there',
};
const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const fetchFrom = (answers: (Response | Error)[]) => {
  let calls = 0;
  const impl = (async () => {
    const a = answers[Math.min(calls++, answers.length - 1)]!;
    if (a instanceof Error) throw a;
    return a;
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
};

describe('searchTv', () => {
  it('returns the clips of a normal answer with one request', async () => {
    const f = fetchFrom([json({ clips: [clip] })]);
    const r = await searchTv('hello', 5, { fetch: f.impl, retryAfterMs: 0 });
    assert.equal(r.hits.length, 1);
    assert.equal(f.calls(), 1);
  });

  it('treats "no results" text as an empty answer, not a failure', async () => {
    const f = fetchFrom([json('No results matched your query.')]);
    const r = await searchTv('zzzz', 5, { fetch: f.impl, retryAfterMs: 0 });
    assert.deepEqual(r.hits, []);
    assert.equal(f.calls(), 1);
  });

  it('tries again once after a dropped connection', async () => {
    const f = fetchFrom([new TypeError('fetch failed'), json({ clips: [clip] })]);
    const r = await searchTv('hello', 5, { fetch: f.impl, retryAfterMs: 0 });
    assert.equal(r.hits.length, 1);
    assert.equal(f.calls(), 2);
  });

  it('tries again once after an error page', async () => {
    const f = fetchFrom([json('Service busy', 503), json({ clips: [clip] })]);
    const r = await searchTv('hello', 5, { fetch: f.impl, retryAfterMs: 0 });
    assert.equal(r.hits.length, 1);
    assert.equal(f.calls(), 2);
  });

  it('gives a clear message after two failures, with the network error code', async () => {
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const f = fetchFrom([reset]);
    await assert.rejects(
      searchTv('hello', 5, { fetch: f.impl, retryAfterMs: 0 }),
      (err: Error) => /did not answer twice: ECONNRESET/.test(err.message) && /try again/.test(err.message),
    );
    assert.equal(f.calls(), 2);
  });
});

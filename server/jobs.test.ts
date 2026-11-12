import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { abortError } from './exec.ts';
import { openDb } from './db.ts';
import { JobRunner, JobStop, type ProcessorContext, type ItemSpec } from './jobs.ts';

const items = (...labels: string[]): ItemSpec[] => labels.map((label) => ({ label, params: { label } }));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** A processor that finishes immediately and remembers what it was given. */
function recorder(seen: string[], fail: string[] = []) {
  return {
    async run(item: ItemSpec) {
      seen.push(item.label);
      if (fail.includes(item.label)) throw new Error(`cannot do ${item.label}`);
    },
  };
}

/** A processor whose items wait until the test releases them (or aborts them, like a real transcription). */
function gated(seen: string[]) {
  const release = new Map<string, () => void>();
  return {
    release,
    processor: {
      run(item: ItemSpec, ctx: ProcessorContext) {
        seen.push(item.label);
        return new Promise<void>((resolve, reject) => {
          release.set(item.label, resolve);
          ctx.signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
      },
    },
  };
}

describe('JobRunner', () => {
  it('runs the items of a job in order and ends done', async () => {
    const seen: string[] = [];
    const runner = new JobRunner(openDb(':memory:'), { t: recorder(seen) });
    runner.create('t', 'three', {}, items('a', 'b', 'c'));
    await runner.idle();
    assert.deepEqual(seen, ['a', 'b', 'c']);
    const [job] = runner.list();
    assert.equal(job!.state, 'done');
    assert.equal(job!.done, 3);
    assert.equal(job!.total, 3);
  });

  it('keeps going when one item fails and reports it', async () => {
    const seen: string[] = [];
    const runner = new JobRunner(openDb(':memory:'), { t: recorder(seen, ['b']) });
    const job = runner.create('t', 'x', {}, items('a', 'b', 'c'));
    await runner.idle();
    assert.deepEqual(seen, ['a', 'b', 'c']);
    const after = runner.get(job.id)!;
    assert.equal(after.state, 'done');
    assert.equal(after.failed, 1);
    assert.deepEqual(after.failures, [{ label: 'b', error: 'cannot do b' }]);
  });

  it('pausing aborts the running item, which waits again; resuming does not redo finished items', async () => {
    const seen: string[] = [];
    const g = gated(seen);
    const runner = new JobRunner(openDb(':memory:'), { t: g.processor });
    const job = runner.create('t', 'x', {}, items('a', 'b', 'c'));
    await tick();
    g.release.get('a')!();
    await tick();
    assert.deepEqual(seen, ['a', 'b']);

    runner.pause(job.id);
    await tick();
    let now = runner.get(job.id)!;
    assert.equal(now.state, 'paused');
    assert.equal(now.done, 1);
    assert.equal(now.total, 3);

    runner.resume(job.id);
    await tick();
    assert.deepEqual(seen, ['a', 'b', 'b']);
    g.release.get('b')!();
    await tick();
    g.release.get('c')!();
    await runner.idle();
    now = runner.get(job.id)!;
    assert.equal(now.state, 'done');
    assert.equal(now.done, 3);
    assert.deepEqual(seen, ['a', 'b', 'b', 'c']);
  });

  it('cancelling stops the job and skips what was left', async () => {
    const seen: string[] = [];
    const g = gated(seen);
    const runner = new JobRunner(openDb(':memory:'), { t: g.processor });
    const job = runner.create('t', 'x', {}, items('a', 'b', 'c'));
    await tick();
    runner.cancel(job.id);
    await tick();
    const now = runner.get(job.id)!;
    assert.equal(now.state, 'cancelled');
    assert.equal(now.skipped, 3);
    assert.deepEqual(seen, ['a']);
  });

  it('a JobStop pauses the job with its message and keeps the item waiting', async () => {
    let calls = 0;
    const runner = new JobRunner(openDb(':memory:'), {
      t: {
        async run() {
          calls++;
          if (calls === 1) throw new JobStop('The speech model is missing');
        },
      },
    });
    const job = runner.create('t', 'x', {}, items('a', 'b'));
    await tick(30);
    let now = runner.get(job.id)!;
    assert.equal(now.state, 'paused');
    assert.equal(now.error, 'The speech model is missing');
    assert.equal(now.done, 0);
    runner.resume(job.id);
    await runner.idle();
    now = runner.get(job.id)!;
    assert.equal(now.state, 'done');
    assert.equal(now.error, null);
    assert.equal(now.done, 2);
  });

  it('lets a processor add items while it runs', async () => {
    const seen: string[] = [];
    const runner = new JobRunner(openDb(':memory:'), {
      t: {
        async run(item: ItemSpec, ctx: ProcessorContext) {
          seen.push(item.label);
          if (item.label === 'a') ctx.addItems(items('a-continued'));
        },
      },
    });
    const job = runner.create('t', 'x', {}, items('a', 'b'));
    await runner.idle();
    assert.deepEqual(seen, ['a', 'b', 'a-continued']);
    assert.equal(runner.get(job.id)!.total, 3);
  });

  it('lets a processor look at the next waiting items', async () => {
    let peeked: string[] = [];
    const runner = new JobRunner(openDb(':memory:'), {
      t: {
        async run(item: ItemSpec, ctx: ProcessorContext) {
          if (item.label === 'a') peeked = ctx.peekWaiting(2).map((i) => i.label);
        },
      },
    });
    runner.create('t', 'x', {}, items('a', 'b', 'c', 'd'));
    await runner.idle();
    assert.deepEqual(peeked, ['b', 'c']);
  });

  it('runs one job at a time, oldest first', async () => {
    const seen: string[] = [];
    const runner = new JobRunner(openDb(':memory:'), { t: recorder(seen) });
    runner.create('t', 'one', {}, items('a1', 'a2'));
    runner.create('t', 'two', {}, items('b1'));
    await runner.idle();
    assert.deepEqual(seen, ['a1', 'a2', 'b1']);
  });

  it('treats a job that was running when the app closed as paused', async () => {
    const conn = openDb(':memory:');
    const g = gated([]);
    const first = new JobRunner(conn, { t: g.processor });
    const job = first.create('t', 'x', {}, items('a', 'b'));
    await tick();
    // The app closes here: nothing aborts the item, the state is simply left in the database.
    const second = new JobRunner(conn, { t: recorder([]) });
    second.start();
    const now = second.get(job.id)!;
    assert.equal(now.state, 'paused');
    assert.equal(now.done, 0);
    second.resume(job.id);
    await second.idle();
    assert.equal(second.get(job.id)!.state, 'done');
    assert.equal(second.get(job.id)!.done, 2);
  });

  it('does not remove a running job, but removes a finished one with its items', async () => {
    const g = gated([]);
    const runner = new JobRunner(openDb(':memory:'), { t: g.processor });
    const job = runner.create('t', 'x', {}, items('a'));
    await tick();
    assert.throws(() => runner.remove(job.id), /Pause or cancel/);
    g.release.get('a')!();
    await runner.idle();
    runner.remove(job.id);
    assert.deepEqual(runner.list(), []);
  });

  it('refuses a job of a kind it has no processor for', () => {
    const runner = new JobRunner(openDb(':memory:'), {});
    assert.throws(() => runner.create('nope', 'x', {}, items('a')), /Unknown job kind/);
  });
});

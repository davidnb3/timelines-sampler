import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BIN_DIR, DATA_DIR } from './config.ts';

export type Tool = 'ffmpeg' | 'ffprobe' | 'whisper-cli';

const TOOLS: readonly string[] = ['ffmpeg', 'ffprobe', 'whisper-cli'];
const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

/** Folders the app itself fills when it installs a tool (Windows). Searched before PATH. */
export function managedToolDirs(): string[] {
  return [path.join(DATA_DIR, 'bin', 'ffmpeg'), path.join(DATA_DIR, 'bin', 'whisper')];
}

/**
 * Where a tool lives: an explicit override (`TIMELINES_BIN_FFMPEG`), the bundled folder, a copy the app
 * installed itself, or else the bare name so the system PATH decides (Homebrew on a Mac).
 */
export function toolPath(name: Tool): string {
  const override = process.env[`TIMELINES_BIN_${name.toUpperCase().replace(/-/g, '_')}`];
  if (override) return override;
  for (const dir of [BIN_DIR, ...managedToolDirs()]) {
    if (!dir) continue;
    const candidate = path.join(dir, exe(name));
    if (fs.existsSync(candidate)) return candidate;
  }
  return name;
}

/** The full path of a tool when it can be found, null when it is not installed. */
export function findTool(name: Tool): string | null {
  const resolved = toolPath(name);
  if (path.isAbsolute(resolved)) return fs.existsSync(resolved) ? resolved : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe(resolved));
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export interface RunOptions {
  quiet?: boolean;
  /** Aborting kills the process and rejects with an error whose `name` is "AbortError". */
  signal?: AbortSignal;
}

/** Runs a program and returns what it wrote to stdout. `ffmpeg`, `ffprobe` and `whisper-cli` are looked up with `toolPath`. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(abortError());
    const child = spawn(TOOLS.includes(cmd) ? toolPath(cmd as Tool) : cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new Error(`${cmd} failed to start: ${e.message}`));
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(abortError());
      if (code === 0) return resolve(out);
      reject(new Error(`${cmd} exited with ${code}${opts.quiet ? '' : `: ${err.slice(-600)}`}`));
    });
  });
}

export function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

export const isAbort = (err: unknown): boolean => err instanceof Error && err.name === 'AbortError';

/** Which whisper build the app installed itself: "cuda" (graphics card) or "cpu"; null when it did not install one. */
export function engineVariant(): 'cuda' | 'cpu' | null {
  try {
    const v = fs.readFileSync(path.join(DATA_DIR, 'bin', 'whisper', 'variant'), 'utf8').trim();
    return v === 'cuda' || v === 'cpu' ? v : null;
  } catch {
    return null;
  }
}

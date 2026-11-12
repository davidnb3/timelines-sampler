import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, USER_AGENT } from './config.ts';
import { downloadTo } from './download.ts';
import { engineVariant, findTool, run } from './exec.ts';
import { isInstalled, MODELS, modelAvailable, modelFile, modelUrl, selectedModel } from './models.ts';
import { readSettings, updateSettings } from './settings.ts';

/**
 * The programs and the speech model transcription needs. On Windows the app downloads them itself
 * (ffmpeg, the whisper.cpp engine, a model); on a Mac or Linux the first two come from the package
 * manager, and the app says which command to run.
 */

export type ToolId = 'ffmpeg' | 'whisper' | 'model';

export interface InstallState {
  state: 'installing' | 'error';
  done: number;
  total: number;
  error?: string;
}

export interface SetupTool {
  id: ToolId;
  label: string;
  ok: boolean;
  detail: string;
  /** The app can install it by itself. */
  installable: boolean;
  /** What to run by hand when the app cannot install it. */
  hint: string | null;
  install: InstallState | null;
}

export interface SetupStatus {
  platform: string;
  ready: boolean;
  tools: SetupTool[];
  models: { id: string; label: string; note: string; sizeMb: number; installed: boolean; selected: boolean }[];
  nvidia: boolean;
  engine: 'cuda' | 'cpu' | null;
  /** Seconds of audio transcribed per second of work on this computer, from earlier imports; null before the first. */
  speed: number | null;
}

const installs = new Map<ToolId, InstallState>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
export function onSetupChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const WIN = process.platform === 'win32';
let nvidia = false;
if (process.platform === 'win32' || process.platform === 'linux') {
  run('nvidia-smi', ['-L'], { quiet: true }).then(
    () => {
      nvidia = true;
      emit();
    },
    () => undefined,
  );
}

/** Picks the Windows download of the whisper.cpp engine out of a release's file names; null when it has none. */
export function pickWhisperAsset(names: string[], variant: 'cuda' | 'cpu'): string | null {
  if (variant === 'cpu') return names.find((n) => /^whisper-bin-x64\.zip$/i.test(n)) ?? null;
  const cuda = names.filter((n) => /^whisper-bin-win-cuda-[\d.]+-x64\.zip$/i.test(n) || /^whisper-cublas-[\d.]+-bin-x64\.zip$/i.test(n));
  // Prefer the newest CUDA 12 build, then any other.
  const version = (n: string) => Number(/([\d]+\.[\d]+)/.exec(n)?.[1] ?? 0);
  const twelve = cuda.filter((n) => version(n) >= 12 && version(n) < 13).sort((a, b) => version(b) - version(a));
  return twelve[0] ?? cuda.sort((a, b) => version(b) - version(a))[0] ?? null;
}

const hintFor = (id: 'ffmpeg' | 'whisper'): string | null => {
  if (WIN) return null;
  if (process.platform === 'darwin') return id === 'ffmpeg' ? 'brew install ffmpeg' : 'brew install whisper-cpp';
  return id === 'ffmpeg' ? 'sudo apt install ffmpeg' : 'Build whisper.cpp (https://github.com/ggml-org/whisper.cpp) and put whisper-cli on the PATH';
};

export function setupStatus(): SetupStatus {
  const ffmpeg = findTool('ffmpeg');
  const ffprobe = findTool('ffprobe');
  const whisper = findTool('whisper-cli');
  const model = modelAvailable();
  const tool = (id: ToolId, label: string, ok: boolean, detail: string, installable: boolean, hint: string | null): SetupTool => ({
    id, label, ok, detail, installable: installable && !ok, hint: ok ? null : hint, install: installs.get(id) ?? null,
  });
  const tools = [
    tool('ffmpeg', 'ffmpeg (reads and cuts audio)', Boolean(ffmpeg && ffprobe), ffmpeg && ffprobe ? ffmpeg : 'Not installed', WIN, hintFor('ffmpeg')),
    tool('whisper', 'Speech engine (whisper.cpp)', Boolean(whisper), whisper ? `${whisper}${engineVariant() === 'cuda' ? ' (graphics card build)' : ''}` : 'Not installed', WIN, hintFor('whisper')),
    tool('model', 'Speech model', model, model ? selectedModel().label : 'No model downloaded', true, null),
  ];
  return {
    platform: process.platform,
    ready: tools.every((t) => t.ok),
    tools,
    models: MODELS.map((m) => ({ id: m.id, label: m.label, note: m.note, sizeMb: m.sizeMb, installed: isInstalled(m), selected: selectedModel().id === m.id })),
    nvidia,
    engine: engineVariant(),
    speed: readSettings().transcribeSpeed ?? null,
  };
}

/** Why transcription cannot run right now, in a sentence for the user; null when everything needed is there. */
export function transcriptionBlocker(): string | null {
  const s = setupStatus();
  const missing = s.tools.filter((t) => !t.ok);
  if (!missing.length) return null;
  return `Transcription is not set up yet (${missing.map((t) => t.label.split(' (')[0]).join(', ')} missing). Open "Add sources" and install it.`;
}

function set(id: ToolId, state: InstallState | null): void {
  if (state) installs.set(id, state);
  else installs.delete(id);
  emit();
}

/** Starts installing one piece in the background; progress shows up in `setupStatus`. */
export function startInstall(id: ToolId, opts: { model?: string } = {}): void {
  if (installs.get(id)?.state === 'installing') return;
  if ((id === 'ffmpeg' || id === 'whisper') && !WIN) throw new Error(`Install it with: ${hintFor(id)}`);
  set(id, { state: 'installing', done: 0, total: 0 });
  const progress = (done: number, total: number) => set(id, { state: 'installing', done, total });
  void (async () => {
    try {
      if (id === 'model') await installModel(opts.model, progress);
      else if (id === 'ffmpeg') await installFfmpeg(progress);
      else await installWhisper(progress);
      set(id, null);
    } catch (err) {
      set(id, { state: 'error', done: 0, total: 0, error: err instanceof Error ? err.message : String(err) });
    }
  })();
}

async function installModel(wanted: string | undefined, progress: (d: number, t: number) => void): Promise<void> {
  const m = MODELS.find((x) => x.id === wanted) ?? selectedModel();
  fs.mkdirSync(path.dirname(modelFile(m)), { recursive: true });
  if (!isInstalled(m)) await downloadTo(modelUrl(m), modelFile(m), { onProgress: progress });
  updateSettings({ whisperModel: m.id });
}

/** Finds a file by name anywhere under `dir`. */
function findFile(dir: string, name: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name) return full;
  }
  return null;
}

/** Downloads a zip, unpacks it with the `tar` that ships with Windows 10 and later, and copies the folder holding `marker` into `dest`. */
async function installZip(url: string, marker: string, dest: string, progress: (d: number, t: number) => void, wanted: string[] | null): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'timelines-setup-'));
  try {
    const zip = path.join(tmp, 'download.zip');
    await downloadTo(url, zip, { onProgress: progress });
    const out = path.join(tmp, 'unpacked');
    fs.mkdirSync(out);
    await run('tar', ['-xf', zip, '-C', out]);
    const found = findFile(out, marker);
    if (!found) throw new Error(`The download did not contain ${marker}`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const from = path.dirname(found);
    for (const f of fs.readdirSync(from)) {
      if (wanted && !wanted.includes(f.toLowerCase())) continue;
      if (fs.statSync(path.join(from, f)).isFile()) fs.copyFileSync(path.join(from, f), path.join(dest, f));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function installFfmpeg(progress: (d: number, t: number) => void): Promise<void> {
  await installZip(
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    'ffmpeg.exe',
    path.join(DATA_DIR, 'bin', 'ffmpeg'),
    progress,
    ['ffmpeg.exe', 'ffprobe.exe'],
  );
}

async function installWhisper(progress: (d: number, t: number) => void): Promise<void> {
  const variant = nvidia ? 'cuda' : 'cpu';
  const res = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20', { headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Could not read the whisper.cpp releases: HTTP ${res.status}`);
  const releases = (await res.json()) as { assets: { name: string; browser_download_url: string }[] }[];
  for (const wanted of nvidia ? (['cuda', 'cpu'] as const) : (['cpu'] as const)) {
    for (const r of releases) {
      const name = pickWhisperAsset(r.assets.map((a) => a.name), wanted);
      if (!name) continue;
      const dest = path.join(DATA_DIR, 'bin', 'whisper');
      await installZip(r.assets.find((a) => a.name === name)!.browser_download_url, 'whisper-cli.exe', dest, progress, null);
      fs.writeFileSync(path.join(dest, 'variant'), wanted);
      return;
    }
  }
  throw new Error(`No Windows ${variant} build of whisper.cpp was found in the recent releases`);
}

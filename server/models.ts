import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';
import { readSettings } from './settings.ts';

export interface ModelInfo {
  id: string;
  file: string;
  label: string;
  note: string;
  sizeMb: number;
}

/** Whisper models the app can download from the whisper.cpp collection on Hugging Face, best quality first. */
export const MODELS: readonly ModelInfo[] = [
  { id: 'large-v3-turbo-q5_0', file: 'ggml-large-v3-turbo-q5_0.bin', label: 'Best', note: 'Most accurate. Needs a fast computer for long recordings.', sizeMb: 574 },
  { id: 'small.en-q5_1', file: 'ggml-small.en-q5_1.bin', label: 'Balanced', note: 'Good accuracy, English only, much faster.', sizeMb: 190 },
  { id: 'base.en-q5_1', file: 'ggml-base.en-q5_1.bin', label: 'Fast', note: 'Quickest and smallest; more mistakes.', sizeMb: 60 },
];

export const modelUrl = (m: ModelInfo) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${m.file}`;

const MIN_BYTES = 1_000_000;

export function modelFile(m: ModelInfo): string {
  return path.join(DATA_DIR, 'models', m.file);
}

export function isInstalled(m: ModelInfo): boolean {
  const f = modelFile(m);
  return fs.existsSync(f) && fs.statSync(f).size > MIN_BYTES;
}

/** The model transcription uses: the chosen one, else the best installed, else the default. */
export function selectedModel(): ModelInfo {
  const chosen = MODELS.find((m) => m.id === readSettings().whisperModel);
  if (chosen && isInstalled(chosen)) return chosen;
  return MODELS.find(isInstalled) ?? chosen ?? MODELS[0]!;
}

/** `TIMELINES_WHISPER_MODEL` points at any model file and wins over the settings. */
export function modelPath(): string {
  return process.env.TIMELINES_WHISPER_MODEL ?? modelFile(selectedModel());
}

export function modelAvailable(): boolean {
  const f = modelPath();
  return fs.existsSync(f) && fs.statSync(f).size > MIN_BYTES;
}

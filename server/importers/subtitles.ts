import type { SegmentInput } from '../db.ts';

/** `00:01:02,500`, `01:02.500` and `1:02.5` all mean the same kind of time stamp; returns milliseconds or null. */
function parseTime(text: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(text.trim());
  if (!m) return null;
  const ms = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + ms;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

function cleanText(lines: string[]): string {
  return lines
    .join(' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reads SRT or WebVTT subtitles into timed text, one segment per cue. Cues that are empty or only sound tags are dropped. */
export function parseSubtitles(source: string): SegmentInput[] {
  const blocks = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const out: SegmentInput[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at]!.split('-->').map((s) => s.trim().split(/\s+/)[0]!);
    const startMs = parseTime(from ?? '');
    const endMs = parseTime(to ?? '');
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const text = cleanText(lines.slice(at + 1));
    if (!text || /^[[(♪].*[\])♪]$/.test(text)) continue;
    out.push({ startMs, endMs, text });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

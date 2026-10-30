import type { DragEvent } from 'react';
import { clipUrl, type Hit } from './api.ts';
import { formatTime } from './format.ts';

/** A file name safe for DownloadURL, which uses ":" as its separator. */
function fileName(hit: Hit): string {
  const base = `${hit.show} ${formatTime(hit.startMs).replace(':', '.')}`.replace(/[^\w .-]+/g, '').trim();
  return base.slice(0, 60) || 'clip';
}

/**
 * Starts dragging a clip out of the page as a WAV file. Chromium browsers turn the `DownloadURL`
 * type into a real file when it is dropped on Finder or the desktop, and apps that accept file
 * drops (DAWs among them) take it from there. Other browsers fall back to a link.
 */
export function startClipDrag(e: DragEvent, hit: Hit): void {
  const url = new URL(clipUrl(hit, 'wav', true), window.location.origin).href;
  const data = e.dataTransfer;
  data.effectAllowed = 'copy';
  data.setData('DownloadURL', `audio/wav:${fileName(hit)}.wav:${url}`);
  data.setData('text/uri-list', url);
  data.setData('text/plain', url);

  // A small label to carry under the pointer instead of a snapshot of the whole card.
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.textContent = `${hit.show} · ${((hit.endMs - hit.startMs) / 1000).toFixed(1)} s`;
  document.body.append(ghost);
  data.setDragImage(ghost, 16, 16);
  window.setTimeout(() => ghost.remove(), 0);
}

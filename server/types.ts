/** One search hit as the web UI sees it, whatever source it came from. */
export interface Hit {
  id: string;
  source: 'library' | 'tv';
  kind: 'audio' | 'video';
  /** Show or podcast name. */
  show: string;
  /** Episode or program title. */
  title: string;
  /** When it was recorded or aired (ISO date), if known. */
  date: string | null;
  /** Clip bounds inside the source media, in milliseconds. */
  startMs: number;
  endMs: number;
  text: string;
  /** Opaque reference the clip endpoint resolves, e.g. `ep:12`. TV hits carry `ia:<id>`, which cannot be cut. */
  ref: string;
  /** Segment index inside the episode (library hits only), used to expand context. */
  episodeId?: number;
  firstIdx?: number;
  lastIdx?: number;
  pageUrl: string | null;
  thumbUrl?: string | null;
  /**
   * Internet Archive player URL for TV clips. The archive streams TV news but refuses downloads
   * (its media files answer 401), so these hits can be watched but not cut or saved.
   */
  embedUrl?: string | null;
  /** Fade in and out of the clip, in ms, set by the editor; absent means none. */
  fadeInMs?: number;
  fadeOutMs?: number;
  topics: string[];
}

export interface SearchResponse {
  source: Hit['source'];
  query: string;
  terms: string[];
  hits: Hit[];
  ms: number;
}

export interface TopicCount {
  topic: string;
  episodes: number;
}

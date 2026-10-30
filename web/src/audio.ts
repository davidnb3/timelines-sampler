/**
 * Web Audio playback shared by the clip editor and the story player. Unlike an <audio> element it
 * plays an exact span of a decoded buffer (sample-accurate edges, loops) and only one sound plays
 * at a time: starting a voice stops whichever one was playing.
 */

let context: AudioContext | null = null;

export function audioContext(): AudioContext {
  context ??= new AudioContext();
  return context;
}

/** Fetches and decodes audio. Rejects with the server's message when the request fails. */
export async function decodeUrl(url: string, signal?: AbortSignal): Promise<AudioBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return audioContext().decodeAudioData(await res.arrayBuffer());
}

export type EndReason = 'ended' | 'stopped' | 'stolen';

export interface VoiceOptions {
  buffer: AudioBuffer;
  /** Span to play, in seconds from the start of the buffer. */
  from: number;
  to: number;
  loop: boolean;
  /** Fades at the start and end of the span, in seconds. */
  fadeIn?: number;
  fadeOut?: number;
  onEnd: (reason: EndReason) => void;
}

/** Same floor as the export's declick (server/fade.ts), so what you hear is what you save. */
const DECLICK_S = 0.005;

let current: Voice | null = null;

export class Voice {
  readonly buffer: AudioBuffer;
  readonly from: number;
  readonly to: number;
  readonly loop: boolean;
  private fadeIn: number;
  private fadeOut: number;
  private gain: GainNode | null = null;
  /** A second gain in series that ramps over a few ms at every start and stop, so neither clicks. */
  private soft: GainNode | null = null;
  private fadeTimer = 0;
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private offset = 0;
  private onEnd: (reason: EndReason) => void;

  constructor(o: VoiceOptions) {
    this.buffer = o.buffer;
    this.from = o.from;
    this.to = o.to;
    this.loop = o.loop;
    this.fadeIn = Math.max(o.fadeIn ?? 0, DECLICK_S);
    this.fadeOut = Math.max(o.fadeOut ?? 0, DECLICK_S);
    this.onEnd = o.onEnd;
  }

  /** Starts playing at `at` seconds (default: the start of the span). */
  async start(at = this.from): Promise<void> {
    const ctx = audioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    if (current && current !== this) current.stop('stolen');
    current = this;
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    const gain = ctx.createGain();
    const soft = ctx.createGain();
    source.connect(gain);
    gain.connect(soft);
    soft.connect(ctx.destination);
    this.gain = gain;
    this.soft = soft;
    this.offset = Math.min(this.to, Math.max(this.from, at));
    const t0 = ctx.currentTime;
    soft.gain.setValueAtTime(0, t0);
    soft.gain.linearRampToValueAtTime(1, t0 + DECLICK_S);
    if (this.loop) {
      source.loop = true;
      source.loopStart = this.from;
      source.loopEnd = this.to;
      source.start(t0, this.offset);
    } else {
      source.start(t0, this.offset, Math.max(0.001, this.to - this.offset));
    }
    this.scheduleFades(ctx, t0);
    source.onended = () => {
      if (this.source !== source) return; // replaced or already stopped
      this.source = null;
      this.clearFades();
      if (current === this) current = null;
      this.onEnd('ended');
    };
    this.source = source;
    this.startedAt = ctx.currentTime;
  }

  /**
   * Automates the gain for the fades. Each pass over the span ramps up from the start and down
   * toward the end; a loop schedules its passes a couple of seconds ahead on a timer.
   */
  private scheduleFades(ctx: AudioContext, t0: number): void {
    const span = this.to - this.from;
    const fadeIn = Math.min(this.fadeIn, span);
    const fadeOut = Math.min(this.fadeOut, Math.max(0, span - fadeIn));
    if (!this.gain || (fadeIn <= 0 && fadeOut <= 0)) return;
    const param = this.gain.gain;
    const gainAt = (p: number) => (fadeIn > 0 && p < fadeIn ? p / fadeIn : fadeOut > 0 && p > span - fadeOut ? (span - p) / fadeOut : 1);
    const pass = (t: number, pos: number) => {
      param.setValueAtTime(gainAt(pos), t);
      if (pos < fadeIn) param.linearRampToValueAtTime(1, t + (fadeIn - pos));
      if (fadeOut > 0) {
        if (pos < span - fadeOut) param.setValueAtTime(1, t + (span - fadeOut - pos));
        param.linearRampToValueAtTime(0, t + (span - pos));
      }
    };
    const first = this.offset - this.from;
    pass(t0, first);
    if (!this.loop) return;
    let next = t0 + (span - first);
    const topUp = () => {
      while (next < ctx.currentTime + 2) {
        pass(next, 0);
        next += span;
      }
    };
    topUp();
    this.fadeTimer = window.setInterval(topUp, 400);
  }

  private clearFades(): void {
    if (this.fadeTimer) window.clearInterval(this.fadeTimer);
    this.fadeTimer = 0;
  }

  /** Where playback is, in seconds from the start of the buffer. */
  position(): number {
    if (!this.source) return this.offset;
    const elapsed = audioContext().currentTime - this.startedAt;
    if (!this.loop) return Math.min(this.to, this.offset + elapsed);
    const span = this.to - this.from;
    return this.from + ((this.offset - this.from + elapsed) % span);
  }

  get playing(): boolean {
    return this.source !== null;
  }

  stop(reason: EndReason = 'stopped'): void {
    const source = this.source;
    if (!source) return;
    this.offset = this.position();
    this.source = null;
    this.clearFades();
    source.onended = null;
    // Ramp down over a few ms instead of cutting off, then let go of the nodes.
    const ctx = audioContext();
    const t = ctx.currentTime;
    const soft = this.soft;
    const gain = this.gain;
    if (soft) {
      soft.gain.cancelScheduledValues(t);
      soft.gain.setValueAtTime(soft.gain.value, t);
      soft.gain.linearRampToValueAtTime(0, t + DECLICK_S);
    }
    try {
      source.stop(t + DECLICK_S + 0.002);
    } catch {
      // Already stopped.
    }
    window.setTimeout(() => {
      source.disconnect();
      gain?.disconnect();
      soft?.disconnect();
    }, 60);
    if (current === this) current = null;
    this.onEnd(reason);
  }
}

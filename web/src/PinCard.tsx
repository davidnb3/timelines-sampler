import { clipUrl, type Hit } from './api.ts';
import { formatDate, formatTime } from './format.ts';
import { Close, Download, External, Pause, Play, Star } from './icons.tsx';
import { Quote } from './ResultCard.tsx';
import type { Theme } from './theme.ts';
import type { Player } from './usePlayer.ts';
import { Waveform } from './Waveform.tsx';

interface Props {
  hit: Hit;
  no: string;
  player: Player;
  theme: Theme;
  embedOpen: boolean;
  onPlay: () => void;
  onRemove: () => void;
  onClose: () => void;
}

/** A clip pinned on the timeline, shown in the popover that opens from its node. */
export function PinCard({ hit, no, player, theme, embedOpen, onPlay, onRemove, onClose }: Props) {
  const isTv = hit.source === 'tv';
  const isActive = isTv ? embedOpen : player.active?.id === hit.id;
  const isPlaying = isTv ? embedOpen : isActive && player.playing;
  const date = formatDate(hit.date);

  return (
    <div className="pin">
      <header className="pin-head">
        <span className="pin-no">{no}</span>
        <span className="pin-show">{hit.show}</span>
        <button type="button" className="pin-x pin-unstar" onClick={onRemove} aria-label="Remove from timeline" title="Remove from timeline"><Star size={14} filled /></button>
        <button type="button" className="pin-x" onClick={onClose} aria-label="Close"><Close size={13} /></button>
      </header>
      <p className="pin-meta">
        {hit.title !== hit.show && <span>{hit.title}</span>}
        <span>{date ?? 'undated'} · {formatTime(hit.startMs)}</span>
      </p>

      {isTv && embedOpen && hit.embedUrl ? (
        <iframe className="card-embed" src={hit.embedUrl} title={`${hit.title} (Internet Archive player)`} allow="fullscreen" />
      ) : (
        <Quote text={hit.text} terms={[]} small />
      )}

      {!isTv && isActive && <Waveform peaks={player.peaks} progress={player.progress} loading={player.loading} theme={theme} height={44} onSeek={player.seek} />}

      <footer className="pin-foot">
        <button type="button" className={`act act-primary${isPlaying ? ' is-playing' : ''}`} onClick={onPlay}>
          {isPlaying ? <Pause /> : <Play />}
          {isTv ? (embedOpen ? 'Close' : 'Watch') : isActive && player.loading ? 'Loading' : isPlaying ? 'Pause' : 'Play'}
        </button>
        {!isTv && (
          <>
            <a className="act" href={clipUrl(hit, 'wav', true)} download><Download size={13} />wav</a>
            <a className="act" href={clipUrl(hit, 'mp3', true)} download><Download size={13} />mp3</a>
          </>
        )}
        {hit.pageUrl && <a className="act act-quiet" href={hit.pageUrl} target="_blank" rel="noreferrer">Source<External /></a>}
      </footer>
    </div>
  );
}

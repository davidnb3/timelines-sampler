import { clipUrl, type Hit } from './api.ts';
import { formatDate, formatTime } from './format.ts';
import { ClipEditor } from './ClipEditor.tsx';
import { startClipDrag } from './dragClip.ts';
import { Close, Download, External, Grip, Pause, Play, Star } from './icons.tsx';
import { Quote } from './ResultCard.tsx';
import type { Theme } from './theme.ts';
import type { Player } from './usePlayer.ts';

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

      {!isTv && isActive && player.win && player.region && (
        <div className="pin-wave">
          <ClipEditor win={player.win} region={player.region} fades={player.fades} playing={player.playing} theme={theme} position={player.position} editable={false} height={76} onSeek={player.seek} />
        </div>
      )}

      <footer className="pin-foot">
        <button type="button" className={`act act-primary${isPlaying ? ' is-playing' : ''}`} onClick={onPlay}>
          {isPlaying ? <Pause /> : <Play />}
          {isTv ? (embedOpen ? 'Close' : 'Watch') : isActive && player.loading ? 'Loading' : isPlaying ? 'Pause' : 'Play'}
        </button>
        {!isTv && (
          <>
            <span className="act act-drag" draggable role="button" tabIndex={0} onDragStart={(e) => startClipDrag(e, hit)} title="Drag this clip into your DAW or a Finder window (WAV)"><Grip size={13} />Drag</span>
            <a className="act" href={clipUrl(hit, 'wav', true)} download><Download size={13} />wav</a>
            <a className="act" href={clipUrl(hit, 'mp3', true)} download><Download size={13} />mp3</a>
          </>
        )}
        {hit.pageUrl && <a className="act act-quiet" href={hit.pageUrl} target="_blank" rel="noreferrer">Source<External /></a>}
      </footer>
    </div>
  );
}

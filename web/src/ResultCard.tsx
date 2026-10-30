import type { CSSProperties } from 'react';
import { clipUrl, type Hit } from './api.ts';
import { formatDate, formatTime, highlightParts } from './format.ts';
import { ClipEditor } from './ClipEditor.tsx';
import { startClipDrag } from './dragClip.ts';
import { Download, External, Grip, Loop, Pause, Play, Plus, Star } from './icons.tsx';
import type { Theme } from './theme.ts';
import type { Player } from './usePlayer.ts';
import type { Fade, Region } from './trim.ts';

interface Props {
  hit: Hit;
  terms: string[];
  index: number;
  selected: boolean;
  player: Player;
  theme: Theme;
  /** TV clips play in the Internet Archive's own embedded player. */
  embedOpen: boolean;
  expanding: boolean;
  pinned: boolean;
  onSelect: () => void;
  onPlay: () => void;
  onExpand: () => void;
  /** The region or its fades were changed on the waveform and let go. */
  onTrim: (region: Region, fades: Fade) => void;
  /** Adds the clip to the timeline; `from` is where the flying dot starts. */
  onPin: (from: HTMLElement) => void;
  onUnpin: () => void;
}

export function Quote({ text, terms, small = false }: { text: string; terms: string[]; small?: boolean }) {
  if (!text) return <blockquote className={small ? 'quote quote-small' : 'quote'}><span className="quote-empty">No transcribed speech in this selection</span></blockquote>;
  return (
    <blockquote className={small ? 'quote quote-small' : 'quote'}>
      <span className="quote-mark" aria-hidden>“</span>
      {highlightParts(text, terms).map((p, i) =>
        p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
      )}
      <span className="quote-mark" aria-hidden>”</span>
    </blockquote>
  );
}

export function ResultCard({
  hit, terms, index, selected, player, theme, embedOpen, expanding, pinned, onSelect, onPlay, onExpand, onTrim, onPin, onUnpin,
}: Props) {
  const isTv = hit.source === 'tv';
  const isActive = isTv ? embedOpen : player.active?.id === hit.id;
  const isPlaying = isTv ? embedOpen : isActive && player.playing;
  const date = formatDate(hit.date);
  const clipLength = Math.round((hit.endMs - hit.startMs) / 1000);
  const playLabel = isTv ? (embedOpen ? 'Close' : 'Watch') : isActive && player.loading ? 'Loading' : isPlaying ? 'Pause' : 'Play';

  return (
    <article
      className={`card card-${hit.source}${selected ? ' is-selected' : ''}${isActive ? ' is-active' : ''}`}
      data-result-id={hit.id}
      style={{ '--i': Math.min(index, 9) } as CSSProperties}
      onClick={onSelect}
    >
      <header className="card-head">
        <span className="card-no">{String(index + 1).padStart(2, '0')}</span>
        <span className="card-show" title={hit.title}>{hit.show}</span>
        {hit.title !== hit.show && <span className="card-title">{hit.title}</span>}
        <span className="card-when">
          {date && <span>{date}</span>}
          <span className="card-stamp" title="Position in the source">{formatTime(hit.startMs)}</span>
        </span>
      </header>

      {isTv && embedOpen && hit.embedUrl ? (
        <iframe className="card-embed" src={hit.embedUrl} title={`${hit.title} (Internet Archive player)`} allow="fullscreen" />
      ) : (
        <div className="card-body">
          {isTv && hit.thumbUrl && <img className="card-thumb" src={hit.thumbUrl} alt="" loading="lazy" />}
          <Quote text={hit.text} terms={terms} />
        </div>
      )}
      {isTv && embedOpen && <Quote text={hit.text} terms={terms} small />}

      {!isTv && isActive && player.win && player.region && (
        <div className="card-wave">
          <ClipEditor
            win={player.win}
            region={player.region}
            fades={player.fades}
            playing={player.playing}
            theme={theme}
            position={player.position}
            height={108}
            onChange={(edit, commit) => {
              player.setEdit(edit, commit);
              if (commit) onTrim(edit.region, edit.fades);
            }}
            onSeek={player.seek}
          />
        </div>
      )}
      {!isTv && isActive && player.loading && !player.win && <div className="card-wave card-wave-skel" aria-hidden />}

      <footer className="card-foot">
        <span className="card-prov">
          {isTv ? 'tv captions · stream only' : `library · ${clipLength}s`}
          {hit.topics.length > 0 && ` · ${hit.topics.join(', ')}`}
        </span>
        <span className="card-actions">
          <button
            type="button"
            className={`act act-primary${isPlaying ? ' is-playing' : ''}`}
            onClick={(e) => { e.stopPropagation(); onPlay(); }}
            aria-label={`${playLabel} result ${index + 1}`}
          >
            {isPlaying ? <Pause /> : <Play />}
            {playLabel}
          </button>
          <button
            type="button"
            className={`act act-star${pinned ? ' is-pinned' : ''}`}
            data-pin
            aria-pressed={pinned}
            aria-label={pinned ? 'Remove from timeline' : 'Add to timeline'}
            title={pinned ? 'On your timeline. Click to remove (s)' : 'Add to timeline (s)'}
            onClick={(e) => { e.stopPropagation(); if (pinned) onUnpin(); else onPin(e.currentTarget); }}
          >
            <Star filled={pinned} size={15} />
            <span className="star-burst" aria-hidden />
          </button>
          {!isTv && (
            <>
              {isActive && player.win && (
                <button
                  type="button"
                  className={`act act-icon${player.loop ? ' is-on' : ''}`}
                  aria-pressed={player.loop}
                  onClick={(e) => { e.stopPropagation(); player.setLoop(!player.loop); }}
                  title="Loop the selection (r)"
                  aria-label="Loop"
                >
                  <Loop size={14} />
                </button>
              )}
              <button
                type="button"
                className="act"
                disabled={expanding}
                onClick={(e) => { e.stopPropagation(); onExpand(); }}
                title="Add the surrounding lines to this clip (e)"
              >
                <Plus size={13} />
                {expanding ? 'Adding' : 'Context'}
              </button>
              <span
                className="act act-drag"
                draggable
                role="button"
                tabIndex={0}
                onDragStart={(e) => startClipDrag(e, hit)}
                onClick={(e) => e.stopPropagation()}
                title="Drag this clip into your DAW or a Finder window (WAV)"
              >
                <Grip size={13} />Drag
              </span>
              <a
                className="act"
                href={clipUrl(hit, 'wav', true)}
                download
                onClick={(e) => { e.stopPropagation(); if (!pinned) onPin(e.currentTarget); }}
                title="Save as WAV, and add to the timeline (d)"
              >
                <Download size={13} />wav
              </a>
              <a
                className="act"
                href={clipUrl(hit, 'mp3', true)}
                download
                onClick={(e) => { e.stopPropagation(); if (!pinned) onPin(e.currentTarget); }}
                title="Save as MP3, and add to the timeline"
              >
                <Download size={13} />mp3
              </a>
            </>
          )}
          {hit.pageUrl && (
            <a className="act act-quiet" href={hit.pageUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              Source<External />
            </a>
          )}
        </span>
      </footer>
      {!isTv && isActive && player.error && <p className="card-error" role="alert">Could not load clip: {player.error}</p>}
    </article>
  );
}

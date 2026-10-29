import { clipUrl, type Hit } from './api.ts';
import { formatDate, formatTime, highlightParts } from './format.ts';
import type { Player } from './usePlayer.ts';

interface Props {
  hit: Hit;
  terms: string[];
  index: number;
  selected: boolean;
  player: Player;
  /** TV clips play in the Internet Archive's own embedded player. */
  embedOpen: boolean;
  expanding: boolean;
  onSelect: () => void;
  onPlay: () => void;
  onExpand: () => void;
}

function Quote({ text, terms, small = false }: { text: string; terms: string[]; small?: boolean }) {
  return (
    <blockquote className={small ? 'quote quote-small' : 'quote'}>
      “
      {highlightParts(text, terms).map((p, i) =>
        p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
      )}
      ”
    </blockquote>
  );
}

export function ResultCard({ hit, terms, index, selected, player, embedOpen, expanding, onSelect, onPlay, onExpand }: Props) {
  const isTv = hit.source === 'tv';
  const isActive = isTv ? embedOpen : player.active?.id === hit.id;
  const isPlaying = isTv ? embedOpen : isActive && player.playing;
  const date = formatDate(hit.date);
  const clipLength = Math.round((hit.endMs - hit.startMs) / 1000);

  const playLabel = isTv
    ? embedOpen ? '✕ close' : '▶ watch'
    : isActive && player.loading ? 'loading…' : isPlaying ? '❚❚ pause' : '▶ play';

  return (
    <article
      className={`result result-${hit.source}${selected ? ' is-selected' : ''}${isActive ? ' is-active' : ''}`}
      data-result-id={hit.id}
      onClick={onSelect}
    >
      <header className="result-head">
        <span className="badge" title={hit.title}>{hit.show}</span>
        <span className="stamp" title="Position in the source">[ {formatTime(hit.startMs)} ]</span>
        <span className="result-meta">
          {hit.title !== hit.show && <span className="result-title">{hit.title}</span>}
          {date && <span>{date}</span>}
        </span>
      </header>

      {isTv && embedOpen && hit.embedUrl ? (
        <iframe
          className="result-embed"
          src={hit.embedUrl}
          title={`${hit.title} (Internet Archive player)`}
          allow="fullscreen"
        />
      ) : (
        <div className="result-body">
          {isTv && hit.thumbUrl && <img className="result-thumb" src={hit.thumbUrl} alt="" loading="lazy" />}
          <Quote text={hit.text} terms={terms} />
        </div>
      )}
      {isTv && embedOpen && <Quote text={hit.text} terms={terms} small />}

      <footer className="result-foot">
        <span className="provenance">
          {isTv ? 'tv captions · stream only' : `library · ${clipLength}s clip`}
          {hit.topics.length > 0 && ` · ${hit.topics.join(', ')}`}
        </span>
        <span className="actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={(e) => { e.stopPropagation(); onPlay(); }}
            aria-label={`${playLabel.replace(/^\S+ /, '')} result ${index + 1}`}
          >
            {playLabel}
          </button>
          {!isTv && (
            <>
              <button
                type="button"
                className="btn"
                disabled={expanding}
                onClick={(e) => { e.stopPropagation(); onExpand(); }}
                title="Add the surrounding lines to this clip (e)"
              >
                {expanding ? '…' : '+ context'}
              </button>
              <a className="btn" href={clipUrl(hit, 'wav', true)} download onClick={(e) => e.stopPropagation()} title="Save this clip as WAV (d)">
                ⤓ wav
              </a>
              <a className="btn" href={clipUrl(hit, 'mp3', true)} download onClick={(e) => e.stopPropagation()} title="Save this clip as MP3">
                ⤓ mp3
              </a>
            </>
          )}
          {hit.pageUrl && (
            <a className="btn btn-link" href={hit.pageUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              view source →
            </a>
          )}
        </span>
      </footer>
      {!isTv && isActive && player.error && <p className="result-error" role="alert">Could not load clip: {player.error}</p>}
    </article>
  );
}

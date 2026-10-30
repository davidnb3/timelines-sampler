import { useEffect, useRef, useState } from 'react';
import { Chevron, Copy, Pencil, Plus, Trash } from '../icons.tsx';
import type { TimelineInfo } from './timelinesApi.ts';

interface Props {
  timelines: TimelineInfo[];
  activeId: number | null;
  onSwitch: (id: number) => void;
  /** Creates a timeline and opens it; resolves to its id and name. */
  onCreate: () => Promise<{ id: number; name: string } | null>;
  onRename: (id: number, name: string) => void;
  onDuplicate: (id: number) => void;
  onDelete: (id: number) => void;
}

/**
 * The timeline's name in the dock, and the menu that opens from it: switch between saved timelines
 * (each one is a story), start a new one, rename, duplicate or delete.
 */
export function TimelineSwitcher({ timelines, activeId, onSwitch, onCreate, onRename, onDuplicate, onDelete }: Props) {
  const root = useRef<HTMLSpanElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState<number | null>(null);
  const current = timelines.find((t) => t.id === activeId);

  const close = () => {
    setOpen(false);
    setEditing(null);
    setConfirming(null);
  };

  // Outside clicks and Esc close the menu. Esc is handled before the app's own shortcuts see it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (editing !== null) setEditing(null);
      else if (confirming !== null) setConfirming(null);
      else close();
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, editing, confirming]);

  // Renaming starts with the whole name selected, so typing replaces it.
  useEffect(() => {
    if (editing === null) return;
    renameInput.current?.focus();
    renameInput.current?.select();
  }, [editing]);

  const startRename = (t: TimelineInfo) => {
    setConfirming(null);
    setDraft(t.name);
    setEditing(t.id);
  };

  const commitRename = () => {
    if (editing === null) return;
    const name = draft.replace(/\s+/g, ' ').trim();
    const t = timelines.find((x) => x.id === editing);
    if (name && t && name !== t.name) onRename(editing, name);
    setEditing(null);
  };

  const create = async () => {
    const created = await onCreate();
    if (!created) return;
    // A new timeline opens straight into renaming, with its default name selected.
    setOpen(true);
    setConfirming(null);
    setDraft(created.name);
    setEditing(created.id);
  };

  return (
    <span className="tl-switcher" ref={root} data-no-pan>
      <button
        type="button"
        className={`tl-name${open ? ' is-open' : ''}`}
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch timeline, or start a new one"
      >
        <span className="tl-name-text">{current?.name ?? 'Timeline'}</span>
        <Chevron size={11} />
      </button>
      {current && current.clipCount > 0 && <em className="tl-count">{current.clipCount} clip{current.clipCount === 1 ? '' : 's'}</em>}

      {open && (
        <div className="tl-menu" role="menu" aria-label="Timelines">
          <p className="tl-menu-head">Timelines <span>{timelines.length}</span></p>
          <ul className="tl-menu-list">
            {timelines.map((t) => {
              const isActive = t.id === activeId;
              return (
                <li key={t.id} className={`tl-row${isActive ? ' is-active' : ''}`}>
                  {editing === t.id ? (
                    <input
                      className="tl-rename"
                      ref={renameInput}
                      value={draft}
                      maxLength={60}
                      aria-label="Timeline name"
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                      }}
                    />
                  ) : confirming === t.id ? (
                    <span className="tl-confirm">
                      Delete “{t.name}”?
                      <button type="button" className="tl-yes" onClick={() => { setConfirming(null); onDelete(t.id); }}>Delete</button>
                      <button type="button" onClick={() => setConfirming(null)}>Keep</button>
                    </span>
                  ) : (
                    <>
                      <button type="button" className="tl-pick" role="menuitemradio" aria-checked={isActive} onClick={() => { onSwitch(t.id); close(); }}>
                        <i aria-hidden />
                        <span className="tl-pick-name">{t.name}</span>
                        <span className="tl-pick-count">{t.clipCount}</span>
                      </button>
                      <span className="tl-row-actions">
                        <button type="button" onClick={() => startRename(t)} aria-label={`Rename ${t.name}`} title="Rename"><Pencil size={13} /></button>
                        <button type="button" onClick={() => { onDuplicate(t.id); close(); }} aria-label={`Duplicate ${t.name}`} title="Duplicate"><Copy size={13} /></button>
                        <button
                          type="button"
                          onClick={() => { setEditing(null); setConfirming(t.id); }}
                          disabled={timelines.length <= 1}
                          aria-label={`Delete ${t.name}`}
                          title={timelines.length <= 1 ? 'Keep at least one timeline' : 'Delete'}
                        >
                          <Trash size={13} />
                        </button>
                      </span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <button type="button" className="tl-new" onClick={() => void create()}><Plus size={13} />New timeline</button>
        </div>
      )}
    </span>
  );
}

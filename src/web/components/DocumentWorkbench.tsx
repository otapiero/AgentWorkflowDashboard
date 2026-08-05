import { useCallback, useEffect, useState, type CSSProperties } from 'react';

import { api } from '../api.ts';
import { loadDocument, saveDocument } from '../doc-io.ts';
import {
  buildDocList,
  clampFontPx,
  clampSplit,
  dirtyKeys,
  docKey,
  effectiveMode,
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  SPLIT_DEFAULT,
  type DocBuffer,
  type DocEntry,
  type DocId,
  type DocMode,
} from '../doc-model.ts';
import { DocPanes } from './docs/DocPanes.tsx';
import { DocRail } from './docs/DocRail.tsx';
import type { ArtifactRef } from '../../shared/types.ts';

interface DocumentWorkbenchProps {
  issue: number;
  artifacts: ArtifactRef[];
  initial: DocId;
  onClose: () => void;
  /** Lets the drawer refresh its inline plan glance after a plan save. */
  onPlanSaved: (content: string) => void;
}

interface DocState extends DocBuffer {
  class: 'markdown' | 'text';
  writeTarget: 'original' | 'snapshot';
  originalPath: string;
}

const FONT_KEY = 'mc.doc.fontPx';
const MODE_KEY = 'mc.doc.mode';
const SPLIT_KEY = 'mc.doc.split';

function readStored(key: string, fallback: number): number {
  const raw = window.localStorage.getItem(key);
  return raw === null ? fallback : Number(raw);
}

export function DocumentWorkbench({
  issue,
  artifacts,
  initial,
  onClose,
  onPlanSaved,
}: DocumentWorkbenchProps) {
  const entries = buildDocList(artifacts);
  const [activeId, setActiveId] = useState<DocId>(initial);
  const [docs, setDocs] = useState<Record<string, DocState>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<DocMode>(
    () => (window.localStorage.getItem(MODE_KEY) as DocMode | null) ?? 'split',
  );
  const [fontPx, setFontPx] = useState(() => clampFontPx(readStored(FONT_KEY, FONT_DEFAULT)));
  const [split, setSplit] = useState(() => clampSplit(readStored(SPLIT_KEY, SPLIT_DEFAULT)));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const activeKey = docKey(activeId);
  const active = docs[activeKey];
  const dirty = dirtyKeys(docs);

  useEffect(() => window.localStorage.setItem(FONT_KEY, String(fontPx)), [fontPx]);
  useEffect(() => window.localStorage.setItem(MODE_KEY, mode), [mode]);
  useEffect(() => window.localStorage.setItem(SPLIT_KEY, String(split)), [split]);

  // Lazy load: the rail renders instantly from board state, each document is
  // fetched the first time it is selected.
  useEffect(() => {
    if (docs[activeKey] || failures[activeKey]) return;
    let cancelled = false;
    loadDocument(issue, activeId)
      .then((payload) => {
        if (cancelled) return;
        setDocs((prev) => ({
          ...prev,
          [activeKey]: {
            text: payload.content,
            loaded: payload.content,
            class: payload.class,
            writeTarget: payload.writeTarget,
            originalPath: payload.originalPath,
          },
        }));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setFailures((prev) => ({ ...prev, [activeKey]: message }));
      });
    return () => {
      cancelled = true;
    };
  }, [issue, activeId, activeKey, docs, failures]);

  const attemptClose = useCallback(() => {
    if (dirty.length > 0) {
      const names = entries
        .filter((e) => dirty.includes(e.key))
        .map((e) => e.label)
        .join(', ');
      if (!window.confirm(`Discard unsaved changes to ${names}?`)) return;
    }
    onClose();
  }, [dirty, entries, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        attemptClose();
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        setFontPx((px) => clampFontPx(px + 1));
      } else if (e.key === '-') {
        e.preventDefault();
        setFontPx((px) => clampFontPx(px - 1));
      } else if (e.key === '0') {
        e.preventDefault();
        setFontPx(FONT_DEFAULT);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [attemptClose]);

  function onWheel(e: React.WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setFontPx((px) => clampFontPx(px + (e.deltaY < 0 ? 1 : -1)));
  }

  async function save() {
    if (!active) return;
    setSaving(true);
    setSaveError(null);
    try {
      const target = await saveDocument(issue, activeId, active.text);
      setDocs((prev) => ({
        ...prev,
        [activeKey]: { ...prev[activeKey]!, loaded: active.text, writeTarget: target },
      }));
      if (activeId.kind === 'plan') onPlanSaved(active.text);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const shownMode = active ? effectiveMode(mode, active.class) : mode;
  const isDirty = active ? active.text !== active.loaded : false;

  return (
    <div
      className="doc-scrim"
      role="dialog"
      aria-label={`Documents for #${issue}`}
      onWheel={onWheel}
    >
      <div
        className="doc-workbench"
        style={{ '--doc-font': `${fontPx}px` } as CSSProperties}
      >
        <header className="doc-head">
          <strong>Docs · #{issue}</strong>

          <div className="plan-editor-tabs">
            {(['edit', 'split', 'preview'] as const).map((m) => (
              <button
                key={m}
                className={`btn is-sm${shownMode === m ? ' is-primary' : ''}`}
                disabled={active !== undefined && active.class === 'text' && m !== 'edit'}
                title={
                  active?.class === 'text' && m !== 'edit'
                    ? 'Preview is markdown only'
                    : undefined
                }
                onClick={() => setMode(m)}
              >
                {m[0]!.toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>

          {active?.writeTarget === 'snapshot' && (
            <span className="doc-target" title={active.originalPath}>
              snapshot only — the original is gone
            </span>
          )}

          <span className="doc-zoom">
            <button className="btn is-sm" disabled={fontPx <= FONT_MIN} onClick={() => setFontPx(clampFontPx(fontPx - 1))}>
              A−
            </button>
            <span>{fontPx}px</span>
            <button className="btn is-sm" disabled={fontPx >= FONT_MAX} onClick={() => setFontPx(clampFontPx(fontPx + 1))}>
              A+
            </button>
          </span>

          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              className="btn is-sm is-primary"
              disabled={saving || !isDirty}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="btn is-sm is-ghost" onClick={attemptClose}>
              Close
            </button>
          </span>
        </header>

        {saveError && <p className="error" style={{ margin: '8px 16px' }}>{saveError}</p>}

        <div className="doc-main">
          <DocRail
            entries={entries}
            activeKey={activeKey}
            dirty={dirty}
            onSelect={(entry: DocEntry) => setActiveId(entry.id)}
            onOpenExternal={(name) => void api.openArtifact(issue, name)}
          />

          {failures[activeKey] ? (
            <div className="doc-placeholder">
              <p>{failures[activeKey]}</p>
              {activeId.kind === 'artifact' && (
                <button className="btn is-sm" onClick={() => void api.openArtifact(issue, activeId.name)}>
                  Open in VS Code
                </button>
              )}
            </div>
          ) : !active ? (
            <div className="doc-placeholder">Loading…</div>
          ) : (
            <DocPanes
              mode={shownMode}
              text={active.text}
              split={split}
              readOnly={false}
              onTextChange={(text) =>
                setDocs((prev) => ({ ...prev, [activeKey]: { ...prev[activeKey]!, text } }))
              }
              onSplitChange={(ratio) => setSplit(clampSplit(ratio))}
            />
          )}
        </div>
      </div>
    </div>
  );
}

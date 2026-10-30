import { useRef } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import type { DocMode } from '../../doc-model.ts';
import { clampSplit } from '../../doc-model.ts';

interface DocPanesProps {
  mode: DocMode;
  text: string;
  /** Editor share of the width in split mode, 0.2 .. 0.8. */
  split: number;
  onTextChange: (text: string) => void;
  onSplitChange: (ratio: number) => void;
  readOnly: boolean;
}

/**
 * Editor, preview, or both.
 *
 * Rendered Markdown is sanitized before it is injected. Agents write these
 * documents from GitHub issue text, which anyone who can file an issue
 * controls, and a script running here could drive the whole API.
 */
export function DocPanes({
  mode,
  text,
  split,
  onTextChange,
  onSplitChange,
  readOnly,
}: DocPanesProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  /** Drag the divider; the ratio is clamped so neither pane can vanish. */
  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const box = bodyRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return;
      onSplitChange(clampSplit((e.clientX - box.left) / box.width));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  }

  /** Proportional scroll sync, guarded so the echo does not fight the user. */
  function syncScroll(from: HTMLElement, to: HTMLElement | null) {
    if (!to || syncing.current) return;
    const fromRange = from.scrollHeight - from.clientHeight;
    const toRange = to.scrollHeight - to.clientHeight;
    if (fromRange <= 0 || toRange <= 0) return;
    syncing.current = true;
    to.scrollTop = (from.scrollTop / fromRange) * toRange;
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  }

  const showEditor = mode === 'edit' || mode === 'split';
  const showPreview = mode === 'preview' || mode === 'split';

  return (
    <div className="doc-body" ref={bodyRef}>
      {showEditor && (
        <textarea
          ref={editorRef}
          className="doc-text"
          style={mode === 'split' ? { flex: `0 0 ${split * 100}%` } : undefined}
          value={text}
          readOnly={readOnly}
          spellCheck={false}
          onChange={(e) => onTextChange(e.target.value)}
          onScroll={(e) => mode === 'split' && syncScroll(e.currentTarget, previewRef.current)}
        />
      )}

      {mode === 'split' && (
        <div
          className="doc-divider"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startDrag}
        />
      )}

      {showPreview && (
        <div
          ref={previewRef}
          className="doc-preview"
          onScroll={(e) => mode === 'split' && syncScroll(e.currentTarget, editorRef.current)}
        >
          <div
            className="doc-prose"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(text) as string) }}
          />
        </div>
      )}
    </div>
  );
}

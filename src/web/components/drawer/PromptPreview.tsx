import { useEffect, useState } from 'react';

import { api } from '../../api.ts';
import type { PromptPreview as Preview } from '../../api.ts';
import type { RunKind } from '../../../shared/types.ts';

interface Props {
  issue: number;
  phase: RunKind;
  phaseLabel: string;
  instructions: string;
  /** Custom runs only: false previews the raw prompt with no preamble. */
  includeContext?: boolean;
  onClose: () => void;
}

/**
 * The real text the agent will receive.
 *
 * The operator's instructions are located inside the resolved prompt and
 * highlighted in place — seeing *where* they land is the whole point, and is
 * what makes it obvious which parts of the prompt need no repeating.
 */
export function PromptPreview({
  issue,
  phase,
  phaseLabel,
  instructions,
  includeContext,
  onClose,
}: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setPreview(null);
    setError(null);
    api
      .previewPrompt(issue, phase, instructions || undefined, includeContext)
      .then((p) => live && setPreview(p))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [issue, phase, instructions, includeContext]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const typed = instructions.trim();
  // Locate the operator's block so it can be highlighted where it lands.
  const at = typed && preview ? preview.text.indexOf(typed) : -1;

  return (
    <div className="plan-editor-scrim" role="dialog" aria-label={`Prompt for ${phaseLabel}`}>
      <div className="plan-editor">
        <header className="plan-editor-head">
          <strong>
            Prompt · {phaseLabel} · #{issue}
          </strong>
          {preview && (
            <span className="badge" style={{ marginLeft: 8 }}>
              {preview.command} · {preview.words} words
            </span>
          )}
          <span style={{ marginLeft: 'auto' }}>
            <button className="btn is-sm is-ghost" onClick={onClose}>
              ← Back to editing
            </button>
          </span>
        </header>
        <div className="plan-editor-body">
          {error ? (
            <p className="error" style={{ margin: 16 }}>
              {error}
            </p>
          ) : !preview ? (
            <p className="note" style={{ margin: 16 }}>
              Rendering…
            </p>
          ) : (
            <pre className="prompt-preview">
              {at >= 0 ? (
                <>
                  {preview.text.slice(0, at)}
                  <mark className="prompt-mine">{preview.text.slice(at, at + typed.length)}</mark>
                  {preview.text.slice(at + typed.length)}
                </>
              ) : (
                preview.text
              )}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

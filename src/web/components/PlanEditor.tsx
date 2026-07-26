import { useEffect, useState } from 'react';
import { marked } from 'marked';

import { api } from '../api.ts';

interface PlanEditorProps {
  issue: number;
  initial: string;
  onClose: () => void;
  onSaved: (content: string) => void;
}

/**
 * Full-screen plan editor with an edit/preview toggle.
 *
 * Content is locally-authored and trusted (single-user local tool), so the
 * rendered Markdown is injected directly into the preview pane.
 */
export function PlanEditor({ issue, initial, onClose, onSaved }: PlanEditorProps) {
  const [text, setText] = useState(initial);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = text !== initial;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') attemptClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  function attemptClose() {
    if (dirty && !window.confirm('Discard unsaved plan changes?')) return;
    onClose();
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.savePlan(issue, text);
      onSaved(text);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="plan-editor-scrim" role="dialog" aria-label={`Edit plan for #${issue}`}>
      <div className="plan-editor">
        <header className="plan-editor-head">
          <strong>Plan · #{issue}</strong>
          <div className="plan-editor-tabs">
            <button
              className={`btn is-sm${mode === 'edit' ? ' is-primary' : ''}`}
              onClick={() => setMode('edit')}
            >
              Edit
            </button>
            <button
              className={`btn is-sm${mode === 'preview' ? ' is-primary' : ''}`}
              onClick={() => setMode('preview')}
            >
              Preview
            </button>
          </div>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn is-sm is-primary" disabled={saving || !dirty} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="btn is-sm is-ghost" onClick={attemptClose}>
              Close
            </button>
          </span>
        </header>
        {error && <p className="error" style={{ margin: '8px 16px' }}>{error}</p>}
        <div className="plan-editor-body">
          {mode === 'edit' ? (
            <textarea
              className="plan-editor-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
            />
          ) : (
            <div
              className="plan-editor-preview"
              dangerouslySetInnerHTML={{ __html: marked.parse(text) as string }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

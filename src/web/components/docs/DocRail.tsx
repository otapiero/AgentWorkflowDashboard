import type { DocEntry } from '../../doc-model.ts';

interface DocRailProps {
  entries: DocEntry[];
  activeKey: string;
  /** Keys with unsaved edits, from `dirtyKeys`. */
  dirty: string[];
  onSelect: (entry: DocEntry) => void;
  /** Hand an artifact to VS Code. The plan row has no such route. */
  onOpenExternal: (name: string) => void;
}

export function DocRail({ entries, activeKey, dirty, onSelect, onOpenExternal }: DocRailProps) {
  return (
    <nav className="doc-rail" aria-label="Documents">
      {entries.map((entry) => (
        <div key={entry.key} className={`doc-row${entry.key === activeKey ? ' is-on' : ''}`}>
          <button
            className="doc-row-name"
            onClick={() => onSelect(entry)}
            aria-current={entry.key === activeKey}
          >
            <span className="doc-row-label">{entry.label}</span>
            {dirty.includes(entry.key) && (
              <span className="doc-dot" aria-label="unsaved changes" />
            )}
          </button>
          {entry.inCheckout && <span className="badge tone-warn">in checkout</span>}
          {entry.id.kind === 'artifact' && (
            <button
              className="doc-row-open"
              title="Open in VS Code"
              onClick={() => onOpenExternal(entry.label)}
            >
              ↗
            </button>
          )}
        </div>
      ))}
    </nav>
  );
}

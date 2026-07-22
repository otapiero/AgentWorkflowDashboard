/** Small shared presentational bits: agent chip and inline icons. */

export function AgentChip({
  agent,
  model,
  effort,
}: {
  agent: string;
  model?: string | null;
  effort?: string | null;
}) {
  return (
    <span className="agent-chip">
      <span className={`chip agent-${agent}`}>{agent}</span>
      {model && <span className="chip-model">{model}</span>}
      {effort && <span className="chip-model">effort: {effort}</span>}
    </span>
  );
}

type IconProps = { className?: string };

export function IconSpinner({ className = 'icon' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 8 8"
          to="360 8 8"
          dur="0.9s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}

export function IconAlert({ className = 'icon' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 5v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="8" cy="11.5" r="1" fill="currentColor" />
      <path
        d="M8 1.8 14.5 13H1.5L8 1.8Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconCheck({ className = 'icon' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 8.5 6.5 12 13 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconDot({ className = 'icon' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="3" fill="currentColor" />
    </svg>
  );
}

export function IconPlay({ className = 'icon' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M5 3.5 12 8l-7 4.5v-9Z" fill="currentColor" />
    </svg>
  );
}

export function BrandMark({ className = 'brand-mark' }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="2.5" y="2.5" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <rect x="9.5" y="9.5" width="12" height="12" rx="2.5" fill="var(--bg)" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

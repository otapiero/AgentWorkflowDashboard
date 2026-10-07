import type { ReactNode } from 'react';

/** Small shared presentational bits: agent chip and inline icons. */

/** An agent as a small avatar in its product colour, then "model · effort". */
export function AgentChip({
  agent,
  model,
  effort,
  showAgent = false,
}: {
  agent: string;
  model?: string | null;
  effort?: string | null;
  /** Name the agent in text too ("Claude · Opus"), not only in the avatar. */
  showAgent?: boolean;
}) {
  const detail = [showAgent ? capitalize(agent) : null, model ? capitalize(model) : null, effort]
    .filter(Boolean)
    .join(' · ');
  const title = [agent, model, effort ? `effort: ${effort}` : null].filter(Boolean).join(', ');
  return (
    <span className="agent-chip" title={title}>
      <span className={`agent-avatar agent-${agent}`} aria-hidden>
        {agent.charAt(0).toUpperCase()}
      </span>
      <span className="agent-detail">{detail || capitalize(agent)}</span>
    </span>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden>
      <svg viewBox="0 0 24 24" fill="none">
        <rect x="3" y="3" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="2" />
        <rect x="10" y="10" width="11" height="11" rx="2.5" fill="currentColor" />
      </svg>
    </span>
  );
}

/** Stroke icons in one style (24px grid, 1.8 stroke), drawn after Lucide. */
function Stroke({ className = 'icon', children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const IconNote = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M15 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M15 3v5h5M8 13h8M8 17h5" />
  </Stroke>
);

export const IconBell = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </Stroke>
);

export const IconBellOff = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0M17 17H3s3-2 3-9a5.9 5.9 0 0 1 .9-3.1M18.6 13A17 17 0 0 1 18 8a6 6 0 0 0-9.3-5M2 2l20 20" />
  </Stroke>
);

export const IconCommit = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M3 12h6M15 12h6" />
  </Stroke>
);

export const IconArrowUp = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Stroke>
);

export const IconPullRequest = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="M6 8.5V21M13 6h3a2 2 0 0 1 2 2v7.5" />
  </Stroke>
);

export const IconPlus = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M12 5v14M5 12h14" />
  </Stroke>
);

export const IconContrast = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
  </Stroke>
);

export const IconSearch = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Stroke>
);

export const IconSidebar = (p: IconProps) => (
  <Stroke {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M15 3v18" />
  </Stroke>
);

export const IconTask = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
  </Stroke>
);

export const IconSettings = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
  </Stroke>
);

export const IconTerminal = (p: IconProps) => (
  <Stroke {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </Stroke>
);

export const IconCode = (p: IconProps) => (
  <Stroke {...p}>
    <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
  </Stroke>
);

export const IconThreads = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M21 12a8 8 0 0 1-11.8 7L4 20l1-5.2A8 8 0 1 1 21 12z" />
    <path d="M8.5 12h.01M12 12h.01M15.5 12h.01" />
  </Stroke>
);

export const IconX = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Stroke>
);

export const IconClock = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Stroke>
);

export const IconChevron = (p: IconProps) => (
  <Stroke {...p}>
    <path d="m9 6 6 6-6 6" />
  </Stroke>
);

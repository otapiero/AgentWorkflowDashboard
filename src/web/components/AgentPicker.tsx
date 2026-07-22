import type { AgentInfo } from '../api.ts';

export interface AgentSelection {
  agent: string;
  model: string;
  effort: string;
}

/**
 * A paired agent / model / effort selector, reused for per-task pins, per-phase
 * defaults, and one-time run overrides.
 *
 * The empty option on each field means "inherit" so the levels compose, and the
 * model and effort choices follow whichever agent is selected — no free typing.
 */
interface Props {
  agents: AgentInfo[];
  value: AgentSelection;
  onChange: (value: AgentSelection) => void;
  /** The agent used when this field inherits, so the picker can offer its models. */
  inheritedAgent?: string | null;
  inheritAgentLabel?: string;
}

export function AgentPicker({
  agents,
  value,
  onChange,
  inheritedAgent,
  inheritAgentLabel = 'Inherit',
}: Props) {
  const effectiveAgentName = value.agent || inheritedAgent || agents[0]?.name;
  const agent = agents.find((a) => a.name === effectiveAgentName);

  // Keep a pinned value visible even if it is not in the offered list.
  const models = withValue(agent?.models ?? [], value.model);
  const efforts = withValue(agent?.efforts ?? [], value.effort);

  return (
    <div className="picker">
      <select
        className="field"
        value={value.agent}
        onChange={(e) => onChange({ ...value, agent: e.target.value })}
        aria-label="Agent"
      >
        <option value="">{inheritAgentLabel}</option>
        {agents.map((a) => (
          <option key={a.name} value={a.name}>
            {a.name}
          </option>
        ))}
      </select>

      <select
        className="field"
        value={value.model}
        onChange={(e) => onChange({ ...value, model: e.target.value })}
        aria-label="Model"
      >
        <option value="">model: default</option>
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>

      {agent?.hasEffort ? (
        <select
          className="field"
          value={value.effort}
          onChange={(e) => onChange({ ...value, effort: e.target.value })}
          aria-label="Reasoning effort"
        >
          <option value="">effort: default</option>
          {efforts.map((ef) => (
            <option key={ef} value={ef}>
              effort: {ef}
            </option>
          ))}
        </select>
      ) : (
        <span className="field field-disabled">no effort control</span>
      )}
    </div>
  );
}

function withValue(list: string[], value: string): string[] {
  return value && !list.includes(value) ? [value, ...list] : list;
}

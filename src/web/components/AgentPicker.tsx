import type { AgentInfo } from '../api.ts';

/**
 * A paired agent + model selector, reused for per-task pins, per-phase
 * defaults, and one-time run overrides. The empty agent option means "inherit"
 * so the three levels compose cleanly.
 */
interface Props {
  agents: AgentInfo[];
  agent: string;
  model: string;
  onAgent: (value: string) => void;
  onModel: (value: string) => void;
  inheritLabel?: string;
  compact?: boolean;
}

export function AgentPicker({
  agents,
  agent,
  model,
  onAgent,
  onModel,
  inheritLabel = 'Inherit',
  compact,
}: Props) {
  const defaultModel = agents.find((a) => a.name === agent)?.model ?? 'default';
  return (
    <div className="pair">
      <select
        className="field"
        value={agent}
        onChange={(e) => onAgent(e.target.value)}
        aria-label="Agent"
      >
        <option value="">{inheritLabel}</option>
        {agents.map((a) => (
          <option key={a.name} value={a.name}>
            {a.name}
          </option>
        ))}
      </select>
      <input
        className="field"
        value={model}
        onChange={(e) => onModel(e.target.value)}
        placeholder={compact ? 'model' : `model (${defaultModel})`}
        aria-label="Model"
      />
    </div>
  );
}

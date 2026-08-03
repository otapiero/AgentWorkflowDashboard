import type { BoardConfig, Phase, TaskWithDerived } from '../../src/shared/types.ts';
import { selectionForAgent, selectionForPhase, type AgentSelection } from '../../src/shared/agent-selection.ts';
import type { SpawnRequest } from './client/mission-control-client.ts';

export interface LaunchPick {
  label: string;
  value: string;
  picked?: boolean;
}

export interface LaunchPicker {
  pick(prompt: string, items: readonly LaunchPick[]): Promise<LaunchPick | undefined>;
}

export type ShowLaunchQuickPick = (
  items: readonly LaunchPick[],
  options: { placeHolder: string },
) => PromiseLike<LaunchPick | undefined>;

/** Adapt VS Code's single-select picker so the resolved choice is initially active. */
export function launchPickerFrom(showQuickPick: ShowLaunchQuickPick): LaunchPicker {
  return {
    async pick(prompt, items) {
      const picked = items.find((item) => item.picked);
      const ordered = picked ? [picked, ...items.filter((item) => item !== picked)] : items;
      return await showQuickPick(ordered, { placeHolder: prompt });
    },
  };
}

export async function runLaunchFlow(
  task: TaskWithDerived,
  config: BoardConfig,
  picker: LaunchPicker,
): Promise<SpawnRequest | null> {
  const phases = config.pipeline.filter((phase) => phase.spawnable);
  const phase = await choose(picker, 'Phase', phases.map((candidate) => ({ label: candidate.label, value: candidate.id, picked: candidate.id === task.derived.displayPhase })));
  if (!phase) return null;

  let selection = selectionForPhase(config, task, phase.value);
  const agent = await choose(picker, 'Agent', config.agents.map((candidate) => ({ label: candidate.name, value: candidate.name, picked: candidate.name === selection.agent })));
  if (!agent) return null;
  selection = selectionForAgent(selection, config.agents, agent.value);

  const capabilities = config.agents.find((candidate) => candidate.name === selection.agent);
  if (!capabilities) return null;
  const model = await choose(picker, 'Model', capabilities.models.map((value) => ({ label: value, value, picked: value === selection.model })));
  if (!model) return null;
  selection = { ...selection, model: model.value };

  if (capabilities.hasEffort) {
    const effort = await choose(picker, 'Reasoning effort', capabilities.efforts.map((value) => ({ label: value, value, picked: value === selection.effort })));
    if (!effort) return null;
    selection = { ...selection, effort: effort.value };
  } else {
    selection = { ...selection, effort: '' };
  }

  const confirmation = confirmationText(task.issue, phase.value as Phase, selection);
  const confirmed = await choose(picker, confirmation, [{ label: 'Run', value: 'confirm' }, { label: 'Cancel', value: 'cancel' }]);
  if (!confirmed || confirmed.value !== 'confirm') return null;
  return { phase: phase.value as Phase, ...selection };
}

function choose(picker: LaunchPicker, prompt: string, items: readonly LaunchPick[]): Promise<LaunchPick | undefined> {
  return picker.pick(prompt, items);
}

function confirmationText(issue: number, phase: Phase, selection: AgentSelection): string {
  return `Run #${issue} · ${phase} with ${[selection.agent, selection.model, selection.effort].filter(Boolean).join(' · ')}?`;
}

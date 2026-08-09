import type { Phase, PhaseConfig, T3PhaseModes } from './types.ts';

/**
 * The free-form run.
 *
 * Deliberately not a member of PHASES: every entry in `config.pipeline` becomes
 * a board lane (Board.tsx), a row in the reconciler's gate table, and — when its
 * gate is manual — a button in the Run tab's "Mark progress" list. A custom run
 * wants none of those, so it is synthesised at launch time instead and never
 * joins the pipeline it is shaped like.
 */
export const CUSTOM_RUN_ID = 'custom';

/**
 * T3 permissions for a free-form run: the safe floor, never inherited from the
 * plan phase. A prompt written at launch time is exactly where auto-accepting
 * edits should not apply.
 */
const CUSTOM_T3_MODES: T3PhaseModes = {
  runtimeMode: 'approval-required',
  interactionMode: 'default',
};

/**
 * What building the synthetic phase actually needs.
 *
 * The server holds a `Config` (agents as a record) and the web holds a
 * `BoardConfig` (agents as an array), so this takes the two things both can
 * supply rather than depending on either concrete shape.
 */
export interface RunPhaseSource {
  pipeline: readonly PhaseConfig[];
  agentNames: readonly string[];
}

/**
 * The synthetic phase a custom run launches through.
 *
 * The actor has to be supplied here because `resolveAgentValues` finds a
 * phase's default agent by looking its id up in the pipeline — a lookup a
 * synthetic phase can never satisfy. The plan phase's actor is the sensible
 * inheritance: it is the one whose work most resembles this.
 */
export function customPhase(source: RunPhaseSource): PhaseConfig {
  const actor =
    source.pipeline.find((phase) => phase.id === 'plan')?.actor ??
    source.agentNames[0] ??
    'claude';

  return {
    // The single seam where the custom id is treated as a Phase. It is safe
    // precisely because this object never enters config.pipeline, so nothing
    // that enumerates phases (lanes, gates, PHASES) ever observes it.
    id: CUSTOM_RUN_ID as Phase,
    label: 'Custom run',
    actor,
    command: 'mc-custom',
    spawnable: true,
    repeatable: true,
    gate: { type: 'manual' },
    t3: CUSTOM_T3_MODES,
  };
}

/** A configured pipeline phase by id, or the synthetic custom one. */
export function resolveRunPhase(
  source: RunPhaseSource,
  id: string | undefined,
): PhaseConfig | null {
  if (id === CUSTOM_RUN_ID) return customPhase(source);
  return source.pipeline.find((phase) => phase.id === id) ?? null;
}

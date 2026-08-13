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
 * T3 permissions for a free-form run. Keep these explicit so custom runs match
 * the unrestricted runtime policy used by every other run type.
 */
const CUSTOM_T3_MODES: T3PhaseModes = {
  runtimeMode: 'full-access',
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
 * It carries an actor so agent resolution has a default to fall back on — the
 * plan phase's, since that is the phase whose work most resembles this. But an
 * actor on the object is not enough on its own: see `pipelineWith`.
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

/**
 * `pipeline` with `phase` appended, unless it is already there.
 *
 * Agent resolution takes a phase *id* and finds that phase's actor by looking
 * the id up in the pipeline (`resolveAgentValues`), so a synthetic phase
 * resolves to no agent at all no matter what actor its object carries — the
 * object is never the one consulted. Splicing it in for the duration of the
 * lookup is what makes its actor reachable, without it ever becoming a lane.
 */
export function pipelineWith(
  pipeline: readonly PhaseConfig[],
  phase: PhaseConfig,
): PhaseConfig[] {
  return pipeline.some((candidate) => candidate.id === phase.id)
    ? [...pipeline]
    : [...pipeline, phase];
}

/**
 * Is this the synthetic custom run?
 *
 * Takes `{ id: string }` rather than a `PhaseConfig` deliberately. `PhaseConfig.id`
 * is typed `Phase`, which by construction excludes 'custom', so a direct
 * `phase.id === CUSTOM_RUN_ID` is a compile error at every call site. Widening
 * the comparison here keeps that one narrow dishonesty in this file instead of
 * spreading casts through the callers.
 */
export function isCustomRun(phase: { id: string }): boolean {
  return phase.id === CUSTOM_RUN_ID;
}

/** A configured pipeline phase by id, or the synthetic custom one. */
export function resolveRunPhase(
  source: RunPhaseSource,
  id: string | undefined,
): PhaseConfig | null {
  if (id === CUSTOM_RUN_ID) return customPhase(source);
  return source.pipeline.find((phase) => phase.id === id) ?? null;
}

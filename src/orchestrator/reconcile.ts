import { PHASES } from '../shared/types.ts';
import type { Badge, DerivedState, Facts, Phase } from '../shared/types.ts';

/**
 * Derive a task's phase and status purely from durable facts.
 *
 * This function must stay pure — no filesystem, no network, no clock. All I/O
 * belongs in gatherFacts. That constraint is what makes the whole board
 * crash-safe: state is never remembered, it is always recomputed.
 */
export function reconcile(
  facts: Facts,
  manualPhase: Phase | null = null,
): DerivedState {
  const gates = computeGates(facts);
  const derivedPhase = derivePhase(facts);
  const badges = computeBadges(facts);
  const { needsYou, needsYouReason } = computeNeedsYou(facts, derivedPhase);

  return {
    issue: facts.issue,
    derivedPhase,
    displayPhase: manualPhase ?? derivedPhase,
    gates,
    badges,
    artifacts: facts.artifacts,
    needsYou,
    needsYouReason,
  };
}

/** Unresolved review threads that are not the Copilot bot's. */
function humanUnresolved(facts: Facts): number {
  return Math.max(
    0,
    facts.review.unresolvedThreads - facts.review.copilotUnresolved,
  );
}

function planReady(facts: Facts): boolean {
  return facts.planMdExists || facts.markers.includes('plan.done');
}

/** Evaluated top-down; the first matching rule wins. */
function derivePhase(facts: Facts): Phase {
  const { pr, review, checks } = facts;

  if (pr.state === 'MERGED') return 'done';

  if (pr.exists) {
    if (review.decision === 'APPROVED' && review.unresolvedThreads === 0) {
      return 'merge';
    }
    if (review.decision === 'CHANGES_REQUESTED' || humanUnresolved(facts) > 0) {
      return 'dev_review';
    }
    if (review.copilotUnresolved > 0) return 'copilot_review';
    if (checks === 'failure' || checks === 'pending') return 'ci';
    // Green and unreviewed: rest here until a review lands.
    return 'copilot_review';
  }

  if (facts.hasPushedCommits && facts.markers.includes('implement.done')) {
    return 'publish';
  }
  if (planReady(facts)) return 'implement';
  if (
    facts.worktreeExists ||
    facts.branchExists ||
    facts.markers.includes('plan.running')
  ) {
    return 'plan';
  }
  return 'inbox';
}

function computeGates(facts: Facts): Record<Phase, boolean> {
  const satisfied: Record<Phase, boolean> = {
    inbox: true,
    plan: planReady(facts),
    implement: facts.markers.includes('implement.done'),
    publish: facts.pr.exists,
    ci: facts.checks === 'success',
    copilot_review: facts.pr.exists && facts.review.copilotUnresolved === 0,
    dev_review:
      facts.review.decision === 'APPROVED' &&
      facts.review.unresolvedThreads === 0,
    // Merging is always a deliberate human act; never auto-satisfied.
    merge: false,
    done: facts.pr.state === 'MERGED',
  };
  // Guard against a phase being added to PHASES without a gate rule here.
  for (const phase of PHASES) {
    if (!(phase in satisfied)) satisfied[phase] = false;
  }
  return satisfied;
}

function computeBadges(facts: Facts): Badge[] {
  const badges: Badge[] = [];

  if (facts.liveSpawn) {
    badges.push({
      kind: 'live',
      label: `${facts.liveSpawn.phase} running`,
      tone: 'busy',
    });
  } else if (facts.markers.some((m) => m.endsWith('.running'))) {
    // A running marker with no live process means a terminal died mid-run.
    badges.push({ kind: 'stale-spawn', label: 'spawn ended', tone: 'warn' });
  }

  if (facts.pr.exists && facts.pr.number !== null) {
    badges.push({
      kind: 'pr',
      label: `#${facts.pr.number}`,
      tone: facts.pr.state === 'MERGED' ? 'good' : 'neutral',
    });
  }

  if (planReady(facts)) {
    badges.push({ kind: 'plan-ready', label: 'plan ready', tone: 'good' });
  }

  if (facts.dirtyFileCount > 0) {
    badges.push({
      kind: 'dirty',
      label: `${facts.dirtyFileCount} uncommitted`,
      tone: 'warn',
    });
  }

  if (facts.unpushedCommits > 0) {
    badges.push({
      kind: 'unpushed',
      label: `${facts.unpushedCommits} unpushed`,
      tone: 'warn',
    });
  }

  if (facts.checks !== 'none') {
    badges.push({
      kind: 'ci',
      label: `CI ${facts.checks}`,
      tone:
        facts.checks === 'success'
          ? 'good'
          : facts.checks === 'failure'
            ? 'bad'
            : 'busy',
    });
  }

  if (facts.review.copilotUnresolved > 0) {
    badges.push({
      kind: 'copilot',
      label: `${facts.review.copilotUnresolved} Copilot`,
      tone: 'warn',
    });
  }

  const human = humanUnresolved(facts);
  if (human > 0) {
    badges.push({ kind: 'review', label: `${human} review`, tone: 'warn' });
  }

  if (facts.review.decision === 'APPROVED') {
    badges.push({ kind: 'approved', label: 'approved', tone: 'good' });
  } else if (facts.review.decision === 'CHANGES_REQUESTED') {
    badges.push({ kind: 'review', label: 'changes requested', tone: 'bad' });
  }

  const inCheckout = facts.artifacts.filter((a) => a.origin === 'repo').length;
  if (inCheckout > 0) {
    badges.push({
      kind: 'artifacts-in-repo',
      label: `${inCheckout} in checkout`,
      tone: 'warn',
    });
  }

  return badges;
}

function computeNeedsYou(
  facts: Facts,
  derivedPhase: Phase,
): { needsYou: boolean; needsYouReason: string | null } {
  const no = { needsYou: false, needsYouReason: null };

  // Something is actively working the task; wait for it.
  if (facts.liveSpawn) return no;
  if (derivedPhase === 'done') return no;

  // Precedence mirrors derivePhase, so the reason always describes the lane the
  // card is resting in: review feedback outranks a red CI, because a PR with
  // outstanding review threads rests in a review lane, not at CI.
  if (facts.review.decision === 'CHANGES_REQUESTED') {
    return { needsYou: true, needsYouReason: 'Changes requested on the PR' };
  }
  const human = humanUnresolved(facts);
  if (human > 0) {
    return {
      needsYou: true,
      needsYouReason: `${human} unresolved review ${human === 1 ? 'comment' : 'comments'}`,
    };
  }
  if (facts.review.copilotUnresolved > 0) {
    return {
      needsYou: true,
      needsYouReason: `${facts.review.copilotUnresolved} unresolved Copilot ${
        facts.review.copilotUnresolved === 1 ? 'comment' : 'comments'
      }`,
    };
  }
  if (facts.checks === 'failure') {
    return { needsYou: true, needsYouReason: 'CI is failing' };
  }
  if (derivedPhase === 'merge') {
    return { needsYou: true, needsYouReason: 'Approved — ready for you to merge' };
  }
  if (derivedPhase === 'publish') {
    return { needsYou: true, needsYouReason: 'Ready to publish the PR' };
  }
  if (derivedPhase === 'implement' && planReady(facts)) {
    return { needsYou: true, needsYouReason: 'Plan ready for your review' };
  }
  return no;
}

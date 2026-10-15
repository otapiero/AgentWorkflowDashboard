import { PHASES } from '../shared/types.ts';
import { layerPhase } from '../shared/pr-stack.ts';
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
  gates.done = manualPhase === 'done';
  const derivedPhase = derivePhase(facts);
  const planAwaitingReview = planReady(facts) && !(
    facts.implementationStarted || facts.pr.exists ||
    (manualPhase ?? derivedPhase) === 'implement' ||
    facts.markers.some(marker => marker.startsWith('implement.')) ||
    facts.liveSpawn?.phase === 'implement' ||
    (manualPhase !== null && manualPhase !== 'inbox' && manualPhase !== 'plan')
  );
  const badges = computeBadges(facts, planAwaitingReview);
  let { needsYou, needsYouReason } = computeNeedsYou(facts, manualPhase === 'done' ? 'done' : derivedPhase, planAwaitingReview);
  if (facts.stack && manualPhase !== 'done' && !isLive(facts)) {
    const problem = facts.stack.layers.find(p => p.checks === 'failure' || p.review.unresolvedThreads > 0 || p.review.decision === 'CHANGES_REQUESTED' || p.warning);
    if (problem) { needsYou = true; needsYouReason = `#${problem.number}: ${problem.warning ?? (problem.checks === 'failure' ? 'CI is failing' : 'Review needs attention')}`; }
    if (!facts.stack.discoveryComplete) { needsYou = true; needsYouReason = 'Stack discovery incomplete'; }
  }

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

/**
 * Is something actively working this task?
 *
 * T3 answers directly when it can. The PID fallback is not vestigial: it
 * covers wt- and vscode-launched phases, and it covers the board running while
 * T3 is down.
 */
function isLive(facts: Facts): boolean {
  // A settled or archived thread keeps its last session state, so it would
  // otherwise read as running forever. Falling through to the marker is right:
  // closing a thread in T3 says nothing about a pwsh spawn still working.
  if (facts.t3 && !facts.t3.settled) {
    const { sessionStatus, activeTurnId } = facts.t3;
    return sessionStatus === 'starting' || sessionStatus === 'running' || activeTurnId !== null;
  }
  return facts.liveSpawn !== null;
}

/** Evaluated top-down; the first matching rule wins. */
function derivePhase(facts: Facts): Phase {
  const { pr, review, checks } = facts;

  if (facts.stack?.layers.length) {
    if (facts.stack.complete) return 'merged';
    const first = facts.stack.layers.find(p => p.state !== 'MERGED');
    if (!first) return 'ci';
    const phase = layerPhase(first);
    return phase === 'merge' && (first.warning || !facts.stack.discoveryComplete) ? 'dev_review' : phase;
  }

  if (pr.state === 'MERGED') return 'merged';

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
    merged: facts.stack ? facts.stack.complete : facts.pr.state === 'MERGED',
    done: false,
  };
  // Guard against a phase being added to PHASES without a gate rule here.
  for (const phase of PHASES) {
    if (!(phase in satisfied)) satisfied[phase] = false;
  }
  if (facts.stack && (!facts.stack.discoveryComplete || facts.stack.layers.some(p => !p.available))) {
    satisfied.ci = false;
    satisfied.copilot_review = false;
    satisfied.dev_review = false;
  }
  return satisfied;
}

function computeBadges(facts: Facts, planAwaitingReview: boolean): Badge[] {
  const badges: Badge[] = [];
  if (facts.stack && facts.stack.layers.length > 1) {
    const layers = facts.stack.layers;
    const failures = layers.filter(p => p.checks === 'failure').length;
    badges.push({ kind: 'stack', label: `${layers.length} PRs, ${layers.filter(p => p.state === 'MERGED').length} merged${failures ? `, ${failures} failing` : ''}`, tone: failures ? 'bad' : 'neutral' });
  }

  if (isLive(facts)) {
    // A T3-only run has no marker to name the phase; the badge still has to
    // say something, and "session running" is honest about what we know.
    const what = facts.liveSpawn?.phase ?? 'session';
    badges.push({ kind: 'live', label: `${what} running`, tone: 'busy' });
  } else if (facts.markers.some((m) => m.endsWith('.running'))) {
    // A running marker with no live process means a terminal died mid-run.
    badges.push({ kind: 'stale-spawn', label: 'spawn ended', tone: 'warn' });
  }

  if (facts.t3?.lastError) {
    badges.push({ kind: 't3-error', label: 'T3 session error', tone: 'bad' });
  }

  if (facts.pr.exists && facts.pr.number !== null) {
    badges.push({
      kind: 'pr',
      label: `#${facts.pr.number}`,
      tone: facts.pr.state === 'MERGED' ? 'good' : 'neutral',
    });
  }

  if (planAwaitingReview) {
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
  planAwaitingReview: boolean,
): { needsYou: boolean; needsYouReason: string | null } {
  const no = { needsYou: false, needsYouReason: null };

  // A thread blocked on an approval request is precisely what the attention
  // rail exists to surface, so it is checked before the "something is working
  // on it, wait" short-circuit.
  if (facts.t3?.awaitingApproval && !facts.t3.settled) {
    return { needsYou: true, needsYouReason: 'T3 session is waiting for your approval' };
  }

  // Something is actively working the task; wait for it.
  if (isLive(facts)) return no;
  if (derivedPhase === 'done') return no;
  if (derivedPhase === 'merged') {
    return { needsYou: true, needsYouReason: 'Merged, ready to mark Done and remove the worktree' };
  }

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
  if (derivedPhase === 'implement' && planAwaitingReview) {
    return { needsYou: true, needsYouReason: 'Plan ready for your review' };
  }
  return no;
}

import type { BoardConfig, Phase, RunKind, TaskWithDerived } from '../../src/shared/types.ts';
import type { TaskStoreSnapshot } from './task-store.ts';
import { matchWorkspace } from './workspace-matcher.ts';

export type Severity = 'bad' | 'warn' | 'normal';

export interface SectionNode { kind: 'section'; id: string; label: string; expanded: boolean }
export interface PhaseNode { kind: 'phase'; id: string; phase: Phase; label: string }
export type TaskScope = 'current' | 'attention' | `all:${Phase}`;
export interface TaskNode { kind: 'task'; id: string; scope: TaskScope; issue: number; label: string; description: string; severity: Severity }
export interface ActionNode { kind: 'action'; id: string; label: string; command: string; args: readonly unknown[] }
export interface MessageNode { kind: 'message'; id: string; label: string }
export type TreeNode = SectionNode | PhaseNode | TaskNode | ActionNode | MessageNode;

type WorkspaceUri = { scheme: string; fsPath: string } | undefined;

export function buildRootNodes(_snapshot: TaskStoreSnapshot, _currentUri: WorkspaceUri): readonly SectionNode[] {
  return [
    { kind: 'section', id: 'section:current', label: 'Current Worktree', expanded: true },
    { kind: 'section', id: 'section:attention', label: 'Needs Attention', expanded: true },
    { kind: 'section', id: 'section:all', label: 'All Tasks', expanded: false },
  ];
}

export function buildChildren(snapshot: TaskStoreSnapshot, currentUri: WorkspaceUri, parentId: string, filter = ''): readonly TreeNode[] {
  if (parentId === 'section:current') {
    const current = matchWorkspace(currentUri, snapshot.tasks);
    return current ? currentWorktreeNodes(snapshot, current) : [{ kind: 'message', id: 'message:current:unrelated', label: 'This workspace is not a Mission Control worktree.' }];
  }
  if (parentId === 'section:attention') {
    return [...filtered(snapshot.tasks.filter((task) => task.derived.needsYou), filter)].sort((left, right) => attentionOrder(snapshot, left, right)).map((task) => buildTaskNode(task, 'attention'));
  }
  if (parentId === 'section:all') {
    if (!snapshot.config) return [{ kind: 'message', id: 'message:all:loading', label: 'Waiting for Mission Control data…' }];
    return laneOrder(snapshot.config)
      .filter((lane) => filtered(snapshot.tasks.filter((task) => task.derived.displayPhase === lane.id), filter).length > 0)
      .map((lane) => ({ kind: 'phase' as const, id: `phase:${lane.id}`, phase: lane.id, label: lane.label }));
  }
  if (parentId.startsWith('phase:')) {
    const phase = parentId.slice('phase:'.length) as Phase;
    return [...filtered(snapshot.tasks.filter((task) => task.derived.displayPhase === phase), filter)].sort(issueOrder).map((task) => buildTaskNode(task, `all:${phase}`));
  }
  return [];
}

export function severityFor(task: TaskWithDerived): Severity {
  if (task.integration.checks === 'failure' || task.integration.review.decision === 'CHANGES_REQUESTED') return 'bad';
  if (task.integration.review.unresolvedThreads > 0 || task.integration.review.copilotUnresolved > 0 || task.integration.approvalRequired || task.derived.needsYou) return 'warn';
  return 'normal';
}

/** Also renders the synthetic 'custom' run kind, which is not a pipeline phase. */
export function phaseLabel(phase: RunKind): string {
  return phase.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function buildTaskNode(task: TaskWithDerived, scope: TaskScope): TaskNode {
  return { kind: 'task', id: `task:${scope}:${task.issue}`, scope, issue: task.issue, label: `#${task.issue} ${task.title}`, description: phaseLabel(task.derived.displayPhase), severity: severityFor(task) };
}

function currentWorktreeNodes(snapshot: TaskStoreSnapshot, task: TaskWithDerived): TreeNode[] {
  const nodes: TreeNode[] = [buildTaskNode(task, 'current')];
  const agent = [task.pinned.agent, task.pinned.model, task.pinned.effort].filter(Boolean).join(' · ');
  if (agent) nodes.push({ kind: 'message', id: `message:agent:${task.issue}`, label: `Agent: ${agent}` });
  if (task.integration.liveSpawn) {
    nodes.push({ kind: 'message', id: `message:session:${task.issue}`, label: `Session: ${phaseLabel(task.integration.liveSpawn.phase)} running` });
    nodes.push({ kind: 'action', id: `action:view-session:${task.issue}`, label: 'View Session', command: 'missionControl.viewSession', args: [task.issue] });
  } else {
    const currentPhase = snapshot.config?.pipeline.find((phase) => phase.id === task.derived.displayPhase);
    if (snapshot.connection === 'connected' && currentPhase?.spawnable) {
      nodes.push({ kind: 'action', id: `action:run:${task.issue}`, label: 'Run Current Phase', command: 'missionControl.runCurrentPhase', args: [task.issue] });
    }
  }
  if (task.integration.worktreeExists) nodes.push({ kind: 'action', id: `action:open:${task.issue}`, label: 'Open Worktree', command: 'missionControl.openTask', args: [task.issue] });
  nodes.push({ kind: 'action', id: `action:dashboard:${task.issue}`, label: 'Open Dashboard', command: 'missionControl.openDashboard', args: [] });
  return nodes;
}

/**
 * config.yaml configures only the pipeline, but a task can rest before it in inbox
 * or after it in merged or done. The board brackets its lanes the same way; grouping on the
 * pipeline alone would make every resting task unreachable in the tree.
 */
function laneOrder(config: BoardConfig): readonly { id: Phase; label: string }[] {
  return [
    { id: 'inbox', label: 'Inbox' },
    ...config.pipeline.map((phase) => ({ id: phase.id, label: phase.label })),
    { id: 'merged', label: 'Merged' },
    { id: 'done', label: 'Done' },
  ];
}

function filtered(tasks: readonly TaskWithDerived[], filter: string): readonly TaskWithDerived[] {
  const query = filter.trim().toLocaleLowerCase();
  if (!query) return tasks;
  return tasks.filter((task) => [String(task.issue), task.title, task.derived.displayPhase, phaseLabel(task.derived.displayPhase)].some((value) => value.toLocaleLowerCase().includes(query)));
}

function issueOrder(left: TaskWithDerived, right: TaskWithDerived): number { return left.issue - right.issue; }
function attentionOrder(snapshot: TaskStoreSnapshot, left: TaskWithDerived, right: TaskWithDerived): number {
  const severity = ({ bad: 0, warn: 1, normal: 2 } as const);
  const severityOrder = severity[severityFor(left)] - severity[severityFor(right)];
  if (severityOrder) return severityOrder;
  const timeOrder = (snapshot.attentionTransitions.get(right.issue) ?? '').localeCompare(snapshot.attentionTransitions.get(left.issue) ?? '');
  return timeOrder || issueOrder(left, right);
}

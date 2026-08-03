import type { Phase, TaskWithDerived } from '../../src/shared/types.ts';
import type { TaskStoreSnapshot } from './task-store.ts';
import { matchWorkspace } from './workspace-matcher.ts';

export type Severity = 'bad' | 'warn' | 'normal';

export interface SectionNode { kind: 'section'; id: string; label: string; expanded: boolean }
export interface PhaseNode { kind: 'phase'; id: string; phase: Phase; label: string }
export interface TaskNode { kind: 'task'; id: string; issue: number; label: string; description: string; severity: Severity }
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
    return [...filtered(snapshot.tasks.filter((task) => task.derived.needsYou), filter)].sort(attentionOrder).map(taskNode);
  }
  if (parentId === 'section:all') {
    if (!snapshot.config) return [{ kind: 'message', id: 'message:all:loading', label: 'Waiting for Mission Control data…' }];
    return snapshot.config.pipeline
      .filter((phase) => filtered(snapshot.tasks.filter((task) => task.derived.displayPhase === phase.id), filter).length > 0)
      .map((phase) => ({ kind: 'phase' as const, id: `phase:${phase.id}`, phase: phase.id, label: phase.label }));
  }
  if (parentId.startsWith('phase:')) {
    const phase = parentId.slice('phase:'.length) as Phase;
    return [...filtered(snapshot.tasks.filter((task) => task.derived.displayPhase === phase), filter)].sort(issueOrder).map(taskNode);
  }
  return [];
}

export function severityFor(task: TaskWithDerived): Severity {
  if (task.integration.checks === 'failure' || task.integration.review.decision === 'CHANGES_REQUESTED') return 'bad';
  if (task.integration.review.unresolvedThreads > 0 || task.integration.review.copilotUnresolved > 0 || task.integration.approvalRequired || task.derived.needsYou) return 'warn';
  return 'normal';
}

export function phaseLabel(phase: Phase): string {
  return phase.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function buildTaskNode(task: TaskWithDerived): TaskNode {
  return { kind: 'task', id: `task:${task.issue}`, issue: task.issue, label: `#${task.issue} ${task.title}`, description: phaseLabel(task.derived.displayPhase), severity: severityFor(task) };
}

const taskNode = buildTaskNode;

function currentWorktreeNodes(snapshot: TaskStoreSnapshot, task: TaskWithDerived): TreeNode[] {
  const nodes: TreeNode[] = [taskNode(task)];
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

function filtered(tasks: readonly TaskWithDerived[], filter: string): readonly TaskWithDerived[] {
  const query = filter.trim().toLocaleLowerCase();
  if (!query) return tasks;
  return tasks.filter((task) => [String(task.issue), task.title, task.derived.displayPhase, phaseLabel(task.derived.displayPhase)].some((value) => value.toLocaleLowerCase().includes(query)));
}

function issueOrder(left: TaskWithDerived, right: TaskWithDerived): number { return left.issue - right.issue; }
function attentionOrder(left: TaskWithDerived, right: TaskWithDerived): number {
  const severity = ({ bad: 0, warn: 1, normal: 2 } as const);
  const severityOrder = severity[severityFor(left)] - severity[severityFor(right)];
  if (severityOrder) return severityOrder;
  const timeOrder = (right.lastReconciledAt ?? '').localeCompare(left.lastReconciledAt ?? '');
  return timeOrder || issueOrder(left, right);
}

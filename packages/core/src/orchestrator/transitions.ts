import { TERMINAL_TASK_STATES, type TaskState } from '@altrex/contracts'

// The task state machine (AGENT_SPEC.md §2.1) as one table. Every non-terminal state may also go to
// FAILED, CANCELLED or INTERRUPTED. Terminal states have no successors.

const forward: Record<TaskState, readonly TaskState[]> = {
  RECEIVED: ['UNDERSTANDING', 'REPOSITORY_ANALYSIS', 'PLANNING', 'IMPLEMENTING', 'ANSWERING'],
  UNDERSTANDING: ['REPOSITORY_ANALYSIS', 'PLANNING', 'IMPLEMENTING', 'ANSWERING'],
  REPOSITORY_ANALYSIS: ['PLANNING', 'IMPLEMENTING', 'ANSWERING'],
  PLANNING: ['AWAITING_APPROVAL', 'IMPLEMENTING', 'COMPLETED_UNVERIFIED'],
  // Returns to the state that asked (plan approval or a HIGH-risk action mid-phase).
  AWAITING_APPROVAL: ['PLANNING', 'IMPLEMENTING', 'TESTING', 'DEBUGGING'],
  IMPLEMENTING: ['AWAITING_APPROVAL', 'TESTING', 'REVIEWING', 'VERIFYING', 'COMPLETED_UNVERIFIED'],
  TESTING: ['AWAITING_APPROVAL', 'DEBUGGING', 'IMPLEMENTING', 'REVIEWING', 'VERIFYING', 'COMPLETED_UNVERIFIED'],
  DEBUGGING: ['AWAITING_APPROVAL', 'TESTING', 'IMPLEMENTING'],
  REVIEWING: ['IMPLEMENTING', 'VERIFYING'],
  VERIFYING: ['VERIFIED', 'COMPLETED_UNVERIFIED'],
  ANSWERING: ['COMPLETED'],
  VERIFIED: [], COMPLETED_UNVERIFIED: [], COMPLETED: [], FAILED: [], CANCELLED: [], INTERRUPTED: [],
}
const always: readonly TaskState[] = ['FAILED', 'CANCELLED', 'INTERRUPTED']

export class IllegalTransitionError extends Error {
  constructor(readonly from: TaskState, readonly to: TaskState) {
    super(`Illegal task transition ${from} → ${to}.`)
  }
}

export function isTerminal(state: TaskState): boolean { return TERMINAL_TASK_STATES.has(state) }

export function canTransition(from: TaskState, to: TaskState): boolean {
  if (isTerminal(from) || from === to) return false
  return forward[from].includes(to) || always.includes(to)
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to)
}

export function successors(from: TaskState): TaskState[] {
  return isTerminal(from) ? [] : [...forward[from], ...always]
}

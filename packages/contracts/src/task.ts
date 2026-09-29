import { z } from 'zod'

/** Full V4 task lifecycle (AGENT_SPEC.md §2.1). Phase 1 legacy engines only reach a subset. */
export const TaskStateSchema = z.enum([
  'RECEIVED',
  'UNDERSTANDING',
  'REPOSITORY_ANALYSIS',
  'PLANNING',
  'AWAITING_APPROVAL',
  'IMPLEMENTING',
  'TESTING',
  'DEBUGGING',
  'REVIEWING',
  'VERIFYING',
  'ANSWERING',
  'VERIFIED',
  'COMPLETED_UNVERIFIED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
])
export type TaskState = z.infer<typeof TaskStateSchema>

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'VERIFIED', 'COMPLETED_UNVERIFIED', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED',
])

/** Request modes accepted by the current desktop chat entry point. */
export const TaskModeSchema = z.enum(['ASK', 'AGENT', 'LOCAL', 'MULTI'])
export type TaskMode = z.infer<typeof TaskModeSchema>

/** `question` = read-only answer; `change` = may modify the workspace. */
export const TaskIntentSchema = z.enum(['change', 'question'])
export type TaskIntent = z.infer<typeof TaskIntentSchema>

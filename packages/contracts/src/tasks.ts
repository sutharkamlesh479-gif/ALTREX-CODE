import { z } from 'zod'
import { TaskIntentSchema, TaskModeSchema, TaskStateSchema } from './task'
import { RoutingModeSchema } from './routing'
import { VerdictSchema } from './verification'

/** Agent roles (AGENT_SPEC.md §3). MANAGER is code; the others run models (TESTER mostly runs commands). */
export const AgentRoleSchema = z.enum(['MANAGER', 'PLANNER', 'CODER', 'DEBUGGER', 'TESTER', 'REVIEWER'])
export type AgentRole = z.infer<typeof AgentRoleSchema>

export const AgentRunSchema = z.object({
  agentId: z.string().min(1),
  role: AgentRoleSchema,
  /** e.g. "Coding agent", "OpenAI Codex (external engine)", "Frontend: Settings page". */
  label: z.string().max(200),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  summary: z.string().max(4000).nullable(),
})
export type AgentRun = z.infer<typeof AgentRunSchema>

export const TaskEngineSchema = z.enum(['altrex', 'codex', 'director'])

/** Persisted task record. Survives restarts; tasks running at a crash become INTERRUPTED (never auto-resumed). */
export const TaskSummarySchema = z.object({
  taskId: z.string().min(1),
  /** Legacy chat request id for correlation with `window.altrex` chat events; null for `task.start` tasks. */
  requestId: z.string().nullable(),
  /** Conversation the task belongs to (client-chosen id passed to `task.start`); null for legacy chat. */
  sessionId: z.string().nullable().default(null),
  mode: TaskModeSchema,
  intent: TaskIntentSchema,
  projectPath: z.string().nullable(),
  title: z.string().max(200),
  modelSelection: z.string().max(200),
  routingMode: RoutingModeSchema.nullable(),
  engine: TaskEngineSchema.nullable(),
  state: TaskStateSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  checkpointIds: z.array(z.string()).max(100),
  changedFiles: z.array(z.string()).max(1000),
  agents: z.array(AgentRunSchema).max(200),
  /** Why the task ended the way it did (failure message, unverified reason, interruption). */
  outcome: z.object({ reason: z.string().max(4000), code: z.string().max(64).nullable() }).nullable(),
  /** True when high-volume events (deltas, command output) were dropped from the persisted history. */
  eventsTruncated: z.boolean(),
  /** Evidence-based verdict (change tasks that went through verification). */
  verdict: VerdictSchema.nullable().default(null),
})
export type TaskSummary = z.infer<typeof TaskSummarySchema>

export const FileChangeSchema = z.object({ path: z.string(), change: z.enum(['added', 'modified', 'deleted']) })

export const taskEventSchemas = {
  'agent.started': z.object({ agentId: z.string(), role: AgentRoleSchema, label: z.string().max(200), providerId: z.string().nullable(), model: z.string().nullable() }),
  /** Structured progress of one agent (round number and the tools it called). */
  'agent.progress': z.object({ agentId: z.string(), role: AgentRoleSchema, round: z.int().nonnegative().nullable(), message: z.string().max(2000) }),
  'agent.completed': z.object({ agentId: z.string(), role: AgentRoleSchema, summary: z.string().max(4000) }),
  /** `code: 'CANCELLED'` when the task was cancelled while the agent ran. */
  'agent.failed': z.object({ agentId: z.string(), role: AgentRoleSchema, message: z.string().max(4000), code: z.string().max(64).nullable() }),
  /** The task's changes relative to its checkpoint are ready (see `checkpoint.diff`). */
  'diff.available': z.object({ checkpointId: z.string(), files: z.array(FileChangeSchema).max(1000), truncated: z.boolean() }),
  /** One tournament candidate finished in its isolated workspace (ranking input: evidence only). */
  'tournament.candidate': z.object({
    candidate: z.int().nonnegative(), providerId: z.string().nullable(), model: z.string().nullable(), status: z.enum(['completed', 'failed']),
    changedFiles: z.int().nonnegative(), changedLines: z.int().nonnegative(), conflicts: z.int().nonnegative(),
    checks: z.array(z.object({ name: z.enum(['build', 'test', 'typecheck', 'lint']), status: z.enum(['PASS', 'FAIL', 'TIMEOUT', 'ERROR', 'NOT_RUN']) })).max(10),
    error: z.string().max(500).optional(),
  }),
  /** Candidates were ranked by code; the winner (if any) was applied to the project. */
  'tournament.selected': z.object({
    winner: z.int().nonnegative().nullable(),
    ranking: z.array(z.object({ candidate: z.int().nonnegative(), eligible: z.boolean(), reasons: z.array(z.string().max(300)).max(10) })).max(3),
    applied: z.array(z.string()).max(1000),
  }),
  /** Terminal: the app stopped while the task ran. Commands were stopped with the app and are not resumed. */
  'task.interrupted': z.object({ reason: z.string().max(2000) }),
} as const

const TaskStartMessageSchema = z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(200_000) })

export const taskCommandSchemas = {
  /**
   * Start a task through the core bridge (no legacy chat stream). Progress arrives as events with the
   * returned taskId. Attachments are ids returned by the file picker.
   */
  'task.start': {
    request: z.object({
      projectPath: z.string().min(1).max(4096).nullable(),
      mode: TaskModeSchema,
      prompt: z.string().min(1).max(200_000),
      history: z.array(TaskStartMessageSchema).max(200).default([]),
      modelSelection: z.string().min(1).max(200).default('AUTO'),
      routingMode: RoutingModeSchema.optional(),
      attachmentIds: z.array(z.string().regex(/^[a-f0-9-]{36}$/)).max(8).default([]),
      resumeRunId: z.string().regex(/^[a-zA-Z0-9-]{8,80}$/).optional(),
      /** AGENT mode: 2–3 candidates implement the task in isolated workspaces; code picks the winner by evidence. */
      candidates: z.int().min(1).max(3).default(1),
      /** Groups tasks into a conversation (`session.list`). Any stable id chosen by the UI. */
      sessionId: z.string().regex(/^[A-Za-z0-9-]{8,80}$/).optional(),
    }),
    response: z.object({ taskId: z.string() }),
  },
  'task.cancel': { request: z.object({ taskId: z.string().min(1) }), response: z.object({ cancelled: z.boolean() }) },
  'task.list': {
    request: z.object({ projectPath: z.string().min(1).max(4096).optional(), sessionId: z.string().max(80).optional(), limit: z.int().min(1).max(500).default(50) }),
    response: z.array(TaskSummarySchema),
  },
  'task.get': { request: z.object({ taskId: z.string().min(1) }), response: TaskSummarySchema },
  /** File content before the task (from the checkpoint) and now, for rendering a diff. */
  'checkpoint.diff': {
    request: z.object({ checkpointId: z.string().min(1), path: z.string().min(1).max(4096) }),
    response: z.object({
      path: z.string(),
      before: z.string().nullable(),
      current: z.string().nullable(),
      binary: z.boolean(),
      /** The file changed again after the task finished (current ≠ task result). */
      changedSinceTask: z.boolean(),
    }),
  },
} as const

import { z } from 'zod'

export const RiskSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'FORBIDDEN'])
export const PermissionProfileSchema = z.enum(['read_only', 'standard', 'autonomous'])
export type PermissionProfile = z.infer<typeof PermissionProfileSchema>

/** A HIGH-risk action waiting for the user. `reason` comes from the classifier, never from the model. */
export const ApprovalRequestSchema = z.object({
  approvalId: z.string().min(1),
  taskId: z.string().min(1).nullable(),
  tool: z.string(),
  summary: z.string().max(2000),
  risk: RiskSchema,
  capability: z.string(),
  reason: z.string(),
  agentReason: z.string().optional(),
  requestedAt: z.iso.datetime(),
})
export type ApprovalRequestView = z.infer<typeof ApprovalRequestSchema>

export const permissionEventSchemas = {
  /** The task is paused until the user approves or denies (see `permission.respond`). */
  'permission.required': ApprovalRequestSchema,
  'permission.resolved': z.object({ approvalId: z.string(), decision: z.enum(['approved', 'denied']), scope: z.enum(['once', 'task']), by: z.enum(['user', 'policy', 'task-grant']), note: z.string() }),
  /** A tool call was refused by policy (FORBIDDEN, read-only project, or HIGH without approval). */
  'tool.denied': z.object({ tool: z.string(), summary: z.string().max(2000), risk: RiskSchema, reason: z.string() }),
  'command.started': z.object({ commandId: z.string(), command: z.string() }),
  /** Live output chunk (≤ 8 KB; long chunks are split). */
  'command.output': z.object({ commandId: z.string(), stream: z.enum(['stdout', 'stderr']), text: z.string().max(8192) }),
  'command.completed': z.object({ commandId: z.string(), command: z.string(), exitCode: z.int().nullable(), timedOut: z.boolean(), durationMs: z.int().nonnegative() }),
} as const

export const permissionCommandSchemas = {
  'permission.respond': {
    request: z.object({ approvalId: z.string().min(1), decision: z.enum(['approve', 'deny']), scope: z.enum(['once', 'task']).default('once') }),
    response: z.object({ accepted: z.boolean() }),
  },
  'permission.pending': { request: z.object({}), response: z.array(ApprovalRequestSchema) },
  /**
   * The UI declares it can answer approvals. Until then, HIGH-risk actions are denied with an explanation
   * (never approved silently).
   */
  'permission.configure': { request: z.object({ interactive: z.boolean() }), response: z.object({ interactive: z.boolean() }) },
  /** Get (omit `profile`) or set the permission profile of an opened project. */
  'project.permissions': {
    request: z.object({ projectPath: z.string().min(1).max(4096), profile: PermissionProfileSchema.optional() }),
    response: z.object({ projectPath: z.string(), profile: PermissionProfileSchema }),
  },
} as const

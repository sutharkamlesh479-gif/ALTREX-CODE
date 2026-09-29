import { z } from 'zod'
import { CheckpointIdSchema, CheckpointSummarySchema, RestorePlanSchema, RestoreResultSchema, RestoreScopeSchema } from './checkpoint'
import { AltrexEventSchema } from './events'
import { ModelViewSchema, ProviderViewSchema } from './provider'
import { RouterPreviewRequestSchema, RoutingPreviewSchema } from './routing'
import { repoCommandSchemas } from './repo'
import { permissionCommandSchemas } from './permissions'
import { taskCommandSchemas } from './tasks'
import { memoryCommandSchemas } from './memory'
import { platformCommandSchemas } from './platform'

export const EventReplaySchema = z.object({
  streamId: z.string().min(1),
  events: z.array(AltrexEventSchema),
  /** Oldest sequence still buffered (null when empty). If `afterSeq + 1 < oldestSeq`, events were lost. */
  oldestSeq: z.int().positive().nullable(),
  latestSeq: z.int().nonnegative(),
  gap: z.boolean(),
})
export type EventReplay = z.infer<typeof EventReplaySchema>

const CheckpointRestoreRequestSchema = z.object({
  checkpointId: CheckpointIdSchema,
  scope: RestoreScopeSchema.default('task'),
})

/** UI → core commands implemented in Phase 1. Every request and response is validated at the IPC boundary. */
export const commandSchemas = {
  'events.replay': {
    request: z.object({ afterSeq: z.int().nonnegative() }),
    response: EventReplaySchema,
  },
  'checkpoint.list': {
    request: z.object({ projectPath: z.string().min(1).max(4096) }),
    response: z.array(CheckpointSummarySchema),
  },
  'checkpoint.preview': {
    request: CheckpointRestoreRequestSchema,
    response: RestorePlanSchema,
  },
  'checkpoint.restore': {
    request: CheckpointRestoreRequestSchema,
    response: RestoreResultSchema,
  },
  /** Configured providers with measured health (no secrets). */
  'provider.list': {
    request: z.object({}),
    response: z.array(ProviderViewSchema),
  },
  /** Known model endpoints with capability knowledge, optionally for one provider. */
  'model.list': {
    request: z.object({ providerId: z.string().min(1).optional() }),
    response: z.array(ModelViewSchema),
  },
  /** Explain what the router would choose for a mode/role now, without calling any model. */
  'router.preview': {
    request: RouterPreviewRequestSchema,
    response: RoutingPreviewSchema,
  },
  ...repoCommandSchemas,
  ...permissionCommandSchemas,
  ...taskCommandSchemas,
  ...memoryCommandSchemas,
  ...platformCommandSchemas,
  /** Persisted event history of one task (survives restarts; each event keeps its original streamId/seq). */
  'task.events': {
    request: z.object({ taskId: z.string().min(1), limit: z.int().min(1).max(20_000).default(5000) }),
    response: z.object({ taskId: z.string(), events: z.array(AltrexEventSchema), truncated: z.boolean() }),
  },
} satisfies Record<string, { request: z.ZodType; response: z.ZodType }>

export type CommandName = keyof typeof commandSchemas
export const COMMAND_NAMES = Object.keys(commandSchemas) as CommandName[]
/** What callers send (defaults may be omitted). */
export type CommandRequest<N extends CommandName> = z.input<(typeof commandSchemas)[N]['request']>
/** What handlers receive after validation (defaults applied). */
export type ParsedCommandRequest<N extends CommandName> = z.output<(typeof commandSchemas)[N]['request']>
export type CommandResponse<N extends CommandName> = z.output<(typeof commandSchemas)[N]['response']>

export function isCommandName(value: unknown): value is CommandName {
  return typeof value === 'string' && Object.hasOwn(commandSchemas, value)
}

export function parseCommandRequest<N extends CommandName>(name: N, request: unknown): ParsedCommandRequest<N> {
  return commandSchemas[name].request.parse(request) as ParsedCommandRequest<N>
}

export function parseCommandResponse<N extends CommandName>(name: N, response: unknown): CommandResponse<N> {
  return commandSchemas[name].response.parse(response) as CommandResponse<N>
}

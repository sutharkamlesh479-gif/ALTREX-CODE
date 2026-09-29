import { z } from 'zod'
import { CONTRACT_VERSION } from './version'
import { TaskIntentSchema, TaskModeSchema, TaskStateSchema } from './task'
import { CheckpointSummarySchema, RestoreResultSchema } from './checkpoint'
import { ProviderHealthStateSchema } from './provider'
import { EndpointSchema, RoutingModeSchema } from './routing'
import { permissionEventSchemas } from './permissions'
import { taskEventSchemas } from './tasks'
import { verificationEventSchemas } from './verification'
import { memoryEventSchemas } from './memory'

const IdSchema = z.string().min(1).max(128)

/**
 * Payload schema for every event type the core emits today.
 * Only types that are actually produced belong here. Planned types (tool.*, check.*, review.*,
 * provider.*, …; see docs/V4_ARCHITECTURE.md §9) are added when their producer exists.
 */
export const eventPayloadSchemas = {
  'task.created': z.object({
    state: z.literal('RECEIVED'),
    mode: TaskModeSchema,
    intent: TaskIntentSchema,
    projectPath: z.string().min(1).nullable(),
    /** First line of the request, ≤200 characters. */
    title: z.string().max(200),
    modelSelection: z.string().max(200),
    /** Legacy chat request id (correlation only); absent for `task.start` tasks. */
    requestId: z.string().max(128).optional(),
  }),
  'task.state_changed': z.object({ from: TaskStateSchema, to: TaskStateSchema }),
  /** Human-readable progress. Informational only: never parse it for control flow. */
  'task.activity': z.object({ message: z.string().min(1).max(4000), source: z.enum(['legacy', 'core']) }),
  /** A `question` task was answered. Answers are not verified. */
  'task.completed': z.object({}),
  /** A `change` task finished without evidence-based verification. `reason` says why. */
  'task.completed_unverified': z.object({ reason: z.string().min(1).max(2000) }),
  'task.failed': z.object({ message: z.string().min(1).max(4000), code: z.string().max(64).nullable() }),
  'task.cancelled': z.object({}),
  'agent.message_delta': z.object({ text: z.string() }),
  /** The endpoint a role call will use. `provider` is a display name; `providerId` the stable id. */
  'model.selected': z.object({ provider: z.string().min(1), model: z.string().min(1), reasons: z.array(z.string()), providerId: z.string().min(1).optional(), role: z.string().optional(), mode: RoutingModeSchema.optional() }),
  /** A role call moved to a different provider (first selection, or a change). */
  'provider.selected': z.object({ providerId: z.string().min(1), role: z.string(), mode: RoutingModeSchema, reason: z.string() }),
  /** The router re-ranked and chose a different endpoint without a failure. */
  'route.changed': z.object({ role: z.string(), from: EndpointSchema, to: EndpointSchema, reason: z.string() }),
  /** A call failed and routing is moving to another endpoint. `reason` is the normalized error category. */
  'fallback.started': z.object({ role: z.string(), from: EndpointSchema, to: EndpointSchema, reason: z.string() }),
  'fallback.completed': z.object({ role: z.string(), from: EndpointSchema, to: EndpointSchema }),
  /** Every candidate was exhausted after a failure. */
  'fallback.failed': z.object({ role: z.string(), from: EndpointSchema, reason: z.string(), attempted: z.int().nonnegative() }),
  ...permissionEventSchemas,
  ...taskEventSchemas,
  ...verificationEventSchemas,
  ...memoryEventSchemas,
  'command.exited': z.object({ command: z.string().min(1), exitCode: z.int().nullable(), output: z.string().max(8192) }),
  /** `cumulative: true` = the full list of paths changed so far in the task. */
  'file.changed': z.object({ paths: z.array(z.string()).max(1000), cumulative: z.boolean() }),
  'checkpoint.created': CheckpointSummarySchema,
  'checkpoint.failed': z.object({ projectPath: z.string().min(1), reason: z.string().min(1).max(2000) }),
  'checkpoint.restored': RestoreResultSchema,
  /** Measured provider health changed (global event: taskId is null). */
  'provider.health_changed': z.object({ providerId: z.string().min(1), baseUrl: z.string().min(1), state: ProviderHealthStateSchema, previous: ProviderHealthStateSchema, errorCategory: z.string().nullable() }),
} satisfies Record<string, z.ZodType>

export type EventType = keyof typeof eventPayloadSchemas
export type EventPayload<T extends EventType> = z.infer<(typeof eventPayloadSchemas)[T]>
export const EVENT_TYPES = Object.keys(eventPayloadSchemas) as EventType[]

export const EventEnvelopeBaseSchema = z.object({
  v: z.literal(CONTRACT_VERSION),
  /** Random per core process. A change means sequence numbers restarted; resync via replay. */
  streamId: IdSchema,
  /** Strictly increasing within a stream, starting at 1. */
  seq: z.int().positive(),
  id: IdSchema,
  ts: z.iso.datetime(),
  /** Task the event belongs to; null for global events. A core task id (uuidv7), not a chat request id. */
  taskId: IdSchema.nullable(),
  type: z.enum(EVENT_TYPES as [EventType, ...EventType[]]),
  payload: z.unknown(),
})

export type AltrexEvent<T extends EventType = EventType> = {
  [K in T]: Omit<z.infer<typeof EventEnvelopeBaseSchema>, 'type' | 'payload'> & { type: K; payload: EventPayload<K> }
}[T]

/** Validates envelope and type-specific payload. */
export const AltrexEventSchema = EventEnvelopeBaseSchema.transform((envelope, context) => {
  const result = eventPayloadSchemas[envelope.type].safeParse(envelope.payload)
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue({ ...issue, path: ['payload', ...issue.path] } as never)
    return z.NEVER
  }
  return { ...envelope, payload: result.data } as AltrexEvent
})

export function parseAltrexEvent(value: unknown): AltrexEvent {
  return AltrexEventSchema.parse(value)
}

export function isEventOfType<T extends EventType>(event: AltrexEvent, type: T): event is Extract<AltrexEvent, { type: T }> {
  return event.type === type
}

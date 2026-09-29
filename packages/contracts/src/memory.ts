import { z } from 'zod'

/** A remembered fact about a project. Sources are evidence, detection or the user — never model claims. */
export const MemoryFactSchema = z.object({
  key: z.string().min(1).max(120),
  value: z.string().max(2000),
  source: z.enum(['evidence', 'user', 'detected']),
  evidenceId: z.string().optional(),
  confidence: z.enum(['confirmed', 'observed-once']),
  lastVerifiedAt: z.iso.datetime(),
})
export type MemoryFact = z.infer<typeof MemoryFactSchema>

export const memoryEventSchemas = {
  /** Project memory changed after a task (evidence-backed facts only). */
  'memory.updated': z.object({ projectPath: z.string(), keys: z.array(z.string()).max(100) }),
} as const

export const memoryCommandSchemas = {
  'memory.list': { request: z.object({ projectPath: z.string().min(1).max(4096) }), response: z.array(MemoryFactSchema) },
  /** Remember a user-stated fact (stored as `user.<key>`). */
  'memory.remember': { request: z.object({ projectPath: z.string().min(1).max(4096), key: z.string().min(1).max(100).regex(/^[\w.-]+$/), value: z.string().min(1).max(2000) }), response: z.object({ key: z.string() }) },
  'memory.forget': { request: z.object({ projectPath: z.string().min(1).max(4096), key: z.string().min(1).max(120) }), response: z.object({ removed: z.boolean() }) },
} as const

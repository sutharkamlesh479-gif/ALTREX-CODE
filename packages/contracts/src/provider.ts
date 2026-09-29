import { z } from 'zod'

/** Measured provider health. UNKNOWN = not checked (new, or observations expired after a restart). */
export const ProviderHealthStateSchema = z.enum(['UNKNOWN', 'HEALTHY', 'DEGRADED', 'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'AUTH_ERROR', 'OFFLINE', 'UNSUPPORTED'])
export type ProviderHealthState = z.infer<typeof ProviderHealthStateSchema>

/** A configured provider connection. Never contains a secret; `keyHint` is at most the last 4 characters. */
export const ProviderViewSchema = z.object({
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  baseUrl: z.string().min(1),
  /** Wire protocol used for this endpoint. */
  protocol: z.enum(['openai-chat', 'gemini']),
  /** `local` only for loopback endpoints; tunnels (e.g. ngrok) and remote hosts are `cloud`. */
  privacy: z.enum(['local', 'cloud']),
  health: ProviderHealthStateSchema,
  lastErrorCategory: z.string().nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  model: z.string(),
  modelsDiscovered: z.int().nonnegative(),
  hasCredential: z.boolean(),
  keyHint: z.string().max(4).nullable(),
  statusMessage: z.string().nullable(),
})
export type ProviderView = z.infer<typeof ProviderViewSchema>

const Tri = z.boolean().nullable()

/** Capability knowledge for one model endpoint. `null` = unknown (never guessed as true). */
export const ModelViewSchema = z.object({
  providerId: z.string().min(1),
  baseUrl: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string(),
  available: Tri,
  health: z.enum(['UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNAVAILABLE', 'INCOMPATIBLE']),
  free: Tri,
  lastErrorCategory: z.string().nullable(),
  capabilities: z.object({
    chat: Tri, streaming: Tri, tools: Tri, streamingTools: Tri, vision: Tri, structuredOutput: Tri, reasoning: Tri,
    contextWindow: z.int().positive().nullable(), maxOutput: z.int().positive().nullable(),
  }),
})
export type ModelView = z.infer<typeof ModelViewSchema>

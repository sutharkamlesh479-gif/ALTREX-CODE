import { z } from 'zod'

/** How the router chooses models. AUTO is the normal-user default. */
export const RoutingModeSchema = z.enum(['AUTO', 'FAST', 'POWERFUL', 'FREE_ONLY', 'LOCAL_ONLY', 'CUSTOM'])
export type RoutingMode = z.infer<typeof RoutingModeSchema>

export const EndpointSchema = z.object({ providerId: z.string().min(1), model: z.string().min(1) })
export type Endpoint = z.infer<typeof EndpointSchema>

/** What the router would choose now (no model is called). */
export const RoutingPreviewSchema = z.object({
  mode: RoutingModeSchema,
  primary: EndpointSchema.nullable(),
  fallbacks: z.array(EndpointSchema),
  reasons: z.array(z.string()),
  rejected: z.array(EndpointSchema.extend({ reason: z.string(), detail: z.string() })),
})
export type RoutingPreview = z.infer<typeof RoutingPreviewSchema>

export const RouterPreviewRequestSchema = z.object({
  mode: RoutingModeSchema.default('AUTO'),
  role: z.string().min(1).max(64).optional(),
  tools: z.boolean().optional(),
  vision: z.boolean().optional(),
  minContext: z.int().positive().optional(),
  prompt: z.string().max(20_000).optional(),
})

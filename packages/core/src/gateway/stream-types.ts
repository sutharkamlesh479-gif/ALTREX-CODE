import type { ProviderToolCall } from '../tools/types'

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown'

/**
 * ALTREX's provider-independent model stream. Adapters translate every wire format into these
 * events; nothing above the gateway sees provider JSON or SSE framing.
 * Tool calls are emitted only when complete and valid (never partially), so they are safe to execute.
 */
export type GatewayStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; call: ProviderToolCall }
  | { type: 'usage'; inputTokens: number | null; outputTokens: number | null }
  | { type: 'finish'; reason: FinishReason }

export type GatewayUsage = { inputTokens: number | null; outputTokens: number | null; source: 'provider' | 'none' }

export type GatewayResponse = {
  text: string
  reasoning: string
  toolCalls: ProviderToolCall[]
  finish: FinishReason
  usage: GatewayUsage
  /** Whether the response was received as a stream. */
  streamed: boolean
}

/** Model metadata a provider's catalog exposes. Absent fields are unknown, never guessed. */
export type DiscoveredModel = {
  id: string
  displayName?: string
  contextWindow?: number
  maxOutput?: number
  supportsTools?: boolean
  supportsVision?: boolean
  supportsStructuredOutput?: boolean
  supportsReasoning?: boolean
  free?: boolean
}

import type { DiscoveredModel } from '../stream-types'

export type CapabilityHints = { supportsStreamingTools?: boolean; supportsStreaming?: boolean }

/**
 * Static adapter knowledge applied only where a capability is still unknown. Observed behaviour
 * (probes, real use) always overrides a hint.
 */
export function capabilityHints(providerId: string): CapabilityHints {
  // Ollama models frequently return tool calls as JSON text in `content`; only the non-streamed
  // parser can recover those, so tool turns for Ollama are not streamed.
  if (providerId === 'ollama') return { supportsStreamingTools: false }
  // crax-gpt documents streaming for its OpenAI-compatible chat endpoint (a gateway property, not per model).
  // Recording it avoids a capability probe per model on a rate-limited free gateway. Tools stay unknown and
  // are probed per model on first use, because models behind a gateway differ.
  if (providerId === 'crax-gpt') return { supportsStreaming: true }
  return {}
}

export type { DiscoveredModel }

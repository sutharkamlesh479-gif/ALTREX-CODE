import type { RequestPolicy } from './request-policy'

/**
 * A resolved model endpoint as the gateway sees it. `providerId` selects the wire dialect/adapter.
 * The API key is resolved by the host just before use and is never persisted or logged by core.
 */
export type EndpointConnection = {
  providerId: string
  baseUrl: string
  model: string
  apiKey: string
  additionalFields?: Record<string, string>
  requestPolicy?: Partial<RequestPolicy>
  /** Known model context window (tokens). When set, the default input budget is sized from it. */
  contextWindow?: number
  /** Known model output limit (tokens). */
  maxOutput?: number
}

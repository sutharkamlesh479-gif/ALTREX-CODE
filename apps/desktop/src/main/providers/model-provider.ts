import type { ProviderConnectionInput, ProviderTestResult } from '../../shared/desktop-api'
import type { ProviderToolCall } from '../project-tool-broker'
import type { ProviderHealthState } from './request-manager'

/** A resolved connection. contextWindow/maxOutput are the model's known limits (from the registry), if any. */
export type ProviderRuntimeConnection = ProviderConnectionInput & { contextWindow?: number; maxOutput?: number }

import type { ProviderContentPart, ProviderMessage } from '@altrex/core/gateway/messages'

export type { ProviderContentPart, ProviderMessage }

export type ProviderStreamInput = {
  connection: ProviderRuntimeConnection
  messages: ProviderMessage[]
  signal: AbortSignal
  onDelta: (delta: string) => void
  onStatus?: (message: string) => void
}

export type ProviderCompletionInput = {
  connection: ProviderRuntimeConnection
  messages: ProviderMessage[]
  tools: ReadonlyArray<unknown>
  signal: AbortSignal
  onStatus?: (message: string) => void
  /** Stream this turn (tool calls are reassembled and returned only when complete). Default: false. */
  stream?: boolean
  /** Live text deltas when streaming. */
  onDelta?: (delta: string) => void
}

export type ProviderCompletion = {
  content: string
  toolCalls: ProviderToolCall[]
}

export type ModelCapabilities = {
  supportsChat: boolean | null
  supportsStreaming: boolean | null
  supportsTools: boolean | null
  /** Tool calls work when the turn is streamed. false = this model must use non-streamed tool turns. */
  supportsStreamingTools: boolean | null
  supportsParallelTools: boolean | null
  supportsVision: boolean | null
  supportsJSON: boolean | null
  supportsReasoning: boolean | null
  contextWindow: number | null
  maxOutput: number | null
}

export type CapabilityRequirement = { chat?: boolean; streaming?: boolean; tools?: boolean; vision?: boolean; json?: boolean; adequateContext?: number; /** Routing key (`providerId:baseUrl:model`) to rank away from, e.g. the endpoint whose work is under review. */ differentFrom?: string }

export interface ModelProvider {
  readonly protocol: string
  healthCheck(connection: ProviderRuntimeConnection): Promise<ProviderTestResult>
  listModels(connection: ProviderRuntimeConnection): Promise<string[]>
  stream(input: ProviderStreamInput): Promise<void>
  complete(input: ProviderCompletionInput): Promise<ProviderCompletion>
  probeCapabilities?(connection: ProviderRuntimeConnection, requirement: CapabilityRequirement, signal: AbortSignal): Promise<Partial<ModelCapabilities>>
  providerHealth?(connection: ProviderRuntimeConnection): { state: ProviderHealthState; active: number; queued: number }
  resetProviderHealth?(connection: ProviderRuntimeConnection): void
  recordFallback?(from: ProviderRuntimeConnection, to: ProviderRuntimeConnection): void
}

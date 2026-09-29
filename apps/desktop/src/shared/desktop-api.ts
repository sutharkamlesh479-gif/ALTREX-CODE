import type { RequestPolicy } from './request-policy'
import type { ProjectRun } from './multi-ai'
import type { ProviderErrorCategory } from './provider-errors'
import { providerDefinitions, type ProviderId, type ProviderLinkKind } from './provider-registry'

export type { ProviderId, ProviderLinkKind } from './provider-registry'

export type ProjectSummary = {
  name: string
  path: string
  branch: string | null
  markers: string[]
}

export type RuntimeInfo = {
  platform: NodeJS.Platform
  electron: string
  chrome: string
  node: string
  bridge: 'connected'
  codex: CodexRuntimeInfo
}

export type CodexRuntimeInfo = {
  available: boolean
  version: string | null
}

export type ProviderConnectionInput = {
  providerId: ProviderId
  apiKey: string
  baseUrl: string
  model: string
  additionalFields?: Record<string, string>
  requestPolicy?: Partial<RequestPolicy>
}

export type ProviderStatus = {
  connected: boolean
  providerId: ProviderId | null
  displayName: string | null
  baseUrl: string | null
  model: string | null
  profiles?: ProviderProfileStatus[]
  warning?: string | null
}

export type ProviderProfileStatus = {
  providerId: ProviderId
  displayName: string
  model: string
  baseUrl: string
  /** Measured provider health. UNKNOWN = not checked since it was configured or since the last restart. */
  health: 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED' | 'AUTH_ERROR' | 'OFFLINE' | 'UNSUPPORTED'
  modelsDiscovered: number
  toolCompatibleModels: number
  lastErrorCategory: ProviderErrorCategory | null
  lastCheckedAt: string | null
  connectionState: 'NOT_CONFIGURED' | 'TESTING' | 'CONNECTED' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED' | 'AUTHENTICATION_FAILED' | 'MODEL_UNAVAILABLE' | 'TEMPORARILY_UNAVAILABLE' | 'ERROR'
  keySuffix: string | null
  statusMessage: string | null
  additionalFields: Record<string, string>
}

export type ProviderTestResult = {
  ok: boolean
  message: string
  latencyMs: number
  failureKind?: 'authentication' | 'too-large' | 'rate-limit' | 'quota-exhausted' | 'timeout' | 'unavailable' | 'model-unavailable' | 'tools-unsupported' | 'invalid-request' | 'network' | 'cancelled'
  errorCategory?: ProviderErrorCategory
  modelsDiscovered?: number
  resolvedModel?: string
  capabilities?: {
    chat: boolean | null
    streaming: boolean | null
    tools: boolean | null
  }
}

export type ProviderRequestDiagnostic = {
  id: string
  startedAt: string
  provider: string
  model: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  retries: number
  status: 'complete' | 'failed' | 'cancelled'
  httpStatus?: number
  errorCategory?: ProviderErrorCategory
  retryable?: boolean
  retryAfterMs?: number
  technicalDetails?: string
  fallbackDestination?: string
}

export type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type ChatAttachment = {
  id: string
  name: string
  mimeType: string
  size: number
  kind: 'image' | 'text' | 'file'
  previewDataUrl?: string
}

export type ChatRequest = {
  requestId: string
  projectPath: string | null
  messages: ChatMessage[]
  attachments: ChatAttachment[]
  mode: 'ASK' | 'AGENT' | 'LOCAL' | 'MULTI'
  modelSelection: string
  /** Routing mode (V4). Omitted: AUTO for 'AUTO' selections, CUSTOM for an explicit model, LOCAL_ONLY in LOCAL mode. */
  routingMode?: 'AUTO' | 'FAST' | 'POWERFUL' | 'FREE_ONLY' | 'LOCAL_ONLY' | 'CUSTOM'
  resumeRunId?: string
  /** AGENT mode tournament: 2–3 candidates in isolated workspaces (set by the core `task.start` command). */
  candidates?: number
  /** Conversation id (set by the core `task.start` command). */
  sessionId?: string
}

export type ChatStreamEvent = {
  requestId: string
  type: 'started' | 'delta' | 'activity' | 'files-changed' | 'command-result' | 'completed' | 'cancelled' | 'error' | 'run-state'
  run?: ProjectRun
  delta?: string
  message?: string
  provider?: string
  model?: string
  files?: string[]
  command?: string
  exitCode?: number | null
  output?: string
}

export const providerPresets: ReadonlyArray<{
  id: ProviderId
  displayName: string
  baseUrl: string
  model: string
  keyUrl: string | null
}> = providerDefinitions.map(provider => ({
  id: provider.id,
  displayName: provider.name,
  baseUrl: provider.baseUrl,
  model: provider.defaultModel,
  keyUrl: provider.apiKeyUrl,
}))

export type DesktopApi = {
  openProject: () => Promise<ProjectSummary | null>
  getRecentProject: () => Promise<ProjectSummary | null>
  getRuntimeInfo: () => Promise<RuntimeInfo>
  getProviderStatus: () => Promise<ProviderStatus>
  getProviderModels: (providerId?: ProviderId) => Promise<string[]>
  refreshProviderModels: () => Promise<ProviderStatus>
  installLocalModel: (modelId: string) => Promise<ProviderStatus>
  getProviderDiagnostics: () => Promise<ProviderRequestDiagnostic[]>
  pickAttachments: () => Promise<ChatAttachment[]>
  testProvider: (input: ProviderConnectionInput) => Promise<ProviderTestResult>
  connectProvider: (input: ProviderConnectionInput) => Promise<ProviderStatus>
  disconnectProvider: (providerId?: ProviderId) => Promise<ProviderStatus>
  openExternalProviderLink: (providerId: ProviderId, kind: ProviderLinkKind) => Promise<void>
  startChat: (request: ChatRequest) => Promise<void>
  cancelChat: (requestId: string) => Promise<void>
  reviseRun: (requestId: string, text: string) => Promise<void>
  getProjectRuns: (projectPath: string) => Promise<ProjectRun[]>
  onChatEvent: (listener: (event: ChatStreamEvent) => void) => () => void
}

export const desktopChannels = {
  openProject: 'dialog:open-project',
  recentProject: 'project:recent',
  runtimeInfo: 'runtime:info',
  providerStatus: 'provider:status',
  providerModels: 'provider:models',
  providerRefreshModels: 'provider:refresh-models',
  providerInstallLocalModel: 'provider:install-local-model',
  providerDiagnostics: 'provider:diagnostics',
  attachmentPick: 'attachment:pick',
  providerTest: 'provider:test',
  providerConnect: 'provider:connect',
  providerDisconnect: 'provider:disconnect',
  providerOpenExternal: 'provider:open-external',
  chatStart: 'chat:start',
  chatCancel: 'chat:cancel',
  chatEvent: 'chat:event',
  runRevise: 'run:revise',
  projectRuns: 'run:list',
} as const

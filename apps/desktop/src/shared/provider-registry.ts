export type ProviderId =
  | 'openai'
  | 'google'
  | 'cerebras'
  | 'cloudflare'
  | 'ollama'
  | 'sambanova'
  | 'groq'
  | 'openrouter'
  | 'nvidia'
  | 'nim-local'
  | 'crax-gpt'
  | 'custom'

export type ProviderSection = 'recommended' | 'local' | 'additional' | 'advanced'
export type ProviderLinkKind = 'apiKey' | 'accountId' | 'install' | 'docs'
export type ProviderTestStrategy = 'openai-compatible' | 'cloudflare-workers-ai' | 'ollama-local'

export type ProviderFieldDefinition = {
  id: 'apiKey' | 'accountId'
  label: string
  placeholder: string
  secret: boolean
  helper?: string
}

export type ProviderDefinition = {
  id: ProviderId
  name: string
  description: string
  logo: string
  section: ProviderSection
  apiKeyUrl: string | null
  accountIdUrl?: string
  installUrl?: string
  docsUrl: string
  requiresApiKey: boolean
  requiredFields: readonly ProviderFieldDefinition[]
  recommended: boolean
  supportsLocal: boolean
  testStrategy: ProviderTestStrategy
  baseUrl: string
  /**
   * Suggested model only. It is replaced by a discovered model when the provider's catalog does not list it,
   * so a stale ID never becomes a hard dependency.
   */
  defaultModel: string
  approvedHosts: readonly string[]
  /** The user supplies the endpoint (custom servers, self-hosted NIM, tunnels such as ngrok). */
  userBaseUrl?: boolean
}

const apiKey = (label = 'API key'): ProviderFieldDefinition => ({
  id: 'apiKey', label, placeholder: `Paste ${label.toLowerCase()}`, secret: true,
})

export const PROVIDER_REGISTRY: Readonly<Record<ProviderId, ProviderDefinition>> = {
  google: {
    id: 'google', name: 'Google Gemini', logo: 'G', section: 'recommended', recommended: true, supportsLocal: false,
    description: 'Powerful general, coding and agent models.',
    apiKeyUrl: 'https://aistudio.google.com/apikey', docsUrl: 'https://ai.google.dev/gemini-api/docs/api-key',
    requiresApiKey: true, requiredFields: [apiKey()], testStrategy: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-3.8-flash',
    approvedHosts: ['aistudio.google.com', 'ai.google.dev'],
  },
  cerebras: {
    id: 'cerebras', name: 'Cerebras', logo: 'C', section: 'recommended', recommended: true, supportsLocal: false,
    description: 'Fast cloud inference for powerful open models.',
    apiKeyUrl: 'https://cloud.cerebras.ai/', docsUrl: 'https://inference-docs.cerebras.ai/api-reference/authentication',
    requiresApiKey: true, requiredFields: [apiKey()], testStrategy: 'openai-compatible',
    baseUrl: 'https://api.cerebras.ai/v1', defaultModel: 'qwen-3.8-27b',
    approvedHosts: ['cloud.cerebras.ai', 'inference-docs.cerebras.ai'],
  },
  cloudflare: {
    id: 'cloudflare', name: 'Cloudflare Workers AI', logo: 'CF', section: 'recommended', recommended: true, supportsLocal: false,
    description: 'Cloud AI inference with multiple supported models.',
    apiKeyUrl: 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai',
    accountIdUrl: 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai',
    docsUrl: 'https://developers.cloudflare.com/workers-ai/get-started/rest-api/',
    requiresApiKey: true,
    requiredFields: [
      { id: 'accountId', label: 'Account ID', placeholder: 'Paste Cloudflare Account ID', secret: false, helper: 'Workers AI requires your Cloudflare Account ID and an API Token with Workers AI permissions.' },
      apiKey('API Token'),
    ],
    testStrategy: 'cloudflare-workers-ai',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1', defaultModel: '@cf/openai/gpt-oss-20b',
    approvedHosts: ['dash.cloudflare.com', 'developers.cloudflare.com'],
  },
  ollama: {
    id: 'ollama', name: 'Ollama Local', logo: 'O', section: 'local', recommended: false, supportsLocal: true,
    description: 'Run supported AI models locally without a cloud API key.',
    apiKeyUrl: null, installUrl: 'https://ollama.com/download', docsUrl: 'https://docs.ollama.com/',
    requiresApiKey: false, requiredFields: [], testStrategy: 'ollama-local',
    baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'qwen2.5-coder:7b-instruct', approvedHosts: ['ollama.com', 'docs.ollama.com'],
  },
  sambanova: {
    id: 'sambanova', name: 'SambaNova', logo: 'S', section: 'additional', recommended: false, supportsLocal: false,
    description: 'Cloud inference provider and additional ALTREX fallback.',
    apiKeyUrl: 'https://cloud.sambanova.ai/apis', docsUrl: 'https://docs.sambanova.ai/docs/en/get-started/api-keys-urls',
    requiresApiKey: true, requiredFields: [apiKey()], testStrategy: 'openai-compatible',
    baseUrl: 'https://api.sambanova.ai/v1', defaultModel: 'Meta-Llama-3.3-70B-Instruct',
    approvedHosts: ['cloud.sambanova.ai', 'docs.sambanova.ai'],
  },
  groq: {
    id: 'groq', name: 'Groq', logo: 'GQ', section: 'additional', recommended: false, supportsLocal: false,
    description: 'Low-latency inference for supported open models.',
    apiKeyUrl: 'https://console.groq.com/keys', docsUrl: 'https://console.groq.com/docs/quickstart',
    requiresApiKey: true, requiredFields: [apiKey()], testStrategy: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'openai/gpt-oss-20b',
    approvedHosts: ['console.groq.com'],
  },
  openrouter: {
    id: 'openrouter', name: 'OpenRouter', logo: 'OR', section: 'additional', recommended: false, supportsLocal: false,
    description: 'A unified catalog with models from many AI providers.',
    apiKeyUrl: 'https://openrouter.ai/settings/keys', docsUrl: 'https://openrouter.ai/docs/quickstart',
    requiresApiKey: true, requiredFields: [apiKey()], testStrategy: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'qwen/qwen3-coder', approvedHosts: ['openrouter.ai'],
  },
  nvidia: {
    id: 'nvidia', name: 'NVIDIA NIM', logo: 'N', section: 'additional', recommended: false, supportsLocal: false,
    description: 'Hosted NVIDIA NIM endpoints and accelerated models.',
    apiKeyUrl: 'https://build.nvidia.com/settings/api-keys', docsUrl: 'https://docs.api.nvidia.com/nim/docs/api-quickstart',
    requiresApiKey: true, requiredFields: [apiKey()], testStrategy: 'openai-compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1', defaultModel: 'nvidia/nemotron-3-super-120b-a12b',
    approvedHosts: ['build.nvidia.com', 'docs.api.nvidia.com'],
  },
  'nim-local': {
    id: 'nim-local', name: 'NVIDIA NIM (self-hosted)', logo: 'N', section: 'advanced', recommended: false, supportsLocal: true,
    description: 'A NIM microservice you run yourself (OpenAI-compatible API).',
    apiKeyUrl: null, docsUrl: 'https://docs.nvidia.com/nim/large-language-models/latest/getting-started.html',
    requiresApiKey: false, requiredFields: [apiKey('Optional API Key')], testStrategy: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8000/v1', defaultModel: '', approvedHosts: ['docs.nvidia.com'], userBaseUrl: true,
  },
  openai: {
    id: 'openai', name: 'OpenAI', logo: 'AI', section: 'additional', recommended: false, supportsLocal: false,
    description: 'OpenAI API models for general and agent workflows.',
    apiKeyUrl: 'https://platform.openai.com/api-keys', docsUrl: 'https://platform.openai.com/docs/quickstart',
    requiresApiKey: true, requiredFields: [apiKey()], testStrategy: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5', approvedHosts: ['platform.openai.com'],
  },
  'crax-gpt': {
    id: 'crax-gpt', name: 'crax-gpt', logo: 'C', section: 'recommended', recommended: true, supportsLocal: false,
    description: 'Free OpenAI-compatible AI gateway: one key, many live models.',
    // crax-gpt offers no third-party OAuth/device login; keys are created in the account's API key settings.
    apiKeyUrl: 'https://gpt.crax.lol/', docsUrl: 'https://gpt.crax.lol/',
    requiresApiKey: true, requiredFields: [apiKey()], testStrategy: 'openai-compatible',
    // Models are always discovered from /v1/models; nothing is hard-coded.
    baseUrl: 'https://gpt.crax.lol/v1', defaultModel: '', approvedHosts: ['gpt.crax.lol'],
    // Not shown in the UI; lets a mirror or test server be used without code changes.
    userBaseUrl: true,
  },
  custom: {
    id: 'custom', name: 'OpenAI-compatible', logo: 'API', section: 'advanced', recommended: false, supportsLocal: true,
    description: 'Connect a trusted OpenAI-compatible endpoint.',
    apiKeyUrl: null, docsUrl: 'https://platform.openai.com/docs/api-reference',
    requiresApiKey: false, requiredFields: [apiKey('Optional API Key')], testStrategy: 'openai-compatible',
    baseUrl: 'https://', defaultModel: '', approvedHosts: ['platform.openai.com'], userBaseUrl: true,
  },
}

export const providerDefinitions = Object.values(PROVIDER_REGISTRY)

export function providerDefinition(providerId: ProviderId): ProviderDefinition {
  return PROVIDER_REGISTRY[providerId]
}

export function officialProviderUrl(providerId: ProviderId, kind: ProviderLinkKind): string {
  const provider = PROVIDER_REGISTRY[providerId]
  if (!provider) throw new Error('Could not open official provider page.')
  const value = kind === 'apiKey' ? provider.apiKeyUrl : kind === 'accountId' ? provider.accountIdUrl : kind === 'install' ? provider.installUrl : provider.docsUrl
  if (!value) throw new Error('This provider does not offer that external destination.')
  const url = new URL(value)
  if (url.protocol !== 'https:' || !provider.approvedHosts.includes(url.hostname)) throw new Error('Could not open official provider page.')
  return url.toString()
}

/** True when a base URL points at this machine (loopback). Everything else, including tunnels, is cloud. */
export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
  } catch { return false }
}

/** Privacy class of a configured endpoint: repository data leaves the machine unless it is local. */
export function endpointPrivacy(baseUrl: string): 'local' | 'cloud' {
  return isLoopbackUrl(baseUrl) ? 'local' : 'cloud'
}

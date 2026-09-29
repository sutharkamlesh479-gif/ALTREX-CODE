import type { ProviderMessage } from '../messages'

export type UnifiedProviderRequest = {
  model: string
  messages: ProviderMessage[]
  tools: readonly unknown[]
  stream: boolean
  maxOutput: number
}

export abstract class BaseProviderAdapter {
  abstract readonly id: string
  headers(apiKey: string): Record<string, string> { return apiKey ? { Authorization: `Bearer ${apiKey}` } : {} }
  build(request: UnifiedProviderRequest): Record<string, unknown> {
    return {
      model: request.model,
      stream: request.stream,
      messages: request.messages,
      max_tokens: request.maxOutput,
      ...(request.tools.length ? { tools: request.tools, tool_choice: 'auto' } : {}),
    }
  }
}

export class OpenAIAdapter extends BaseProviderAdapter {
  readonly id = 'openai' as const
  override build(request: UnifiedProviderRequest): Record<string, unknown> {
    const body = super.build(request)
    if (/^(?:o\d|gpt-5)/i.test(request.model)) {
      delete body.max_tokens
      body.max_completion_tokens = request.maxOutput
    }
    return body
  }
}

export class GroqAdapter extends BaseProviderAdapter { readonly id = 'groq' as const }
export class GoogleGeminiAdapter extends BaseProviderAdapter {
  readonly id = 'google' as const
  // Gemini's current OpenAI compatibility layer uses bearer authorization. Keeping
  // it here allows Google auth-key changes without altering the shared transport.
  override headers(apiKey: string): Record<string, string> { return { Authorization: `Bearer ${apiKey}` } }
}
export class CerebrasAdapter extends BaseProviderAdapter { readonly id = 'cerebras' as const }
export class CloudflareWorkersAiAdapter extends BaseProviderAdapter { readonly id = 'cloudflare' as const }
export class OllamaAdapter extends BaseProviderAdapter {
  readonly id = 'ollama' as const
  override headers(): Record<string, string> { return {} }
}
export class SambaNovaAdapter extends BaseProviderAdapter { readonly id = 'sambanova' as const }

export class NvidiaNimAdapter extends BaseProviderAdapter {
  readonly id = 'nvidia' as const
  override build(request: UnifiedProviderRequest): Record<string, unknown> {
    const body = super.build(request)
    if (request.model.includes('nemotron-3-ultra')) Object.assign(body, { temperature: 1, top_p: .95, reasoning_budget: 2048, chat_template_kwargs: { enable_thinking: true, force_nonempty_content: true, medium_effort: true } })
    return body
  }
}

export class OpenRouterAdapter extends BaseProviderAdapter {
  readonly id = 'openrouter' as const
  // Optional OpenRouter attribution headers (no user data).
  override headers(apiKey: string): Record<string, string> { return { ...super.headers(apiKey), 'X-Title': 'ALTREX CODE' } }
}
export class OpenAICompatibleAdapter extends BaseProviderAdapter { readonly id = 'custom' as const }

const adapters: Record<string, BaseProviderAdapter> = {
  openai: new OpenAIAdapter(), google: new GoogleGeminiAdapter(), cerebras: new CerebrasAdapter(), cloudflare: new CloudflareWorkersAiAdapter(), ollama: new OllamaAdapter(), sambanova: new SambaNovaAdapter(), groq: new GroqAdapter(), nvidia: new NvidiaNimAdapter(), openrouter: new OpenRouterAdapter(), custom: new OpenAICompatibleAdapter(),
  // Self-hosted NVIDIA NIM speaks the same dialect as hosted NIM.
  'nim-local': new NvidiaNimAdapter(),
}
/** Wire dialect for a provider; unknown providers use the plain OpenAI-compatible dialect. */
export function providerAdapter(providerId: string): BaseProviderAdapter { return adapters[providerId] ?? adapters.custom! }

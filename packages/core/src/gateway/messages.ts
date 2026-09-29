// Normalized chat message shapes used by the current OpenAI-compatible transport.
// Phase 2 replaces these with the Gateway request types in PROVIDER_SPEC.md §3.
export type ProviderContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'auto' } }

export type ProviderMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ProviderContentPart[] | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

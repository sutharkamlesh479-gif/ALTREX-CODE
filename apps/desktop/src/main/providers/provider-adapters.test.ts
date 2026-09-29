import { describe, expect, it } from 'vitest'
import { providerAdapter } from './provider-adapters'

const request = { model: 'model', messages: [{ role: 'user' as const, content: 'hi' }], tools: [{}], stream: false, maxOutput: 128 }
describe('provider payload adapters', () => {
  it('uses max_completion_tokens for OpenAI reasoning models', () => {
    const body = providerAdapter('openai').build({ ...request, model: 'gpt-5-mini' })
    expect(body).toMatchObject({ max_completion_tokens: 128, tool_choice: 'auto' })
    expect(body).not.toHaveProperty('max_tokens')
  })

  it('adds NVIDIA Nemotron reasoning fields only for that model family', () => {
    const nvidia = providerAdapter('nvidia').build({ ...request, model: 'nvidia/nemotron-3-ultra' })
    const groq = providerAdapter('groq').build(request)
    expect(nvidia).toMatchObject({ reasoning_budget: 2048, chat_template_kwargs: { enable_thinking: true } })
    expect(groq).not.toHaveProperty('reasoning_budget')
  })

  it('isolates Gemini bearer authentication and keeps local Ollama keyless', () => {
    expect(providerAdapter('google').headers('gemini-secret')).toEqual({ Authorization: 'Bearer gemini-secret' })
    expect(providerAdapter('ollama').headers('ignored')).toEqual({})
    for (const id of ['cerebras', 'cloudflare', 'sambanova', 'openrouter'] as const) expect(providerAdapter(id).build(request)).toHaveProperty('model', 'model')
  })
})

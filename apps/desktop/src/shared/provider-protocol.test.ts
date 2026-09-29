import { describe, expect, it } from 'vitest'
import { describeProviderFailure, normalizeProviderBaseUrl, parseOpenAiStreamBlock } from './provider-protocol'
import { providerPresets } from './desktop-api'

describe('provider protocol safety', () => {
  it('allows secure remote endpoints and local HTTP only', () => {
    expect(normalizeProviderBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
    expect(normalizeProviderBaseUrl('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1')
    expect(() => normalizeProviderBaseUrl('http://example.com/v1')).toThrow('HTTPS')
  })

  it('extracts streamed OpenAI-compatible text deltas', () => {
    expect(parseOpenAiStreamBlock('data: {"choices":[{"delta":{"content":"Hello"}}]}')).toBe('Hello')
    expect(parseOpenAiStreamBlock('data: [DONE]')).toBeNull()
    expect(parseOpenAiStreamBlock('event: ping')).toBeNull()
  })

  it('maps common provider failures without exposing response internals', () => {
    expect(describeProviderFailure(401, 'secret detail')).toContain('Authentication failed')
    expect(describeProviderFailure(429, '')).toContain('rate limited')
    expect(describeProviderFailure(503, '')).toContain('unavailable')
  })

  it('includes NVIDIA NIM with its official OpenAI-compatible endpoint', () => {
    expect(providerPresets.find((provider) => provider.id === 'nvidia')).toMatchObject({
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      model: 'nvidia/nemotron-3-super-120b-a12b',
    })
  })
})

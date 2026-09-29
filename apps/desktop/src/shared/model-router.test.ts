import { describe, expect, it } from 'vitest'
import { selectCodingModelCandidates, selectNvidiaCodingModel } from './model-router'

describe('NVIDIA AUTO model router', () => {
  it('uses Qwen Coder for feature and frontend implementation', () => {
    expect(selectNvidiaCodingModel('Build a React gaming storefront', []).model).toBe('qwen/qwen3-coder-480b-a35b-instruct')
  })

  it('uses Nemotron Ultra for complex debugging and architecture', () => {
    expect(selectNvidiaCodingModel('Debug a database race condition and redesign the architecture', []).model).toBe('nvidia/nemotron-3-ultra-550b-a55b')
  })

  it('falls back to an actually available model', () => {
    expect(selectNvidiaCodingModel('Write documentation', ['custom/available'], 'custom/available').model).toBe('custom/available')
  })

  it('builds a ranked Groq failover chain and excludes non-coding audio models', () => {
    const route = selectCodingModelCandidates('groq', 'Build a complete React application', [
      'whisper-large-v3',
      'llama-3.3-70b-versatile',
      'qwen/qwen3-coder-32b',
      'openai/gpt-oss-120b',
    ], 'llama-3.3-70b-versatile')

    expect(route.models[0]).toBe('qwen/qwen3-coder-32b')
    expect(route.models).toContain('llama-3.3-70b-versatile')
    expect(route.models).not.toContain('whisper-large-v3')
  })

  it('keeps a free coding route near the front of an OpenRouter fallback chain', () => {
    const route = selectCodingModelCandidates('openrouter', 'Build a small webpage', ['openai/gpt-4.1-mini', 'qwen/qwen3-coder', 'cohere/north-mini-code:free'], 'openai/gpt-4.1-mini')
    expect(route.models[0]).toBe('cohere/north-mini-code:free')
  })

  it('prefers a stable Gemini Flash model over paid preview and special-purpose models', () => {
    const route = selectCodingModelCandidates('google', 'Build an application', [
      'gemini-3.1-pro-preview-customtools',
      'gemini-3.8-flash',
      'gemini-3.1-flash-image',
      'gemini-embedding-001',
    ], 'gemini-3.8-flash')
    expect(route.models[0]).toBe('gemini-3.8-flash')
    expect(route.models).not.toContain('gemini-embedding-001')
  })
})

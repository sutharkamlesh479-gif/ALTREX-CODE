import { describe, expect, it } from 'vitest'
import { classifyProviderHttpError } from './provider-errors'

describe('provider error classification', () => {
  it('separates temporary throttling from exhausted quota', () => {
    expect(classifyProviderHttpError(429, '{"error":{"message":"Too many requests"}}', '2')).toMatchObject({ category: 'RATE_LIMITED', retryable: true, retryAfterMs: 2000 })
    expect(classifyProviderHttpError(429, '{"error":{"message":"Output tokens per minute reached. Try again in 26s. Upgrade billing tier."}}', '27')).toMatchObject({ category: 'RATE_LIMITED', retryable: true, retryAfterMs: 27000 })
    expect(classifyProviderHttpError(429, '{"error":{"message":"Account credit quota exhausted"}}', null)).toMatchObject({ category: 'QUOTA_EXHAUSTED', retryable: false })
    expect(classifyProviderHttpError(429, '{"error":{"message":"You exceeded your current quota. Quota exceeded for metric generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro-preview. Please retry in 10s.","status":"RESOURCE_EXHAUSTED"}}', null)).toMatchObject({ category: 'QUOTA_EXHAUSTED', retryable: false })
  })

  it('recognizes model, tool, context, authentication, and server failures', () => {
    expect(classifyProviderHttpError(401, 'invalid api key', null).category).toBe('INVALID_API_KEY')
    expect(classifyProviderHttpError(404, 'model does not exist', null).category).toBe('MODEL_NOT_FOUND')
    expect(classifyProviderHttpError(400, 'tool calling is not supported', null).category).toBe('TOOLS_UNSUPPORTED')
    expect(classifyProviderHttpError(413, 'request too large', null).category).toBe('CONTEXT_TOO_LARGE')
    expect(classifyProviderHttpError(503, 'maintenance', null).category).toBe('PROVIDER_SERVER_ERROR')
  })

  it('redacts credential-shaped strings from technical details', () => {
    const result = classifyProviderHttpError(400, 'Bearer sk-secretvalue123456789 request rejected', null)
    expect(result.technicalDetails).not.toContain('secretvalue')
    expect(result.technicalDetails).toContain('[REDACTED]')
  })
})

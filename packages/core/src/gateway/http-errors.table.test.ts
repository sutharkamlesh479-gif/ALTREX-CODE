import { describe, expect, it } from 'vitest'
import { classifyProviderHttpError, type ProviderErrorCategory } from './http-errors'

// Characterization table (Phase 1): pins the CURRENT classifier so the Phase 2 gateway migration
// (PROVIDER_SPEC.md §5) changes behaviour only deliberately. Rows marked "V4 change" are known gaps.
const body = (message: string) => JSON.stringify({ error: { message } })
type Row = [status: number, responseBody: string, retryAfter: string | null, category: ProviderErrorCategory, retryable: boolean, retryAfterMs: number]

const rows: Row[] = [
  [401, '', null, 'INVALID_API_KEY', false, 0],
  [401, body('Incorrect API key provided'), null, 'INVALID_API_KEY', false, 0],
  [401, body('Your organization lacks access'), null, 'AUTH_ERROR', false, 0],
  [402, '', null, 'QUOTA_EXHAUSTED', false, 0],
  [403, body('invalid api key'), null, 'INVALID_API_KEY', false, 0],
  [403, body('quota exceeded for this project'), null, 'QUOTA_EXHAUSTED', false, 0],
  [403, body('region not supported'), null, 'AUTH_ERROR', false, 0],
  [404, body('The model `x` does not exist'), null, 'MODEL_NOT_FOUND', false, 0],
  [404, 'Not Found', null, 'ENDPOINT_NOT_FOUND', false, 0], // Phase 3: generic 404 = wrong base URL (was MODEL_UNAVAILABLE)
  [404, '<!DOCTYPE html><html><body>404</body></html>', null, 'ENDPOINT_NOT_FOUND', false, 0],
  [404, '404 page not found', null, 'ENDPOINT_NOT_FOUND', false, 0],
  [404, JSON.stringify({ detail: 'Not Found' }), null, 'ENDPOINT_NOT_FOUND', false, 0],
  [404, JSON.stringify({ status: 404, title: 'Not Found', detail: "Function 'abc': Not found for account 'xyz'" }), null, 'MODEL_UNAVAILABLE', false, 0], // NVIDIA: model-level
  [405, 'Method Not Allowed', null, 'ENDPOINT_NOT_FOUND', false, 0],
  [400, body('API key not valid. Please pass a valid API key.'), null, 'INVALID_API_KEY', false, 0], // Gemini
  [400, JSON.stringify({ error: { code: 400, message: 'Invalid argument', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }), null, 'INVALID_API_KEY', false, 0],
  [410, '', null, 'MODEL_UNAVAILABLE', false, 0],
  [408, '', null, 'TIMEOUT', true, 0],
  [413, 'Request too large', null, 'CONTEXT_TOO_LARGE', false, 0],
  [422, body('tools are not supported for this model'), null, 'TOOLS_UNSUPPORTED', false, 0],
  [400, body('This model does not support function calling'), null, 'TOOLS_UNSUPPORTED', false, 0],
  [400, body('maximum context length is 8192 tokens'), null, 'CONTEXT_TOO_LARGE', false, 0],
  [400, body('model not found: foo'), null, 'MODEL_NOT_FOUND', false, 0],
  [400, body('temperature must be <= 2'), null, 'BAD_REQUEST', false, 0],
  [429, body('Rate limit reached for requests per minute'), '7', 'RATE_LIMITED', true, 7000],
  [429, body('You exceeded your current quota, please check your plan and billing'), null, 'QUOTA_EXHAUSTED', false, 0],
  [429, body('insufficient credits'), null, 'QUOTA_EXHAUSTED', false, 0],
  [429, body('Too many requests'), '99999', 'RATE_LIMITED', true, 3_600_000], // Retry-After is capped at 1 hour
  [500, '', null, 'PROVIDER_SERVER_ERROR', true, 0],
  [502, '', null, 'PROVIDER_SERVER_ERROR', true, 0],
  [503, body('overloaded'), '3', 'PROVIDER_SERVER_ERROR', true, 3000],
  [504, '', null, 'PROVIDER_SERVER_ERROR', true, 0],
  [418, '', null, 'UNKNOWN', false, 0],
]

describe('provider HTTP error classification (characterization)', () => {
  it.each(rows)('HTTP %i %s (Retry-After %s) → %s retryable=%s wait=%i', (status, responseBody, retryAfter, category, retryable, retryAfterMs) => {
    const result = classifyProviderHttpError(status, responseBody, retryAfter)
    expect(result.category).toBe(category)
    expect(result.retryable).toBe(retryable)
    expect(result.retryAfterMs).toBe(retryAfterMs)
    expect(result.message.length).toBeGreaterThan(0)
  })

  it('parses HTTP-date Retry-After values and caps them at one hour', () => {
    expect(classifyProviderHttpError(429, '', new Date(Date.now() + 30_000).toUTCString()).retryAfterMs).toBeGreaterThan(25_000)
    expect(classifyProviderHttpError(429, '', 'Wed, 21 Oct 2099 07:28:00 GMT').retryAfterMs).toBe(3_600_000)
  })

  it('extracts a numeric token limit only when the number follows "limit"/"maximum" directly', () => {
    expect(classifyProviderHttpError(413, 'context limit 6,000 tokens', null).tokenLimit).toBe(6000)
    // V4 change: "maximum context length is 8192 tokens" should yield 8192 (PROVIDER_SPEC §5).
    expect(classifyProviderHttpError(400, body('maximum context length is 8192 tokens'), null).tokenLimit).toBeUndefined()
  })

  it('never echoes bearer tokens or common key formats into technical details', () => {
    const details = classifyProviderHttpError(401, 'Bearer abc.def.ghi sk-proj-abcdefghijklmnop nvapi-abcdefghijklmn gsk_abcdefghijklmnop', null).technicalDetails
    expect(details).not.toMatch(/abc\.def\.ghi|sk-proj-abcdefghijklmnop|nvapi-abcdefghijklmn|gsk_abcdefghijklmnop/)
  })
})

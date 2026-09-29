export type ProviderErrorCategory =
  | 'AUTH_ERROR'
  | 'INVALID_API_KEY'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'QUOTA_EXHAUSTED'
  | 'BAD_REQUEST'
  | 'TOOLS_UNSUPPORTED'
  | 'CONTEXT_TOO_LARGE'
  | 'TIMEOUT'
  | 'CONNECTION_ERROR'
  | 'PROVIDER_SERVER_ERROR'
  | 'CANCELLED'
  /** Stream frames were unparsable, or the stream ended with no usable content. */
  | 'STREAM_MALFORMED'
  /** The connection dropped mid-stream. */
  | 'STREAM_INTERRUPTED'
  /** A streamed or returned tool call was incomplete, had invalid JSON arguments, or named an unknown tool. */
  | 'TOOL_CALL_MALFORMED'
  /** The model stopped at its output limit without a usable result. */
  | 'OUTPUT_TRUNCATED'
  /** The base URL does not expose this API (generic 404/405, HTML page, unknown route). */
  | 'ENDPOINT_NOT_FOUND'
  /** The user disconnected this provider while the request was in flight. */
  | 'PROVIDER_DISCONNECTED'
  | 'UNKNOWN'

export type ClassifiedProviderError = {
  category: ProviderErrorCategory
  message: string
  retryable: boolean
  retryAfterMs: number
  technicalDetails: string
  tokenLimit?: number
}

function providerDetail(body: string): string {
  let detail = body.trim()
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; code?: unknown; type?: unknown }; message?: unknown; detail?: unknown; title?: unknown }
    // OpenAI-style error.message, plain message, FastAPI/vLLM/NVIDIA `detail`, or RFC 7807 `title`.
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message : typeof parsed.message === 'string' ? parsed.message
      : typeof parsed.detail === 'string' ? parsed.detail : typeof parsed.title === 'string' ? parsed.title : ''
    const code = typeof parsed.error?.code === 'string' || typeof parsed.error?.code === 'number' ? String(parsed.error.code) : ''
    const type = typeof parsed.error?.type === 'string' ? parsed.error.type : ''
    detail = [message, code && `code=${code}`, type && `type=${type}`].filter(Boolean).join(' | ')
  } catch { /* Preserve bounded plain-text provider detail. */ }
  return detail
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|nvapi|gsk|or)[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .slice(0, 1200)
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 0
  const seconds = Number(value)
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(duration) ? Math.max(0, Math.min(duration, 60 * 60 * 1000)) : 0
}

export function classifyProviderHttpError(status: number, body: string, retryAfter: string | null): ClassifiedProviderError {
  const detail = providerDetail(body)
  const source = `${body} ${detail}`.toLowerCase()
  const retryAfterMs = parseRetryAfter(retryAfter)
  const temporaryRate = /rate[_\s-]*limit|rate[_\s-]*limit[_\s-]*exceeded|too[_\s-]*many[_\s-]*requests|per[_\s-]*(?:second|minute|hour)|requests?[_\s-]*per|tokens?[_\s-]*per[_\s-]*(?:minute|second)|try again in/.test(source)
  const quota = /quota[_\s-]*(?:exceeded|exhausted|depleted|reached)|quota[_\s-]*failure|insufficient[_\s-]*(?:fund|balance|credit)|credit[_\s-]*(?:balance|exhausted)|spend[_\s-]*limit|monthly[_\s-]*limit|daily[_\s-]*limit|usage[_\s-]*limit|resource[_\s-]*exhausted|payment[_\s-]*required/.test(source)
  const nonRetryableQuota = /quota[_\s-]*exceeded|quota[_\s-]*failure|(?:per|each)[_\s-]*day|requests?perday|limit\s*[:=]\s*0\b|check (?:your )?(?:plan|billing)|free[_\s-]*tier.*(?:unavailable|not available)|insufficient[_\s-]*(?:fund|balance|credit)|credit[_\s-]*(?:balance|exhausted)|spend[_\s-]*limit|monthly[_\s-]*limit|daily[_\s-]*limit|usage[_\s-]*limit|payment[_\s-]*required/.test(source)
  const invalidKey = /invalid[_\s-]*(?:api[_\s-]*)?key|incorrect[_\s-]*(?:api[_\s-]*)?key|api[_\s-]*key.*(?:invalid|incorrect|expired|not[_\s-]*valid)|api_key_invalid|invalid[_\s-]*token/.test(source)
  // A generic not-found page means the base URL is wrong; a detailed 404 (e.g. NVIDIA "Function … not found for account") is model-level.
  const headline = detail.split(' | ')[0]?.trim() ?? ''
  const genericNotFound = !headline || /^(?:<!doctype|<html)|^(?:404\s*)?(?:page\s+)?not\s+found\.?$|^cannot (?:post|get)\b|no route|unknown (?:url|path|endpoint)|invalid url/i.test(headline)
  const modelMissing = /model.*(?:not found|does not exist|unknown|invalid|retired|deprecated)|no such model/.test(source)
  const toolsUnsupported = /(?:tool|function)(?:[_\s-]*(?:call|calling|choice))?.*(?:not supported|unsupported|not available)|unsupported.*(?:tool|function)|does not support.*(?:tool|function)/.test(source)
  const contextTooLarge = /context.*(?:length|window|limit)|too many tokens|token.*(?:limit|maximum)|request too large|maximum context/.test(source)
  const limitMatch = /(?:limit|maximum)\s*[:=]?\s*([\d,]+)/i.exec(body)
  const tokenLimit = limitMatch ? Number(limitMatch[1]!.replaceAll(',', '')) : undefined

  let category: ProviderErrorCategory = 'UNKNOWN'
  if (status === 401) category = invalidKey || !detail ? 'INVALID_API_KEY' : 'AUTH_ERROR'
  else if (status === 402) category = 'QUOTA_EXHAUSTED'
  else if (status === 403) category = invalidKey ? 'INVALID_API_KEY' : quota ? 'QUOTA_EXHAUSTED' : 'AUTH_ERROR'
  else if (status === 404) category = modelMissing ? 'MODEL_NOT_FOUND' : genericNotFound ? 'ENDPOINT_NOT_FOUND' : 'MODEL_UNAVAILABLE'
  else if (status === 405) category = 'ENDPOINT_NOT_FOUND'
  else if (status === 410) category = 'MODEL_UNAVAILABLE'
  else if (status === 413) category = 'CONTEXT_TOO_LARGE'
  else if (status === 408) category = 'TIMEOUT'
  else if (status === 429) category = nonRetryableQuota ? 'QUOTA_EXHAUSTED' : temporaryRate ? 'RATE_LIMITED' : quota ? 'QUOTA_EXHAUSTED' : 'RATE_LIMITED'
  else if (status === 400 || status === 422) category = invalidKey ? 'INVALID_API_KEY' : toolsUnsupported ? 'TOOLS_UNSUPPORTED' : contextTooLarge ? 'CONTEXT_TOO_LARGE' : modelMissing ? 'MODEL_NOT_FOUND' : 'BAD_REQUEST'
  else if (status >= 500) category = 'PROVIDER_SERVER_ERROR'

  const messages: Record<ProviderErrorCategory, string> = {
    AUTH_ERROR: 'The provider rejected this credential or account permission.',
    INVALID_API_KEY: 'The provider confirmed that the API key is invalid.',
    MODEL_NOT_FOUND: 'The selected model does not exist on this provider.',
    MODEL_UNAVAILABLE: 'The selected model is currently unavailable.',
    RATE_LIMITED: 'The provider is temporarily rate limited.',
    QUOTA_EXHAUSTED: 'The provider account quota or credits are exhausted.',
    BAD_REQUEST: 'The provider rejected this request format.',
    TOOLS_UNSUPPORTED: 'This model does not support the required tool calling format.',
    CONTEXT_TOO_LARGE: 'The request exceeds this model’s context limit.',
    TIMEOUT: 'The provider request timed out.',
    CONNECTION_ERROR: 'ALTREX could not connect to the provider.',
    PROVIDER_SERVER_ERROR: 'The provider is temporarily unavailable.',
    CANCELLED: 'The provider request was cancelled.',
    STREAM_MALFORMED: 'The provider sent a response ALTREX could not read.',
    STREAM_INTERRUPTED: 'The provider connection dropped while responding.',
    TOOL_CALL_MALFORMED: 'The model produced an invalid tool call.',
    OUTPUT_TRUNCATED: 'Model output reached its limit. Increase output budget or request a smaller edit.',
    ENDPOINT_NOT_FOUND: 'This address does not provide a compatible model API. Check the provider base URL.',
    PROVIDER_DISCONNECTED: 'The provider was disconnected.',
    UNKNOWN: 'The provider request failed for an unknown reason.',
  }
  const retryable = category === 'RATE_LIMITED' || category === 'TIMEOUT' || category === 'PROVIDER_SERVER_ERROR'
  return { category, message: messages[category], retryable, retryAfterMs, technicalDetails: detail || `HTTP ${status}`, ...(tokenLimit ? { tokenLimit } : {}) }
}

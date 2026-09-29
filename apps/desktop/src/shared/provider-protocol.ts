export type OpenAiChatChunk = {
  choices?: Array<{
    delta?: { content?: string | null }
  }>
}

export function normalizeProviderBaseUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.username || url.password) throw new Error('Provider URLs cannot contain credentials.')
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new Error('Provider endpoint must use HTTPS. HTTP is allowed only for localhost.')
  }
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/$/, '')
}

export function parseOpenAiStreamBlock(block: string): string | null {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())

  if (dataLines.length === 0) return null
  const data = dataLines.join('\n')
  if (data === '[DONE]') return null

  try {
    const parsed = JSON.parse(data) as OpenAiChatChunk
    return parsed.choices?.[0]?.delta?.content ?? null
  } catch {
    return null
  }
}

export function describeProviderFailure(status: number, body: string): string {
  if (status === 401 || status === 403) return 'Authentication failed. Check the API key and provider permissions.'
  if (status === 429) return 'The provider is rate limited or its quota is exhausted. Try again later or choose another provider.'
  if (status >= 500) return 'The provider is currently unavailable. Try again or choose another provider.'
  if (status === 413) return 'Request exceeds the provider token budget.'
  if (status === 408) return 'The provider request timed out.'
  if (status === 404 || status === 410) return 'The selected model or endpoint is unavailable.'
  void body
  return `Provider rejected the request (HTTP ${status}). Check model capabilities and connection settings.`
}


import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiCompatibleProvider } from './openai-compatible'
import { RequestManager, type Transport } from './request-manager'
const transport: Transport = (url, init) => fetch(url, init)
const provider = (timeout?: number) => new OpenAiCompatibleProvider(timeout, new RequestManager(transport), transport)

afterEach(() => vi.unstubAllGlobals())

describe('OpenAI-compatible provider model discovery', () => {
  it('reports authentication and model availability failures separately', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 410 })))
    const result = await provider().healthCheck({
      providerId: 'nvidia',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      model: 'retired-model',
      apiKey: 'nvapi-test-key',
    })

    expect(result).toMatchObject({
      ok: false,
      failureKind: 'model-unavailable',
      message: 'The selected model is currently unavailable.',
    })
  })

  it('loads and sorts models from NVIDIA NIM-compatible endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 'qwen/qwen3-coder-480b-a35b-instruct' },
        { id: 'nvidia/nemotron-3-ultra-550b-a55b' },
        { id: 'qwen/qwen3-coder-480b-a35b-instruct' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    const models = await provider().listModels({
      providerId: 'nvidia',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      model: 'qwen/qwen3-coder-480b-a35b-instruct',
      apiKey: 'nvapi-test-key',
    })

    expect(models).toEqual([
      'nvidia/nemotron-3-ultra-550b-a55b',
      'qwen/qwen3-coder-480b-a35b-instruct',
    ])
  })

  it('normalizes Gemini catalog resource names for OpenAI-compatible requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-3.1-pro-preview-customtools' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    // Phase 3: Google profiles default to the native Gemini API; this covers the explicit opt-in to
    // Google's OpenAI-compatibility layer.
    const models = await provider().listModels({
      providerId: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-3.8-flash',
      apiKey: 'google-test-key',
      additionalFields: { api: 'openai-compatible' },
    })

    expect(models).toEqual(['gemini-3.1-pro-preview-customtools', 'gemini-3.8-flash'])
  })

  it('lists Gemini models from the native API by default, with limits, sending the key in a header', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      models: [
        { name: 'models/gemini-3.8-flash', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const target = provider()
    const connection = { providerId: 'google' as const, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', apiKey: 'google-test-key' }
    expect(await target.listModels(connection)).toEqual(['gemini-3.8-flash'])
    expect(target.catalogMetadata(connection)).toEqual([{ id: 'gemini-3.8-flash', contextWindow: 1_048_576, maxOutput: 65_536 }])
    expect(fetchMock.mock.calls[0]![0]).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000')
    expect(fetchMock.mock.calls[0]![0]).not.toContain('google-test-key')
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)['x-goog-api-key']).toBe('google-test-key')
  })

  it('sends NVIDIA Nemotron coding-agent reasoning and tool-call flags', async () => {
    let requestBody: Record<string, unknown> = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ choices: [{ message: { content: 'done', tool_calls: [] } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    await provider().complete({
      connection: {
        providerId: 'nvidia',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        model: 'nvidia/nemotron-3-ultra-550b-a55b',
        apiKey: 'nvapi-test-key',
      },
      messages: [{ role: 'user', content: 'Fix the project' }],
      tools: [],
      signal: new AbortController().signal,
    })

    expect(requestBody).toMatchObject({
      // Default output is 4096; with an unknown context window it is capped at half the 6000-token input budget.
      max_tokens: 3000,
      reasoning_budget: 2048,
      chat_template_kwargs: {
        enable_thinking: true,
        force_nonempty_content: true,
        medium_effort: true,
      },
    })
  })

  it('fails a stalled provider request instead of spinning forever', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })))

    await expect(provider(10).complete({
      connection: {
        providerId: 'nvidia',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        model: 'nvidia/nemotron-3-ultra-550b-a55b',
        apiKey: 'nvapi-test-key',
      },
      messages: [{ role: 'user', content: 'Fix the project' }],
      tools: [],
      signal: new AbortController().signal,
    })).rejects.toThrow('deadline exceeded')
  })

  it('normalizes Ollama content-encoded function calls from local coding models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"name":"write_file","arguments":{"path":"index.html","content":"ready"}}' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    const result = await provider().complete({
      connection: { providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b-instruct', apiKey: '' },
      messages: [{ role: 'user', content: 'Create the file.' }],
      tools: [{ type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } }],
      signal: new AbortController().signal,
    })

    expect(result.content).toBe('')
    expect(result.toolCalls).toMatchObject([{ name: 'write_file', arguments: '{"path":"index.html","content":"ready"}' }])
  })
})


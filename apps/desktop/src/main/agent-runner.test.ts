import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatStreamEvent } from '../shared/desktop-api'
import { runCodingAgent } from './agent-runner'
import type { ModelProvider } from './providers/model-provider'
import { ProviderFailure } from './providers/request-manager'
import { ModelRegistry, RoleRouter } from './providers/model-registry'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) if (resolve(root).startsWith(resolve(tmpdir()))) rmSync(root, { recursive: true, force: true })
})

describe('coding agent loop', () => {
  it('passes image previews and text-file contents as multimodal provider input', async () => {
    const root = mkdtempSync(join(tmpdir(), 'altrex-agent-'))
    roots.push(root)
    let receivedContent: unknown = null
    const provider: ModelProvider = {
      protocol: 'test',
      healthCheck: async () => ({ ok: true, message: 'ok', latencyMs: 1 }),
      listModels: async () => ['vision-coder'],
      stream: async () => undefined,
      complete: async ({ messages }) => {
        receivedContent = messages.filter((message) => message.role === 'user').at(-1)?.content
        return { content: 'I inspected both attachments.', toolCalls: [] }
      },
    }
    const textConnection = { providerId: 'nvidia' as const, apiKey: 'test-key-value', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'text-coder' }
    const visionConnection = { ...textConnection, model: 'vision-coder' }
    const registry = new ModelRegistry(join(root, 'models.json'))
    registry.observeCapabilities(textConnection, { supportsChat: true, supportsTools: true, supportsVision: false })
    registry.observeCapabilities(visionConnection, { supportsChat: true, supportsTools: true, supportsVision: true })
    const router = new RoleRouter(provider, [textConnection, visionConnection], registry)
    await runCodingAgent({
      provider,
      connection: textConnection,
      router,
      request: { requestId: 'attachment-123', projectPath: root, mode: 'AGENT', modelSelection: 'AUTO', messages: [{ role: 'user', content: 'What do these show?' }], attachments: [] },
      repositoryContext: '(empty project)',
      attachments: [
        { id: 'image-1', name: 'screen.png', mimeType: 'image/png', size: 10, kind: 'image', imageDataUrl: 'data:image/png;base64,AAAA' },
        { id: 'text-1', name: 'notes.txt', mimeType: 'text/plain', size: 12, kind: 'text', textContent: 'Important requirements' },
      ],
      signal: new AbortController().signal,
      emit: () => undefined,
    })

    expect(receivedContent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('Important requirements') }),
      expect.objectContaining({ type: 'image_url', image_url: expect.objectContaining({ url: 'data:image/png;base64,AAAA' }) }),
    ]))
    expect(registry.record(textConnection).roleHistory['Coding Agent']).toBeUndefined()
    expect(registry.record(visionConnection).roleHistory['Coding Agent']?.accepted).toBe(1)
  })

  it('switches to the next AUTO model when the first provider model fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'altrex-agent-'))
    roots.push(root)
    const attemptedModels: string[] = []
    const provider: ModelProvider = {
      protocol: 'test',
      healthCheck: async () => ({ ok: true, message: 'ok', latencyMs: 1 }),
      listModels: async () => ['model-one', 'model-two'],
      stream: async () => undefined,
      complete: async ({ connection }) => {
        attemptedModels.push(connection.model)
        if (connection.model === 'model-one') throw new Error('The provider is currently unavailable.')
        return { content: 'Hi from the fallback model.', toolCalls: [] }
      },
    }
    const events: ChatStreamEvent[] = []
    await runCodingAgent({
      provider,
      connection: { providerId: 'groq', apiKey: 'test-key-value', baseUrl: 'https://api.groq.com/openai/v1', model: 'model-one' },
      fallbackModels: ['model-two'],
      request: { requestId: 'fallback-123', projectPath: root, mode: 'AGENT', modelSelection: 'AUTO', messages: [{ role: 'user', content: 'Hi' }], attachments: [] },
      repositoryContext: '(empty project)',
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    })

    expect(attemptedModels).toEqual(['model-one', 'model-two'])
    expect(events.some((event) => event.type === 'activity' && event.model === 'model-two' && event.message?.includes('Switching automatically'))).toBe(true)
    expect(events.some((event) => event.type === 'delta' && event.delta === 'Hi from the fallback model.')).toBe(true)
  })

  it('answers a conversational prompt without forcing fake project edits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'altrex-agent-'))
    roots.push(root)
    let completionCount = 0
    const provider: ModelProvider = {
      protocol: 'test',
      healthCheck: async () => ({ ok: true, message: 'ok', latencyMs: 1 }),
      listModels: async () => ['test-model'],
      stream: async () => undefined,
      complete: async () => {
        completionCount += 1
        return { content: 'Hi! What would you like to build?', toolCalls: [] }
      },
    }
    const events: ChatStreamEvent[] = []
    await runCodingAgent({
      provider,
      connection: { providerId: 'custom', apiKey: 'test-key-value', baseUrl: 'http://127.0.0.1:1/v1', model: 'test-model' },
      request: { requestId: 'greeting-123', projectPath: root, mode: 'AGENT', modelSelection: 'test-model', messages: [{ role: 'user', content: 'Hi' }], attachments: [] },
      repositoryContext: '(empty project)',
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    })

    expect(completionCount).toBe(1)
    expect(events.some((event) => event.type === 'delta' && event.delta === 'Hi! What would you like to build?')).toBe(true)
    expect(events.some((event) => event.type === 'files-changed')).toBe(false)
  })

  it('executes a provider write tool and reports the real changed file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'altrex-agent-'))
    roots.push(root)
    let completionNumber = 0
    const provider: ModelProvider = {
      protocol: 'test',
      healthCheck: async () => ({ ok: true, message: 'ok', latencyMs: 1 }),
      listModels: async () => ['test-model'],
      stream: async () => undefined,
      complete: async () => {
        completionNumber += 1
        if (completionNumber === 1) {
          return {
            content: '',
            toolCalls: [
              { id: 'write-1', name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: '<h1>GPU Store</h1>' }) },
              { id: 'write-2', name: 'write_file', arguments: JSON.stringify({ path: 'verify.cjs', content: "require('node:fs').accessSync('index.html'); console.log('verified')" }) },
            ],
          }
        }
        if (completionNumber === 2) {
          return { content: '', toolCalls: [{ id: 'command-1', name: 'run_command', arguments: JSON.stringify({ command: 'node', args: ['verify.cjs'] }) }] }
        }
        return { content: 'Created and verified the storefront.', toolCalls: [] }
      },
    }
    const events: ChatStreamEvent[] = []
    await runCodingAgent({
      provider,
      connection: { providerId: 'custom', apiKey: 'test-key-value', baseUrl: 'http://127.0.0.1:1/v1', model: 'test-model' },
      request: { requestId: 'request-123', projectPath: root, mode: 'AGENT', modelSelection: 'test-model', messages: [{ role: 'user', content: 'Build a GPU store' }], attachments: [] },
      repositoryContext: '(empty project)',
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    })

    expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain('GPU Store')
    expect(events.some((event) => event.type === 'files-changed' && event.files?.includes('index.html'))).toBe(true)
    expect(events.some((event) => event.type === 'command-result' && event.command === 'node verify.cjs' && event.exitCode === 0)).toBe(true)
    expect(events.some((event) => event.type === 'delta' && event.delta === 'Created and verified the storefront.')).toBe(true)
  })

  it('keeps a verified implementation successful when quota fails before the final prose summary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'altrex-agent-')); roots.push(root)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test acceptance.test.cjs' } }))
    writeFileSync(join(root, 'acceptance.test.cjs'), "const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');test('page',()=>assert.match(fs.readFileSync('index.html','utf8'),/Done/));")
    let completionNumber = 0
    const provider: ModelProvider = {
      protocol: 'test', healthCheck: async () => ({ ok: true, message: 'ok', latencyMs: 1 }), listModels: async () => ['tool-model'], stream: async () => undefined,
      complete: async () => {
        completionNumber += 1
        if (completionNumber === 1) return { content: '', toolCalls: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: '<h1>Done</h1>' }) }] }
        throw new ProviderFailure('The provider account quota or credits are exhausted.', 'quota-exhausted', false, 429, 0, undefined, 'QUOTA_EXHAUSTED')
      },
    }
    const events: ChatStreamEvent[] = []
    await runCodingAgent({ provider, connection: { providerId: 'groq', apiKey: 'secret', baseUrl: 'https://example.invalid/v1', model: 'tool-model' }, request: { requestId: 'verified-quota', projectPath: root, mode: 'AGENT', modelSelection: 'AUTO', messages: [{ role: 'user', content: 'Build a complete tiny webpage' }], attachments: [] }, repositoryContext: '(empty)', signal: new AbortController().signal, emit: event => events.push(event) })
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain('Done')
    expect(events).toContainEqual(expect.objectContaining({ type: 'command-result', exitCode: 0 }))
    expect(events.some(event => event.type === 'delta' && event.delta?.includes('Implementation completed'))).toBe(true)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => true, getSize: () => ({ width: 1, height: 1 }), resize: () => ({ toDataURL: () => '' }) }) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`encrypted:${value}`), decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''), getSelectedStorageBackend: () => 'dpapi' },
}))
vi.mock('./local-ai-service', () => ({ ensureLocalAiServer: vi.fn(async () => undefined), pullLocalModel: vi.fn(async () => undefined), unloadLocalModel: vi.fn(async () => undefined) }))

import { EventBus } from '@altrex/core/events/event-bus'
import { PermissionCenter } from '@altrex/core/security/permission-center'
import { CheckpointStore } from '@altrex/core/workspace/checkpoints'
import type { AltrexEvent } from '@altrex/contracts'
import { ProviderService } from './provider-service'
import { consentGranted } from './test-consent'
import type { ChatRequest, ChatStreamEvent, ProviderConnectionInput } from '../shared/desktop-api'
import type { ProviderCompletionInput } from './providers/model-provider'

// Phase 6: permission profiles, policy-checked agent commands, and command/permission events.

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'altrex-phase6-'))
  roots.push(root)
  const project = join(root, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'index.js'), 'console.log("hello")\n')
  const events = new EventBus(), published: AltrexEvent[] = []
  events.subscribe(event => published.push(event))
  const permissions = new PermissionCenter(join(root, 'permissions.json'), events)
  const service = new ProviderService(join(root, 'credentials', 'provider.json'), join(root, 'multi-ai'), join(root, 'multi-ai'), { events, permissions, consent: consentGranted(), checkpoints: new CheckpointStore(join(root, 'checkpoints')) })
  const internal = service as unknown as { provider: Record<string, ReturnType<typeof vi.fn>> }
  internal.provider.healthCheck = vi.fn(async () => ({ ok: true, message: 'ready', latencyMs: 1 }))
  internal.provider.listModels = vi.fn(async () => ['coder-large'])
  internal.provider.probeCapabilities = vi.fn(async () => ({ supportsChat: true, supportsStreaming: true, supportsTools: true }))
  return { root, project, service, internal, published, permissions }
}
const nvidia: ProviderConnectionInput = { providerId: 'nvidia', apiKey: 'nvapi-secret', baseUrl: '', model: 'coder-large' }
const request = (projectPath: string, content: string): ChatRequest => ({ requestId: `req-${Math.random().toString(16).slice(2, 10)}`, projectPath, mode: 'AGENT', modelSelection: 'AUTO', messages: [{ role: 'user', content }], attachments: [] })
const completion = (content: string, toolCalls: Array<{ name: string; args: unknown }> = []) => ({ content, toolCalls: toolCalls.map((call, index) => ({ id: `call-${index}-${Math.random()}`, name: call.name, arguments: JSON.stringify(call.args) })), finishReason: toolCalls.length ? 'tool_calls' : 'stop' })

describe('permission profiles in the request flow', () => {
  it('refuses write-capable modes for read-only projects before any model call or checkpoint', async () => {
    const { project, service, internal, permissions, published } = setup()
    await service.connect(nvidia)
    permissions.setProfile(project, 'read_only')
    internal.provider.complete = vi.fn()
    const events: ChatStreamEvent[] = []
    await service.streamChat(request(project, 'Add a README'), '', [], event => events.push(event))
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/read-only/) })
    expect(internal.provider.complete).not.toHaveBeenCalled()
    expect(published.some(event => event.type === 'checkpoint.created')).toBe(false)
  })

  it('denies FORBIDDEN agent commands with tool.denied, and streams command events for allowed ones', async () => {
    const { project, service, internal, published } = setup()
    await service.connect(nvidia)
    const toolResults: string[] = []
    let turn = 0
    internal.provider.complete = vi.fn(async ({ messages }: ProviderCompletionInput) => {
      for (const message of messages) if (message.role === 'tool' && typeof message.content === 'string' && !toolResults.includes(message.content)) toolResults.push(message.content)
      turn += 1
      if (turn === 1) return completion('', [{ name: 'run_command', args: { command: 'git', args: ['push', 'origin', 'main'] } }])
      if (turn === 2) return completion('', [{ name: 'run_command', args: { command: 'node', args: ['index.js'] } }])
      return completion('I inspected the project; index.js prints hello. No changes were needed.')
    })
    const events: ChatStreamEvent[] = []
    await service.streamChat(request(project, 'What does index.js print when it runs?'), '', [], event => events.push(event))
    expect(toolResults[0]).toMatch(/not allowed \(FORBIDDEN\)/)
    expect(toolResults[1]).toMatch(/exited with code 0/)
    const types = published.map(event => event.type)
    expect(types).toContain('tool.denied')
    expect(types.indexOf('command.started')).toBeLessThan(types.indexOf('command.completed'))
    const output = published.filter(event => event.type === 'command.output').map(event => (event.payload as { text: string }).text).join('')
    expect(output).toContain('hello')
    expect(published.filter(event => ['tool.denied', 'command.started', 'command.completed'].includes(event.type)).every(event => event.taskId === events[0]!.requestId)).toBe(true)
    expect(readFileSync(join(project, 'index.js'), 'utf8')).toContain('hello')
  })
})

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import type { ChatStreamEvent, DesktopApi } from '../../shared/desktop-api'
import { HISTORY_KEY } from './conversation-history'
import { LOCAL_CONVERSATION_STORAGE_KEY } from './local-conversation'
import type { ProjectRun } from '../../shared/multi-ai'

let listener: (event: ChatStreamEvent) => void
let api: DesktopApi
const project = { name: 'Fixture project', path: 'C:/fixture', branch: 'main', markers: ['package.json'] }
beforeEach(() => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, String(value)) }, removeItem: (key: string) => { data.delete(key) }, clear: () => data.clear(), key: (index: number) => [...data.keys()][index] ?? null, get length() { return data.size } }
  vi.stubGlobal('localStorage', storage)
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
  Element.prototype.scrollTo = vi.fn()
  api = {
    reviseRun: vi.fn().mockResolvedValue(undefined), getProjectRuns: vi.fn().mockResolvedValue([]),
    getRuntimeInfo: vi.fn().mockResolvedValue({ platform: 'win32', electron: '43', chrome: '130', node: '22', bridge: 'connected', codex: { available: true, version: 'Fixture runtime' } }),
    getRecentProject: vi.fn().mockResolvedValue(project),
    getProviderStatus: vi.fn().mockResolvedValue({ connected: true, providerId: 'custom', displayName: 'Test provider', baseUrl: 'http://localhost:9999', model: 'fixture-model' }),
    getProviderModels: vi.fn().mockResolvedValue(['fixture-model', 'another-model']),
    refreshProviderModels: vi.fn().mockResolvedValue({ connected: true, providerId: 'custom', displayName: 'Test provider', baseUrl: 'http://localhost:9999', model: 'fixture-model', profiles: [] }),
    installLocalModel: vi.fn().mockResolvedValue({ connected: true, providerId: 'ollama', displayName: 'Ollama Local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b-instruct', profiles: [] }),
    getProviderDiagnostics: vi.fn().mockResolvedValue([]),
    openProject: vi.fn().mockResolvedValue({ ...project, name: 'Other project', path: 'C:/other' }),
    pickAttachments: vi.fn().mockResolvedValue([{ id: 'attachment-1', name: 'reference.png', mimeType: 'image/png', size: 128, kind: 'image', previewDataUrl: 'data:image/png;base64,AA==' }]),
    startChat: vi.fn().mockResolvedValue(undefined), cancelChat: vi.fn().mockResolvedValue(undefined),
    testProvider: vi.fn().mockResolvedValue({ ok: false, message: 'Invalid API key', latencyMs: 1 }),
    connectProvider: vi.fn().mockRejectedValue(new Error('Invalid API key')),
    disconnectProvider: vi.fn().mockResolvedValue({ connected: false, providerId: null, displayName: null, baseUrl: null, model: null }),
    openExternalProviderLink: vi.fn().mockResolvedValue(undefined),
    onChatEvent: vi.fn().mockImplementation(callback => { listener = callback; return () => {} }),
  }
  window.altrex = api
})
afterEach(cleanup)
async function launch() { render(<App />); await screen.findByText('Fixture project', { selector: '.project-item span' }) }
function emit(event: ChatStreamEvent) { act(() => listener(event)) }
async function send(content = 'Fix the fixture issue') {
  fireEvent.change(screen.getByLabelText('Ask ALTREX'), { target: { value: content } })
  fireEvent.keyDown(screen.getByLabelText('Ask ALTREX'), { key: 'Enter' })
  await waitFor(() => expect(api.startChat).toHaveBeenCalled())
  return vi.mocked(api.startChat).mock.lastCall![0].requestId
}

describe('new desktop interface integration', () => {
  it('connects Multi-AI run state, selective revisions, and Stop through the bridge', async () => {
    await launch(); fireEvent.click(screen.getByLabelText('Mode')); fireEvent.click(screen.getByRole('option', { name: 'Multi-AI' }))
    const id = await send('Build task modules'); expect(vi.mocked(api.startChat).mock.lastCall![0].mode).toBe('MULTI')
    const run: ProjectRun = { version: 1, id, projectPath: project.path, request: 'Build task modules', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'RUNNING', spec: null, tasks: [], activity: ['Director creating contracts'], finalVerification: null, revisions: [], filesChanged: [], error: null }
    emit({ requestId: id, type: 'run-state', run }); expect(screen.getByLabelText('ALTREX Director run')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Ask ALTREX'), { target: { value: 'Make navbar red' } }); fireEvent.keyDown(screen.getByLabelText('Ask ALTREX'), { key: 'Enter' })
    await waitFor(() => expect(api.reviseRun).toHaveBeenCalledWith(id, 'Make navbar red'))
    fireEvent.click(screen.getByLabelText('Stop response')); expect(api.cancelChat).toHaveBeenCalledWith(id)
    emit({ requestId: id, type: 'cancelled' }); expect(screen.queryByLabelText('Stop response')).toBeNull()
  })
  it('exposes a private Local AI mode with the recommended coding model', async () => {
    await launch()
    fireEvent.click(screen.getByLabelText('Mode'))
    fireEvent.click(screen.getByRole('option', { name: 'Local AI' }))
    expect(screen.getByText('Private · offline')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Model'))
    expect(screen.getByRole('option', { name: /Qwen2.5-Coder 7B Instruct/ })).toBeTruthy()
  })
  it('guides Local AI image uploads to the local vision installer when it is missing', async () => {
    vi.mocked(api.getProviderStatus).mockResolvedValue({ connected: true, providerId: 'ollama', displayName: 'Ollama Local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b-instruct', profiles: [{ providerId: 'ollama', displayName: 'Ollama Local', model: 'qwen2.5-coder:7b-instruct', baseUrl: 'http://127.0.0.1:11434/v1', health: 'HEALTHY', modelsDiscovered: 1, toolCompatibleModels: 1, lastErrorCategory: null, lastCheckedAt: null, connectionState: 'CONNECTED', keySuffix: null, statusMessage: 'Ready', additionalFields: {} }] })
    vi.mocked(api.getProviderModels).mockResolvedValue(['qwen2.5-coder:7b-instruct'])
    await launch()
    fireEvent.click(screen.getByLabelText('Mode'))
    fireEvent.click(screen.getByRole('option', { name: 'Local AI' }))
    fireEvent.click(screen.getByLabelText('Add context'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Attach files/ }))
    await screen.findByLabelText('Remove reference.png')
    fireEvent.change(screen.getByLabelText('Ask ALTREX'), { target: { value: 'Inspect this screenshot' } })
    fireEvent.keyDown(screen.getByLabelText('Ask ALTREX'), { key: 'Enter' })
    expect(await screen.findByText(/Install Qwen2.5-VL 3B/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Install Local Vision' })).toBeTruthy()
    expect(api.startChat).not.toHaveBeenCalled()
  })
  it('keeps real send, tool events, code rendering, stop and conversation restoration connected', async () => {
    await launch()
    fireEvent.click(screen.getByRole('button', { name: /Explore Understand/ }))
    expect((screen.getByLabelText('Ask ALTREX') as HTMLTextAreaElement).value).toContain('Explore this project')
    fireEvent.keyDown(screen.getByLabelText('Ask ALTREX'), { key: 'Enter', shiftKey: true })
    expect(api.startChat).not.toHaveBeenCalled()
    const id = await send()
    expect(vi.mocked(api.startChat).mock.lastCall![0]).toMatchObject({ projectPath: project.path, mode: 'AGENT', modelSelection: 'AUTO' })
    fireEvent.click(screen.getByLabelText('Stop response'))
    expect(api.cancelChat).toHaveBeenCalledWith(id)
    emit({ requestId: id, type: 'activity', message: 'Running tests' })
    emit({ requestId: id, type: 'command-result', command: 'node verify.js', output: 'All assertions passed', exitCode: 0 })
    emit({ requestId: id, type: 'files-changed', files: ['src/fix.ts'] })
    emit({ requestId: id, type: 'delta', delta: 'Fixed the issue.\n\n```ts\nconst fixed = true\n```' })
    emit({ requestId: id, type: 'completed' })
    expect(screen.getByText('const fixed = true')).toBeTruthy()
    expect(screen.getByText('Ran command')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Results' }))
    expect(within(screen.getByLabelText('Task results')).getByText('src/fix.ts')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Close task results'))
    fireEvent.click(screen.getByRole('button', { name: /New chat/ }))
    expect(screen.getByRole('heading', { name: 'What should we build?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Fix the fixture issue' }))
    expect(screen.getByText('const fixed = true')).toBeTruthy()
    const second = await send('Continue with a review')
    expect(vi.mocked(api.startChat).mock.lastCall![0].messages).toHaveLength(3)
    emit({ requestId: second, type: 'cancelled' })
    expect(screen.getByText('Response stopped.')).toBeTruthy()
  })

  it('switches real models, attaches files, and excludes image payloads from persisted history', async () => {
    await launch()
    fireEvent.click(screen.getByLabelText('Model'))
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'another' } })
    fireEvent.click(screen.getByRole('option', { name: 'another-model' }))
    fireEvent.click(screen.getByLabelText('Add context'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Attach files/ }))
    await screen.findByLabelText('Remove reference.png')
    const id = await send('Read the attached reference')
    expect(vi.mocked(api.startChat).mock.lastCall![0]).toMatchObject({ modelSelection: 'another-model', attachments: [{ name: 'reference.png' }] })
    expect(localStorage.getItem(HISTORY_KEY)).not.toContain('data:image')
    expect(localStorage.getItem(LOCAL_CONVERSATION_STORAGE_KEY)).not.toContain('data:image')
    emit({ requestId: id, type: 'error', message: 'Provider rate limit reached. Try again later.' })
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit and retry' })).toBeTruthy()
  })

  it('preserves the migrated conversation, guards project switching during tasks, and resets context after project selection', async () => {
    localStorage.setItem(LOCAL_CONVERSATION_STORAGE_KEY, JSON.stringify([{ id: 'legacy', role: 'user', content: 'Existing conversation', createdAt: '2026-09-01', status: 'complete' }]))
    await launch()
    expect(screen.getByText('Existing conversation', { selector: '.user-bubble p' })).toBeTruthy()
    const id = await send()
    expect((screen.getByRole('button', { name: 'Open project' }) as HTMLButtonElement).disabled).toBe(true)
    emit({ requestId: id, type: 'completed' })
    fireEvent.click(screen.getByRole('button', { name: 'Open project' }))
    await screen.findByText('Other project', { selector: '.project-item span' })
    expect(screen.getByRole('heading', { name: 'What should we build?' })).toBeTruthy()
    expect(localStorage.getItem(HISTORY_KEY)).toContain('Existing conversation')
    expect(localStorage.getItem(HISTORY_KEY)).toContain('C:/fixture')
  })

  it('searches commands, closes menus with Escape, persists collapse and uses the existing provider settings', async () => {
    await launch()
    fireEvent.click(screen.getByLabelText('Collapse sidebar'))
    expect(localStorage.getItem('altrex.sidebar.collapsed')).toBe('true')
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true })
    fireEvent.change(screen.getByLabelText('Search conversations and commands'), { target: { value: 'Settings' } })
    fireEvent.keyDown(screen.getByLabelText('Search conversations and commands'), { key: 'Enter' })
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByLabelText('Model'))
    fireEvent.keyDown(screen.getByLabelText('Search models'), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.click(screen.getByLabelText('Model'))
    fireEvent.click(screen.getByRole('button', { name: 'Connect provider' }))
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'test-only-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText('Invalid API key')
    expect(api.testProvider).toHaveBeenCalled()
    expect(localStorage.getItem(HISTORY_KEY) ?? '').not.toContain('test-only-key')
  })

  it('keeps archived history when a blank new chat is reloaded', async () => {
    await launch()
    const first = await send('First saved conversation')
    emit({ requestId: first, type: 'completed' })
    const originalId = localStorage.getItem('altrex.active-conversation')
    fireEvent.click(screen.getByRole('button', { name: /New chat/ }))
    expect(localStorage.getItem('altrex.active-conversation')).not.toBe(originalId)
    cleanup()
    await launch()
    const second = await send('Second saved conversation')
    emit({ requestId: second, type: 'completed' })
    expect(JSON.parse(localStorage.getItem(HISTORY_KEY)!)).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'First saved conversation' })).toBeTruthy()
  })

  it('exposes official provider actions, Cloudflare fields, and keyless Ollama detection', async () => {
    await launch()
    fireEvent.click(screen.getByLabelText('Model'))
    fireEvent.click(screen.getByRole('button', { name: 'Connect provider' }))
    expect(screen.getByText('Google Gemini')).toBeTruthy()
    expect(screen.getByText('Cerebras')).toBeTruthy()
    expect(screen.getByText('Cloudflare Workers AI')).toBeTruthy()
    expect(screen.getByText('SambaNova')).toBeTruthy()

    const cloudflare = screen.getByText('Cloudflare Workers AI').closest('article')!
    fireEvent.click(within(cloudflare).getByRole('button', { name: 'Get API Token' }))
    expect(api.openExternalProviderLink).toHaveBeenCalledWith('cloudflare', 'apiKey')
    fireEvent.click(within(cloudflare).getByRole('button', { name: 'Configure' }))
    expect(await screen.findByLabelText('Account ID')).toBeTruthy()
    expect(screen.getByLabelText('API Token')).toBeTruthy()

    const ollama = screen.getByText('Ollama Local').closest('article')!
    fireEvent.click(within(ollama).getByRole('button', { name: 'Install Ollama' }))
    expect(api.openExternalProviderLink).toHaveBeenCalledWith('ollama', 'install')
    fireEvent.click(within(ollama).getByRole('button', { name: 'Configure' }))
    expect(screen.getByRole('button', { name: 'Detect Ollama' })).toBeTruthy()
    expect(screen.getByText('Qwen2.5-Coder 7B Instruct')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Install recommended model' }))
    await waitFor(() => expect(api.installLocalModel).toHaveBeenCalledWith('qwen2.5-coder:7b-instruct'))
    expect(screen.queryByLabelText('API key')).toBeNull()
  })
})


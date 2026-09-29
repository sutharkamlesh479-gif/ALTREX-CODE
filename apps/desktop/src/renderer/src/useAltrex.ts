import { useCallback, useEffect, useRef, useState } from 'react'
import { providerPresets, type ChatAttachment, type ChatMessage, type ProjectSummary, type ProviderConnectionInput, type ProviderId, type ProviderLinkKind, type ProviderRequestDiagnostic, type ProviderStatus, type RuntimeInfo } from '../../shared/desktop-api'
import { nvidiaCodingModels } from '../../shared/model-router'
import { getConversationTitle, LOCAL_CONVERSATION_STORAGE_KEY, parseLocalConversation, type LocalConversationMessage } from './local-conversation'
import { commandItems, defaultMode, type Mode } from './product'
import { HISTORY_KEY, readHistory, serializeHistory, recoverMessages, type SavedConversation } from './conversation-history'
import type { ProjectRun } from '../../shared/multi-ai'
import { recommendedLocalCodingModel, recommendedLocalVisionModel } from '../../shared/local-ai'
const disconnectedProvider: ProviderStatus = { connected: false, providerId: null, displayName: null, baseUrl: null, model: null }
const initialProvider = providerPresets.find(provider => provider.id === 'google')!
export function useAltrex() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('altrex.sidebar.collapsed') === 'true')
  const [project, setProject] = useState<ProjectSummary | null>(null)
  const [ready, setReady] = useState(window.altrex === undefined)
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const codexAvailable = runtime?.codex.available ?? false
  const [prompt, setPrompt] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [mode, setMode] = useState<Mode>(defaultMode)
  const [modelSelection, setModelSelection] = useState('AUTO')
  const [commandOpen, setCommandOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [openingProject, setOpeningProject] = useState(false)
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>(disconnectedProvider)
  const [providerModels, setProviderModels] = useState<string[]>([])
  const [localModels, setLocalModels] = useState<string[]>([])
  const [providerDiagnostics, setProviderDiagnostics] = useState<ProviderRequestDiagnostic[]>([])
  const [providerDraft, setProviderDraft] = useState<ProviderConnectionInput>({
    providerId: initialProvider.id,
    apiKey: '',
    baseUrl: initialProvider.baseUrl,
    model: initialProvider.model,
  })
  const [testingProvider, setTestingProvider] = useState(false)
  const [connectingProvider, setConnectingProvider] = useState(false)
  const [installingLocalModel, setInstallingLocalModel] = useState(false)
  const [connectionResult, setConnectionResult] = useState<string | null>(null)
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null)
  const [projectRuns, setProjectRuns] = useState<ProjectRun[]>([])
  useEffect(() => { if (project?.path && window.altrex?.getProjectRuns) void window.altrex.getProjectRuns(project.path).then(setProjectRuns).catch(() => {}); else setProjectRuns([]) }, [project?.path])
  const [pendingRequest, setPendingRequest] = useState(false)
  const [messages, setMessages] = useState<LocalConversationMessage[]>(() => (
    parseLocalConversation(window.localStorage.getItem(LOCAL_CONVERSATION_STORAGE_KEY)).map((message) => (
      message.status === 'streaming'
        ? { ...message, status: 'cancelled', content: message.content || 'Response interrupted when ALTREX closed.' }
        : message
    ))
  ))
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const messageListRef = useRef<HTMLDivElement>(null)
  const followOutput = useRef(true)
  const [history, setHistory] = useState<SavedConversation[]>(readHistory)
  const [conversationId, setConversationId] = useState(() => localStorage.getItem('altrex.active-conversation') ?? crypto.randomUUID())
  const requestGuard = useRef(false)
  useEffect(() => { localStorage.setItem('altrex.sidebar.collapsed', String(sidebarCollapsed)) }, [sidebarCollapsed])
  useEffect(() => { localStorage.setItem('altrex.active-conversation', conversationId) }, [conversationId])
  useEffect(() => {
    if (!messages.length || !ready) return
    const entry: SavedConversation = { id: conversationId, projectPath: project?.path ?? null, messages, updatedAt: new Date().toISOString() }
    const next = [entry, ...readHistory().filter(item => item.id !== conversationId)]
    try { localStorage.setItem(HISTORY_KEY, serializeHistory(next)); localStorage.setItem('altrex.active-conversation', conversationId) }
    catch { setNotice('Conversation storage is full. Keep this window open to retain the current conversation.') }
    setHistory(next)
  }, [messages, conversationId, project?.path, ready])

  useEffect(() => {
    if (window.altrex === undefined) return
    void Promise.all([
      window.altrex.getRuntimeInfo(),
      window.altrex.getRecentProject(),
      window.altrex.getProviderStatus(),
      window.altrex.getProviderModels(),
      window.altrex.getProviderModels('ollama'),
      window.altrex.getProviderDiagnostics(),
    ]).then(([runtimeInfo, recentProject, currentProvider, currentModels, currentLocalModels, diagnostics]) => {
      setRuntime(runtimeInfo)
      setProject(recentProject)
      if (recentProject !== null) setMode('AGENT')
      setProviderStatus(currentProvider)
      setProviderModels(currentModels)
      setLocalModels(currentLocalModels)
      setProviderDiagnostics(diagnostics)
      setReady(true)
    }).catch(() => {
      setNotice('The secure desktop bridge did not respond. Restart ALTREX and try again.')
    })

    return window.altrex.onChatEvent((event) => {
      if (event.type === 'run-state' && event.run) { const run = event.run; setProjectRuns(current => [run, ...current.filter(item => item.id !== run.id)]); setMessages(current => current.map(message => message.id === event.requestId ? { ...message, activity: run.activity.at(-1) ?? 'Director planning' } : message)) }
      if (event.type === 'started') {
        setMessages((current) => current.map((message) => (
          message.id === event.requestId
            ? {
                ...message,
                ...(event.provider === undefined ? {} : { provider: event.provider }),
                ...(event.model === undefined ? {} : { model: event.model }),
              }
            : message
        )))
      }
      if (event.type === 'delta' && event.delta !== undefined) {
        setMessages((current) => current.map((message) => (
          message.id === event.requestId ? { ...message, content: message.content + event.delta } : message
        )))
      }
      if (event.type === 'activity' && event.message !== undefined) {
        const activity = event.message
        setMessages((current) => current.map((message) => (
          message.id === event.requestId
            ? { ...message, activity, activities: [...(message.activities ?? []).filter(item => item !== activity), activity].slice(-100), ...(event.model === undefined ? {} : { model: event.model }) }
            : message
        )))
      }
      if (event.type === 'files-changed' && event.files !== undefined) {
        const files = event.files
        setMessages((current) => current.map((message) => (
          message.id === event.requestId ? { ...message, files } : message
        )))
      }
      if (event.type === 'command-result' && event.command !== undefined && event.output !== undefined) {
        const command = event.command
        const output = event.output
        const exitCode = event.exitCode ?? null
        setMessages((current) => current.map((message) => (
          message.id === event.requestId
            ? { ...message, commands: [...(message.commands ?? []), { command, exitCode, output }] }
            : message
        )))
      }
      if (event.type === 'completed' || event.type === 'cancelled' || event.type === 'error') {
        requestGuard.current = false
        setMessages((current) => current.map((message) => {
          if (message.id !== event.requestId) return message
          if (event.type === 'completed') return { ...message, status: 'complete', finishedAt: new Date().toISOString() }
          if (event.type === 'cancelled') return { ...message, status: 'cancelled', finishedAt: new Date().toISOString(), content: message.content || 'Response stopped.' }
          return { ...message, status: 'error', finishedAt: new Date().toISOString(), content: event.message ?? 'The provider request failed.' }
        }))
        setActiveRequestId((current) => current === event.requestId ? null : current)
        void Promise.all([window.altrex!.getProviderStatus(), window.altrex!.getProviderDiagnostics()]).then(([status, diagnostics]) => { setProviderStatus(status); setProviderDiagnostics(diagnostics) }).catch(() => {})
      }
    })
  }, [])

  useEffect(() => {
    if (mode !== 'LOCAL' || !window.altrex) return
    void window.altrex.getProviderModels('ollama').then(setLocalModels).catch(() => setLocalModels([]))
  }, [mode])

  useEffect(() => {
    if (messages.length === 0) {
      window.localStorage.removeItem(LOCAL_CONVERSATION_STORAGE_KEY)
      return
    }
    try { window.localStorage.setItem(LOCAL_CONVERSATION_STORAGE_KEY, JSON.stringify(messages.map((message) => ({
      ...message,
      ...(message.attachments === undefined ? {} : {
        attachments: message.attachments.map(({ previewDataUrl: _previewDataUrl, ...attachment }) => attachment),
      }),
    })))) } catch { setNotice('Conversation storage is full. Keep this window open to retain your messages.') }
    const frame = window.requestAnimationFrame(() => {
      const list = messageListRef.current
      if (list !== null && followOutput.current) list.scrollTo({ top: list.scrollHeight, behavior: 'auto' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [messages])

  const openProject = useCallback(async (): Promise<void> => {
    if (window.altrex === undefined) {
      setNotice('The native project picker is available in the ALTREX desktop runtime. This is the renderer preview.')
      return
    }
    if (requestGuard.current) { setNotice('Stop the current task before changing projects.'); return }
    setOpeningProject(true)
    try {
      const selected = await window.altrex.openProject()
      if (selected !== null) {
        setPendingRequest(false)
        setMessages([])
        setPrompt('')
        setAttachments([])
        setConversationId(crypto.randomUUID())
        setProject(selected)
        setMode('AGENT')
        setNotice(`Opened ${selected.name}. Ready for your next task.`)
      }
    } catch {
      setNotice('ALTREX could not open that project. The selection was not saved.')
    } finally {
      setOpeningProject(false)
    }
  }, [])

  const focusComposer = useCallback((): void => {
    window.setTimeout(() => composerRef.current?.focus(), 0)
  }, [])

  const newTask = useCallback((): void => {
    if (requestGuard.current) { setNotice('Stop the current task before starting a new chat.'); return }
    setConversationId(crypto.randomUUID())
    setPrompt('')
    setAttachments([])
    setMessages([])
    setPendingRequest(false)
    setActiveRequestId(null)
    setNotice(null)
    focusComposer()
  }, [activeRequestId, focusComposer])

  const runCommand = useCallback((action: (typeof commandItems)[number]['action']): void => {
    setCommandOpen(false)
    if (action === 'new-task') newTask()
    if (action === 'open-project') void openProject()
    if (action === 'models') setConnectOpen(true)
    if (action === 'security') setSettingsOpen(true)
  }, [newTask, openProject])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setCommandOpen((open) => !open)
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        newTask()
      }
      if (event.key === 'Escape') {
        setCommandOpen(false)
        setSettingsOpen(false)
        setConnectOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [newTask])

  const startProviderChat = useCallback((history: LocalConversationMessage[], selection = modelSelection): void => {
    if (window.altrex === undefined) {
      setNotice('Provider requests run only in the ALTREX desktop app.')
      return
    }
    requestGuard.current = true
    followOutput.current = true
    const requestId = window.crypto.randomUUID()
    const assistant: LocalConversationMessage = {
      id: requestId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      status: 'streaming',
    }
    const apiMessages: ChatMessage[] = history
      .filter((message) => message.status === 'complete' && message.content.trim().length > 0)
      .map(({ role, content }) => ({ role, content }))
    setMessages((current) => [...current, assistant])
    setActiveRequestId(requestId)
    void window.altrex.startChat({
      requestId,
      projectPath: project?.path ?? null,
      messages: apiMessages,
      attachments: history.slice().reverse().find((message) => message.role === 'user')?.attachments ?? [],
      mode: mode === 'MULTI' ? 'MULTI' : mode === 'LOCAL' ? 'LOCAL' : mode === 'AGENT' ? 'AGENT' : 'ASK',
      modelSelection: selection,
    }).catch((error: unknown) => {
      requestGuard.current = false
      setMessages((current) => current.map((message) => (
        message.id === requestId
          ? { ...message, status: 'error', content: error instanceof Error ? error.message : 'Could not start the provider request.' }
          : message
      )))
      setActiveRequestId(null)
    })
  }, [mode, modelSelection, project?.path])

  const submitPrompt = useCallback((): void => {
    const content = prompt.trim() || (attachments.length > 0 ? 'Inspect and use the attached files.' : '')
    if (content.length === 0 && attachments.length === 0) {
      setNotice('Ask ALTREX something or attach a file first.')
      focusComposer()
      return
    }
    if (activeRequestId !== null || requestGuard.current) {
      if (mode === 'MULTI' && activeRequestId && window.altrex) { void window.altrex.reviseRun(activeRequestId, content).then(() => { setPrompt(''); setNotice('Change sent to the Director. Affected tasks will be revised.'); setMessages(current => [...current, { id: crypto.randomUUID(), role: 'user', content, createdAt: new Date().toISOString(), status: 'complete' }]) }).catch(error => setNotice(error instanceof Error ? error.message : 'Could not revise run.')); return }
      setNotice('Stop the current response before sending another message.')
      return
    }
    if ((mode === 'AGENT' || mode === 'LOCAL' || mode === 'MULTI') && project === null) {
      setNotice('Open the project folder before running Agent mode.')
      return
    }
    if (mode === 'MULTI' && !providerStatus.connected) { setNotice('Connect a tool-capable provider for Multi-AI.'); setConnectOpen(true); return }
    if (mode === 'MULTI' && modelSelection === 'CODEX') { setModelSelection('AUTO'); setNotice('Select a connected provider model for Multi-AI.'); return }
    if (mode === 'LOCAL' && !providerStatus.profiles?.some(profile => profile.providerId === 'ollama' && profile.connectionState === 'CONNECTED')) {
      const local = providerPresets.find(provider => provider.id === 'ollama')!
      setProviderDraft({ providerId: 'ollama', apiKey: '', baseUrl: local.baseUrl, model: local.model })
      setNotice('Install and detect the recommended Ollama coding model first.')
      setConnectOpen(true)
      return
    }
    if (mode === 'LOCAL' && attachments.some(attachment => attachment.kind === 'image') && !localModels.includes(recommendedLocalVisionModel.id)) {
      const local = providerPresets.find(provider => provider.id === 'ollama')!
      setProviderDraft({ providerId: 'ollama', apiKey: '', baseUrl: local.baseUrl, model: recommendedLocalCodingModel.id })
      setNotice(`Install ${recommendedLocalVisionModel.name} to let Local AI inspect screenshots and images.`)
      setConnectOpen(true)
      return
    }
    if (mode === 'AGENT' && modelSelection === 'CODEX' && !codexAvailable) {
      setNotice('The Codex runtime was not detected. Select AUTO or connect NVIDIA NIM to use another autonomous coding model.')
      return
    }
    if (mode === 'AGENT' && modelSelection === 'AUTO' && !codexAvailable && !providerStatus.connected) {
      setNotice('AUTO needs either Codex or a connected model provider. Connect NVIDIA NIM to continue without Codex.')
      setConnectOpen(true)
      return
    }
    if (mode === 'AGENT' && modelSelection !== 'AUTO' && modelSelection !== 'CODEX' && !providerStatus.connected) {
      setNotice('Connect the provider for this model before starting the Agent task.')
      setConnectOpen(true)
      return
    }

    const createdAt = new Date().toISOString()
    const userMessage: LocalConversationMessage = {
      id: window.crypto.randomUUID(),
      role: 'user',
      content,
      ...(attachments.length === 0 ? {} : { attachments }),
      createdAt,
      status: 'complete',
    }
    const history = [...messages, userMessage]
    setMessages(history)
    setPrompt('')
    setAttachments([])
    focusComposer()
    if (mode !== 'AGENT' && !providerStatus.connected) {
      setPendingRequest(true)
      setConnectOpen(true)
      return
    }
    startProviderChat(history)
  }, [activeRequestId, attachments, codexAvailable, focusComposer, localModels, messages, mode, modelSelection, project, prompt, providerStatus.connected, startProviderChat])

  const pickAttachments = useCallback(async (): Promise<void> => {
    if (window.altrex === undefined) {
      setNotice('File attachments are available in the ALTREX desktop app.')
      return
    }
    try {
      const picked = await window.altrex.pickAttachments()
      setAttachments((current) => [...current, ...picked.filter((candidate) => !current.some((attachment) => attachment.id === candidate.id))].slice(0, 8))
      if (picked.length > 0) setNotice(`${picked.length} ${picked.length === 1 ? 'file' : 'files'} attached. Add instructions or send now.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not attach the selected files.')
    }
  }, [])

  const selectProvider = useCallback((providerId: string): void => {
    const preset = providerPresets.find((provider) => provider.id === providerId)
    if (preset === undefined) return
    const saved = providerStatus.profiles?.find(profile => profile.providerId === preset.id)
    setProviderDraft({ providerId: preset.id, apiKey: '', baseUrl: preset.baseUrl, model: saved?.model ?? preset.model, additionalFields: saved?.additionalFields ?? {} })
    setConnectionResult(null)
    if (window.altrex) void window.altrex.getProviderModels(preset.id).then(setProviderModels).catch(() => setProviderModels([]))
  }, [providerStatus.profiles])

  const testProvider = useCallback(async (): Promise<void> => {
    if (window.altrex === undefined) {
      setConnectionResult('Open the ALTREX desktop app to test a provider connection.')
      return
    }
    setTestingProvider(true)
    setConnectionResult(null)
    try {
      const result = await window.altrex.testProvider(providerDraft)
      setConnectionResult(result.ok ? `${result.message} ${result.latencyMs} ms.` : result.message)
      if (result.resolvedModel) setProviderDraft(current => ({ ...current, model: result.resolvedModel! }))
      setProviderStatus(await window.altrex.getProviderStatus())
      if (result.modelsDiscovered) setProviderModels(await window.altrex.getProviderModels(providerDraft.providerId))
    } catch {
      setConnectionResult('The connection test could not run.')
    } finally {
      setTestingProvider(false)
    }
  }, [providerDraft])

  const connectProvider = useCallback(async (): Promise<void> => {
    if (window.altrex === undefined) {
      setConnectionResult('Open the ALTREX desktop app to connect a provider.')
      return
    }
    setConnectingProvider(true)
    setConnectionResult(null)
    try {
      const connected = await window.altrex.connectProvider(providerDraft)
      setProviderStatus(connected)
      setProviderModels(await window.altrex.getProviderModels(providerDraft.providerId))
      setModelSelection('AUTO')
      setProviderDraft((current) => ({ ...current, apiKey: '' }))
      setConnectionResult(connected.warning ?? `${providerPresets.find(provider => provider.id === providerDraft.providerId)?.displayName ?? 'AI provider'} connected and ready for ALTREX.`)
      if (pendingRequest) {
        setPendingRequest(false)
        setConnectOpen(false)
        startProviderChat(messages, 'AUTO')
      }
    } catch (error) {
      setConnectionResult(error instanceof Error ? error.message : 'Could not connect this provider.')
    } finally {
      setConnectingProvider(false)
    }
  }, [messages, pendingRequest, providerDraft, startProviderChat])

  const installLocalModel = useCallback(async (modelId = recommendedLocalCodingModel.id): Promise<void> => {
    if (!window.altrex) { setConnectionResult('Open ALTREX CODE on the desktop to install a local model.'); return }
    const model = modelId === recommendedLocalVisionModel.id ? recommendedLocalVisionModel : recommendedLocalCodingModel
    setInstallingLocalModel(true)
    setConnectionResult(`Installing ${model.name}. The ${model.downloadSize} download can take several minutes.`)
    try {
      const status = await window.altrex.installLocalModel(model.id)
      const installed = await window.altrex.getProviderModels('ollama')
      setProviderStatus(status)
      setLocalModels(installed)
      setProviderModels(installed)
      setProviderDraft({ providerId: 'ollama', apiKey: '', baseUrl: 'http://127.0.0.1:11434/v1', model: recommendedLocalCodingModel.id })
      setMode('LOCAL')
      setModelSelection('AUTO')
      setConnectionResult(`${model.name} is installed, verified, and ready in Local AI mode.`)
      setNotice(model.id === recommendedLocalVisionModel.id ? 'Local Vision is ready. ALTREX can now inspect attached images offline.' : 'Local AI is ready. Requests in Local AI mode stay on this computer.')
    } catch (error) {
      setConnectionResult(error instanceof Error ? error.message : 'Could not install the local coding model.')
    } finally {
      setInstallingLocalModel(false)
    }
  }, [])

  const disconnectProvider = useCallback(async (providerId?: ProviderId): Promise<void> => {
    if (window.altrex === undefined) return
    let disconnected: ProviderStatus
    try { disconnected = await window.altrex.disconnectProvider(providerId) }
    catch { setNotice('Could not disconnect the provider. Try again.'); return }
    setProviderStatus(disconnected)
    setProviderModels(disconnected.providerId ? await window.altrex.getProviderModels(disconnected.providerId) : [])
    setModelSelection('AUTO')
    setConnectionResult('Provider disconnected and its saved credential was removed.')
    setNotice('Provider disconnected and its saved credential was removed.')
  }, [])

  const openProviderLink = useCallback(async (providerId: ProviderId, kind: ProviderLinkKind): Promise<void> => {
    if (!window.altrex) { setConnectionResult('Open ALTREX CODE on the desktop to launch the official provider page.'); return }
    try { await window.altrex.openExternalProviderLink(providerId, kind) }
    catch { setConnectionResult('Could not open official provider page.') }
  }, [])

  const refreshProviderModels = useCallback(async (): Promise<void> => {
    if (!window.altrex) return
    setTestingProvider(true); setConnectionResult(null)
    try {
      const status = await window.altrex.refreshProviderModels()
      setProviderStatus(status)
      setProviderModels(await window.altrex.getProviderModels())
      setProviderDiagnostics(await window.altrex.getProviderDiagnostics())
      setConnectionResult('Model catalogs refreshed. Healthy provider circuit states were reset.')
    } catch (error) { setConnectionResult(error instanceof Error ? error.message : 'Could not refresh provider models.') }
    finally { setTestingProvider(false) }
  }, [])

  const cancelResponse = useCallback((): void => {
    if (activeRequestId === null || window.altrex === undefined) return
    void window.altrex.cancelChat(activeRequestId).catch(() => setNotice('Could not stop the task. Try Stop again.'))
  }, [activeRequestId])

  const projectLabel = project?.name ?? 'No project open'
  const conversationTitle = getConversationTitle(messages)
  const nvidiaLabels = new Map(nvidiaCodingModels.map((model) => [model.id, model.label]))
  const connectedModelIds = [...new Set([
    ...(providerStatus.model === null ? [] : [providerStatus.model]),
    ...providerModels,
  ])]
    .filter((model) => providerStatus.providerId !== 'nvidia' || /coder|code|nemotron|minimax|kimi|deepseek|qwen|gpt-oss|glm/i.test(model))
    .slice(0, 80)
  const connectedModelOptions = connectedModelIds.map((model) => ({
    value: model,
    label: nvidiaLabels.get(model) ?? model,
  }))
  const agentModelOptions: Array<string | { value: string; label: string }> = [
    { value: 'AUTO', label: 'AUTO · Best for task' },
    ...(codexAvailable ? [{ value: 'CODEX', label: 'OpenAI Codex' }] : []),
    ...connectedModelOptions,
  ]
  const askModelOptions: Array<string | { value: string; label: string }> = [
    { value: 'AUTO', label: 'AUTO · Provider default' },
    ...connectedModelOptions,
  ]

  const multiModelOptions = [{ value: 'AUTO', label: 'AUTO · Best per task' }, ...connectedModelOptions]
  const localModelOptions: Array<string | { value: string; label: string }> = [
    { value: 'AUTO', label: `AUTO · ${recommendedLocalCodingModel.name}` },
    ...localModels.filter(model => model !== recommendedLocalVisionModel.id).map(model => ({ value: model, label: model === recommendedLocalCodingModel.id ? `${recommendedLocalCodingModel.name} · Recommended` : model })),
  ]
  const restoreConversation = (entry: SavedConversation): void => {
    if (requestGuard.current) { setNotice('Stop the current task before switching conversations.'); return }
    if (entry.projectPath !== (project?.path ?? null)) { setNotice('Open the original project folder to continue this conversation.'); return }
    setConversationId(entry.id)
    setMessages(recoverMessages(entry.messages))
    setPrompt(''); setAttachments([]); setPendingRequest(false); followOutput.current = true; focusComposer()
  }
  const restartRun = (run: ProjectRun): void => {
    if (!window.altrex || requestGuard.current || !project || run.projectPath !== project.path) return
    const id = crypto.randomUUID(); requestGuard.current = true; setActiveRequestId(id); setMode('MULTI'); setSettingsOpen(false)
    setMessages(current => [...current, { id, role: 'assistant', content: '', createdAt: new Date().toISOString(), status: 'streaming' }])
    void window.altrex.startChat({ requestId: id, projectPath: project.path, messages: [{ role: 'user', content: run.request }], attachments: [], mode: 'MULTI', modelSelection: 'AUTO', resumeRunId: run.id }).catch(error => { requestGuard.current = false; setActiveRequestId(null); setMessages(current => current.map(message => message.id === id ? { ...message, status: 'error', content: error instanceof Error ? error.message : 'Restart failed.' } : message)) })
  }
  return { multiModelOptions, localModelOptions, localModels, projectRuns, restartRun, sidebarCollapsed, setSidebarCollapsed, project, runtime, codexAvailable, prompt, setPrompt, attachments, setAttachments, mode, setMode, modelSelection, setModelSelection, commandOpen, setCommandOpen, settingsOpen, setSettingsOpen, connectOpen, setConnectOpen, notice, setNotice, openingProject, providerStatus, providerModels, providerDiagnostics, providerDraft, setProviderDraft, testingProvider, connectingProvider, installingLocalModel, connectionResult, activeRequestId, messages, composerRef, messageListRef, followOutput, openProject, focusComposer, newTask, runCommand, submitPrompt, pickAttachments, selectProvider, testProvider, connectProvider, installLocalModel, disconnectProvider, openProviderLink, refreshProviderModels, cancelResponse, projectLabel, conversationTitle, agentModelOptions, askModelOptions, history, conversationId, restoreConversation }
}
export type AltrexController = ReturnType<typeof useAltrex>



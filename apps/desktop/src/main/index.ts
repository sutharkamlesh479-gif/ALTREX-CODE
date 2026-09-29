import { app, BrowserWindow, dialog, ipcMain, nativeImage, session, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import appIconIcoPath from '../../assets/branding/altrex-app-icon.ico?asset'
import appIconPngPath from '../../assets/branding/altrex-app-icon.png?asset'
import {
  desktopChannels,
  type ChatStreamEvent,
  type ChatRequest,
  type ChatAttachment,
  type ProjectSummary,
  type ProviderConnectionInput,
  type ProviderId,
  type ProviderLinkKind,
  type RuntimeInfo,
} from '../shared/desktop-api'
import { providerDefinitions } from '../shared/provider-registry'
import { recommendedLocalCodingModel } from '../shared/local-ai'
import { openOfficialProviderLink } from './provider-link-service'
import { ProviderService } from './provider-service'
import { buildRepositoryContext, repositoryIntelligence } from './repository-context'
import { AttachmentService } from './attachment-service'
import { configureInstalledLocalAiHome, stopLocalAiServer } from './local-ai-service'
import { coreChannels } from '@altrex/contracts/channels'
import { EventBus } from '@altrex/core/events/event-bus'
import { PermissionCenter } from '@altrex/core/security/permission-center'
import { TaskManager } from '@altrex/core/orchestrator/task-manager'
import { TaskStore } from '@altrex/core/tasks/task-store'
import { ProjectMemory } from '@altrex/core/memory/project-memory'
import { recoverLeases } from '@altrex/core/workspace/lease'
import { CoreCommandError } from '@altrex/core/errors'
import { ConsentStore } from '@altrex/core/security/consent'
import { CheckpointStore } from '@altrex/core/workspace/checkpoints'
import { CoreHost, sameProject } from './core-host'

const isDevelopment = !app.isPackaged
const requestedScale = process.env.ALTREX_DEVICE_SCALE_FACTOR
const trustedProjects = new Set<string>()
const attachmentService = new AttachmentService()
// Contract-v1 core bridge host (window.altrexCore). Created once the app is ready.
let coreHost: CoreHost | null = null
// Evidence-backed project memory (userData/core/projects). Created once the app is ready.
let projectMemory: ProjectMemory | null = null
// Project picker for the core bridge (needs the main window; set when IPC is registered).
let projectOps: { open(): Promise<ProjectSummary | null>; list(): ProjectSummary[] } | null = null

if (process.env.ALTREX_SMOKE_TEST === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.setPath('userData', join(app.getPath('temp'), `altrex-code-smoke-${process.pid}`))
}

if (requestedScale === '1.25' || requestedScale === '1.5') {
  app.commandLine.appendSwitch('force-device-scale-factor', requestedScale)
}

if (process.platform === 'win32') app.setAppUserModelId('com.altrex.code')

function readGitBranch(projectPath: string): string | null {
  const gitEntry = join(projectPath, '.git')
  if (!existsSync(gitEntry)) return null

  try {
    const headPath = existsSync(join(gitEntry, 'HEAD'))
      ? join(gitEntry, 'HEAD')
      : join(projectPath, readFileSync(gitEntry, 'utf8').trim().replace(/^gitdir:\s*/, ''), 'HEAD')
    const head = readFileSync(headPath, 'utf8').trim()
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head.slice(0, 8)
  } catch {
    return null
  }
}

function detectMarkers(projectPath: string): string[] {
  const candidates = ['package.json', 'pnpm-lock.yaml', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'ALTREX.md']
  return candidates.filter((entry) => existsSync(join(projectPath, entry)))
}

function summarizeProject(projectPath: string): ProjectSummary {
  return {
    name: basename(projectPath),
    path: projectPath,
    branch: readGitBranch(projectPath),
    markers: detectMarkers(projectPath),
  }
}

function isTrustedSender(window: BrowserWindow, event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (frame === null || frame.parent !== null || event.sender.id !== window.webContents.id) return false
  const frameUrl = frame.url
  if (frameUrl.startsWith('file:')) return true
  if (isDevelopment) return frameUrl.startsWith('http://127.0.0.1:') || frameUrl.startsWith('http://localhost:')
  return false
}

/**
 * Start a chat/agent request: legacy events are forwarded to the renderer (when `forward` is given) and
 * translated into core task events. Returns the core task id.
 */
function startChat(request: ChatRequest, providerService: ProviderService, forward?: (payload: ChatStreamEvent) => void): string | null {
  const prompt = request.messages.filter(message => message.role === 'user').at(-1)?.content ?? ''
  if (request.projectPath !== null && projectMemory) { try { projectMemory.importLegacy(request.projectPath, providerService.runs.memory(request.projectPath)) } catch { /* legacy memory is optional */ } }
  // Project rules (ALTREX.md, user-owned) and evidence-backed memory are pinned ahead of retrieved code.
  const memoryBlock = request.projectPath !== null && projectMemory ? projectMemory.render(request.projectPath, prompt) : ''
  const repositoryContext = request.projectPath === null ? '' : [memoryBlock, buildRepositoryContext(request.projectPath, prompt)].filter(Boolean).join('\n\n')
  const attachments = attachmentService.resolve(request.attachments, request.projectPath)
  const emit = (payload: ChatStreamEvent): void => {
    forward?.(payload)
    coreHost?.legacy.handle(payload)
  }
  const taskId = coreHost?.legacy.begin(request) ?? null
  void providerService.streamChat(request, repositoryContext, attachments, emit).catch((error: unknown) => {
    emit({
      requestId: request.requestId,
      type: 'error',
      message: error instanceof Error ? error.message : 'Could not start the provider request.',
    })
  })
  return taskId
}

function registerIpc(window: BrowserWindow, providerService: ProviderService, stateDirectory: string): void {
  const recentProjectPath = join(stateDirectory, 'recent-project.json')
  for (const channel of Object.values(desktopChannels)) {
    if (channel !== desktopChannels.chatEvent) ipcMain.removeHandler(channel)
  }
  ipcMain.removeHandler(coreChannels.command)

  ipcMain.handle(coreChannels.command, (event, name: unknown, request: unknown): Promise<unknown> => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    if (coreHost === null) return Promise.resolve({ ok: false, error: { code: 'UNAVAILABLE', message: 'ALTREX core is not ready.', retryable: true } })
    return coreHost.handleResult(name, request)
  })
  const stopForwarding = coreHost?.events.subscribe((coreEvent) => {
    if (!window.isDestroyed()) window.webContents.send(coreChannels.event, coreEvent)
  })
  window.once('closed', () => stopForwarding?.())

  const openProject = async (): Promise<ProjectSummary | null> => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Open a project in ALTREX CODE',
      buttonLabel: 'Open project',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled) return null
    const selectedPath = result.filePaths[0]
    if (selectedPath === undefined) return null
    trustedProjects.add(selectedPath)
    mkdirSync(stateDirectory, { recursive: true })
    writeFileSync(recentProjectPath, JSON.stringify({ path: selectedPath }), 'utf8')
    return summarizeProject(selectedPath)
  }
  // The most recent project stays available after a restart (the same trust rule as the recent-project handler).
  const recentProject = (): string | null => {
    try { const parsed = JSON.parse(readFileSync(recentProjectPath, 'utf8')) as { path?: unknown }; return typeof parsed.path === 'string' && existsSync(parsed.path) ? parsed.path : null } catch { return null }
  }
  projectOps = {
    open: openProject,
    list: () => {
      const recent = recentProject()
      if (recent) trustedProjects.add(recent)
      return [...trustedProjects].filter(path => existsSync(path)).map(summarizeProject).sort((a, b) => Number(b.path === recent) - Number(a.path === recent))
    },
  }
  ipcMain.handle(desktopChannels.openProject, async (event): Promise<ProjectSummary | null> => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return openProject()
  })

  ipcMain.handle(desktopChannels.recentProject, (event): ProjectSummary | null => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    try {
      const parsed = JSON.parse(readFileSync(recentProjectPath, 'utf8')) as { path?: unknown }
      if (typeof parsed.path !== 'string' || !existsSync(parsed.path)) return null
      trustedProjects.add(parsed.path)
      return summarizeProject(parsed.path)
    } catch {
      return null
    }
  })

  ipcMain.handle(desktopChannels.runtimeInfo, (event): RuntimeInfo => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return {
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      bridge: 'connected',
      codex: providerService.getCodexRuntimeInfo(),
    }
  })

  ipcMain.handle(desktopChannels.providerStatus, (event) => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return providerService.getStatus()
  })

  ipcMain.handle(desktopChannels.providerModels, (event, providerId?: ProviderId) => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return providerService.getModels(providerId)
  })

  ipcMain.handle(desktopChannels.providerRefreshModels, (event) => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return providerService.refreshModels()
  })

  ipcMain.handle(desktopChannels.providerInstallLocalModel, (event, modelId: string) => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    if (typeof modelId !== 'string' || modelId.length > 100) throw new Error('Invalid local model.')
    return providerService.installLocalModel(modelId)
  })

  ipcMain.handle(desktopChannels.providerDiagnostics, (event) => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return providerService.diagnostics()
  })

  ipcMain.handle(desktopChannels.attachmentPick, (event): Promise<ChatAttachment[]> => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return attachmentService.pick(window)
  })

  ipcMain.handle(desktopChannels.providerTest, (event, input: ProviderConnectionInput) => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return providerService.test(input)
  })

  ipcMain.handle(desktopChannels.providerConnect, (event, input: ProviderConnectionInput) => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    return providerService.connect(input)
  })

  ipcMain.handle(desktopChannels.providerDisconnect, (event, providerId?: ProviderId) => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    if (providerId !== undefined && !providerDefinitions.some(provider => provider.id === providerId)) throw new Error('Unsupported provider.')
    return providerService.disconnect(providerId)
  })

  ipcMain.handle(desktopChannels.providerOpenExternal, async (event, providerId: ProviderId, kind: ProviderLinkKind): Promise<void> => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    if (!providerDefinitions.some(provider => provider.id === providerId)) throw new Error('Could not open official provider page.')
    if (!['apiKey', 'accountId', 'install', 'docs'].includes(kind)) throw new Error('Could not open official provider page.')
    await openOfficialProviderLink(providerId, kind)
  })

  ipcMain.handle(desktopChannels.chatStart, (event, request: ChatRequest): void => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    if (
      typeof request?.requestId !== 'string'
      || !/^[a-zA-Z0-9-]{8,80}$/.test(request.requestId)
      || !Array.isArray(request.messages)
      || !Array.isArray(request.attachments)
      || request.attachments.length > 8
      || (request.mode !== 'ASK' && request.mode !== 'AGENT' && request.mode !== 'LOCAL' && request.mode !== 'MULTI')
      || (request.resumeRunId !== undefined && !/^[a-zA-Z0-9-]{8,80}$/.test(request.resumeRunId))
      || (request.routingMode !== undefined && !['AUTO', 'FAST', 'POWERFUL', 'FREE_ONLY', 'LOCAL_ONLY', 'CUSTOM'].includes(request.routingMode))
      || typeof request.modelSelection !== 'string'
      || request.modelSelection.length === 0
      || request.modelSelection.length > 200
      || request.messages.some((message) => (
        (message.role !== 'user' && message.role !== 'assistant')
        || typeof message.content !== 'string'
      ))
      || request.attachments.some((attachment) => (
        typeof attachment?.id !== 'string'
        || !/^[a-f0-9-]{36}$/.test(attachment.id)
        || typeof attachment.name !== 'string'
        || attachment.name.length === 0
        || attachment.name.length > 260
        || typeof attachment.mimeType !== 'string'
        || typeof attachment.size !== 'number'
        || attachment.size < 0
        || (attachment.kind !== 'image' && attachment.kind !== 'text' && attachment.kind !== 'file')
      ))
    ) throw new Error('Invalid chat request.')
    if (request.projectPath !== null && !trustedProjects.has(request.projectPath)) throw new Error('Project access was not granted.')

    startChat(request, providerService, payload => { if (!window.isDestroyed()) window.webContents.send(desktopChannels.chatEvent, payload) })
  })

  ipcMain.handle(desktopChannels.chatCancel, (event, requestId: string): void => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    if (typeof requestId !== 'string') throw new Error('Invalid request ID.')
    providerService.cancel(requestId)
  })
  ipcMain.handle(desktopChannels.runRevise, (event, id: string, text: string): void => {
    if (!isTrustedSender(window, event)) throw new Error('Rejected IPC sender')
    if (typeof id !== 'string' || typeof text !== 'string') throw new Error('Invalid revision.')
    providerService.revise(id, text)
  })
  ipcMain.handle(desktopChannels.projectRuns, (event, projectPath: string) => {
    if (!isTrustedSender(window, event) || !trustedProjects.has(projectPath)) throw new Error('Open the project before inspecting its runs.')
    return providerService.runs.list(projectPath)
  })
}

function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 360,
    height: 260,
    frame: false,
    resizable: false,
    movable: true,
    show: true,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#161616',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const logoDataUrl = nativeImage.createFromPath(appIconPngPath).toDataURL()
  const splashMarkup = `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'" />
        <style>
          * { box-sizing: border-box; }
          html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
          body { display: grid; place-items: center; background: #161616; color: #f2f2f2; font-family: Inter, Segoe UI, sans-serif; }
          main { display: flex; flex-direction: column; align-items: center; }
          img { width: 82px; height: 82px; object-fit: cover; mix-blend-mode: screen; }
          h1 { margin: 18px 0 0; font-size: 15px; font-weight: 560; letter-spacing: .28em; text-indent: .28em; }
          .progress { width: 70px; height: 1px; margin-top: 30px; overflow: hidden; background: #24272b; }
          .progress::after { content: ''; display: block; width: 28px; height: 1px; background: #c7c9cc; animation: move 1.25s ease-in-out infinite alternate; }
          @keyframes move { from { transform: translateX(-28px); opacity: .35; } to { transform: translateX(70px); opacity: .9; } }
          @media (prefers-reduced-motion: reduce) { .progress::after { animation: none; transform: translateX(21px); } }
        </style>
      </head>
      <body><main><img src="${logoDataUrl}" alt="" /><h1>ALTREX CODE</h1><div class="progress"></div></main></body>
    </html>`

  void splash.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(splashMarkup)}`)
  return splash
}

function launchWindowFlow(providerService: ProviderService, stateDirectory: string): void {
  const splash = createSplashWindow()
  splash.webContents.once('did-finish-load', () => {
    if (process.env.ALTREX_SMOKE_TEST === '1') console.log('[ALTREX_SPLASH_READY] logo=A')
    createWindow(splash, providerService, stateDirectory)
  })
  splash.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[ALTREX_SPLASH_FAILED]', errorCode, errorDescription)
    if (process.env.ALTREX_SMOKE_TEST === '1') app.exit(1)
  })
}

function createWindow(splash: BrowserWindow, providerService: ProviderService, stateDirectory: string): BrowserWindow {
  const windowIcon = nativeImage.createFromPath(process.platform === 'win32' ? appIconIcoPath : appIconPngPath)
  if (windowIcon.isEmpty()) throw new Error('ALTREX application icon could not be loaded')
  const window = new BrowserWindow({
    title: 'ALTREX CODE',
    width: 1540,
    height: 960,
    minWidth: 820,
    minHeight: 620,
    show: false,
    backgroundColor: '#161616',
    icon: windowIcon,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  registerIpc(window, providerService, stateDirectory)

  if (isDevelopment && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  let revealed = false
  const reveal = () => {
    if (revealed || window.isDestroyed()) return
    revealed = true
    if (!splash.isDestroyed()) splash.destroy()
    window.show()
    if (process.env.ALTREX_SMOKE_TEST === '1') {
      void window.webContents
        .executeJavaScript(`Promise.all([
          window.altrex?.getRuntimeInfo().then((info) => info.bridge),
          window.altrexCore?.invoke('events.replay', { afterSeq: 0 }).then((replay) => window.altrexCore.contractVersion === 1 && typeof replay.streamId === 'string'),
        ])`)
        .then(async ([bridge, core]: [unknown, unknown]) => {
          if (bridge !== 'connected') throw new Error('Secure preload bridge did not respond')
          if (core !== true) throw new Error('Core contract bridge (window.altrexCore) did not respond')
          const renderer = await window.webContents.executeJavaScript(`(async () => {
            await document.fonts.ready;
            const shell = document.querySelector('.v4-shell');
            const composer = document.querySelector('textarea[aria-label="Ask ALTREX"]');
            if (!shell || !composer) throw new Error('V4 workspace did not mount');
            const rect = composer.getBoundingClientRect();
            if (rect.left < 0 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) throw new Error('Composer outside viewport');
            return { workspace: 'v4', width: innerWidth, height: innerHeight, scale: devicePixelRatio, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
          })()`)
          if (renderer.horizontalOverflow) throw new Error('V4 workspace has horizontal overflow')
          // Layout can be ready before the visible compositor frame. Capture only after paint.
          await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
          await new Promise(resolve => setTimeout(resolve, 400))
          if (process.env.ALTREX_SMOKE_SCREENSHOT) writeFileSync(process.env.ALTREX_SMOKE_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
          console.log(`[ALTREX_SMOKE_READY] bridge=connected core=contract-v1 splash=closed icon=logo-a scale=${requestedScale ?? '1'}`)
          if (process.env.ALTREX_SMOKE_REPORT) writeFileSync(process.env.ALTREX_SMOKE_REPORT, JSON.stringify({ ready: true, packaged: app.isPackaged, bridge: 'connected', executable: process.execPath, renderer }))
          setTimeout(() => app.quit(), 700)
        })
        .catch((error: unknown) => {
          console.error('[ALTREX_SMOKE_FAILED]', error)
          app.exit(1)
        })
    }
  }
  window.once('ready-to-show', reveal)
  window.webContents.once('did-finish-load', reveal)

  return window
}

app.whenReady().then(async () => {
  if (app.isPackaged) configureInstalledLocalAiHome(app.getPath('userData'))
  // The local AI server is started lazily by the first request that needs it, never at startup.
  const stateDirectory = join(app.getPath('userData'), 'state')
  const savedProviderRetest = process.env.ALTREX_PROVIDER_RETEST
  const localSetup = process.env.ALTREX_LOCAL_SETUP === '1'
  const diagnostic = process.env.ALTREX_PROVIDER_CHECK === '1' || process.env.ALTREX_WORKFLOW_CHECK === '1' || localSetup || Boolean(savedProviderRetest)
  const providerStateRoot = join(app.getPath('userData'), 'multi-ai')
  const diagnosticRoot = diagnostic ? mkdtempSync(join(app.getPath('temp'), 'altrex-diagnostics-')) : null
  const events = new EventBus({ onListenerError: error => console.error('[ALTREX_EVENT_LISTENER]', error) })
  const checkpoints = new CheckpointStore(join(diagnosticRoot ?? join(app.getPath('userData'), 'core'), 'checkpoints'))
  const permissions = new PermissionCenter(join(diagnosticRoot ?? join(app.getPath('userData'), 'core'), 'permissions.json'), events)
  // Task records and per-task event history survive restarts; tasks left running by a crash become INTERRUPTED.
  const tasks = new TaskManager(events, new TaskStore(join(diagnosticRoot ?? join(app.getPath('userData'), 'core'), 'tasks')), error => console.error('[ALTREX_TASKS]', error))
  const interrupted = tasks.recover()
  const coreRoot = diagnosticRoot ?? join(app.getPath('userData'), 'core')
  projectMemory = new ProjectMemory(join(coreRoot, 'projects'))
  const leasesRoot = join(coreRoot, 'leases')
  // Workspaces left by a crash are removed; nothing they contained is applied or resumed.
  try { const removed = recoverLeases(leasesRoot); if (removed) console.log('[ALTREX_LEASES_RECOVERED]', removed) } catch (error) { console.error('[ALTREX_LEASES]', error) }
  if (interrupted.length) console.log('[ALTREX_TASKS_INTERRUPTED]', interrupted.length)
  const providerService = new ProviderService(join(app.getPath('userData'), 'credentials', 'provider.json'), diagnosticRoot ?? providerStateRoot, providerStateRoot, { events, checkpoints, permissions, tasks, memory: projectMemory, leasesRoot, consent: new ConsentStore(join(coreRoot, 'consent.json')) })
  coreHost = new CoreHost({
    events,
    checkpoints,
    isProjectTrusted: projectPath => [...trustedProjects].some(trusted => sameProject(trusted, projectPath)),
    isProjectBusy: projectPath => providerService.isProjectBusy(projectPath),
    onBridgeError: error => console.error('[ALTREX_EVENT_BRIDGE]', error),
    catalog: { providers: () => providerService.providerViews(), models: providerId => providerService.modelViews(providerId) },
    routing: { preview: request => providerService.previewRoute(request) },
    repo: projectPath => repositoryIntelligence(projectPath),
    permissions,
    tasks,
    memory: projectMemory,
    startTask: async start => {
      const request: ChatRequest = {
        requestId: randomUUID(),
        projectPath: start.projectPath,
        mode: start.mode,
        modelSelection: start.modelSelection,
        messages: [...start.history, { role: 'user', content: start.prompt }],
        attachments: attachmentService.lookup(start.attachmentIds),
        ...(start.routingMode === undefined ? {} : { routingMode: start.routingMode }),
        ...(start.resumeRunId === undefined ? {} : { resumeRunId: start.resumeRunId }),
        ...(start.candidates > 1 ? { candidates: start.candidates } : {}),
        ...(start.sessionId === undefined ? {} : { sessionId: start.sessionId }),
      }
      const taskId = startChat(request, providerService)
      if (taskId === null) throw new Error('The task could not be created.')
      return taskId
    },
    cancelRequest: requestId => providerService.cancel(requestId),
    consent: {
      list: () => providerService.consentEndpoints(),
      grant: endpoint => providerService.grantConsent(endpoint),
      revoke: endpoint => providerService.revokeConsent(endpoint),
    },
    projects: { open: async () => projectOps ? projectOps.open() : null, list: () => projectOps?.list() ?? [] },
    providers: {
      connect: async input => {
        if (!providerDefinitions.some(definition => definition.id === input.providerId)) throw new CoreCommandError('INVALID_REQUEST', `Unknown provider: ${input.providerId}`)
        await providerService.connect({ providerId: input.providerId as ProviderId, apiKey: input.apiKey, baseUrl: input.baseUrl, model: input.model, ...(input.additionalFields ? { additionalFields: input.additionalFields } : {}) })
      },
      disconnect: providerId => {
        if (!providerDefinitions.some(definition => definition.id === providerId)) throw new CoreCommandError('INVALID_REQUEST', `Unknown provider: ${providerId}`)
        providerService.disconnect(providerId as ProviderId)
      },
      test: async () => { await providerService.testConfigured() },
      refresh: async () => { await providerService.refreshModels() },
      openLink: async (providerId, kind) => {
        if (!providerDefinitions.some(definition => definition.id === providerId)) throw new CoreCommandError('INVALID_REQUEST', `Unknown provider: ${providerId}`)
        try { await openOfficialProviderLink(providerId as ProviderId, kind); return true } catch { return false }
      },
    },
  })
  let shutdownReady = false
  app.on('before-quit', event => {
    if (shutdownReady) return
    event.preventDefault()
    void providerService.stopAll()
      .then(() => stopLocalAiServer())
      .catch(() => undefined)
      .finally(() => { shutdownReady = true; app.quit() })
  })
  // Diagnostic modes exit via app.exit(), which skips before-quit; stop any server ALTREX started first.
  const exitDiagnostic = (code: number): void => { void stopLocalAiServer().catch(() => undefined).finally(() => app.exit(code)) }
  if (localSetup) {
    void providerService.installLocalModel(recommendedLocalCodingModel.id)
      .then(status => {
        const local = status.profiles?.find(profile => profile.providerId === 'ollama')
        console.log('[ALTREX_LOCAL_SETUP]', JSON.stringify({ connected: local?.connectionState === 'CONNECTED', model: local?.model ?? null, message: local?.statusMessage ?? null }))
        exitDiagnostic(local?.connectionState === 'CONNECTED' ? 0 : 1)
      })
      .catch(error => { console.error('[ALTREX_LOCAL_SETUP]', error instanceof Error ? error.message : 'Local AI setup failed.'); exitDiagnostic(1) })
    return
  }
  if (savedProviderRetest) {
    const providerId = providerDefinitions.some(provider => provider.id === savedProviderRetest) ? savedProviderRetest as ProviderId : null
    const profile = providerId ? providerService.getStatus().profiles?.find(item => item.providerId === providerId) : undefined
    if (!providerId || !profile) { console.error('[ALTREX_PROVIDER_RETEST] Saved provider was not found.'); exitDiagnostic(1); return }
    void providerService.test({ providerId, apiKey: '', baseUrl: profile.baseUrl ?? '', model: profile.model ?? '', additionalFields: profile.additionalFields ?? {} })
      .then(result => { console.log('[ALTREX_PROVIDER_RETEST]', JSON.stringify({ providerId, ...result })); exitDiagnostic(result.ok ? 0 : 1) })
      .catch(() => { console.error('[ALTREX_PROVIDER_RETEST] Could not unlock or test the saved connection.'); exitDiagnostic(1) })
    return
  }
  if (process.env.ALTREX_PROVIDER_CHECK === '1') {
    void providerService.testConfigured().then(results => { console.log('[ALTREX_PROVIDER_CHECK]', JSON.stringify(results)); exitDiagnostic(results.length > 0 && results.every(result => result.ok) ? 0 : 1) }).catch(() => { console.error('[ALTREX_PROVIDER_CHECK] Could not unlock or test saved connections.'); exitDiagnostic(1) })
    return
  }
  if (process.env.ALTREX_WORKFLOW_CHECK === '1') {
    void providerService.testWorkflows().then(results => { console.log('[ALTREX_WORKFLOW_CHECK]', JSON.stringify(results)); exitDiagnostic(results.every(result => result.ok) ? 0 : 1) }).catch(error => { console.error('[ALTREX_WORKFLOW_CHECK]', error instanceof Error ? error.message : 'Workflow check failed.'); exitDiagnostic(1) })
    return
  }
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  launchWindowFlow(providerService, stateDirectory)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) launchWindowFlow(providerService, stateDirectory)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

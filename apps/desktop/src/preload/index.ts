import { contextBridge, ipcRenderer } from 'electron'
import { desktopChannels, type ChatStreamEvent, type DesktopApi } from '../shared/desktop-api'
import { CORE_BRIDGE_GLOBAL, coreChannels } from '@altrex/contracts/channels'
import { CONTRACT_VERSION } from '@altrex/contracts/version'
import type { AltrexCoreBridge, AltrexEvent } from '@altrex/contracts'

const desktopApi: DesktopApi = Object.freeze({
  openProject: () => ipcRenderer.invoke(desktopChannels.openProject) as ReturnType<DesktopApi['openProject']>,
  getRecentProject: () => ipcRenderer.invoke(desktopChannels.recentProject) as ReturnType<DesktopApi['getRecentProject']>,
  getRuntimeInfo: () => ipcRenderer.invoke(desktopChannels.runtimeInfo) as ReturnType<DesktopApi['getRuntimeInfo']>,
  getProviderStatus: () => ipcRenderer.invoke(desktopChannels.providerStatus) as ReturnType<DesktopApi['getProviderStatus']>,
  getProviderModels: (providerId) => ipcRenderer.invoke(desktopChannels.providerModels, providerId) as ReturnType<DesktopApi['getProviderModels']>,
  refreshProviderModels: () => ipcRenderer.invoke(desktopChannels.providerRefreshModels) as ReturnType<DesktopApi['refreshProviderModels']>,
  installLocalModel: (modelId) => ipcRenderer.invoke(desktopChannels.providerInstallLocalModel, modelId) as ReturnType<DesktopApi['installLocalModel']>,
  getProviderDiagnostics: () => ipcRenderer.invoke(desktopChannels.providerDiagnostics) as ReturnType<DesktopApi['getProviderDiagnostics']>,
  pickAttachments: () => ipcRenderer.invoke(desktopChannels.attachmentPick) as ReturnType<DesktopApi['pickAttachments']>,
  testProvider: (input) => ipcRenderer.invoke(desktopChannels.providerTest, input) as ReturnType<DesktopApi['testProvider']>,
  connectProvider: (input) => ipcRenderer.invoke(desktopChannels.providerConnect, input) as ReturnType<DesktopApi['connectProvider']>,
  disconnectProvider: (providerId) => ipcRenderer.invoke(desktopChannels.providerDisconnect, providerId) as ReturnType<DesktopApi['disconnectProvider']>,
  openExternalProviderLink: (providerId, kind) => ipcRenderer.invoke(desktopChannels.providerOpenExternal, providerId, kind) as ReturnType<DesktopApi['openExternalProviderLink']>,
  startChat: (request) => ipcRenderer.invoke(desktopChannels.chatStart, request) as ReturnType<DesktopApi['startChat']>,
  cancelChat: (requestId) => ipcRenderer.invoke(desktopChannels.chatCancel, requestId) as ReturnType<DesktopApi['cancelChat']>,
  reviseRun: (requestId, text) => ipcRenderer.invoke(desktopChannels.runRevise, requestId, text) as ReturnType<DesktopApi['reviseRun']>,
  getProjectRuns: (projectPath) => ipcRenderer.invoke(desktopChannels.projectRuns, projectPath) as ReturnType<DesktopApi['getProjectRuns']>,
  onChatEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ChatStreamEvent): void => listener(payload)
    ipcRenderer.on(desktopChannels.chatEvent, wrapped)
    return () => ipcRenderer.removeListener(desktopChannels.chatEvent, wrapped)
  },
})

contextBridge.exposeInMainWorld('altrex', desktopApi)

// Contract-v1 core bridge. Commands are validated in the main process; events arrive pre-validated.
const coreBridge: AltrexCoreBridge = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  onEvent: (listener: (event: AltrexEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AltrexEvent): void => listener(payload)
    ipcRenderer.on(coreChannels.event, wrapped)
    return () => ipcRenderer.removeListener(coreChannels.event, wrapped)
  },
  // The main process always answers with a result envelope; `invoke` turns failures into Errors.
  invoke: (async (name: string, request: unknown) => {
    const result = await ipcRenderer.invoke(coreChannels.command, name, request) as { ok: boolean; value?: unknown; error?: { code: string; message: string } }
    if (!result.ok) throw new Error(`${result.error?.code ?? 'INTERNAL'}: ${result.error?.message ?? 'The command failed.'}`)
    return result.value
  }) as AltrexCoreBridge['invoke'],
  invokeResult: ((name: string, request: unknown) => ipcRenderer.invoke(coreChannels.command, name, request)) as AltrexCoreBridge['invokeResult'],
})

contextBridge.exposeInMainWorld(CORE_BRIDGE_GLOBAL, coreBridge)

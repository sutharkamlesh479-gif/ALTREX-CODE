import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { isApprovedLocalModel } from '../shared/local-ai'

export type OllamaPullCommand = { command: 'ollama'; args: ['pull', string] }

let installedLocalAiHome: string | undefined

export function configureInstalledLocalAiHome(userDataDirectory: string): void {
  installedLocalAiHome = join(userDataDirectory, 'local-ai')
}

export function ollamaPullCommand(modelId: string): OllamaPullCommand {
  if (!isApprovedLocalModel(modelId)) throw new Error('This local model is not approved by ALTREX.')
  return { command: 'ollama', args: ['pull', modelId] }
}

function findWorkspaceRoot(startDirectory = process.cwd()): string {
  let current = resolve(startDirectory)
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml')) || existsSync(join(current, 'ALTREX.md'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return resolve(startDirectory)
}

export function localAiHome(startDirectory = process.cwd()): string {
  const configured = process.env.ALTREX_LOCAL_AI_HOME?.trim()
  return configured ? resolve(configured) : installedLocalAiHome ?? join(findWorkspaceRoot(startDirectory), '.local-ai')
}

export function localModelDirectory(startDirectory = process.cwd()): string {
  const configured = process.env.ALTREX_LOCAL_MODEL_DIR?.trim()
  return configured ? resolve(configured) : join(localAiHome(startDirectory), 'models')
}

function executableCandidates(startDirectory = process.cwd()): string[] {
  const configured = process.env.ALTREX_OLLAMA_PATH?.trim()
  const candidates = [
    configured,
    join(localAiHome(startDirectory), 'runtime', process.platform === 'win32' ? 'ollama.exe' : 'ollama'),
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe')
      : undefined,
  ].filter((entry): entry is string => Boolean(entry))

  if (process.platform === 'win32') {
    for (const directory of (process.env.Path ?? process.env.PATH ?? '').split(delimiter)) {
      if (directory) candidates.push(join(directory, 'ollama.exe'))
    }
  }
  return candidates
}

export function resolveOllamaExecutable(startDirectory = process.cwd()): string {
  return executableCandidates(startDirectory).find(candidate => existsSync(candidate)) ?? 'ollama'
}

function ollamaEnvironment(startDirectory = process.cwd()): NodeJS.ProcessEnv {
  const models = localModelDirectory(startDirectory)
  mkdirSync(models, { recursive: true })
  const cpuOnly = process.env.ALTREX_LOCAL_AI_CPU_ONLY === '1' || existsSync(join(localAiHome(startDirectory), 'cpu-only'))
  return {
    ...process.env,
    OLLAMA_MODELS: models,
    ...(cpuOnly ? { OLLAMA_VULKAN: '0', GGML_VK_VISIBLE_DEVICES: '-1' } : {}),
  }
}

async function serverIsReady(): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2_000) })
    return response.ok
  } catch {
    return false
  }
}

/** The subset of a spawned child process the runtime relies on (injectable for tests). */
export type RuntimeChild = {
  readonly pid?: number | undefined
  readonly exitCode: number | null
  once(event: 'spawn', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: () => void): unknown
  unref(): void
}

export type LocalAiRuntimeDeps = {
  isReady: () => Promise<boolean>
  startServer: () => RuntimeChild
  killTree: (pid: number) => void
  sleep: (ms: number) => Promise<void>
  readyAttempts: number
}

/**
 * Owns the local Ollama server lifecycle. The server is started lazily, only when a request actually
 * needs it (never during app startup), and only a process this runtime started is ever stopped;
 * an Ollama instance the user runs themselves is used but never killed.
 */
export class LocalAiRuntime {
  private child: RuntimeChild | null = null
  private starting: Promise<void> | null = null

  constructor(private readonly deps: LocalAiRuntimeDeps) {}

  /** True while a server process started by ALTREX is running. */
  ownsProcess(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  async ensureStarted(): Promise<void> {
    if (this.starting) return this.starting
    if (await this.deps.isReady()) return
    this.starting ??= this.start().finally(() => { this.starting = null })
    return this.starting
  }

  /** Stops the server only if this runtime started it. Safe to call repeatedly. */
  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null || child.pid === undefined) return
    const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()))
    this.deps.killTree(child.pid)
    await Promise.race([exited, this.deps.sleep(3_000)])
  }

  private async start(): Promise<void> {
    const child = this.deps.startServer()
    let spawnError: NodeJS.ErrnoException | null = null
    let exited = false
    child.once('error', error => { spawnError = error })
    child.once('exit', () => { exited = true; if (this.child === child) this.child = null })
    await new Promise<void>(resolveSpawn => { child.once('spawn', () => resolveSpawn()); child.once('error', () => resolveSpawn()) })
    if (spawnError) throw toStartError(spawnError)
    child.unref()
    this.child = child

    for (let attempt = 0; attempt < this.deps.readyAttempts; attempt += 1) {
      if (await this.deps.isReady()) return
      // An early exit usually means another Ollama instance owns the port; use it if it answers.
      if (exited) {
        if (await this.deps.isReady()) return
        throw new Error('The local AI server exited during startup.')
      }
      await this.deps.sleep(1_000)
    }
    await this.stop()
    throw new Error('The local AI server did not become ready.')
  }
}

function toStartError(error: NodeJS.ErrnoException): Error {
  return new Error(error.code === 'ENOENT'
    ? 'Ollama is not installed. Install Ollama or place the portable runtime in .local-ai/runtime.'
    : 'ALTREX could not start the local AI server.')
}

function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => { try { process.kill(pid) } catch { /* already exited */ } })
  } else {
    try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ } }
  }
}

const defaultRuntime = new LocalAiRuntime({
  isReady: serverIsReady,
  startServer: () => spawn(resolveOllamaExecutable(), ['serve'], {
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
    env: ollamaEnvironment(),
  }),
  killTree: killProcessTree,
  sleep: ms => new Promise(resolveWait => setTimeout(resolveWait, ms)),
  readyAttempts: 30,
})

/** Starts the local AI server if it is not already answering. Called lazily on first local-AI use. */
export async function ensureLocalAiServer(): Promise<void> {
  return defaultRuntime.ensureStarted()
}

/** Stops the local AI server if, and only if, ALTREX started it. Called on application quit. */
export async function stopLocalAiServer(): Promise<void> {
  return defaultRuntime.stop()
}

export async function pullLocalModel(modelId: string): Promise<void> {
  const invocation = ollamaPullCommand(modelId)
  await ensureLocalAiServer()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolveOllamaExecutable(), invocation.args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: ollamaEnvironment(),
    })
    let output = ''
    const collect = (chunk: Buffer): void => { output = `${output}${chunk.toString()}`.slice(-12_000) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('The local model download timed out. Open Ollama and try again.'))
    }, 45 * 60_000)
    child.once('error', error => {
      clearTimeout(timeout)
      reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'Ollama is not installed. Use Install Ollama first, then retry the model download.'
        : 'ALTREX could not start the Ollama model download.'))
    })
    child.once('close', code => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`Ollama could not install the model.${output.trim() ? ` ${output.trim().slice(-500)}` : ''}`))
    })
  })
}

export async function unloadLocalModel(modelId: string): Promise<void> {
  if (!isApprovedLocalModel(modelId)) throw new Error('This local model is not approved by ALTREX.')
  await new Promise<void>((resolveUnload, rejectUnload) => {
    const child = spawn(resolveOllamaExecutable(), ['stop', modelId], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      env: ollamaEnvironment(),
    })
    child.once('error', () => rejectUnload(new Error('ALTREX could not unload the local model.')))
    child.once('close', code => code === 0 ? resolveUnload() : rejectUnload(new Error('Ollama could not unload the local model.')))
  })
}

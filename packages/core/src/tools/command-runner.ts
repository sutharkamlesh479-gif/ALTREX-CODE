import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

export type ProjectCommandResult = {
  command: string
  exitCode: number | null
  output: string
  timedOut: boolean
}

// Which commands may run is decided by the command classifier + permission policy (security/), not by
// this runner. The runner enforces execution safety: argv only (no shell), shell metacharacter rejection
// for Windows .cmd shims, inline-code flags blocked, secret-looking environment variables stripped,
// bounded output, and whole-process-tree termination.
const shellLaunchers = new Set(['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'wsl'])

const blockedInlineExecution = new Map<string, Set<string>>([
  ['node', new Set(['-e', '--eval', '-p', '--print'])],
  ['python', new Set(['-c'])],
  ['python3', new Set(['-c'])],
  ['py', new Set(['-c'])],
])

const sensitiveEnvironmentName = /(api.?key|token|secret|password|credential|private.?key)/i
const commandArgumentHazards = /[\0\r\n"&|<>^%!]/
const maxOutputCharacters = 200_000

function safeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !sensitiveEnvironmentName.test(name)) environment[name] = value
  }
  environment.CI = '1'
  environment.NO_COLOR = '1'
  return environment
}

function resolveExecutable(command: string, projectRoot: string): string {
  const wrapperCandidates = process.platform === 'win32'
    ? [join(projectRoot, `${command}.cmd`), join(projectRoot, `${command}.bat`)]
    : [join(projectRoot, command)]
  const localWrapper = wrapperCandidates.find((candidate) => existsSync(candidate))
  if (localWrapper !== undefined && (command === 'gradlew' || command === 'mvnw')) return localWrapper

  const finder = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = spawnSync(finder, [command], { encoding: 'utf8', windowsHide: true })
  const executable = result.stdout.split(/\r?\n/).map((entry) => entry.trim()).find(entry => !!entry && (process.platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(entry)))
  if (result.status !== 0 || executable === undefined) throw new Error(`Command not found: ${command}`)
  return executable
}

function quoteCmdArgument(value: string): string {
  if (commandArgumentHazards.test(value)) throw new Error('A command argument contained blocked shell characters.')
  if (value.length === 0) return '""'
  return /\s/.test(value) ? `"${value}"` : value
}

function displayCommand(command: string, args: string[]): string {
  return [command, ...args.map((argument) => (/\s/.test(argument) ? JSON.stringify(argument) : argument))].join(' ')
}

export async function runProjectCommand({
  projectRoot,
  command,
  args,
  timeoutMs,
  signal,
  onOutput,
}: {
  projectRoot: string
  command: string
  args: string[]
  timeoutMs: number
  signal: AbortSignal
  /** Live output chunks (bounded by the same 200,000 character cap as the returned output). */
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void
}): Promise<ProjectCommandResult> {
  const normalizedCommand = command.trim().toLowerCase().replace(/\.(cmd|exe|bat)$/i, '')
  if (!/^[a-z0-9][a-z0-9._+-]*$/i.test(normalizedCommand) || shellLaunchers.has(normalizedCommand)) {
    throw new Error(`Command is not allowed: ${command}`)
  }
  if (args.length > 80 || args.some((argument) => argument.length > 8_000 || /[\0\r\n]/.test(argument))) {
    throw new Error('Command arguments exceeded the execution limits.')
  }
  const blockedFlags = blockedInlineExecution.get(normalizedCommand)
  if (blockedFlags !== undefined && args.some((argument) => blockedFlags.has(argument.toLowerCase()))) {
    throw new Error(`${normalizedCommand} inline code execution is blocked. Run a project file instead.`)
  }
  if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError')

  const executable = resolveExecutable(normalizedCommand, projectRoot)
  const isWindowsScript = process.platform === 'win32' && (extname(executable).toLowerCase() === '.cmd' || extname(executable).toLowerCase() === '.bat')
  const childCommand = isWindowsScript ? (process.env.ComSpec ?? 'cmd.exe') : executable
  const childArgs = isWindowsScript
    ? ['/d', '/s', '/c', `"${quoteCmdArgument(executable)} ${args.map(quoteCmdArgument).join(' ')}"`]
    : args
  const shownCommand = displayCommand(basename(normalizedCommand), args)

  return new Promise<ProjectCommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(childCommand, childArgs, {
      cwd: projectRoot,
      env: safeEnvironment(),
      shell: false,
      windowsVerbatimArguments: isWindowsScript,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let truncated = false
    let timedOut = false
    let settled = false

    const append = (stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      if (output.length >= maxOutputCharacters) {
        truncated = true
        return
      }
      const text = chunk.toString('utf8')
      const remaining = maxOutputCharacters - output.length
      output += text.slice(0, remaining)
      if (text.length > remaining) truncated = true
      try { onOutput?.(stream, text.slice(0, remaining)) } catch { /* observers never break a command */ }
    }
    child.stdout.on('data', append('stdout'))
    child.stderr.on('data', append('stderr'))

    const terminate = (): void => {
      if (child.pid === undefined || settled) return
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => child.kill())
        killer.on('exit', code => { if (code !== 0 && !settled) child.kill() })
      } else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    }
    const timeout = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    const onAbort = (): void => terminate()
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()

    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      rejectPromise(error)
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      const finalOutput = `${output.trim()}${truncated ? '\n[output truncated]' : ''}`.trim()
      resolvePromise({
        command: shownCommand,
        exitCode,
        output: finalOutput || '(command produced no output)',
        timedOut,
      })
    })
  })
}

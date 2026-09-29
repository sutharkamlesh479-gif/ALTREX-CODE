import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalAiRuntime, type LocalAiRuntimeDeps, type RuntimeChild } from './local-ai-service'

// Regression tests for Phase 1 fix A: the local AI server used to be started (and awaited for up to
// ~90 s) during app startup, and the detached process was never stopped.

class FakeChild extends EventEmitter implements RuntimeChild {
  exitCode: number | null = null
  unref = vi.fn()
  constructor(readonly pid: number | undefined = 4242) { super() }
  exit(code = 0) { this.exitCode = code; this.emit('exit') }
}

function runtime(overrides: Partial<LocalAiRuntimeDeps> & { child?: FakeChild; readyAfter?: number } = {}) {
  const child = overrides.child ?? new FakeChild()
  let readinessChecks = 0
  const deps: LocalAiRuntimeDeps = {
    isReady: vi.fn(async () => { readinessChecks++; return overrides.readyAfter !== undefined && readinessChecks > overrides.readyAfter }),
    startServer: vi.fn(() => { queueMicrotask(() => child.emit('spawn')); return child }),
    killTree: vi.fn((pid: number) => { if (pid === child.pid) queueMicrotask(() => child.exit(1)) }),
    sleep: vi.fn(async () => undefined),
    readyAttempts: 5,
    ...overrides,
  }
  return { runtime: new LocalAiRuntime(deps), deps, child }
}

describe('LocalAiRuntime lifecycle', () => {
  it('uses an already-running server without starting or ever stopping it', async () => {
    const { runtime: local, deps } = runtime({ isReady: vi.fn(async () => true) })
    await local.ensureStarted()
    await local.stop()
    expect(deps.startServer).not.toHaveBeenCalled()
    expect(deps.killTree).not.toHaveBeenCalled()
    expect(local.ownsProcess()).toBe(false)
  })

  it('starts the server once for concurrent callers and waits until it answers', async () => {
    const { runtime: local, deps, child } = runtime({ readyAfter: 3 })
    await Promise.all([local.ensureStarted(), local.ensureStarted(), local.ensureStarted()])
    expect(deps.startServer).toHaveBeenCalledTimes(1)
    expect(child.unref).toHaveBeenCalled()
    expect(local.ownsProcess()).toBe(true)
  })

  it('stops only the process it started, and only once', async () => {
    const { runtime: local, deps, child } = runtime({ readyAfter: 1 })
    await local.ensureStarted()
    await local.stop()
    await local.stop()
    expect(deps.killTree).toHaveBeenCalledTimes(1)
    expect(deps.killTree).toHaveBeenCalledWith(child.pid)
    expect(local.ownsProcess()).toBe(false)
  })

  it('reports a missing Ollama installation promptly instead of polling', async () => {
    const child = new FakeChild(undefined)
    const { runtime: local, deps } = runtime({
      child,
      startServer: vi.fn(() => { queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ollama ENOENT'), { code: 'ENOENT' }))); return child }),
    })
    await expect(local.ensureStarted()).rejects.toThrow('Ollama is not installed')
    expect(deps.sleep).not.toHaveBeenCalled()
    expect(local.ownsProcess()).toBe(false)
  })

  it('fails fast when the server exits during startup and nothing else answers', async () => {
    const { runtime: local, deps, child } = runtime({ sleep: vi.fn(async () => { child.exit(1) }) })
    await expect(local.ensureStarted()).rejects.toThrow('exited during startup')
    expect(deps.sleep).toHaveBeenCalledTimes(1)
  })

  it('stops its own process when the server never becomes ready', async () => {
    const { runtime: local, deps, child } = runtime()
    await expect(local.ensureStarted()).rejects.toThrow('did not become ready')
    expect(deps.isReady).toHaveBeenCalledTimes(6)
    expect(deps.killTree).toHaveBeenCalledWith(child.pid)
  })
})

describe('application startup', () => {
  it('does not start or await the local AI runtime in the main process entry point', () => {
    // Static guard: the Electron entry point cannot be unit-tested without launching Electron.
    const entry = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    expect(entry).not.toMatch(/ensureLocalAiServer/)
    expect(entry).toMatch(/stopLocalAiServer/)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { localAiHome, localModelDirectory, ollamaPullCommand } from './local-ai-service'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

describe('local AI model installer', () => {
  it('uses a fixed shell-free Ollama pull command for the approved coding model', () => {
    expect(ollamaPullCommand('qwen2.5-coder:7b-instruct')).toEqual({
      command: 'ollama',
      args: ['pull', 'qwen2.5-coder:7b-instruct'],
    })
  })

  it('rejects arbitrary renderer-supplied model names', () => {
    expect(() => ollamaPullCommand('anything; remove-files')).toThrow('not approved')
  })

  it('keeps the portable runtime and models inside the ALTREX workspace', () => {
    const desktopPackage = process.cwd()
    const workspace = resolve(desktopPackage, '..', '..')
    expect(localAiHome(desktopPackage)).toBe(join(workspace, '.local-ai'))
    expect(localModelDirectory(desktopPackage)).toBe(join(workspace, '.local-ai', 'models'))
  })

  it('stores installed-app models in user data regardless of the shortcut working directory', async () => {
    vi.stubEnv('ALTREX_LOCAL_AI_HOME', '')
    vi.stubEnv('ALTREX_LOCAL_MODEL_DIR', '')
    const installed = await import('./local-ai-service')
    const userData = resolve('test-user-data')
    installed.configureInstalledLocalAiHome(userData)
    expect(installed.localAiHome('C:\\Windows\\System32')).toBe(join(userData, 'local-ai'))
    expect(installed.localModelDirectory('C:\\Program Files\\ALTREX CODE')).toBe(join(userData, 'local-ai', 'models'))
    vi.stubEnv('ALTREX_LOCAL_AI_HOME', resolve('custom-model-storage'))
    expect(installed.localAiHome()).toBe(resolve('custom-model-storage'))
  })
})

import { describe, expect, it } from 'vitest'
import { getCodexRuntimeInfo, parseCodexEvent } from './codex-cli-agent'

describe('Codex App Server bridge', () => {
  it('detects a runnable executable and captures its version', () => {
    const status = getCodexRuntimeInfo(process.execPath)
    expect(status.available).toBe(true)
    expect(status.version).toMatch(/^v?\d+/)
  })

  it('parses official JSON-RPC event shapes and rejects noise', () => {
    expect(parseCodexEvent('{"method":"thread/started","params":{"thread":{"id":"thread-1"}}}')).toEqual({
      method: 'thread/started',
      params: { thread: { id: 'thread-1' } },
    })
    expect(parseCodexEvent('{"method":"item/agentMessage/delta","params":{"delta":"done"}}')?.params?.delta).toBe('done')
    expect(parseCodexEvent('Codex warning output')).toBeNull()
  })
})

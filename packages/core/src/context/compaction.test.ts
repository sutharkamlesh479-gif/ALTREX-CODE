import { describe, expect, it } from 'vitest'
import type { ProviderMessage } from '../gateway/messages'
import { effectivePolicy } from '../gateway/request-executor'
import { budgetContext } from './budget'

const call = (id: string, name: string, args: Record<string, unknown>): ProviderMessage => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const result = (id: string, content: string): ProviderMessage => ({ role: 'tool', tool_call_id: id, content })
const toolText = (messages: ProviderMessage[], id: string) => messages.find(message => message.role === 'tool' && message.tool_call_id === id)?.content

describe('context compaction (Phase 5)', () => {
  const history: ProviderMessage[] = [
    { role: 'system', content: 'Agent.' }, { role: 'user', content: 'Fix the bug.' },
    call('r1', 'read_file', { path: 'src/a.ts' }), result('r1', 'src/a.ts (10 lines)\nOLD CONTENT'),
    call('c1', 'run_command', { command: 'npm', args: ['test'] }), result('c1', 'Command exited with code 1: npm test\nFAIL a.test.ts expected 2 got 3'),
    call('w1', 'edit_file', { path: 'src/a.ts', old_text: 'x', new_text: 'y' }), result('w1', 'Wrote src/a.ts'),
    call('l1', 'list_files', { path: '' }), result('l1', 'src/\npackage.json'),
    call('r2', 'read_file', { path: 'src/b.ts' }), result('r2', 'src/b.ts (3 lines)\nB CONTENT'),
    call('r3', 'read_file', { path: 'src/c.ts' }), result('r3', 'src/c.ts (3 lines)\nC CONTENT'),
  ]

  it('replaces a file read that was superseded by a later change to the same file', () => {
    const { messages } = budgetContext(history, [], 20_000)
    expect(toolText(messages, 'r1')).toContain('[Superseded: src/a.ts')
    expect(toolText(messages, 'r1')).not.toContain('OLD CONTENT')
  })

  it('keeps the most recent failing command output in full while compacting other old results', () => {
    const { messages } = budgetContext(history, [], 20_000)
    expect(toolText(messages, 'c1')).toContain('expected 2 got 3')
    expect(toolText(messages, 'w1')).toBe('Wrote src/a.ts [older tool output compacted]')
    expect(toolText(messages, 'r3')).toContain('C CONTENT')
    expect(toolText(messages, 'r2')).toContain('B CONTENT')
  })

  it('never produces orphan tool results', () => {
    const { messages } = budgetContext(history, [], 20_000)
    const ids = new Set(messages.flatMap(message => message.tool_calls?.map(item => item.id) ?? []))
    expect(messages.filter(message => message.role === 'tool').every(message => ids.has(message.tool_call_id!))).toBe(true)
  })
})

describe('model-aware request budget (Phase 5)', () => {
  const base = { providerId: 'openrouter', baseUrl: 'https://x.invalid/v1', model: 'm', apiKey: 'k' }

  it('keeps the conservative default only when the model limits are unknown', () => {
    expect(effectivePolicy(base).inputTokens).toBe(6000)
  })

  it('sizes the input budget from a known context window', () => {
    // Output limit unknown, large window known: output grows to min(8192, window/8) and input is 75% of the window minus it.
    expect(effectivePolicy({ ...base, contextWindow: 128_000 })).toMatchObject({ outputTokens: 8192, inputTokens: 96_000 - 8192 })
    expect(effectivePolicy({ ...base, contextWindow: 1_048_576 }).inputTokens).toBe(128_000)
    expect(effectivePolicy({ ...base, contextWindow: 8192, maxOutput: 4096 })).toMatchObject({ outputTokens: 4096, inputTokens: 2048 })
  })

  it('never overrides a budget the user set or a per-call override', () => {
    expect(effectivePolicy({ ...base, contextWindow: 128_000, requestPolicy: { inputTokens: 12_000 } }).inputTokens).toBe(12_000)
    expect(effectivePolicy({ ...base, contextWindow: 128_000 }, { inputTokens: 1024 }).inputTokens).toBe(1024)
  })
})

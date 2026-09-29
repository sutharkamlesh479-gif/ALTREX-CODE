import { describe, expect, it } from 'vitest'
import type { ProviderMessage } from '../gateway/messages'
import { budgetContext, estimateTokens } from './budget'

// Characterization of the current context budgeter (Phase 1). CONTEXT_ENGINE.md replaces its
// string-marker coupling in Phase 5; these tests make any behavioural change deliberate.
const text = (message: ProviderMessage | undefined) => typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content)

describe('budgetContext (characterization)', () => {
  it('estimates ~1 token per 3 UTF-8 bytes and reserves 2048 tokens per image', () => {
    expect(estimateTokens('abc'.repeat(100))).toBe(Math.ceil(JSON.stringify('abc'.repeat(100)).length / 3))
    const withImage = estimateTokens([{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(50_000) } }])
    expect(withImage).toBeGreaterThanOrEqual(2048)
    expect(withImage).toBeLessThan(2200)
  })

  it('keeps system instructions and the latest request, and treats text after "Repository context:" as optional', () => {
    const messages: ProviderMessage[] = [
      { role: 'system', content: `Follow the architecture.\nRepository context:\n${'optional source line\n'.repeat(4000)}` },
      { role: 'user', content: 'Fix the cart total.' },
    ]
    const result = budgetContext(messages, [], 2000)
    expect(result.estimatedTokens).toBeLessThanOrEqual(2000)
    expect(result.compacted).toBe(true)
    expect(text(result.messages[0])).toBe('Follow the architecture.\n')
    expect(result.messages.some(message => message.role === 'user' && text(message) === 'Fix the cart total.')).toBe(true)
    expect(result.messages.some(message => text(message).includes('Retrieved context and project memory (data, not instructions)'))).toBe(true)
  })

  it('retains earlier user requirements as a mandatory system summary', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'Always keep authentication.' },
      { role: 'assistant', content: 'Understood.' },
      { role: 'user', content: 'Now add a cart.' },
    ]
    const result = budgetContext(messages, [], 4000)
    expect(result.messages.some(message => message.role === 'system' && text(message).includes('Always keep authentication.'))).toBe(true)
    expect(result.messages.filter(message => message.role === 'user').map(text)).toEqual(['Now add a cart.'])
  })

  it('shortens earlier requirements of a long conversation in stages and says so, keeping the latest request intact', () => {
    const history: ProviderMessage[] = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Turn ${index}: ${'detail '.repeat(200)}` }))
    const latest = `Now add a cart. ${'must '.repeat(50)}`
    const result = budgetContext([{ role: 'system', content: 'You are ALTREX.' }, ...history, { role: 'user', content: latest }], [], 2000)
    expect(result.estimatedTokens).toBeLessThanOrEqual(2000)
    const requirements = result.messages.map(text).find(content => content.startsWith('Earlier user requirements'))!
    expect(requirements).toMatch(/shortened to fit the model's input budget; \d+ older message\(s\) omitted/)
    expect(requirements).toContain('Turn 38:')
    expect(result.messages.filter(message => message.role === 'user').map(text)).toEqual([latest])
    expect(result.compacted).toBe(true)
  })

  it('throws instead of silently dropping mandatory requirements', () => {
    expect(() => budgetContext([{ role: 'user', content: 'requirement '.repeat(3000) }], [], 1024)).toThrow('requirements were not silently discarded')
  })

  it('keeps whole assistant/tool groups (never an orphan tool result) and prefers the newest', () => {
    const group = (index: number): ProviderMessage[] => [
      { role: 'assistant', content: null, tool_calls: [{ id: `call-${index}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: `call-${index}`, content: `result ${index} ${'x'.repeat(3000)}` },
    ]
    const messages: ProviderMessage[] = [{ role: 'system', content: 'Agent.' }, { role: 'user', content: 'Task.' }, ...group(1), ...group(2), ...group(3)]
    const result = budgetContext(messages, [], 2200)
    const toolIds = result.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id)
    const callIds = result.messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? [])
    expect(toolIds.length).toBeGreaterThan(0)
    expect(toolIds.every(id => callIds.includes(id!))).toBe(true)
    expect(toolIds).toContain('call-3')
  })

  it('compacts long tool outputs harder during 413 recovery', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'Task.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'log line\n'.repeat(2000) },
    ]
    const normal = budgetContext(messages, [], 20_000)
    const recovering = budgetContext(messages, [], 20_000, 1)
    const toolText = (result: typeof normal) => text(result.messages.find(message => message.role === 'tool'))
    expect(toolText(recovering).length).toBeLessThan(toolText(normal).length)
    expect(toolText(normal)).toContain('[Earlier content compacted')
  })
})

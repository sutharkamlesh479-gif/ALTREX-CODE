import { describe, expect, it } from 'vitest'
import {
  getConversationTitle,
  parseLocalConversation,
  type LocalConversationMessage,
} from './local-conversation'

const message: LocalConversationMessage = {
  id: 'message-1',
  role: 'user',
  content: 'Build a reliable local conversation flow',
  createdAt: '2026-08-10T16:00:00.000Z',
  status: 'complete',
}

describe('local conversation state', () => {
  it('restores only valid local messages', () => {
    const restored = parseLocalConversation(JSON.stringify([message, { id: 2 }]))
    expect(restored).toEqual([message])
    expect(parseLocalConversation('not-json')).toEqual([])
  })

  it('restores validated command results', () => {
    const commandMessage: LocalConversationMessage = {
      ...message,
      role: 'assistant',
      commands: [{ command: 'pnpm build', exitCode: 0, output: 'built' }],
    }
    expect(parseLocalConversation(JSON.stringify([commandMessage]))).toEqual([commandMessage])
  })

  it('creates a compact recent-task title', () => {
    expect(getConversationTitle([message])).toBe('Build a reliable local conversation fl...')
  })
})

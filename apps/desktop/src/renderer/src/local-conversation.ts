export const LOCAL_CONVERSATION_STORAGE_KEY = 'altrex.local-conversation.v2'

export type LocalConversationRole = 'user' | 'assistant'

export type LocalCommandResult = {
  command: string
  exitCode: number | null
  output: string
}

export type LocalConversationMessage = {
  id: string
  role: LocalConversationRole
  content: string
  createdAt: string
  status: 'complete' | 'streaming' | 'error' | 'cancelled'
  provider?: string
  model?: string
  activity?: string
  activities?: string[]
  finishedAt?: string
  files?: string[]
  commands?: LocalCommandResult[]
  attachments?: ChatAttachment[]
}

function isLocalCommandResult(value: unknown): value is LocalCommandResult {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<LocalCommandResult>
  return typeof candidate.command === 'string'
    && (typeof candidate.exitCode === 'number' || candidate.exitCode === null)
    && typeof candidate.output === 'string'
}

function isLocalConversationMessage(value: unknown): value is LocalConversationMessage {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<LocalConversationMessage>
  return (
    typeof candidate.id === 'string'
    && (candidate.role === 'user' || candidate.role === 'assistant')
    && typeof candidate.content === 'string'
    && typeof candidate.createdAt === 'string'
    && (candidate.status === 'complete' || candidate.status === 'streaming' || candidate.status === 'error' || candidate.status === 'cancelled')
    && (candidate.provider === undefined || typeof candidate.provider === 'string')
    && (candidate.model === undefined || typeof candidate.model === 'string')
    && (candidate.activity === undefined || typeof candidate.activity === 'string')
    && (candidate.activities === undefined || (Array.isArray(candidate.activities) && candidate.activities.every(value => typeof value === 'string')))
    && (candidate.finishedAt === undefined || typeof candidate.finishedAt === 'string')
    && (candidate.files === undefined || (Array.isArray(candidate.files) && candidate.files.every((file) => typeof file === 'string')))
    && (candidate.commands === undefined || (Array.isArray(candidate.commands) && candidate.commands.every(isLocalCommandResult)))
    && (candidate.attachments === undefined || (Array.isArray(candidate.attachments) && candidate.attachments.every((attachment) => (
      typeof attachment === 'object'
      && attachment !== null
      && typeof attachment.id === 'string'
      && typeof attachment.name === 'string'
      && typeof attachment.mimeType === 'string'
      && typeof attachment.size === 'number'
      && (attachment.kind === 'image' || attachment.kind === 'text' || attachment.kind === 'file')
    ))))
  )
}

export function parseLocalConversation(value: string | null): LocalConversationMessage[] {
  if (value === null) return []

  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(isLocalConversationMessage) : []
  } catch {
    return []
  }
}

export function getConversationTitle(messages: LocalConversationMessage[]): string | null {
  const firstPrompt = messages.find((message) => message.role === 'user')?.content.trim()
  if (firstPrompt === undefined || firstPrompt.length === 0) return null

  const firstLine = firstPrompt.split(/\r?\n/, 1)[0] ?? ''
  return firstLine.length > 38 ? `${firstLine.slice(0, 38).trimEnd()}...` : firstLine
}
import type { ChatAttachment } from '../../shared/desktop-api'

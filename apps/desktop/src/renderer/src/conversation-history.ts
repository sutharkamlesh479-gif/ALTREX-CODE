import { parseLocalConversation, type LocalConversationMessage } from './local-conversation'

export const HISTORY_KEY = 'altrex.conversations.v1'
export type SavedConversation = { id: string; projectPath: string | null; messages: LocalConversationMessage[]; updatedAt: string }
export function recoverMessages(messages: LocalConversationMessage[]): LocalConversationMessage[] {
  return messages.map(message => message.status === 'streaming' ? { ...message, status: 'cancelled', content: message.content || 'Response interrupted when ALTREX closed.' } : message)
}
export function readHistory(): SavedConversation[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    if (!Array.isArray(data)) return []
    return data.flatMap((entry: Partial<SavedConversation> | null) => {
      if (!entry || typeof entry.id !== 'string' || typeof entry.updatedAt !== 'string' || !(entry.projectPath === null || typeof entry.projectPath === 'string')) return []
      const messages = parseLocalConversation(JSON.stringify(entry.messages))
      return messages.length ? [{ id: entry.id, projectPath: entry.projectPath, messages, updatedAt: entry.updatedAt }] : []
    })
  } catch { return [] }
}
export function serializeHistory(history: SavedConversation[]): string {
  return JSON.stringify(history, (key, value: unknown) => key === 'previewDataUrl' ? undefined : value)
}

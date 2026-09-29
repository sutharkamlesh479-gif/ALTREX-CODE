import { app, dialog, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { ChatAttachment } from '../shared/desktop-api'

const MAX_ATTACHMENTS = 8
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TEXT_BYTES = 750 * 1024
const imageMimeTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
const textExtensions = new Set([
  '.txt', '.md', '.mdx', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.csv', '.tsv',
  '.html', '.css', '.scss', '.less', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rb',
  '.php', '.java', '.kt', '.kts', '.swift', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.sh',
  '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.vue', '.svelte', '.env', '.ini', '.log', '.svg',
])

type RegisteredAttachment = ChatAttachment & { sourcePath: string }

export type ResolvedAttachment = {
  id: string
  name: string
  mimeType: string
  size: number
  kind: ChatAttachment['kind']
  textContent?: string
  imageDataUrl?: string
  projectRelativePath?: string
  absolutePath?: string
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'attachment'
}

function describeFile(filePath: string): Omit<RegisteredAttachment, 'id' | 'sourcePath'> {
  const extension = extname(filePath).toLowerCase()
  const imageMime = imageMimeTypes[extension]
  const size = statSync(filePath).size
  if (size > MAX_FILE_BYTES) throw new Error(`${basename(filePath)} is larger than the 20 MB attachment limit.`)
  const kind: ChatAttachment['kind'] = imageMime !== undefined ? 'image' : textExtensions.has(extension) ? 'text' : 'file'
  const mimeType = imageMime ?? (kind === 'text' ? 'text/plain' : 'application/octet-stream')
  const previewDataUrl = kind === 'image'
    ? `data:${mimeType};base64,${readFileSync(filePath).toString('base64')}`
    : undefined
  return { name: basename(filePath), mimeType, size, kind, ...(previewDataUrl === undefined ? {} : { previewDataUrl }) }
}

export class AttachmentService {
  private readonly registered = new Map<string, RegisteredAttachment>()

  constructor(private readonly root?: string) {}

  private storageRoot(): string {
    return this.root ?? join(app.getPath('userData'), 'core', 'attachments')
  }

  async pick(window: BrowserWindow): Promise<ChatAttachment[]> {
    const result = await dialog.showOpenDialog(window, {
      title: 'Attach files to ALTREX',
      buttonLabel: 'Attach',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images and project files', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'txt', 'md', 'json', 'csv', 'pdf', 'docx', 'xlsx', 'zip', 'js', 'ts', 'tsx', 'jsx', 'py', 'html', 'css'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled) return []
    const selected: ChatAttachment[] = []
    for (const filePath of result.filePaths.slice(0, MAX_ATTACHMENTS)) {
      const id = randomUUID()
      const summary = describeFile(filePath)
      const registered = { id, sourcePath: filePath, ...summary }
      this.registered.set(id, registered)
      selected.push(summary.previewDataUrl === undefined ? { id, ...summary } : { id, ...summary, previewDataUrl: summary.previewDataUrl })
    }
    while (this.registered.size > 64) this.registered.delete(this.registered.keys().next().value as string)
    return selected
  }

  /** Attachments previously picked in this session, by id (for `task.start`). */
  lookup(ids: readonly string[]): ChatAttachment[] {
    return ids.map(id => {
      const attachment = this.registered.get(id)
      if (attachment === undefined) throw new Error('An attachment is no longer available. Attach it again.')
      return { id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, kind: attachment.kind }
    })
  }

  resolve(requested: ChatAttachment[], projectPath: string | null): ResolvedAttachment[] {
    if (requested.length > MAX_ATTACHMENTS) throw new Error(`Attach no more than ${MAX_ATTACHMENTS} files at once.`)
    return requested.map((request) => {
      const attachment = this.registered.get(request.id)
      if (attachment === undefined) throw new Error(`${request.name} is no longer available. Attach it again.`)
      const resolved: ResolvedAttachment = {
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        kind: attachment.kind,
      }
      if (attachment.kind === 'image') {
        if (attachment.previewDataUrl !== undefined) resolved.imageDataUrl = attachment.previewDataUrl
        resolved.absolutePath = attachment.sourcePath
      } else if (attachment.kind === 'text' && attachment.size <= MAX_TEXT_BYTES) {
        resolved.textContent = readFileSync(attachment.sourcePath, 'utf8')
      }
      // V4 Phase 6: attachments are kept in ALTREX's own data directory, never written into the user's
      // repository. Text content is passed to the model directly; the stable copy's absolute path lets
      // external engines (Codex) and future tools read binary files.
      if (projectPath !== null) {
        const directory = this.storageRoot()
        const absolutePath = join(directory, `${attachment.id.slice(0, 8)}-${safeFileName(attachment.name)}`)
        mkdirSync(directory, { recursive: true })
        copyFileSync(attachment.sourcePath, absolutePath)
        resolved.absolutePath = absolutePath
      }
      return resolved
    })
  }
}

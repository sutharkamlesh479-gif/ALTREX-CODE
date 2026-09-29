import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RepoIndex } from './file-index'

export type SearchQuery = {
  pattern: string
  /** Treat `pattern` as a regular expression (default: literal text). */
  regex?: boolean | undefined
  caseSensitive?: boolean | undefined
  /** Match whole words only. */
  word?: boolean | undefined
  /** Simple glob on the project-relative path, e.g. `src/**`, `*.ts`. */
  glob?: string | undefined
  maxResults?: number | undefined
  /** Skip generated files and lockfiles (default true). */
  skipGenerated?: boolean | undefined
}
export type SearchMatch = { path: string; line: number; text: string }
export type SearchResult = { matches: SearchMatch[]; truncated: boolean; engine: 'ripgrep' | 'builtin' }

const MAX_FILE_BYTES = 1_000_000

/** Convert a simple glob (`*`, `**`, `?`) to a RegExp over POSIX paths. */
export function globToRegExp(glob: string): RegExp {
  let pattern = ''
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index]!
    if (character === '*') {
      if (glob[index + 1] === '*') { pattern += '.*'; index++; if (glob[index + 1] === '/') index++ }
      else pattern += '[^/]*'
    } else if (character === '?') pattern += '[^/]'
    else pattern += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(glob.includes('/') ? `^${pattern}$` : `(^|/)${pattern}$`, 'i')
}

function matcher(query: SearchQuery): RegExp {
  const source = query.regex ? query.pattern : query.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(query.word ? `\\b(?:${source})\\b` : source, query.caseSensitive ? '' : 'i')
}

let ripgrep: string | null | undefined
function ripgrepPath(): string | null {
  if (ripgrep !== undefined) return ripgrep
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['rg'], { encoding: 'utf8', windowsHide: true })
  ripgrep = probe.status === 0 ? probe.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? null : null
  return ripgrep
}

function builtin(index: RepoIndex, query: SearchQuery, limit: number): SearchResult {
  const expression = matcher(query), glob = query.glob ? globToRegExp(query.glob) : null
  const matches: SearchMatch[] = []
  for (const file of index.files) {
    if (file.size > MAX_FILE_BYTES || (query.skipGenerated !== false && file.isGenerated) || (glob && !glob.test(file.path))) continue
    let text: string
    try { text = readFileSync(join(index.root, file.path), 'utf8') } catch { continue }
    if (text.includes('\0')) continue
    const lines = text.split(/\r?\n/)
    for (let line = 0; line < lines.length; line++) {
      if (!expression.test(lines[line]!)) continue
      matches.push({ path: file.path, line: line + 1, text: lines[line]!.slice(0, 300) })
      if (matches.length > limit) return { matches: matches.slice(0, limit), truncated: true, engine: 'builtin' }
    }
  }
  return { matches, truncated: false, engine: 'builtin' }
}

function withRipgrep(executable: string, index: RepoIndex, query: SearchQuery, limit: number): SearchResult | null {
  const args = ['--json', '--line-number', '--no-messages', '--max-filesize', '1M', query.caseSensitive ? '--case-sensitive' : '--ignore-case']
  if (!query.regex) args.push('--fixed-strings')
  if (query.word) args.push('--word-regexp')
  if (query.glob) args.push('--glob', query.glob)
  for (const directory of ['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', 'target', '.venv', '__pycache__']) args.push('--glob', `!${directory}/**`)
  args.push('--glob', '!.env*', '--glob', '!*secret*', '--glob', '!*credential*', '--glob', '!*.pem', '--glob', '!*.key')
  args.push('-e', query.pattern, '--', '.')
  const result = spawnSync(executable, args, { cwd: index.root, encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 })
  if (result.error || (result.status !== 0 && result.status !== 1)) return null
  const indexed = new Map(index.files.map(file => [file.path, file]))
  const matches: SearchMatch[] = []
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('{"type":"match"')) continue
    try {
      const data = (JSON.parse(line) as { data: { path: { text: string }; line_number: number; lines: { text?: string } } }).data
      const path = data.path.text.replace(/^\.[\\/]/, '').replaceAll('\\', '/')
      const file = indexed.get(path)
      if (!file || (query.skipGenerated !== false && file.isGenerated)) continue // only indexed (non-protected, non-ignored) files
      matches.push({ path, line: data.line_number, text: (data.lines.text ?? '').replace(/\r?\n$/, '').slice(0, 300) })
      if (matches.length > limit) break
    } catch { /* skip malformed JSON line */ }
  }
  matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line))
  return { matches: matches.slice(0, limit), truncated: matches.length > limit, engine: 'ripgrep' }
}

/** Search indexed files. Uses ripgrep when installed; the built-in engine gives identical results otherwise. */
export function searchRepository(index: RepoIndex, query: SearchQuery, options: { engine?: 'auto' | 'builtin' } = {}): SearchResult {
  if (!query.pattern) return { matches: [], truncated: false, engine: 'builtin' }
  if (query.regex) matcher(query) // validate early: invalid regex throws a clear SyntaxError
  const limit = Math.max(1, Math.min(query.maxResults ?? 200, 5000))
  const executable = options.engine === 'builtin' ? null : ripgrepPath()
  return (executable && withRipgrep(executable, index, query, limit)) || builtin(index, query, limit)
}

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { safePath } from '../security/path-guard'
import { IGNORED_DIRECTORIES } from '../workspace/ignore'

export type Language = 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java' | 'kotlin' | 'csharp' | 'c' | 'cpp' | 'ruby' | 'php' | 'swift' | 'css' | 'html' | 'json' | 'yaml' | 'toml' | 'markdown' | 'shell' | 'sql' | 'other'

export type IndexedFile = {
  /** Project-relative POSIX path. */
  path: string
  size: number
  mtimeMs: number
  language: Language
  isTest: boolean
  /** Build output, minified bundles, lockfiles and similar: searchable but never preferred as context. */
  isGenerated: boolean
}

export type RepoIndex = {
  root: string
  files: IndexedFile[]
  /** Enumeration used: `git` (respects .gitignore) or `walk`. */
  source: 'git' | 'walk'
  /** True when the file limit was reached. */
  truncated: boolean
  builtAt: number
}

const LANGUAGES: Record<string, Language> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.cs': 'csharp',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
  '.css': 'css', '.scss': 'css', '.less': 'css', '.html': 'html', '.vue': 'javascript', '.svelte': 'javascript',
  '.json': 'json', '.jsonc': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.md': 'markdown', '.mdx': 'markdown',
  '.sh': 'shell', '.ps1': 'shell', '.bash': 'shell', '.sql': 'sql',
}

export function languageOf(path: string): Language {
  return LANGUAGES[extname(path).toLowerCase()] ?? 'other'
}

const TEST_PATH = /(^|\/)(__tests__|tests?|spec|specs)\/|[._-](test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$|Tests?\.(java|kt|cs)$/i
const GENERATED_PATH = /(^|\/)(vendor|generated|__generated__|\.cache)\/|\.min\.(js|css)$|\.map$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock)$/i

export function isTestPath(path: string): boolean { return TEST_PATH.test(path) }

function describe(root: string, path: string): IndexedFile | null {
  try { safePath(path) } catch { return null } // never index protected files (.env, secrets, keys, .git …)
  if (path.split('/').some(segment => IGNORED_DIRECTORIES.has(segment))) return null
  try {
    const stats = lstatSync(join(root, path))
    if (!stats.isFile()) return null
    return { path, size: stats.size, mtimeMs: stats.mtimeMs, language: languageOf(path), isTest: isTestPath(path), isGenerated: GENERATED_PATH.test(path) }
  } catch { return null }
}

function gitFiles(root: string): string[] | null {
  if (!existsSync(join(root, '.git'))) return null
  const result = spawnSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  if (result.status !== 0 || typeof result.stdout !== 'string') return null
  return result.stdout.split('\0').filter(Boolean).map(path => path.replaceAll('\\', '/'))
}

function walkFiles(root: string, limit: number): string[] {
  const out: string[] = []
  const visit = (directory: string) => {
    if (out.length >= limit) return
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink()) continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) out.push(relative(root, absolute).replaceAll('\\', '/'))
    }
  }
  visit(root)
  return out
}

/** Enumerate a project's files: git-aware when possible, bounded, never including protected files. */
export function indexRepository(projectPath: string, options: { maxFiles?: number } = {}): RepoIndex {
  const root = realpathSync(projectPath), limit = options.maxFiles ?? 50_000
  const fromGit = gitFiles(root)
  const paths = fromGit ?? walkFiles(root, limit + 1)
  const files: IndexedFile[] = []
  for (const path of paths) {
    if (files.length >= limit) break
    const file = describe(root, path)
    if (file) files.push(file)
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { root, files, source: fromGit ? 'git' : 'walk', truncated: paths.length > limit, builtAt: Date.now() }
}

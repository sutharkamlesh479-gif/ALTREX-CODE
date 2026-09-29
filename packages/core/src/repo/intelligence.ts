import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { safePath } from '../security/path-guard'
import { indexRepository, type IndexedFile, type RepoIndex } from './file-index'
import { detectProjectProfile, type ProjectProfile } from './project-profile'
import { searchRepository, type SearchQuery, type SearchResult } from './search'
import { conventionalTests, extractImports, extractSymbols, resolveImport, type CodeSymbol } from './structure'

const MAX_SOURCE_BYTES = 1_000_000
const GRAPH_LANGUAGES = new Set(['typescript', 'javascript', 'python'])

export type SymbolLocation = CodeSymbol & { path: string }

/**
 * Repository understanding for one project: file index, search, symbols, definitions, references,
 * import graph, related tests and project profile. Results are cached until the index is refreshed
 * (explicitly or after `ttlMs`), so repeated agent queries are cheap.
 */
export class RepositoryIntelligence {
  private cached: RepoIndex | null = null
  private readonly symbolCache = new Map<string, { mtimeMs: number; symbols: CodeSymbol[] }>()
  private graph: { imports: Map<string, string[]>; importers: Map<string, string[]> } | null = null
  private profileCache: ProjectProfile | null = null

  constructor(readonly projectPath: string, private readonly options: { ttlMs?: number; maxFiles?: number } = {}) {}

  index(): RepoIndex {
    if (!this.cached || Date.now() - this.cached.builtAt > (this.options.ttlMs ?? 30_000)) this.refresh()
    return this.cached!
  }

  refresh(): void {
    this.cached = indexRepository(this.projectPath, this.options.maxFiles ? { maxFiles: this.options.maxFiles } : {})
    this.graph = null
    this.profileCache = null
  }

  file(path: string): IndexedFile | undefined {
    return this.index().files.find(file => file.path === path)
  }

  /** Read an indexed text file (protected paths are never readable). */
  read(path: string): string | null {
    try { safePath(path) } catch { return null }
    const file = this.file(path)
    if (!file || file.size > MAX_SOURCE_BYTES) return null
    try { const text = readFileSync(join(this.index().root, path), 'utf8'); return text.includes('\0') ? null : text } catch { return null }
  }

  search(query: SearchQuery): SearchResult {
    return searchRepository(this.index(), query)
  }

  symbols(path: string): CodeSymbol[] {
    const file = this.file(path)
    if (!file) return []
    const cached = this.symbolCache.get(path)
    if (cached && cached.mtimeMs === file.mtimeMs) return cached.symbols
    const text = this.read(path)
    const symbols = text === null ? [] : extractSymbols(file.language, text)
    this.symbolCache.set(path, { mtimeMs: file.mtimeMs, symbols })
    return symbols
  }

  /** Where a symbol is defined: word search narrows files, then the outline confirms a definition. */
  findDefinitions(name: string, limit = 20): SymbolLocation[] {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return []
    const files = [...new Set(this.search({ pattern: name, word: true, caseSensitive: true, maxResults: 2000 }).matches.map(match => match.path))]
    const found: SymbolLocation[] = []
    for (const path of files) {
      for (const symbol of this.symbols(path)) if (symbol.name === name) found.push({ ...symbol, path })
      if (found.length >= limit) break
    }
    return found.sort((a, b) => Number(b.exported) - Number(a.exported) || a.path.localeCompare(b.path)).slice(0, limit)
  }

  /** Usages of a symbol name (word matches), excluding its definition lines. */
  findReferences(name: string, limit = 200): SearchResult {
    const definitions = new Set(this.findDefinitions(name, 50).map(symbol => `${symbol.path}:${symbol.line}`))
    const result = this.search({ pattern: name, word: true, caseSensitive: true, maxResults: limit + definitions.size })
    return { ...result, matches: result.matches.filter(match => !definitions.has(`${match.path}:${match.line}`)).slice(0, limit) }
  }

  private importGraph() {
    if (this.graph) return this.graph
    const index = this.index(), known = new Set(index.files.map(file => file.path))
    const imports = new Map<string, string[]>(), importers = new Map<string, string[]>()
    for (const file of index.files) {
      if (!GRAPH_LANGUAGES.has(file.language) || file.isGenerated || file.size > MAX_SOURCE_BYTES) continue
      const text = this.read(file.path)
      if (text === null) continue
      const resolved = [...new Set(extractImports(file.language, text).map(specifier => resolveImport(file.path, specifier, file.language, known)).filter((path): path is string => path !== null))]
      imports.set(file.path, resolved)
      for (const target of resolved) importers.set(target, [...(importers.get(target) ?? []), file.path])
    }
    this.graph = { imports, importers }
    return this.graph
  }

  /** Project files imported by `path` (external packages are omitted). */
  imports(path: string): string[] { return this.importGraph().imports.get(path) ?? [] }
  /** Project files that import `path`. */
  importers(path: string): string[] { return this.importGraph().importers.get(path) ?? [] }

  /** Tests that exercise `path`: naming conventions plus test files importing it. */
  relatedTests(path: string): string[] {
    const index = this.index(), file = this.file(path)
    if (!file) return []
    const byImport = this.importers(path).filter(importer => index.files.find(candidate => candidate.path === importer)?.isTest)
    return [...new Set([...conventionalTests(file, index.files), ...byImport])].sort()
  }

  profile(): ProjectProfile {
    this.profileCache ??= detectProjectProfile(this.index())
    return this.profileCache
  }
}

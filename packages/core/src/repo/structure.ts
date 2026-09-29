import { posix } from 'node:path'
import type { IndexedFile, Language } from './file-index'

// Lightweight structural analysis (symbols, imports, related tests) using per-language patterns.
// Deliberately dependency-free: no bundled parsers. Good enough to locate definitions, callers and tests;
// not a type checker.

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'method' | 'struct' | 'trait' | 'module'
export type CodeSymbol = { name: string; kind: SymbolKind; line: number; exported: boolean }

type Rule = { pattern: RegExp; kind: SymbolKind; exported?: (match: RegExpExecArray) => boolean }
const exportedJs = (match: RegExpExecArray) => /\bexport\b/.test(match[0])
const RULES: Partial<Record<Language, Rule[]>> = {
  typescript: [
    { pattern: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function', exported: exportedJs },
    { pattern: /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', exported: exportedJs },
    { pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface', exported: exportedJs },
    { pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, kind: 'type', exported: exportedJs },
    { pattern: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum', exported: exportedJs },
    { pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: 'function', exported: exportedJs },
    { pattern: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'const', exported: () => true },
    { pattern: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*$/, kind: 'method', exported: () => false },
  ],
  python: [
    { pattern: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function', exported: match => !match[1]!.startsWith('_') },
    { pattern: /^class\s+([A-Za-z_]\w*)/, kind: 'class', exported: match => !match[1]!.startsWith('_') },
    { pattern: /^\s+(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'method', exported: () => false },
  ],
  go: [
    { pattern: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function', exported: match => /^[A-Z]/.test(match[1]!) },
    { pattern: /^type\s+([A-Za-z_]\w*)\s+struct/, kind: 'struct', exported: match => /^[A-Z]/.test(match[1]!) },
    { pattern: /^type\s+([A-Za-z_]\w*)\s+interface/, kind: 'interface', exported: match => /^[A-Z]/.test(match[1]!) },
  ],
  rust: [
    { pattern: /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function' },
    { pattern: /^\s*(pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct' },
    { pattern: /^\s*(pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum' },
    { pattern: /^\s*(pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'trait' },
  ],
  java: [
    { pattern: /^\s*(?:public\s+|protected\s+|private\s+)?(?:abstract\s+|final\s+|static\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, kind: 'class', exported: match => /\bpublic\b/.test(match[0]) },
    { pattern: /^\s*(?:public|protected|private)\s+(?:static\s+|final\s+|abstract\s+|synchronized\s+)*[\w<>[\],\s]+\s+([a-z_]\w*)\s*\(/, kind: 'method', exported: match => /\bpublic\b/.test(match[0]) },
  ],
  csharp: [
    { pattern: /^\s*(?:public\s+|internal\s+|protected\s+|private\s+)?(?:static\s+|abstract\s+|sealed\s+|partial\s+)*(?:class|interface|enum|struct|record)\s+([A-Za-z_]\w*)/, kind: 'class', exported: match => /\bpublic\b/.test(match[0]) },
    { pattern: /^\s*(?:public|protected|internal|private)\s+(?:static\s+|async\s+|virtual\s+|override\s+)*[\w<>[\],?\s]+\s+([A-Z]\w*)\s*\(/, kind: 'method', exported: match => /\bpublic\b/.test(match[0]) },
  ],
  kotlin: [
    { pattern: /^\s*(?:private\s+|internal\s+)?(?:suspend\s+)?fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/, kind: 'function', exported: match => !/\b(private|internal)\b/.test(match[0]) },
    { pattern: /^\s*(?:private\s+|internal\s+)?(?:data\s+|sealed\s+|abstract\s+|open\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/, kind: 'class', exported: match => !/\b(private|internal)\b/.test(match[0]) },
  ],
}
RULES.javascript = RULES.typescript!.filter(rule => rule.kind !== 'interface' && rule.kind !== 'type' && rule.kind !== 'enum')
const RESERVED = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'else', 'do', 'try', 'with'])

/** Outline of top-level and member definitions in a source file. */
export function extractSymbols(language: Language, text: string): CodeSymbol[] {
  const rules = RULES[language]
  if (!rules) return []
  const symbols: CodeSymbol[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (line.length > 400) return
    for (const rule of rules) {
      const match = rule.pattern.exec(line)
      if (!match) continue
      const name = language === 'rust' ? match[2] : match[1]
      if (!name || RESERVED.has(name)) continue
      const exported = language === 'rust' ? Boolean(match[1]) : rule.exported?.(match) ?? false
      symbols.push({ name, kind: rule.kind, line: index + 1, exported })
      break
    }
  })
  return symbols
}

/** Raw module specifiers imported by a file. */
export function extractImports(language: Language, text: string): string[] {
  const found = new Set<string>()
  const add = (value: string | undefined) => { if (value) found.add(value) }
  if (language === 'typescript' || language === 'javascript') {
    for (const match of text.matchAll(/(?:\bimport\s+(?:type\s+)?(?:[^'";]*?\bfrom\s*)?|\bexport\s+[^'";]*?\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"\n]+)['"]/g)) add(match[1])
  } else if (language === 'python') {
    for (const match of text.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\s+/gm)) add(match[1])
    for (const match of text.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) for (const name of match[1]!.split(',')) add(name.trim())
  } else if (language === 'go') {
    for (const match of text.matchAll(/^\s*(?:import\s+)?(?:[\w.]+\s+)?"([^"]+)"\s*$/gm)) add(match[1])
  } else if (language === 'rust') {
    for (const match of text.matchAll(/^\s*(?:pub\s+)?(?:use|mod)\s+([\w:]+)/gm)) add(match[1])
  } else if (language === 'java' || language === 'kotlin' || language === 'csharp') {
    for (const match of text.matchAll(/^\s*(?:import|using)\s+(?:static\s+)?([\w.]+)/gm)) add(match[1])
  }
  return [...found]
}

const JS_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']

/** Resolve an import specifier to an indexed project file (relative imports only; packages are external). */
export function resolveImport(fromPath: string, specifier: string, language: Language, known: ReadonlySet<string>): string | null {
  if (language === 'typescript' || language === 'javascript') {
    if (!specifier.startsWith('.')) return null
    const raw = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
    if (known.has(raw)) return raw
    // TS projects import './x.js' for './x.ts'; strip a JS extension before trying source extensions.
    const base = raw.replace(/\.(js|jsx|mjs|cjs)$/, '')
    for (const extension of JS_EXTENSIONS) if (known.has(`${base}${extension}`)) return `${base}${extension}`
    return null
  }
  if (language === 'python') {
    const dots = /^\.+/.exec(specifier)?.[0].length ?? 0
    const module = specifier.slice(dots).replaceAll('.', '/')
    const base = dots ? posix.join(posix.dirname(fromPath), ...Array(Math.max(0, dots - 1)).fill('..'), module) : module
    for (const candidate of [`${base}.py`, `${base}/__init__.py`]) if (known.has(posix.normalize(candidate))) return posix.normalize(candidate)
    return null
  }
  return null
}

/** Files that conventionally test `file` (name conventions; see also import graph in RepositoryIntelligence). */
export function conventionalTests(file: IndexedFile, files: readonly IndexedFile[]): string[] {
  const stem = posix.basename(file.path).replace(/\.[^.]+$/, '').replace(/[._-](test|spec)$/i, '')
  if (!stem) return []
  const pattern = new RegExp(`(^|/)(test_${stem}\\.py|${stem}_test\\.(go|py)|${stem}[._-](test|spec)\\.[a-z0-9]+|${stem}Tests?\\.(java|kt|cs))$`, 'i')
  const sameDirTests = new RegExp(`(^|/)__tests__/${stem}\\.[a-z0-9]+$`, 'i')
  return files.filter(candidate => candidate.isTest && candidate.path !== file.path && (pattern.test(candidate.path) || sameDirTests.test(candidate.path))).map(candidate => candidate.path)
}

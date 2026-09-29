import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { indexRepository } from './file-index'
import { RepositoryIntelligence } from './intelligence'
import { searchRepository } from './search'
import { extractImports, extractSymbols } from './structure'
import { renderRetrievedContext, retrieveContext } from '../context/retrieval'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop', packageManager: 'pnpm@10.0.0', scripts: { test: 'vitest run', build: 'vite build', typecheck: 'tsc --noEmit', dev: 'vite', lint: 'eslint . --watch' }, devDependencies: { vitest: '3', vite: '7', typescript: '5' }, dependencies: { react: '19' } }),
  'ALTREX.md': 'Always use named exports.',
  'src/auth/login.ts': "import { hashPassword } from '../util/crypto'\nimport type { User } from './user.js'\n\nexport async function login(user: User, password: string): Promise<boolean> {\n  return user.passwordHash === hashPassword(password)\n}\n\nexport class SessionStore {\n  private sessions = new Map<string, string>()\n  create(id: string) {\n    this.sessions.set(id, 'x')\n  }\n}\n",
  'src/auth/user.ts': 'export interface User { name: string; passwordHash: string }\nexport type UserId = string\n',
  'src/util/crypto.ts': "export const hashPassword = (value: string) => `h:${value}`\n",
  'src/app.tsx': "import { login } from './auth/login'\nexport function App() { return login }\n",
  'src/auth/login.test.ts': "import { login } from './login'\nimport { expect, it } from 'vitest'\nit('logs in', () => expect(login).toBeDefined())\n",
  'src/big.ts': Array.from({ length: 400 }, (_, index) => index === 300 ? 'export function deepTarget() { return 42 }' : `export const filler${index} = ${index}`).join('\n'),
  'dist/bundle.min.js': 'function login(){}',
  '.env': 'SECRET_TOKEN=abc',
  'config/credentials.json': '{"key":"secret"}',
  'node_modules/lib/index.js': 'export function login() {}',
  'py/service.py': 'from .models import Account\n\nclass BillingService:\n    def charge(self, account):\n        return True\n\ndef _private():\n    pass\n',
  'py/models.py': 'class Account:\n    pass\n',
  'py/test_service.py': 'from py.service import BillingService\n',
}

function fixture(files = FILES, git = false) {
  const root = mkdtempSync(join(tmpdir(), 'altrex-repo-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }
  if (git) {
    writeFileSync(join(root, '.gitignore'), 'ignored-by-git/\n')
    mkdirSync(join(root, 'ignored-by-git')); writeFileSync(join(root, 'ignored-by-git', 'x.ts'), 'export const hidden = 1')
    spawnSync('git', ['init', '-q'], { cwd: root })
  }
  return root
}

describe('file index', () => {
  it('never indexes protected or ignored files, and flags tests and generated output', () => {
    const index = indexRepository(fixture())
    const paths = index.files.map(file => file.path)
    expect(paths).toContain('src/auth/login.ts')
    expect(paths).not.toContain('.env')
    expect(paths).not.toContain('config/credentials.json')
    expect(paths.some(path => path.startsWith('node_modules/'))).toBe(false)
    expect(index.files.find(file => file.path === 'src/auth/login.test.ts')).toMatchObject({ isTest: true, language: 'typescript' })
    expect(index.files.find(file => file.path === 'py/test_service.py')?.isTest).toBe(true)
    expect(index.source).toBe('walk')
  })

  it('respects .gitignore when the project is a Git repository', () => {
    const index = indexRepository(fixture(FILES, true))
    expect(index.source).toBe('git')
    expect(index.files.map(file => file.path)).not.toContain('ignored-by-git/x.ts')
    expect(index.files.map(file => file.path)).not.toContain('.env')
  })
})

describe('search', () => {
  it('finds literal, regex and whole-word matches, skipping generated files by default', () => {
    const index = indexRepository(fixture())
    const hits = searchRepository(index, { pattern: 'login', word: true, caseSensitive: true }, { engine: 'builtin' })
    expect(hits.matches.map(match => match.path)).toEqual(expect.arrayContaining(['src/app.tsx', 'src/auth/login.ts', 'src/auth/login.test.ts']))
    expect(hits.matches.some(match => match.path.startsWith('dist/'))).toBe(false)
    expect(searchRepository(index, { pattern: 'def \\w+\\(', regex: true, glob: 'py/**' }, { engine: 'builtin' }).matches.map(match => match.path)).toEqual(['py/service.py', 'py/service.py'])
    expect(() => searchRepository(index, { pattern: '(', regex: true })).toThrow()
  })

  it('returns the same matches through ripgrep when it is installed', () => {
    const index = indexRepository(fixture())
    const auto = searchRepository(index, { pattern: 'hashPassword', caseSensitive: true })
    const builtin = searchRepository(index, { pattern: 'hashPassword', caseSensitive: true }, { engine: 'builtin' })
    expect(auto.matches).toEqual(builtin.matches)
    expect(['ripgrep', 'builtin']).toContain(auto.engine)
  })
})

describe('structure', () => {
  it('outlines TypeScript and Python definitions with export status', () => {
    expect(extractSymbols('typescript', FILES['src/auth/login.ts']!)).toEqual([
      { name: 'login', kind: 'function', line: 4, exported: true },
      { name: 'SessionStore', kind: 'class', line: 8, exported: true },
      { name: 'create', kind: 'method', line: 10, exported: false },
    ])
    expect(extractSymbols('python', FILES['py/service.py']!).map(symbol => [symbol.name, symbol.kind, symbol.exported])).toEqual([['BillingService', 'class', true], ['charge', 'method', false], ['_private', 'function', false]])
    expect(extractSymbols('go', 'func (s *Server) Handle() {}\ntype config struct{}').map(symbol => [symbol.name, symbol.exported])).toEqual([['Handle', true], ['config', false]])
  })

  it('extracts import specifiers across languages', () => {
    expect(extractImports('typescript', FILES['src/auth/login.ts']!)).toEqual(['../util/crypto', './user.js'])
    expect(extractImports('python', 'from .models import Account\nimport os, json')).toEqual(['.models', 'os', 'json'])
  })
})

describe('RepositoryIntelligence', () => {
  it('finds definitions, references, imports, importers and related tests', () => {
    const intel = new RepositoryIntelligence(fixture())
    expect(intel.findDefinitions('login')).toEqual([expect.objectContaining({ path: 'src/auth/login.ts', line: 4, kind: 'function', exported: true })])
    expect(intel.findReferences('login').matches.map(match => match.path)).toEqual(expect.arrayContaining(['src/app.tsx', 'src/auth/login.test.ts']))
    expect(intel.findReferences('login').matches.some(match => match.path === 'src/auth/login.ts' && match.line === 4)).toBe(false)
    expect(intel.imports('src/auth/login.ts')).toEqual(['src/util/crypto.ts', 'src/auth/user.ts'])
    expect(intel.importers('src/auth/login.ts').sort()).toEqual(['src/app.tsx', 'src/auth/login.test.ts'])
    expect(intel.relatedTests('src/auth/login.ts')).toEqual(['src/auth/login.test.ts'])
    expect(intel.imports('py/service.py')).toEqual(['py/models.py'])
    expect(intel.relatedTests('py/service.py')).toEqual(['py/test_service.py'])
  })

  it('detects the project profile and only the checks the project declares', () => {
    const profile = new RepositoryIntelligence(fixture()).profile()
    expect(profile).toMatchObject({ packageManager: 'pnpm', testRunner: 'vitest', monorepo: false, manifests: ['package.json'] })
    expect(profile.frameworks).toEqual(expect.arrayContaining(['React', 'Vite', 'Vitest', 'TypeScript']))
    expect(profile.commands.map(command => command.argv.join(' '))).toEqual(['pnpm run typecheck', 'pnpm run test', 'pnpm run build']) // lint is a watcher: excluded
    expect(profile.languages[0]).toMatchObject({ language: 'typescript' })
  })

  it('never reads protected files even when asked directly', () => {
    const intel = new RepositoryIntelligence(fixture())
    expect(intel.read('.env')).toBeNull()
    expect(intel.read('config/credentials.json')).toBeNull()
  })
})

describe('retrieval', () => {
  it('selects the definition, its imports and its tests for a task, with reasons', () => {
    const intel = new RepositoryIntelligence(fixture())
    const result = retrieveContext(intel, 'The `login` function rejects valid passwords', { maxChars: 20_000 })
    const byPath = new Map(result.items.map(item => [item.path, item]))
    expect(byPath.get('ALTREX.md')).toMatchObject({ kind: 'rules', reason: 'project instructions' })
    expect(byPath.get('src/auth/login.ts')?.reason).toContain('defines login')
    expect(byPath.get('src/util/crypto.ts')?.reason).toContain('imported by src/auth/login.ts')
    expect(byPath.get('src/auth/login.test.ts')).toMatchObject({ kind: 'test' })
    expect(byPath.has('py/service.py')).toBe(false)
    expect(result.items.map(item => item.content).join('\n')).not.toContain('SECRET_TOKEN')
  })

  it('uses line-numbered snippets for large files and honours explicit paths and stack traces', () => {
    const intel = new RepositoryIntelligence(fixture())
    const result = retrieveContext(intel, 'Error at src/big.ts:301 in deepTarget', { maxChars: 20_000 })
    const snippet = result.items.find(item => item.path === 'src/big.ts')!
    expect(snippet.kind).toBe('snippet')
    expect(snippet.range![0]).toBeLessThanOrEqual(301)
    expect(snippet.range![1]).toBeGreaterThanOrEqual(301)
    expect(snippet.content).toContain('301: export function deepTarget()')
    expect(snippet.content.length).toBeLessThan(FILES['src/big.ts']!.length)
  })

  it('respects the character budget and renders provenance', () => {
    const intel = new RepositoryIntelligence(fixture())
    const result = retrieveContext(intel, 'login SessionStore hashPassword BillingService', { maxChars: 1200 })
    expect(result.items.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(1200)
    const rendered = renderRetrievedContext('shop', result)
    expect(rendered).toContain('Project: shop')
    expect(rendered).toContain('Repository tree:')
    expect(rendered).toMatch(/--- \S+ \[.+\] ---/)
  })

  it('sends only rules, configuration and the tree when there is no task', () => {
    const result = retrieveContext(new RepositoryIntelligence(fixture()), '')
    expect(result.items.map(item => item.kind).every(kind => kind === 'rules' || kind === 'config')).toBe(true)
    expect(result.tree).toContain('src/auth/login.ts')
  })
})

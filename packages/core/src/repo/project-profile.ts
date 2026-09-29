import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Language, RepoIndex } from './file-index'

export type CheckKind = 'build' | 'test' | 'lint' | 'typecheck'
export type ProjectCommand = { kind: CheckKind; argv: string[]; source: string }

export type ProjectProfile = {
  languages: Array<{ language: Language; files: number }>
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | null
  frameworks: string[]
  testRunner: string | null
  /** Runnable checks discovered from the project's own configuration (never invented). */
  commands: ProjectCommand[]
  manifests: string[]
  monorepo: boolean
}

const NODE_FRAMEWORKS: Array<[string, string]> = [
  ['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['@angular/core', 'Angular'], ['express', 'Express'],
  ['fastify', 'Fastify'], ['@nestjs/core', 'NestJS'], ['electron', 'Electron'], ['vite', 'Vite'], ['tailwindcss', 'Tailwind CSS'],
  ['prisma', 'Prisma'], ['typescript', 'TypeScript'], ['vitest', 'Vitest'], ['jest', 'Jest'], ['mocha', 'Mocha'], ['@playwright/test', 'Playwright'],
]
const SCRIPT_KINDS: Array<[CheckKind, string[]]> = [['typecheck', ['typecheck', 'type-check', 'tsc', 'check-types']], ['lint', ['lint']], ['test', ['test']], ['build', ['build']]]
const LONG_RUNNING = /\b(watch|dev|serve|start|--watch)\b/

function readJson(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> } catch { return null }
}
function readText(path: string): string {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

/** Detect the project's stack and the checks it declares, from manifests at the project root. */
export function detectProjectProfile(index: RepoIndex): ProjectProfile {
  const root = index.root, has = (path: string) => existsSync(join(root, path))
  const counts = new Map<Language, number>()
  for (const file of index.files) if (!file.isGenerated && file.language !== 'other') counts.set(file.language, (counts.get(file.language) ?? 0) + 1)
  const languages = [...counts].map(([language, files]) => ({ language, files })).sort((a, b) => b.files - a.files || a.language.localeCompare(b.language)).slice(0, 8)
  const frameworks = new Set<string>(), commands: ProjectCommand[] = [], manifests: string[] = []
  let packageManager: ProjectProfile['packageManager'] = null, testRunner: string | null = null, monorepo = false

  const pkg = has('package.json') ? readJson(join(root, 'package.json')) : null
  if (pkg) {
    manifests.push('package.json')
    const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : ''
    packageManager = declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm' ? declared
      : has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm'
    const dependencies = { ...(pkg.dependencies as Record<string, string> | undefined), ...(pkg.devDependencies as Record<string, string> | undefined) }
    for (const [name, label] of NODE_FRAMEWORKS) if (dependencies[name]) frameworks.add(label)
    const scripts = (pkg.scripts ?? {}) as Record<string, string>
    for (const [kind, names] of SCRIPT_KINDS) {
      const name = names.find(candidate => typeof scripts[candidate] === 'string' && !LONG_RUNNING.test(scripts[candidate]!) && !/no test specified/i.test(scripts[candidate]!))
      if (name) commands.push({ kind, argv: [packageManager, 'run', name], source: `package.json scripts.${name}` })
    }
    const testScript = scripts.test ?? ''
    testRunner = /vitest/.test(testScript) || dependencies.vitest ? 'vitest' : /jest/.test(testScript) || dependencies.jest ? 'jest' : /mocha/.test(testScript) || dependencies.mocha ? 'mocha' : /node\s+--test/.test(testScript) ? 'node:test' : null
    monorepo = Boolean(pkg.workspaces) || has('pnpm-workspace.yaml') || has('turbo.json') || has('lerna.json')
  }
  const pyproject = has('pyproject.toml') ? readText(join(root, 'pyproject.toml')) : ''
  const requirements = has('requirements.txt') ? readText(join(root, 'requirements.txt')) : ''
  if (pyproject || requirements || has('setup.py')) {
    for (const manifest of ['pyproject.toml', 'requirements.txt', 'setup.py']) if (has(manifest)) manifests.push(manifest)
    const python = `${pyproject}\n${requirements}`.toLowerCase()
    for (const [name, label] of [['django', 'Django'], ['flask', 'Flask'], ['fastapi', 'FastAPI'], ['pydantic', 'Pydantic'], ['sqlalchemy', 'SQLAlchemy']] as const) if (python.includes(name)) frameworks.add(label)
    if (python.includes('pytest') || has('pytest.ini') || has('conftest.py') || index.files.some(file => /(^|\/)test_[^/]+\.py$/.test(file.path))) {
      testRunner ??= 'pytest'
      if (!commands.some(command => command.kind === 'test')) commands.push({ kind: 'test', argv: ['python', '-m', 'pytest'], source: 'pytest configuration' })
    }
    if (python.includes('ruff')) commands.push({ kind: 'lint', argv: ['python', '-m', 'ruff', 'check', '.'], source: 'ruff in project dependencies' })
    if (python.includes('mypy')) commands.push({ kind: 'typecheck', argv: ['python', '-m', 'mypy', '.'], source: 'mypy in project dependencies' })
  }
  if (has('go.mod')) {
    manifests.push('go.mod'); testRunner ??= 'go test'
    commands.push({ kind: 'build', argv: ['go', 'build', './...'], source: 'go.mod' }, { kind: 'test', argv: ['go', 'test', './...'], source: 'go.mod' })
  }
  if (has('Cargo.toml')) {
    manifests.push('Cargo.toml'); testRunner ??= 'cargo test'
    commands.push({ kind: 'build', argv: ['cargo', 'build'], source: 'Cargo.toml' }, { kind: 'test', argv: ['cargo', 'test'], source: 'Cargo.toml' })
  }
  if (has('pom.xml')) { manifests.push('pom.xml'); commands.push({ kind: 'test', argv: [has('mvnw') || has('mvnw.cmd') ? 'mvnw' : 'mvn', '-q', 'test'], source: 'pom.xml' }) }
  else if (has('build.gradle') || has('build.gradle.kts')) { manifests.push(has('build.gradle') ? 'build.gradle' : 'build.gradle.kts'); commands.push({ kind: 'test', argv: [has('gradlew') || has('gradlew.bat') ? 'gradlew' : 'gradle', 'test'], source: 'Gradle build' }) }
  const dotnet = index.files.find(file => /\.(sln|csproj)$/.test(file.path) && !file.path.includes('/'))
  if (dotnet) { manifests.push(dotnet.path); commands.push({ kind: 'build', argv: ['dotnet', 'build'], source: dotnet.path }, { kind: 'test', argv: ['dotnet', 'test'], source: dotnet.path }) }
  return { languages, packageManager, frameworks: [...frameworks], testRunner, commands, manifests, monorepo }
}

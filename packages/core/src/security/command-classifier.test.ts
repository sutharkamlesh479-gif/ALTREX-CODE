import { describe, expect, it } from 'vitest'
import { classifyCommand, type Risk } from './command-classifier'

// Command classifier table (SECURITY_MODEL.md §4.2). These were `todo` specification rows in Phase 1.

const scripts = { test: 'vitest run', build: 'vite build', typecheck: 'tsc --noEmit', lint: 'eslint .' }
const context = { scripts, fileExists: (path: string) => ['scripts/gen.js', 'test.py'].includes(path), hasLocalBin: (name: string) => ['vitest', 'tsc', 'eslint'].includes(name) }
const risk = (line: string): Risk => { const [command = '', ...args] = line.split(' '); return classifyCommand(command, args, context).risk }

describe('command classifier', () => {
  it.each([['git status'], ['git diff --stat'], ['git log -n 5'], ['git show HEAD'], ['git blame src/a.ts'], ['git ls-files'], ['git rev-parse HEAD']])('%s → LOW', line => expect(risk(line)).toBe('LOW'))

  it('git add|commit on the task branch → MEDIUM', () => {
    expect(risk('git add -A')).toBe('MEDIUM')
    expect(risk('git commit -m fix')).toBe('MEDIUM')
    expect(risk('git checkout -b altrex/task')).toBe('MEDIUM')
  })

  it('git checkout|switch|stash|branch -D → HIGH (ask)', () => {
    for (const line of ['git checkout main', 'git switch main', 'git stash', 'git branch -D old', 'git merge feature', 'git reset HEAD~1', 'git pull']) expect(risk(line)).toBe('HIGH')
  })

  it('git push|reset --hard|clean|rebase|filter-branch|gc --prune → FORBIDDEN', () => {
    for (const line of ['git push origin main', 'git reset --hard HEAD', 'git clean -fdx', 'git rebase -i main', 'git filter-branch', 'git gc --prune=now', 'git config --global user.name x']) expect(risk(line)).toBe('FORBIDDEN')
  })

  it('npm|pnpm|yarn|bun run|test <script declared in package.json> → MEDIUM', () => {
    for (const line of ['npm run build', 'pnpm run typecheck', 'yarn test', 'bun run lint', 'npm test', 'pnpm build']) expect(risk(line)).toBe('MEDIUM')
  })

  it('npm|pnpm|yarn|bun run <undeclared script> → HIGH', () => {
    expect(risk('npm run deploy')).toBe('HIGH')
    expect(risk('pnpm run nuke')).toBe('HIGH')
  })

  it('npm ci / pnpm install with no package arguments → MEDIUM', () => {
    for (const line of ['npm ci', 'pnpm install', 'yarn', 'bun install --frozen-lockfile']) expect(risk(line)).toBe('MEDIUM')
  })

  it('npm install|pnpm add|yarn add <package> → MEDIUM (dependency.add; visible in manifest and lockfile)', () => {
    const result = classifyCommand('npm', ['install', 'zod'], context)
    expect(result).toMatchObject({ risk: 'MEDIUM', capability: 'dependency.add' })
    expect(risk('pnpm add -D vitest')).toBe('MEDIUM')
  })

  it('npx|pnpm dlx|bunx|yarn dlx|npm exec → HIGH (downloads and executes), unless a local binary', () => {
    for (const line of ['npx create-react-app app', 'pnpm dlx degit x', 'bunx cowsay', 'yarn dlx tool', 'npm exec foo', 'npm create vite@latest']) expect(risk(line)).toBe('HIGH')
    expect(risk('npx vitest run')).toBe('MEDIUM')
    expect(risk('pnpm vitest run')).toBe('MEDIUM')
  })

  it('npm publish|login|token → FORBIDDEN', () => {
    for (const line of ['npm publish', 'npm login', 'npm token create', 'pnpm publish', 'cargo publish']) expect(risk(line)).toBe('FORBIDDEN')
  })

  it('node|python|go run|cargo run <file in workspace> → MEDIUM (agents may run the scripts they write)', () => {
    for (const line of ['node scripts/gen.js', 'python test.py', 'python -m pytest', 'go run ./cmd', 'cargo run', 'go test ./...', 'cargo test']) expect(risk(line)).toBe('MEDIUM')
    expect(risk('node ../outside.js')).toBe('HIGH')
  })

  it('node -e/--eval/-p, python -c → FORBIDDEN', () => {
    for (const line of ['node -e process.exit(1)', 'node --eval x', 'node -p 1', 'python -c print(1)', 'python3 -c x']) expect(risk(line)).toBe('FORBIDDEN')
  })

  it('cmd /c, powershell -c|-Command, bash -c, sh -c → FORBIDDEN', () => {
    for (const line of ['cmd /c dir', 'powershell -Command echo', 'pwsh -c x', 'bash -c ls', 'sh -c ls', 'powershell.exe -File x.ps1']) expect(risk(line)).toBe('FORBIDDEN')
  })

  it('sudo, runas, setx, reg add, sc, schtasks → FORBIDDEN', () => {
    for (const line of ['sudo rm x', 'runas /user:admin x', 'setx PATH x', 'reg add HKCU\\x', 'sc stop svc', 'schtasks /create']) expect(risk(line)).toBe('FORBIDDEN')
  })

  it('curl, wget, Invoke-WebRequest → HIGH (network)', () => {
    for (const line of ['curl https://x', 'wget https://x', 'Invoke-WebRequest https://x']) expect(classifyCommand(line.split(' ')[0]!, line.split(' ').slice(1))).toMatchObject({ risk: 'HIGH', capability: 'network' })
  })

  it('unknown executable → HIGH (ask), never allowed silently', () => {
    expect(classifyCommand('mystery-tool', ['--do-things'])).toMatchObject({ risk: 'HIGH', reason: 'unknown executable mystery-tool' })
    expect(risk('C:\\tools\\thing.exe')).toBe('HIGH')
  })

  it('shell deletion is HIGH; recursive deletion of broad targets is FORBIDDEN', () => {
    expect(risk('rm build/out.txt')).toBe('HIGH')
    expect(risk('rm -rf /')).toBe('FORBIDDEN')
    expect(risk('rm -rf ..')).toBe('FORBIDDEN')
  })

  it('read-only tools and build tools are LOW and MEDIUM respectively', () => {
    expect(risk('ls src')).toBe('LOW')
    expect(risk('rg TODO')).toBe('LOW')
    expect(risk('tsc --noEmit')).toBe('MEDIUM')
    expect(risk('pnpm --version')).toBe('LOW')
    expect(risk('find . -delete')).toBe('HIGH')
  })

  it('normalizes Windows executable suffixes', () => {
    expect(risk('npm.cmd test')).toBe('MEDIUM')
    expect(risk('git.exe status')).toBe('LOW')
    expect(risk('CMD.EXE /c x')).toBe('FORBIDDEN')
  })
})

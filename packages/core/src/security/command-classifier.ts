import { basename } from 'node:path'

// Argv command classifier (SECURITY_MODEL.md §4.2). Replaces the executable-name allowlist: the risk of a
// command depends on the executable AND its subcommand/flags. Pure and data-driven; the policy engine
// turns a classification into allow / ask / deny for the active permission profile.

export type Risk = 'LOW' | 'MEDIUM' | 'HIGH' | 'FORBIDDEN'
export type CommandCapability =
  | 'process.inspect' | 'process.execute' | 'dependency.install' | 'dependency.add' | 'package.execute'
  | 'git.read' | 'git.write' | 'git.destructive' | 'network' | 'filesystem.delete' | 'system'

export type CommandClassification = { risk: Risk; capability: CommandCapability; reason: string }

export type ClassifyContext = {
  /** package.json scripts, to tell declared scripts from arbitrary ones. */
  scripts?: Readonly<Record<string, string>>
  /** Whether a path exists inside the workspace (for `node file.js`). */
  fileExists?: (relativePath: string) => boolean
  /** Whether a package binary is installed locally (node_modules/.bin). */
  hasLocalBin?: (name: string) => boolean
}

const result = (risk: Risk, capability: CommandCapability, reason: string): CommandClassification => ({ risk, capability, reason })

const SHELLS = new Set(['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'wsl', 'csh', 'tcsh'])
const SYSTEM = new Set(['sudo', 'su', 'doas', 'runas', 'setx', 'reg', 'regedit', 'sc', 'schtasks', 'net', 'netsh', 'bcdedit', 'diskpart', 'format', 'shutdown', 'reboot', 'halt', 'systemctl', 'launchctl', 'crontab', 'mount', 'umount', 'icacls', 'takeown', 'chown'])
const NETWORK = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'scp', 'sftp', 'ssh', 'ftp', 'nc', 'ncat', 'telnet', 'rsync'])
const DELETE = new Set(['rm', 'del', 'rmdir', 'rd', 'erase', 'shred'])
const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'which', 'where', 'grep', 'rg', 'tree', 'stat', 'file', 'diff', 'sort', 'uniq'])
const BUILD_TOOLS = new Set(['tsc', 'vite', 'vitest', 'jest', 'mocha', 'eslint', 'prettier', 'biome', 'pytest', 'ruff', 'mypy', 'black', 'flake8', 'make', 'cmake', 'ctest', 'ninja', 'rustc', 'javac', 'gcc', 'g++', 'clang', 'clang++', 'mvn', 'mvnw', 'gradle', 'gradlew', 'playwright', 'webpack', 'rollup', 'esbuild', 'turbo', 'nx'])
const INTERPRETERS = new Set(['node', 'python', 'python3', 'py', 'deno', 'ruby', 'php', 'perl', 'java'])
const INLINE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c', '--command', '-r', '--run'])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PACKAGE_RUNNERS = new Set(['npx', 'pnpx', 'bunx'])

const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'rev-parse', 'grep', 'describe', 'shortlog', 'show-ref', 'cat-file', 'ls-tree', 'whatchanged', 'reflog', 'help', 'version', '--version'])
const GIT_WRITE = new Set(['add', 'commit', 'init', 'mv', 'restore-staged', 'notes'])
const GIT_HIGH = new Set(['checkout', 'switch', 'stash', 'merge', 'cherry-pick', 'revert', 'restore', 'tag', 'fetch', 'pull', 'clone', 'rm', 'reset', 'am', 'apply', 'worktree', 'submodule', 'bisect'])
const GIT_FORBIDDEN = new Set(['push', 'clean', 'rebase', 'filter-branch', 'filter-repo', 'gc', 'prune', 'update-ref', 'replace', 'send-email', 'daemon'])

export function normalizeExecutable(command: string): string {
  return basename(command.trim().replaceAll('\\', '/')).toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/i, '')
}

function firstPositional(args: readonly string[]): { value: string | undefined; index: number } {
  const index = args.findIndex(arg => !arg.startsWith('-'))
  return { value: index >= 0 ? args[index] : undefined, index }
}

function classifyGit(args: readonly string[]): CommandClassification {
  const { value: sub, index } = firstPositional(args)
  const rest = index >= 0 ? args.slice(index + 1) : []
  if (!sub) return result('LOW', 'git.read', 'git without a subcommand')
  if (args.some(arg => arg === '--global' || arg === '--system') && sub === 'config') return result('FORBIDDEN', 'system', 'changing global Git configuration')
  if (sub === 'config') return result(rest.some(arg => !arg.startsWith('-')) && rest.length >= 2 ? 'MEDIUM' : 'LOW', 'git.write', 'repository Git configuration')
  if (GIT_FORBIDDEN.has(sub)) return result('FORBIDDEN', 'git.destructive', `git ${sub} rewrites history, deletes work, or publishes; the user does this`)
  if (sub === 'reset' && rest.includes('--hard')) return result('FORBIDDEN', 'git.destructive', 'git reset --hard discards work')
  if (sub === 'branch') {
    if (rest.some(arg => arg === '-D' || arg === '-d' || arg === '--delete' || arg === '-M' || arg === '-m')) return result('HIGH', 'git.destructive', 'deleting or renaming a branch')
    return result(rest.some(arg => !arg.startsWith('-')) ? 'MEDIUM' : 'LOW', rest.length ? 'git.write' : 'git.read', 'listing or creating a branch')
  }
  if ((sub === 'checkout' || sub === 'switch') && rest.some(arg => arg === '-b' || arg === '-c' || arg === '--create')) return result('MEDIUM', 'git.write', 'creating a branch')
  if (sub === 'restore' && rest.includes('--staged') && !rest.includes('--worktree')) return result('MEDIUM', 'git.write', 'unstaging changes')
  if (sub === 'remote') return result(rest.filter(arg => !arg.startsWith('-')).length === 0 ? 'LOW' : 'HIGH', rest.length ? 'git.write' : 'git.read', 'Git remotes')
  if (GIT_READ.has(sub)) return result('LOW', 'git.read', `git ${sub} reads repository state`)
  if (GIT_WRITE.has(sub)) return result('MEDIUM', 'git.write', `git ${sub} records changes`)
  if (GIT_HIGH.has(sub)) return result('HIGH', sub === 'fetch' || sub === 'pull' || sub === 'clone' ? 'network' : 'git.destructive', `git ${sub} can discard or overwrite work`)
  return result('HIGH', 'git.write', `unrecognized git subcommand ${sub}`)
}

function classifyPackageManager(manager: string, args: readonly string[], context: ClassifyContext): CommandClassification {
  const { value: sub, index } = firstPositional(args)
  const rest = index >= 0 ? args.slice(index + 1) : []
  const packages = rest.filter(arg => !arg.startsWith('-'))
  const scripts = context.scripts ?? {}
  if (!sub) {
    if (args.some(arg => ['--version', '-v', '--help', '-h'].includes(arg))) return result('LOW', 'process.inspect', `${manager} version/help`)
    return result('MEDIUM', 'dependency.install', `${manager} with no arguments installs declared dependencies`)
  }
  if (['publish', 'unpublish', 'login', 'logout', 'adduser', 'token', 'owner', 'deprecate', 'access', 'dist-tag'].includes(sub)) return result('FORBIDDEN', 'network', `${manager} ${sub} publishes or changes registry credentials; the user does this`)
  if (['--version', 'version', 'help', 'list', 'ls', 'outdated', 'why', 'view', 'info', 'audit', 'doctor', 'root', 'bin', 'prefix'].includes(sub)) return result('LOW', 'process.inspect', `${manager} ${sub} only inspects`)
  if (['run', 'run-script'].includes(sub)) {
    const script = packages[0]
    return script && scripts[script] !== undefined
      ? result('MEDIUM', 'process.execute', `runs the project's declared "${script}" script`)
      : result('HIGH', 'process.execute', `script "${script ?? ''}" is not declared in package.json`)
  }
  if (['test', 't', 'tst', 'start', 'build', 'lint', 'typecheck'].includes(sub)) {
    if (sub === 'test' || sub === 't' || sub === 'tst' || scripts[sub] !== undefined) return result('MEDIUM', 'process.execute', `runs the project's ${sub} script`)
  }
  if (['install', 'i', 'ci', 'add'].includes(sub)) {
    return packages.length
      ? result('MEDIUM', 'dependency.add', `adds dependencies (${packages.slice(0, 5).join(', ')}); the change is visible in the manifest and lockfile`)
      : result('MEDIUM', 'dependency.install', 'installs the declared dependencies')
  }
  if (['uninstall', 'remove', 'rm', 'un', 'update', 'upgrade', 'up', 'dedupe', 'prune', 'rebuild'].includes(sub)) return result('MEDIUM', 'dependency.add', `${manager} ${sub} changes dependencies`)
  if (['exec', 'dlx', 'x', 'create', 'init', 'innit'].includes(sub)) return result('HIGH', 'package.execute', `${manager} ${sub} downloads and executes a package`)
  if (sub === 'config') return result(rest[0] === 'get' || rest[0] === 'list' ? 'LOW' : 'HIGH', 'system', `${manager} config`)
  if (scripts[sub] !== undefined) return result('MEDIUM', 'process.execute', `runs the project's declared "${sub}" script`)
  // pnpm/yarn/bun <bin> runs a locally installed binary; npm has no such shorthand.
  if (manager !== 'npm' && context.hasLocalBin?.(sub)) return result('MEDIUM', 'process.execute', `runs the locally installed ${sub}`)
  return result('HIGH', 'process.execute', `unrecognized ${manager} command "${sub}"`)
}

function classifyInterpreter(executable: string, args: readonly string[], context: ClassifyContext): CommandClassification {
  if (args.some(arg => INLINE_FLAGS.has(arg.toLowerCase()) && !(executable === 'java' && arg === '-r'))) return result('FORBIDDEN', 'process.execute', `${executable} inline code execution; write a file in the project and run it instead`)
  const { value: target } = firstPositional(args)
  if (!target) return result(args.some(arg => /^(-v|-V|--version|-h|--help)$/.test(arg)) ? 'LOW' : 'HIGH', 'process.execute', args.length ? `${executable} ${args[0]}` : `interactive ${executable}`)
  const moduleIndex = args.indexOf('-m')
  if (moduleIndex >= 0) {
    const module = args[moduleIndex + 1] ?? ''
    if (module === 'pip') {
      const sub = args[moduleIndex + 2]
      if (sub === 'install') return result('MEDIUM', 'dependency.add', 'pip install')
      if (sub === 'download') return result('HIGH', 'network', 'pip download')
      return result(sub === 'uninstall' ? 'MEDIUM' : 'LOW', 'dependency.add', `pip ${sub ?? ''}`)
    }
    if (module === 'http.server' || module === 'smtpd') return result('HIGH', 'network', `python -m ${module} opens a network server`)
    return result('MEDIUM', 'process.execute', `runs the ${module} module`)
  }
  if (target.includes('..') || /^([a-z]:[\\/]|[\\/])/i.test(target)) return result('HIGH', 'process.execute', `runs ${target}, which is outside the project`)
  return result('MEDIUM', 'process.execute', context.fileExists && !context.fileExists(target) ? `runs ${target} (not found in the project)` : `runs project file ${target}`)
}

/** Classify an argv command. Never throws; unknown executables are HIGH, never silently allowed. */
export function classifyCommand(command: string, args: readonly string[], context: ClassifyContext = {}): CommandClassification {
  const executable = normalizeExecutable(command)
  if (!executable) return result('FORBIDDEN', 'process.execute', 'empty command')
  if (/[/\\]/.test(command.trim()) && !/^(\.\/)?(gradlew|mvnw)(\.bat|\.cmd)?$/i.test(command.trim())) return result('HIGH', 'process.execute', 'commands are run by name, not by path')
  if (SHELLS.has(executable)) return result('FORBIDDEN', 'process.execute', `${executable} is a shell launcher; pass the program and its arguments directly`)
  if (SYSTEM.has(executable)) return result('FORBIDDEN', 'system', `${executable} changes system configuration or privileges`)
  if (NETWORK.has(executable)) return result('HIGH', 'network', `${executable} transfers data over the network`)
  if (DELETE.has(executable)) {
    const recursive = args.some(arg => /^-[a-z]*r[a-z]*$/i.test(arg) || arg === '/s' || arg === '--recursive')
    const escapes = args.some(arg => arg === '/' || arg === '~' || arg.includes('..') || /^[a-z]:[\\/]?$/i.test(arg) || arg === '*')
    return result(recursive && escapes ? 'FORBIDDEN' : 'HIGH', 'filesystem.delete', recursive ? 'recursive deletion through the shell' : 'deletion through the shell; use the delete_file tool')
  }
  if (executable === 'git') return classifyGit(args)
  if (PACKAGE_MANAGERS.has(executable)) return classifyPackageManager(executable, args, context)
  if (PACKAGE_RUNNERS.has(executable)) {
    const { value: name } = firstPositional(args)
    return name && context.hasLocalBin?.(name) && !args.includes('--yes') && !args.includes('-y')
      ? result('MEDIUM', 'process.execute', `runs the locally installed ${name}`)
      : result('HIGH', 'package.execute', `${executable} may download and execute ${name ?? 'a package'}`)
  }
  if (executable === 'pip' || executable === 'pip3') {
    const { value: sub } = firstPositional(args)
    if (sub === 'install') return result('MEDIUM', args.includes('-r') ? 'dependency.install' : 'dependency.add', 'pip install')
    if (sub === 'download') return result('HIGH', 'network', 'pip download')
    return result(sub === 'uninstall' ? 'MEDIUM' : 'LOW', 'dependency.add', `pip ${sub ?? ''}`)
  }
  if (['cargo', 'go', 'dotnet'].includes(executable)) {
    const { value: sub } = firstPositional(args)
    if (['publish', 'login', 'owner', 'yank'].includes(sub ?? '') || (executable === 'dotnet' && args.includes('push'))) return result('FORBIDDEN', 'network', `${executable} ${sub ?? ''} publishes; the user does this`)
    if (['install', 'get', 'add'].includes(sub ?? '')) return result('MEDIUM', 'dependency.add', `${executable} ${sub}`)
    if (!sub || ['version', 'help', 'env', 'list', 'fmt', 'vet', 'check', 'doc', 'tree', '--version'].includes(sub)) return result('LOW', 'process.inspect', `${executable} ${sub ?? ''}`.trim())
    return result('MEDIUM', 'process.execute', `${executable} ${sub}`)
  }
  if (INTERPRETERS.has(executable)) return classifyInterpreter(executable, args, context)
  if (BUILD_TOOLS.has(executable)) return result('MEDIUM', 'process.execute', `${executable} build/test tool`)
  if (executable === 'find') return result(args.some(arg => arg === '-delete' || arg === '-exec' || arg === '-execdir') ? 'HIGH' : 'LOW', 'process.inspect', 'find')
  if (READ_ONLY.has(executable)) return result('LOW', 'process.inspect', `${executable} only reads`)
  return result('HIGH', 'process.execute', `unknown executable ${executable}`)
}

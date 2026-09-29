// The single list of directories ALTREX never walks, snapshots, lists, or sends as context.
// Replaces four divergent copies (tool broker, Codex agent, workspace snapshot, repository context).
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git', '.altrex', '.next', '.turbo', '.venv', '.pnpm-store', '__pycache__',
  'build', 'coverage', 'dist', 'node_modules', 'out', 'target',
])

export function isIgnoredDirectory(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name)
}

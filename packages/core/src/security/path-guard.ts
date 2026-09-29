// Validates a project-relative POSIX path. Rejects traversal, absolute paths, drive letters,
// Windows reserved names/trailing dots, and protected locations (VCS, ALTREX state, dependencies,
// environment files, secrets, keys).
export function safePath(path: string): string {
  const value = path.replaceAll('\\', '/')
  if (value.split('/').some(segment => /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw new Error('Ambiguous operating-system path is not allowed.')
  if (!value || value.startsWith('/') || /[:\0]/.test(value) || value.split('/').some(segment => segment === '..' || segment === '.' || !segment) || /(^|\/)(\.git|\.altrex|node_modules|\.env[^/]*|[^/]*(?:secret|credential)[^/]*)(\/|$)/i.test(value) || /\.(pem|key)$/i.test(value)) throw new Error(`Protected or invalid project path: ${path}`)
  return value
}

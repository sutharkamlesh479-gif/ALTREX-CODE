import { digest, snapshot } from '../workspace/snapshot'
import { isRepository, workingTreeHash } from '../git/git'

/**
 * Identity of the project's source tree, used to decide whether evidence is current. Ignored directories
 * (build output, dependencies, .git …) and protected files are excluded, so running a build does not
 * change the hash, while any source edit does. Large Git projects fall back to Git's tree id.
 * Returns null when no hash can be computed (evidence can then never count as current).
 */
export function treeHash(root: string): string | null {
  try {
    const files = snapshot(root)
    return `snap:${digest(JSON.stringify(Object.keys(files).sort().map(path => [path, files[path]])))}`
  } catch {
    try { return isRepository(root) ? `git:${workingTreeHash(root)}` : null } catch { return null }
  }
}

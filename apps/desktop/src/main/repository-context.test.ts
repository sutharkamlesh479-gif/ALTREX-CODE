import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRepositoryContext } from './repository-context'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    const resolved = resolve(root)
    if (resolved.startsWith(resolve(tmpdir()))) rmSync(resolved, { recursive: true, force: true })
  }
})

describe('bounded repository context', () => {
  it('includes the tree and selected metadata without dumping unrelated source', () => {
    const root = mkdtempSync(join(tmpdir(), 'altrex-context-'))
    temporaryRoots.push(root)
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'package.json'), '{"name":"fixture"}')
    writeFileSync(join(root, 'src', 'private.ts'), 'UNRELATED_SOURCE_CONTENT')
    writeFileSync(join(root, 'node_modules', 'ignored.js'), 'DEPENDENCY_CONTENT')

    const context = buildRepositoryContext(root)
    expect(context).toContain('src/private.ts')
    expect(context).toContain('{"name":"fixture"}')
    expect(context).not.toContain('UNRELATED_SOURCE_CONTENT')
    expect(context).not.toContain('node_modules')
    expect(context).not.toContain('DEPENDENCY_CONTENT')
  })
})

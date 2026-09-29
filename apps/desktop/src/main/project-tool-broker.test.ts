import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectToolBroker } from './project-tool-broker'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) if (resolve(root).startsWith(resolve(tmpdir()))) rmSync(root, { recursive: true, force: true })
})

describe('project tool broker', () => {
  it('edits exact segments and appends bounded chunks without losing literal replacement text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'altrex-tools-')); roots.push(root)
    const broker = new ProjectToolBroker(root)
    await broker.execute({ id: 'w', name: 'write_file', arguments: JSON.stringify({ path: 'large.txt', content: 'needle\n' }) })
    const edit = await broker.execute({ id: 'e', name: 'edit_file', arguments: JSON.stringify({ path: 'large.txt', old_text: 'needle', new_text: '$& literal' }) })
    expect(edit.changedFile).toBe('large.txt')
    await broker.execute({ id: 'a', name: 'append_file', arguments: JSON.stringify({ path: 'large.txt', content: 'next chunk\n' }) })
    expect(readFileSync(join(root, 'large.txt'), 'utf8')).toBe('$& literal\nnext chunk\n')
    expect((await broker.execute({ id: 's', name: 'read_file', arguments: '{"path":".env"}' })).content).toContain('Protected')
  })
  it('writes and reads files only inside the selected project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'altrex-tools-'))
    roots.push(root)
    mkdirSync(join(root, 'src'))
    const broker = new ProjectToolBroker(root)

    const write = await broker.execute({ id: '1', name: 'write_file', arguments: JSON.stringify({ path: 'src/app.js', content: 'console.log("ALTREX")' }) })
    expect(write.changedFile).toBe('src/app.js')
    expect(readFileSync(join(root, 'src', 'app.js'), 'utf8')).toContain('ALTREX')
    expect((await broker.execute({ id: '2', name: 'read_file', arguments: JSON.stringify({ path: 'src/app.js' }) })).content).toContain('ALTREX')
  })

  it('blocks traversal outside the selected project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'altrex-tools-'))
    roots.push(root)
    const broker = new ProjectToolBroker(root)
    const result = await broker.execute({ id: '3', name: 'write_file', arguments: JSON.stringify({ path: '../escape.txt', content: 'blocked' }) })
    expect(result.content).toContain('blocked')
    expect(result.changedFile).toBeUndefined()
  })

  it('runs an allowlisted project command and records files it creates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'altrex-tools-'))
    roots.push(root)
    const broker = new ProjectToolBroker(root)
    await broker.execute({
      id: '4',
      name: 'write_file',
      arguments: JSON.stringify({ path: 'generate.cjs', content: "require('node:fs').writeFileSync('generated.txt', 'verified')" }),
    })
    const result = await broker.execute({ id: '5', name: 'run_command', arguments: JSON.stringify({ command: 'node', args: ['generate.cjs'] }) })

    expect(result.commandResult?.exitCode).toBe(0)
    expect(result.changedFiles).toContain('generated.txt')
    expect(readFileSync(join(root, 'generated.txt'), 'utf8')).toBe('verified')
  })

  it('rejects commands outside the development allowlist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'altrex-tools-'))
    roots.push(root)
    const broker = new ProjectToolBroker(root)
    const result = await broker.execute({ id: '6', name: 'run_command', arguments: JSON.stringify({ command: 'powershell', args: ['-Command', 'echo blocked'] }) })

    expect(result.content).toContain('not allowed')
    expect(result.commandResult).toBeUndefined()
  })

  it('executes the pnpm package-manager shim used on Windows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'altrex-tools-'))
    roots.push(root)
    const broker = new ProjectToolBroker(root)
    const result = await broker.execute({ id: '7', name: 'run_command', arguments: JSON.stringify({ command: 'pnpm', args: ['--version'] }) })

    expect(result.commandResult?.exitCode).toBe(0)
    expect(result.commandResult?.output).toMatch(/\d+\.\d+/)
  })
})

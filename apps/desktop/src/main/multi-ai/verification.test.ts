import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { verifyCommands } from './verification'
import { runProjectCommand } from '../project-command-runner'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
it('runs actual Node tests and reports a failing assertion as failed verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'altrex-verify-')); roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test unit.test.cjs' } }))
  writeFileSync(join(root, 'unit.test.cjs'), "require('node:assert/strict').equal(1, 2)")
  const failed = await verifyCommands(root, new AbortController().signal, () => {})
  expect(failed[0]?.command).toBe('npm run test'); expect(failed[0]?.exitCode).not.toBe(0)
  writeFileSync(join(root, 'unit.test.cjs'), "require('node:assert/strict').equal(2, 2)")
  const passed = await verifyCommands(root, new AbortController().signal, () => {})
  expect(passed[0]?.exitCode, passed[0]?.output).toBe(0)
}, 15000)
it('cancels spawned development process trees', async () => {
  const root = mkdtempSync(join(tmpdir(), 'altrex-cancel-')); roots.push(root)
  writeFileSync(join(root, 'child.cjs'), 'setInterval(() => {}, 1000)')
  writeFileSync(join(root, 'parent.cjs'), "const c = require('node:child_process').spawn(process.execPath, ['child.cjs'], {stdio:'ignore'}); require('node:fs').writeFileSync('child.pid', String(c.pid)); setInterval(() => {}, 1000)")
  const controller = new AbortController(), pending = runProjectCommand({ projectRoot: root, command: 'node', args: ['parent.cjs'], timeoutMs: 10000, signal: controller.signal })
  const deadline = Date.now() + 5000
  while (!existsSync(join(root, 'child.pid')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  controller.abort(); await pending
  const pid = Number(readFileSync(join(root, 'child.pid'), 'utf8'))
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(() => process.kill(pid, 0)).toThrow()
}, 15000)

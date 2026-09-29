import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceFiles = readdirSync(__dirname).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))

describe('contracts package purity', () => {
  it.each(sourceFiles)('%s is renderer-safe (no Node, Electron, or React imports)', (file) => {
    const text = readFileSync(join(__dirname, file), 'utf8')
    expect(text).not.toMatch(/from ['"](node:|electron|react)/)
    expect(text).not.toMatch(/require\(/)
  })

  it('keeps the IPC channel module free of runtime dependencies (preload imports it)', () => {
    expect(readFileSync(join(__dirname, 'channels.ts'), 'utf8')).not.toMatch(/^import /m)
  })
})

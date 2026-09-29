import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? sources(path) : name.endsWith('.ts') ? [path] : []
  })
}

describe('@altrex/core boundaries', () => {
  it.each(sources(__dirname).map(path => relative(__dirname, path)))('%s does not import Electron, React, or desktop code', (file) => {
    const text = readFileSync(join(__dirname, file), 'utf8')
    expect(text).not.toMatch(/from ['"](electron|react)['"/]/)
    expect(text).not.toMatch(/require\(['"]electron/)
    expect(text).not.toMatch(/from ['"][./]*(apps|desktop)\//)
  })
})

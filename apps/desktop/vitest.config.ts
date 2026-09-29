import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { testTimeout: 15_000, hookTimeout: 15_000 },
})

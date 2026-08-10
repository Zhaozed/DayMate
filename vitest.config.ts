import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Unit + integration tests for main/shared logic. Renderer e2e uses Playwright (M4).
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/evaluation/**/*.test.ts'],
    environment: 'node'
  }
})

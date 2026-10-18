import { defineConfig } from 'vitest/config'
import path from 'path'

// Tests against a real PostgreSQL server started by docker-compose.test.yml.
// Run with `npm run test:db`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.db.test.ts'],
    // .claude/** holds the worktrees of coding agents, other checkouts of this repository with tests of their own.
    exclude: ['node_modules/**', '.next/**', '.claude/**'],
    fileParallelism: false,
    globalSetup: ['./tests/db/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})

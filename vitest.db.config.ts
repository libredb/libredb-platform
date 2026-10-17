import { defineConfig } from 'vitest/config'
import path from 'path'

// Tests against a real PostgreSQL server started by docker-compose.test.yml.
// Run with `npm run test:db`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.db.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
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

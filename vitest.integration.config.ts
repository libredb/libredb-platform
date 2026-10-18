import { defineConfig } from 'vitest/config'
import path from 'path'

// Tests against the Keycloak services started by docker-compose.test.yml:
// `docker compose -f docker-compose.test.yml up -d --wait keycloak keycloak-proxied`,
// then `npm run test:integration`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.integration.test.ts'],
    // .claude/** holds the worktrees of coding agents, other checkouts of this repository with tests of their own.
    exclude: ['node_modules/**', '.next/**', 'installer/**', '.claude/**'],
    // One file at a time: directory-sync.integration.test.ts removes bob's role in the shared realm for a moment,
    // and other files read bob's roles.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/shared/test-setup.ts'],
    // .claude/** holds the worktrees of coding agents, other checkouts of this repository with tests of their own.
    exclude: ['e2e/**', 'node_modules/**', '.next/**', 'installer/**', '.claude/**', '**/*.db.test.ts', '**/*.integration.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})

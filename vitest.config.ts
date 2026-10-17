import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/shared/test-setup.ts'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**', 'installer/**', '**/*.db.test.ts', '**/*.integration.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})

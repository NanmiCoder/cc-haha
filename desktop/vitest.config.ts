import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    maxWorkers: process.platform === 'win32' ? 4 : undefined,
    environment: 'jsdom',
    globals: true,
    css: true,
    setupFiles: ['./src/test/webStorage.ts'],
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/types/**',
        'src/mocks/**',
        'src/test/**',
        'src/vite-env.d.ts',
      ],
    },
  },
})

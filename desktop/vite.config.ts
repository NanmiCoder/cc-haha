import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const host = process.env.TAURI_DEV_HOST
// Allow running an isolated dev pair (alternate ports) without disturbing
// other sessions sharing this checkout. Defaults preserve the standard
// 1420/3456 setup the testing doc relies on.
const PROXY_PORT = Number(process.env.SERVER_PROXY_PORT) || 3456
const VITE_PORT = Number(process.env.VITE_PORT) || 1420
const PROXY_TARGET = `http://127.0.0.1:${PROXY_PORT}`
const PROXY_WS_TARGET = `ws://127.0.0.1:${PROXY_PORT}`

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    // Vite 8 defaults to baseline-widely-available (safari16.4+), which
    // requires macOS 13+. Tauri on macOS 12 uses Safari 15 WebView.
    target: ['es2021', 'safari15'],
    chunkSizeWarningLimit: 2200,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT') return
        warn(warning)
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: VITE_PORT,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: VITE_PORT + 1 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    // Dev-only: proxy backend traffic so the renderer talks to the API
    // server through the same Vite origin. This avoids CORS and the
    // loopback-clears-H5-auth path that breaks the standalone-browser
    // dev workflow. Electron production path is unaffected because
    // Electron sets the base URL via IPC at runtime.
    proxy: {
      '/health': PROXY_TARGET,
      '/api': PROXY_TARGET,
      '/ws': { target: PROXY_WS_TARGET, ws: true },
      '/local-file': PROXY_TARGET,
      '/preview-fs': PROXY_TARGET,
    },
  },
})

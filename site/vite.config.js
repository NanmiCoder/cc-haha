import { defineConfig } from 'vite'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { generateDocsManifest, paths } from './scripts/generate-docs-manifest.mjs'

const imageMimeTypes = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

function docsManifestPlugin() {
  return {
    name: 'claude-code-haha-docs-manifest',
    async buildStart() {
      await generateDocsManifest()
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
        const extension = path.extname(pathname).toLowerCase()
        if (!imageMimeTypes[extension]) {
          next()
          return
        }

        const sourcePath = path.resolve(paths.docsDir, pathname.replace(/^\/+/, ''))
        if (!sourcePath.startsWith(`${paths.docsDir}${path.sep}`)) {
          next()
          return
        }

        try {
          response.statusCode = 200
          response.setHeader('Content-Type', imageMimeTypes[extension])
          response.end(await fs.readFile(sourcePath))
        } catch {
          next()
        }
      })

      const docsGlob = `${paths.docsDir.replaceAll('\\', '/')}/**/*.md`
      server.watcher.add(docsGlob)
      server.watcher.on('all', async (event, changedPath) => {
        if (!changedPath.endsWith('.md') || !changedPath.startsWith(paths.docsDir)) {
          return
        }

        if (['add', 'change', 'unlink'].includes(event)) {
          await generateDocsManifest()
        }
      })
    }
  }
}

export default defineConfig({
  plugins: [docsManifestPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true
  },
  server: {
    port: 5173
  },
  preview: {
    port: 4173
  }
})

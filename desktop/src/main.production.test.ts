// @vitest-environment node

import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'vite'
import { expect, it } from 'vitest'

const desktopRoot = fileURLToPath(new URL('../', import.meta.url))

it('boots React from the production ESM chunks', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'cc-haha-renderer-'))
  try {
    await build({
      root: desktopRoot,
      envFile: false,
      logLevel: 'error',
      build: { outDir, manifest: true, copyPublicDir: false },
    })

    // Native ESM evaluation catches chunk initialization failures that Vitest's
    // source module runner never sees. jsdom supplies the DOM without a server.
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--input-type=module',
      '--eval',
      `
        import { readFileSync, readdirSync } from 'node:fs'
        import { join } from 'node:path'
        import { setTimeout as delay } from 'node:timers/promises'
        import { pathToFileURL } from 'node:url'
        import { JSDOM } from 'jsdom'

        const [dir] = process.argv.slice(1)
        const manifest = JSON.parse(readFileSync(join(dir, '.vite/manifest.json'), 'utf8'))
        const { window } = new JSDOM('<!doctype html><div id="root"></div>', {
          url: 'http://localhost', pretendToBeVisual: true,
        })
        for (const key of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage',
          'location', 'HTMLElement', 'MutationObserver', 'getComputedStyle']) {
          Object.defineProperty(globalThis, key, { configurable: true, value: window[key] })
        }
        globalThis.fetch = window.fetch = async () => { throw new Error('Offline startup test') }
        window.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {}, removeEventListener() {} })
        document.createElement('link').relList.constructor.prototype.supports = () => true
        for (const file of readdirSync(join(dir, 'assets')).filter(name => name.endsWith('.css'))) {
          const link = document.createElement('link')
          link.rel = 'stylesheet'
          link.href = pathToFileURL(join(dir, 'assets', file)).href
          document.head.appendChild(link)
        }

        try {
          await Promise.race([
            new Promise((_, reject) => { window.__CC_HAHA_SHOW_STARTUP_ERROR__ = reject }),
            (async () => {
              await import(pathToFileURL(join(dir, manifest['index.html'].file)).href)
              while (!window.__CC_HAHA_BOOTSTRAPPED__ || !document.querySelector('#root > *')) await delay(10)
            })(),
          ])
          console.log('Renderer mounted')
          process.exit(0)
        } catch (error) {
          console.error(error.stack ?? error)
          process.exit(1)
        }
      `,
      await realpath(outDir),
    ], { cwd: desktopRoot, timeout: 10_000 })
    expect(stdout).toContain('Renderer mounted')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
}, 30_000)

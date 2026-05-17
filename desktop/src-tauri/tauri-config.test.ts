import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const currentDir = dirname(fileURLToPath(import.meta.url))

describe('tauri security config', () => {
  it('allows desktop sidecar image URLs for opener icons', () => {
    const config = JSON.parse(
      readFileSync(join(currentDir, 'tauri.conf.json'), 'utf8'),
    ) as {
      app?: {
        security?: {
          csp?: string
        }
      }
    }

    const csp = config.app?.security?.csp ?? ''
    expect(csp).toContain('img-src')
    expect(csp).toContain('http://127.0.0.1:*')
    expect(csp).toContain('http://localhost:*')
  })
})

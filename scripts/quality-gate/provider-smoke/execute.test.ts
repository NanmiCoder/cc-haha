import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeProviderSmoke } from './execute'

const ENV_KEYS = [
  'QUALITY_GATE_PROVIDER_BASE_URL',
  'QUALITY_GATE_PROVIDER_API_KEY',
  'QUALITY_GATE_PROVIDER_MODEL',
  'QUALITY_GATE_PROVIDER_API_FORMAT',
  'QUALITY_GATE_PROVIDER_AUTH_STRATEGY',
] as const

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
)

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = originalEnv.get(key)
    if (original === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = original
    }
  }
})

describe('provider smoke execution', () => {
  test('skips unsaved provider smoke with an actionable missing-env reason', async () => {
    for (const key of ENV_KEYS) {
      delete process.env[key]
    }

    const artifactRoot = mkdtempSync(join(tmpdir(), 'provider-smoke-test-'))
    try {
      const result = await executeProviderSmoke(
        process.cwd(),
        join(artifactRoot, 'case'),
        'provider-smoke:test',
        'Provider smoke',
        undefined,
      )

      expect(result.status).toBe('skipped')
      expect(result.skipReason).toContain('QUALITY_GATE_PROVIDER_BASE_URL')
      expect(existsSync(join(artifactRoot, 'case'))).toBe(true)
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true })
    }
  })
})

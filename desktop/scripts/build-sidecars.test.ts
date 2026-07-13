import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

function readBuildScript() {
  return readFileSync(path.resolve(import.meta.dirname, 'build-sidecars.ts'), 'utf8')
}

function readCliLauncher() {
  return readFileSync(
    path.resolve(import.meta.dirname, '../../bin/claude-haha'),
    'utf8',
  )
}

function extractWindowsX64BunTarget(source: string) {
  const match = source.match(/case 'x86_64-pc-windows-msvc':[\s\S]*?return '([^']+)'/)
  return match?.[1] ?? null
}

describe('build-sidecars Windows x64 target mapping', () => {
  it('uses the baseline Bun runtime so older CPUs do not crash with Illegal Instruction', () => {
    expect(extractWindowsX64BunTarget(readBuildScript())).toBe('bun-windows-x64-baseline')
  })

  it('compiles the sidecar with the transcript classifier feature', () => {
    expect(readBuildScript()).toContain("features: ['TRANSCRIPT_CLASSIFIER']")
  })

  it('starts the development CLI with the transcript classifier feature', () => {
    expect(readCliLauncher()).toContain('--feature=TRANSCRIPT_CLASSIFIER')
  })
})

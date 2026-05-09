import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('release desktop workflow', () => {
  test('build job runs directly without quality preflight dependency', () => {
    const workflow = readFileSync('.github/workflows/release-desktop.yml', 'utf8')

    expect(workflow).not.toContain('quality-preflight:')
    expect(workflow).not.toContain('run: bun run quality:gate --mode pr')
    expect(workflow).not.toContain('needs: quality-preflight')
    expect(workflow).toContain('name: Build (${{ matrix.label }})')
  })
})

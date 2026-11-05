// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { scanMissingImports } from './scan-missing-imports'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'scan-imports-'))
  roots.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'adapters'), { recursive: true })
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('does not create source placeholders from imports embedded in test fixtures', async () => {
  const root = fixture()
  for (const file of ['runtime.test.ts', 'runtime.spec.tsx', 'runtime.test.mts']) {
    writeFileSync(join(root, 'src', file), "const fixture = `await import('./src/private-module')`\n")
  }
  writeFileSync(join(root, 'adapters', 'runtime.test.ts'), "import './missing-test-module'\n")
  await scanMissingImports(root)
  expect(existsSync(join(root, 'src/src/private-module.ts'))).toBe(false)
  expect(existsSync(join(root, 'adapters/missing-test-module.ts'))).toBe(false)
})

test('still prepares production feature-gated modules without replacing existing source', async () => {
  const root = fixture()
  const existing = 'export const value = 42\n'
  writeFileSync(join(root, 'src/existing.ts'), existing)
  writeFileSync(join(root, 'src/runtime.ts'), "import './existing'\nif (feature('INTERNAL')) import('./private-module')\n")
  writeFileSync(join(root, 'adapters/runtime.ts'), "if (feature('INTERNAL')) import('./private-module')\n")
  await scanMissingImports(root)
  expect(readFileSync(join(root, 'src/existing.ts'), 'utf8')).toBe(existing)
  for (const area of ['src', 'adapters']) {
    expect(readFileSync(join(root, area, 'private-module.ts'), 'utf8')).toContain('// @generated stub from scan-missing-imports')
  }
})

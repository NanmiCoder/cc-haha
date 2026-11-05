import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeSource(root: string, relativePath: string, contents: string) {
  const file = path.join(root, relativePath)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

// The script derives the repo root from its own location, so run a copy inside a fixture tree.
function runScan(root: string) {
  const script = path.join(root, 'desktop', 'scripts', 'scan-missing-imports.ts')
  mkdirSync(path.dirname(script), { recursive: true })
  copyFileSync(path.join(scriptsDir, 'scan-missing-imports.ts'), script)
  return spawnSync('bun', ['run', script], {
    cwd: root,
    env: createSandboxedTestEnvironment(path.join(root, 'home')),
    encoding: 'utf8',
    timeout: 30_000,
  })
}

describe('scan-missing-imports', () => {
  it('stubs missing source imports but ignores specifiers inside test files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'scan-missing-imports-'))
    tempRoots.push(root)
    writeSource(root, 'src/feature/entry.ts', "export const gated = () => import('./internalOnly.js')\n")
    // Tests embed repo-root-relative paths in subprocess sources; they are never compiled into the sidecar.
    writeSource(root, 'src/feature/runtime.test.ts', [
      'const source = `',
      "  const { run } = await import('./src/utils/effort.ts')",
      '`',
      "const { helper } = await import('./missingTestHelper.ts')",
      '',
    ].join('\n'))
    writeSource(root, 'adapters/common/view.spec.tsx', "import { view } from './missingSpecHelper'\n")

    const result = runScan(root)

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(path.join(root, 'src/feature/internalOnly.ts'))).toBe(true)
    expect(existsSync(path.join(root, 'src/feature/src'))).toBe(false)
    expect(existsSync(path.join(root, 'src/feature/missingTestHelper.ts'))).toBe(false)
    expect(existsSync(path.join(root, 'adapters/common/missingSpecHelper.ts'))).toBe(false)
  })
})

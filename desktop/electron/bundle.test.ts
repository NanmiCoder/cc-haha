import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const desktopRoot = existsSync(path.resolve(process.cwd(), 'electron', 'main.ts'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'desktop')
const outDir = mkdtempSync(path.join(os.tmpdir(), 'cc-haha-electron-bundle-'))
afterAll(() => rmSync(outDir, { recursive: true, force: true }))

/** The `bun build` steps of build:electron, with the arguments the package script passes. */
function electronBuilds() {
  const script: string = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8')).scripts['build:electron']
  return script.split('&&').map(step => step.trim().split(/\s+/)).filter(args => args[0] === 'bun' && args[1] === 'build')
}

describe('Electron bundles', () => {
  // Bun replaces `__dirname` in these ESM sources with the directory it was
  // built in, so a packaged app reading a file next to its bundle looked inside
  // the build machine's checkout instead (P2P direct connections never started).
  it.each(electronBuilds().map(args => [args[2], args] as const))('%s does not depend on the build machine\'s paths', (_entry, args) => {
    const command = args.slice(1)
    const outfileAt = command.indexOf('--outfile') + 1
    expect(outfileAt).toBeGreaterThan(0)
    const outfile = path.join(outDir, path.basename(command[outfileAt] ?? 'bundle.js'))
    command[outfileAt] = outfile
    const result = spawnSync(process.versions.bun ? process.execPath : 'bun', command, { cwd: desktopRoot, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    const bundle = readFileSync(outfile, 'utf8')
    expect(bundle).not.toContain(desktopRoot)
    expect(bundle).not.toContain(JSON.stringify(desktopRoot).slice(1, -1))
  }, 60_000)
})

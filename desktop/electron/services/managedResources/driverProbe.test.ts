/**
 * Tests for the side-effect-free M0.2 managed resource driver probe.
 *
 * Three layers are exercised:
 *
 *   1. Direct Vitest call: probeManagedResourceDrivers() returns true for all
 *      five entries without constructing any Client, opening a connection,
 *      reading configuration, or registering global state.
 *   2. Real Electron 42 Windows Node main-process subprocess: spawn the
 *      Electron binary with ELECTRON_RUN_AS_NODE=1, run a temporary CJS
 *      script that uses createRequire anchored to desktop/package.json to
 *      resolve the five pinned drivers, and assert every entry point is a
 *      function. The subprocess exits with code 0 within 30 seconds.
 *   3. Static renderer scan: walk every .ts/.tsx file under desktop/src and
 *      assert none of them references the five Node-only drivers via static
 *      import, bare import, dynamic import, or export-from. The boundary
 *      uses a root-package prefix rule (specifier === root OR starts with
 *      root + '/') instead of a finite allow-list of known subpaths, so
 *      arbitrary synthetic subpaths are rejected by construction.
 *
 * The Electron subprocess is spawned with shell=false and windowsHide=true;
 * the temporary script is written into os.tmpdir() and removed in the
 * afterEach hook. The test never opens a network port or calls connect /
 * query / exec / open / listen / createServer on any driver entry point,
 * and the zero-network assertion reads both the production driverProbe.ts
 * source and the Electron subprocess script body statically to prove it.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { probeManagedResourceDrivers } from './driverProbe'
import ts from 'typescript'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.resolve(HERE, '..', '..', '..')
const ELECTRON_EXE = path.join(DESKTOP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe')
const DESKTOP_PACKAGE_JSON = path.join(DESKTOP_DIR, 'package.json')
const RENDERER_SRC_DIR = path.join(DESKTOP_DIR, 'src')
const DRIVER_PROBE_SOURCE_PATH = path.join(
  DESKTOP_DIR,
  'electron',
  'services',
  'managedResources',
  'driverProbe.ts',
)

// Five pinned M0.2 root packages. A renderer import is forbidden whenever
// its specifier equals one of these roots OR starts with root + '/'. This
// rule closes MR-M02-002: arbitrary synthetic subpaths under each root are
// rejected without enumerating every legitimate subpath, and the previous
// finite allow-list (which missed ssh2/arbitrary, mysql2/custom, etc.) is
// removed entirely.
const RENDERER_FORBIDDEN_ROOTS = [
  'ssh2',
  'mysql2',
  'pg',
  'pg-cursor',
  '@redis/client',
] as const

function isRendererForbiddenSpecifier(specifier: string): boolean {
  return RENDERER_FORBIDDEN_ROOTS.some(
    root => specifier === root || specifier.startsWith(root + '/'),
  )
}

// Network-invocation patterns that MUST NOT appear in the production probe
// source or in the Electron subprocess script body. Closes MR-M02-003 by
// reading both sources statically and asserting each pattern is absent.
// The detector is a separate pure function so a synthetic dangerous text
// can prove it catches every required call shape.
const NETWORK_INVOCATION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['new Client(...)', /\bnew\s+Client\s*\(/],
  ['createConnection(...)', /\bcreateConnection\s*\(/],
  ['createClient(...)', /\bcreateClient\s*\(/],
  ['.connect(...)', /\.connect\s*\(/],
  ['.query(...)', /\.query\s*\(/],
  ['.exec(...)', /\.exec\s*\(/],
  ['.open(...)', /\.open\s*\(/],
  ['.listen(...)', /\.listen\s*\(/],
  ['createServer(...)', /\bcreateServer\s*\(/],
]

function findNetworkInvocations(source: string): string[] {
  return NETWORK_INVOCATION_PATTERNS
    .filter(([, re]) => re.test(source))
    .map(([label]) => label)
}

// Electron subprocess CJS body. Hoisted to module scope so the zero-network
// assertion can read it statically without parsing the closure body of
// runElectronProbeChild(). The script only does createRequire + typeof
// checks; it never constructs a client, opens a socket, or reads env.
const SUBPROCESS_SCRIPT = `
'use strict'
const { createRequire } = require('node:module')
const packageJsonPath = ${JSON.stringify(DESKTOP_PACKAGE_JSON)}
const req = createRequire(packageJsonPath)
const entries = [
  ['ssh2', 'Client'],
  ['mysql2/promise', 'createConnection'],
  ['pg', 'Client'],
  ['pg-cursor', 'default'],
  ['@redis/client', 'createClient'],
]
for (const [pkg, entry] of entries) {
  const mod = req(pkg)
  let resolved
  if (entry === 'default') {
    resolved = mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod
  } else {
    resolved = mod[entry]
  }
  if (typeof resolved !== 'function') {
    process.stderr.write('expected function for ' + pkg + '.' + entry + '\\n')
    process.exit(2)
  }
}
process.exitCode = 0
`

const tempScriptPaths: string[] = []

afterEach(() => {
  for (const file of tempScriptPaths.splice(0)) {
    try {
      fs.unlinkSync(file)
    } catch {
      // best-effort cleanup; os.tmpdir() entries can vanish across reboots
    }
  }
})

function writeChildScript(script: string): string {
  const hash = createHash('sha1').update(script).digest('hex').slice(0, 8)
  const file = path.join(
    os.tmpdir(),
    `cc-haha-driver-probe-${process.pid}-${Date.now()}-${hash}.cjs`,
  )
  fs.writeFileSync(file, script, 'utf8')
  tempScriptPaths.push(file)
  return file
}

function findImportSpecifiers(source: string): string[] {
  // The old cross-line regex backtracked over entire export bodies and made
  // the renderer-tree gate exceed its deadline. Use the compiler's scanner.
  return [...new Set(ts.preProcessFile(source, true, true).importedFiles.map(file => file.fileName))]
}

function collectRendererViolations(): Array<{ file: string; specifier: string }> {
  const violations: Array<{ file: string; specifier: string }> = []
  const stack: string[] = [RENDERER_SRC_DIR]
  while (stack.length > 0) {
    const dir = stack.pop()!
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!/\.(t|tx)sx?$/.test(entry.name)) continue
      if (/\.test\.(t|tx)sx?$/.test(entry.name)) continue
      const source = fs.readFileSync(full, 'utf8')
      for (const specifier of findImportSpecifiers(source)) {
        if (isRendererForbiddenSpecifier(specifier)) {
          violations.push({
            file: path.relative(DESKTOP_DIR, full).replaceAll(path.sep, '/'),
            specifier,
          })
        }
      }
    }
  }
  return violations
}

function runElectronProbeChild(): Promise<{ code: number | null; stderr: string }> {
  const childPath = writeChildScript(SUBPROCESS_SCRIPT)
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ELECTRON_EXE,
      [childPath],
      {
        cwd: DESKTOP_DIR,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`Electron probe child timed out after 30000ms; stderr=${stderr}`))
    }, 30_000)
    proc.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
    proc.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

describe('M0.2 driver capability probe', () => {
  it('exposes all five driver capabilities as true from a direct call', async () => {
    const result = await probeManagedResourceDrivers()
    expect(result).toEqual({
      ssh: true,
      mysql: true,
      postgres: true,
      postgresCursor: true,
      redis: true,
    })
  })

  it(
    'loads all five driver entry points inside the current Electron Node main process',
    async () => {
      const { code, stderr } = await runElectronProbeChild()
      expect(code).toBe(0)
      expect(stderr).toBe('')
    },
    35_000,
  )

  it('keeps the five Node-only drivers out of the renderer source tree', () => {
    const violations = collectRendererViolations()
    expect(violations).toEqual([])
  })

  it('finds import, export, require and dynamic-import edges without treating comments as imports', () => {
    const imports = findImportSpecifiers([
      "import { Client } from 'ssh2/custom'",
      "import 'mysql2/promise'",
      "export { Client } from 'pg'",
      "const cursor = import('pg-cursor')",
      "const redis = require('@redis/client')",
      "// import 'not-a-real-import'",
    ].join('\n'))
    expect(imports.sort()).toEqual(['@redis/client', 'mysql2/promise', 'pg', 'pg-cursor', 'ssh2/custom'].sort())
  })

  describe('renderer boundary root-package prefix rule', () => {
    // Five unenumerated synthetic subpaths required by MR-M02-002 plus the
    // five roots themselves. The previous allow-list missed every one of
    // these; the prefix rule catches them by construction.
    it.each([
      ['ssh2/arbitrary'],
      ['mysql2/custom'],
      ['pg/custom'],
      ['pg-cursor/custom'],
      ['@redis/client/custom'],
      ['ssh2'],
      ['mysql2'],
      ['pg'],
      ['pg-cursor'],
      ['@redis/client'],
    ])('rejects forbidden root or subpath: %s', (spec) => {
      expect(isRendererForbiddenSpecifier(spec)).toBe(true)
    })

    it.each([
      ['some-other-package'],
      ['./local-relative'],
      ['@scope/safe-pkg'],
      ['mysql2x/sneaky-look-alike'],
      ['pg-fake/x'],
      ['/absolute/path'],
    ])('allows unrelated or non-matching specifier: %s', (spec) => {
      expect(isRendererForbiddenSpecifier(spec)).toBe(false)
    })
  })

  describe('zero-network static assertion', () => {
    it('finds every required network invocation shape in a synthetic dangerous text', () => {
      // Synthetic text deliberately containing each forbidden pattern.
      // Proves the detector is wired to every required call shape, not
      // only to whichever ones happen to appear in the real sources.
      const dangerous = [
        "const a = new Client({ host: 'x' })",
        "const b = createConnection({ host: 'x' })",
        "const c = createClient({ url: 'x' })",
        'a.connect()',
        "a.query('SELECT 1')",
        "a.exec('ls')",
        'a.open()',
        'a.listen(0)',
        'const srv = createServer(() => {})',
      ].join('\n')
      expect(findNetworkInvocations(dangerous)).toEqual([
        'new Client(...)',
        'createConnection(...)',
        'createClient(...)',
        '.connect(...)',
        '.query(...)',
        '.exec(...)',
        '.open(...)',
        '.listen(...)',
        'createServer(...)',
      ])
    })

    it('reports no network invocations in the production driverProbe.ts', () => {
      const source = fs.readFileSync(DRIVER_PROBE_SOURCE_PATH, 'utf8')
      expect(findNetworkInvocations(source)).toEqual([])
    })

    it('reports no network invocations in the Electron subprocess script body', () => {
      expect(findNetworkInvocations(SUBPROCESS_SCRIPT)).toEqual([])
    })
  })
})
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import path from 'node:path'
import {
  __resetCuHelperCache,
  callCuHelper,
  isCuHelperAvailable,
  isMacosComputerUseRuntimeSupported,
  resolveCuHelperAppBundle,
  resolveCuHelperBinary,
  resolveCuHelperDevelopmentBinary,
  resolveLaunchableCuHelperBinary,
} from './cuHelperBridge.js'
import { __resetInstalledHelperCache } from './cuHelperInstall.js'

function resetComputerUseHelperState(): void {
  __resetCuHelperCache()
  // callCuHelper now resolves through ensureInstalledHelper(); clear its module
  // cache too so a prior test's resolution can't leak into the next.
  __resetInstalledHelperCache()
  delete process.env.CC_HAHA_CU_HELPER_PATH
  delete process.env.CLAUDE_APP_ROOT
}

beforeEach(resetComputerUseHelperState)
afterEach(resetComputerUseHelperState)

const currentDevBinary = resolveCuHelperDevelopmentBinary('/project')
if (!currentDevBinary) throw new Error(`unsupported test architecture: ${process.arch}`)
const currentDevSuffix = currentDevBinary.slice('/project'.length)

function isCurrentDevBinary(candidate: string): boolean {
  return candidate.endsWith(currentDevSuffix)
}

describe('resolveCuHelperBinary', () => {
  test('returns the env override when it exists', () => {
    process.env.CC_HAHA_CU_HELPER_PATH = '/custom/cu-helper'
    expect(resolveCuHelperBinary(p => p === '/custom/cu-helper')).toBe('/custom/cu-helper')
  })

  test('ignores overrides and development candidates in a packaged app', () => {
    process.env.CC_HAHA_CU_HELPER_PATH = '/tmp/evil-helper'
    process.env.CLAUDE_APP_ROOT = '/Applications/App.app/Contents/Resources/app.asar'
    const bundled = path.join(
      '/Applications/App.app/Contents/Resources/app.asar.unpacked',
      'src-tauri', 'binaries', 'cc-haha-computer-use.app', 'Contents', 'MacOS', 'cc-haha-computer-use',
    )

    const found = resolveCuHelperBinary(p =>
      p === '/tmp/evil-helper'
      || isCurrentDevBinary(p)
      || p === bundled,
    )
    expect(found).toBe(bundled)
  })

  test('ignores the env override when it does not exist, falling to candidates', () => {
    process.env.CC_HAHA_CU_HELPER_PATH = '/missing/cu-helper'
    const found = resolveCuHelperBinary(isCurrentDevBinary)
    expect(found?.endsWith(currentDevSuffix)).toBe(true)
  })

  test('resolves the dev build path (.app inner executable)', () => {
    const found = resolveCuHelperBinary(isCurrentDevBinary)
    expect(found?.endsWith(currentDevSuffix)).toBe(true)
    expect(found).not.toContain('/.build/release/')
  })

  test('maps Node architectures to matching thin SwiftPM products', () => {
    expect(resolveCuHelperDevelopmentBinary('/repo', 'arm64')).toBe(
      path.join('/repo', 'native', 'cu-helper', '.build', 'arm64', 'arm64-apple-macosx', 'release', 'cc-haha-computer-use.app', 'Contents', 'MacOS', 'cc-haha-computer-use'),
    )
    expect(resolveCuHelperDevelopmentBinary('/repo', 'x64')).toBe(
      path.join('/repo', 'native', 'cu-helper', '.build', 'x86_64', 'x86_64-apple-macosx', 'release', 'cc-haha-computer-use.app', 'Contents', 'MacOS', 'cc-haha-computer-use'),
    )
    expect(resolveCuHelperDevelopmentBinary('/repo', 'ia32')).toBeNull()
  })

  test('resolves the bundled unpacked path from CLAUDE_APP_ROOT (.asar → .asar.unpacked)', () => {
    process.env.CLAUDE_APP_ROOT = '/Applications/App.app/Contents/Resources/app.asar'
    const unpacked = path.join(
      '/Applications/App.app/Contents/Resources/app.asar.unpacked',
      'src-tauri', 'binaries', 'cc-haha-computer-use.app', 'Contents', 'MacOS', 'cc-haha-computer-use',
    )
    // Probe matches ONLY the unpacked binaries path (not the dev SwiftPM build).
    const found = resolveCuHelperBinary(p => p === unpacked)
    expect(found).toBe(unpacked)
    expect(found?.replaceAll('\\', '/')).toContain(
      'app.asar.unpacked/src-tauri/binaries/cc-haha-computer-use.app/Contents/MacOS/cc-haha-computer-use',
    )
    // Must reach the inner executable THROUGH `src-tauri/binaries/cc-haha-computer-use.app`,
    // not the old bogus `<projectRoot>/binaries/cc-haha-computer-use` guess (no `src-tauri/`
    // segment) and not a bare Mach-O (Screen Recording TCC requires the real .app subject).
    expect(found).toMatch(
      /[/\\]src-tauri[/\\]binaries[/\\]cc-haha-computer-use\.app[/\\]Contents[/\\]MacOS[/\\]cc-haha-computer-use$/,
    )
  })

  test('uses only the bundled path in a packaged app when dev and bundled paths both exist', () => {
    process.env.CLAUDE_APP_ROOT = '/Applications/App.app/Contents/Resources/app.asar'
    // A packaged process must never escape to a writable development build.
    const bundled = path.join(
      '/Applications/App.app/Contents/Resources/app.asar.unpacked',
      'src-tauri', 'binaries', 'cc-haha-computer-use.app', 'Contents', 'MacOS', 'cc-haha-computer-use',
    )
    const found = resolveCuHelperBinary(
      p => isCurrentDevBinary(p) || p === bundled,
    )
    expect(found).toBe(bundled)
  })

  test('returns null when nothing exists', () => {
    expect(resolveCuHelperBinary(() => false)).toBeNull()
  })

  test('caches the first resolution', () => {
    expect(resolveCuHelperBinary(() => false)).toBeNull()
    // A later call with a different probe is ignored because of the cache.
    expect(resolveCuHelperBinary(() => true)).toBeNull()
  })
})

describe('resolveCuHelperAppBundle', () => {
  test('derives the .app bundle path from the resolved inner executable', () => {
    const app = resolveCuHelperAppBundle(isCurrentDevBinary)
    expect(app).toContain(path.join('native', 'cu-helper', '.build', process.arch === 'x64' ? 'x86_64' : 'arm64'))
    expect(app?.endsWith('cc-haha-computer-use.app')).toBe(true)
    // The bundle path stops at `.app` — it must NOT include the inner Contents/MacOS.
    expect(app).not.toContain('Contents')
  })

  test('returns null when the resolved binary is a bare path (no .app wrapper)', () => {
    process.env.CC_HAHA_CU_HELPER_PATH = '/custom/cu-helper'
    expect(resolveCuHelperAppBundle(p => p === '/custom/cu-helper')).toBeNull()
  })

  test('returns null when nothing resolves', () => {
    expect(resolveCuHelperAppBundle(() => false)).toBeNull()
  })
})

describe('isCuHelperAvailable', () => {
  test('gates the native runtime at macOS 14.4 in both directions', () => {
    expect(isMacosComputerUseRuntimeSupported('darwin', '23.3.0')).toBe(false)
    expect(isMacosComputerUseRuntimeSupported('darwin', '23.4.0')).toBe(true)
    expect(isMacosComputerUseRuntimeSupported('darwin', '24.0.0')).toBe(true)
    expect(isMacosComputerUseRuntimeSupported('linux', '24.0.0')).toBe(false)
    expect(isMacosComputerUseRuntimeSupported('darwin', 'invalid')).toBe(false)
  })

  test('is false off darwin regardless of binary', () => {
    if (process.platform !== 'darwin') {
      expect(isCuHelperAvailable()).toBe(false)
    } else {
      // On darwin in the worktree the dev binary is usually present; either way
      // the function must not throw and returns a boolean.
      expect(typeof isCuHelperAvailable()).toBe('boolean')
    }
  })

  test('launch resolution fails closed before touching a helper on unsupported systems', () => {
    process.env.CC_HAHA_CU_HELPER_PATH = '/x/cu-helper'
    __resetCuHelperCache()
    resolveCuHelperBinary(p => p === '/x/cu-helper')
    expect(resolveLaunchableCuHelperBinary(false)).toBeNull()
    expect(resolveLaunchableCuHelperBinary(true)).toBe('/x/cu-helper')
  })
})

describe('callCuHelper', () => {
  function primeBinary(path = '/x/cu-helper') {
    process.env.CC_HAHA_CU_HELPER_PATH = path
    __resetCuHelperCache()
    resolveCuHelperBinary(p => p === path)
  }

  test('parses an ok envelope and returns result', async () => {
    primeBinary()
    const exec = async () => ({ code: 0, stdout: '{"ok":true,"result":{"x":1}}', stderr: '' })
    const r = await callCuHelper<{ x: number }>('foo', {}, exec as never, () => '/x/cu-helper')
    expect(r).toEqual({ x: 1 })
  })

  test('throws the helper error message on ok:false', async () => {
    primeBinary()
    const exec = async () => ({ code: 0, stdout: '{"ok":false,"error":{"message":"nope"}}', stderr: '' })
    await expect(callCuHelper('foo', {}, exec as never, () => '/x/cu-helper')).rejects.toThrow('nope')
  })

  test('throws on invalid JSON', async () => {
    primeBinary()
    const exec = async () => ({ code: 0, stdout: 'not json', stderr: 'boom' })
    await expect(callCuHelper('foo', {}, exec as never, () => '/x/cu-helper')).rejects.toThrow()
  })

  test('throws a clear error when the binary is missing', async () => {
    __resetCuHelperCache()
    resolveCuHelperBinary(() => false) // prime cache to null
    await expect(callCuHelper('foo', {}, undefined, () => null)).rejects.toThrow(/not found/)
  })

  test('never falls back to a packaged nested source when standalone installation fails', async () => {
    process.env.CLAUDE_APP_ROOT =
      '/Applications/Claude Code Haha.app/Contents/Resources/app.asar'
    const nestedBinary =
      '/Applications/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/src-tauri/binaries/cc-haha-computer-use.app/Contents/MacOS/cc-haha-computer-use'
    __resetCuHelperCache()
    resolveCuHelperBinary(candidate => candidate === nestedBinary)
    let spawnCount = 0
    const exec = async () => {
      spawnCount += 1
      return { code: 0, stdout: '{"ok":true,"result":true}', stderr: '' }
    }

    await expect(
      callCuHelper('check_permissions', {}, exec as never),
    ).rejects.toThrow(/standalone installation failed/i)
    expect(spawnCount).toBe(0)
  })

  test('passes command + payload to the binary as <cmd> --payload <json>', async () => {
    primeBinary('/x/cu-helper')
    let seenArgs: string[] = []
    const exec = async (_bin: string, args: string[]) => {
      seenArgs = args
      return { code: 0, stdout: '{"ok":true,"result":true}', stderr: '' }
    }
    await callCuHelper('click', { x: 5, y: 9 }, exec as never, () => '/x/cu-helper')
    expect(seenArgs).toEqual(['click', '--payload', '{"x":5,"y":9}'])
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  __resetInstalledHelperCache,
  ensureInstalledHelper,
  installedHelperAppBundle,
  installedHelperRoot,
  isNestedInHostApp,
} from './cuHelperInstall.js'

afterEach(() => __resetInstalledHelperCache())

const INNER = path.join('Contents', 'MacOS', 'cc-haha-computer-use')

describe('isNestedInHostApp', () => {
  test('true when the helper .app sits inside an OUTER .app (packaged in the host)', () => {
    const nested =
      '/Applications/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/src-tauri/binaries/cc-haha-computer-use.app'
    expect(isNestedInHostApp(nested)).toBe(true)
  })

  test('false for a standalone path (dev build or the installed copy)', () => {
    expect(
      isNestedInHostApp('/Users/x/proj/native/cu-helper/.build/release/cc-haha-computer-use.app'),
    ).toBe(false)
    expect(isNestedInHostApp('/Users/x/.claude/cu-helper/cc-haha-computer-use.app')).toBe(false)
  })
})

describe('installedHelperAppBundle / installedHelperRoot', () => {
  test('derive <configHome>/cu-helper[/cc-haha-computer-use.app]', () => {
    expect(installedHelperRoot('/home/.claude')).toBe(path.join('/home/.claude', 'cu-helper'))
    expect(installedHelperAppBundle('/home/.claude')).toBe(
      path.join('/home/.claude', 'cu-helper', 'cc-haha-computer-use.app'),
    )
  })
})

describe('standalone helper copy command', () => {
  test('uses system ditto without quarantine metadata', async () => {
    const { __copyAppCommandForTests } = await import('./cuHelperInstall.js')
    expect(__copyAppCommandForTests('/source/helper.app', '/dest/helper.app')).toEqual({
      command: '/usr/bin/ditto',
      args: ['--noqtn', '/source/helper.app', '/dest/helper.app'],
    })
  })
})

describe('ensureInstalledHelper', () => {
  const CONFIG = '/cfg'
  const DEST_APP = path.join(CONFIG, 'cu-helper', 'cc-haha-computer-use.app')
  const DEST_INNER = path.join(DEST_APP, INNER)
  const STAGING_APP = path.join(CONFIG, 'cu-helper', '.cc-haha-computer-use.app.staging-test')
  const NESTED =
    '/Applications/Claude Code Haha.app/Contents/Resources/app.asar.unpacked/src-tauri/binaries/cc-haha-computer-use.app'
  const STANDALONE = '/dev/native/cu-helper/.build/release/cc-haha-computer-use.app'
  const BYTES = Buffer.from('helper-binary-v1')
  const HASH = createHash('sha256')
    .update(INNER).update('\0').update(BYTES).update('\0')
    .update(path.join('Contents', 'Info.plist')).update('\0').update(BYTES).update('\0')
    .update(path.join('Contents', '_CodeSignature', 'CodeResources')).update('\0').update(BYTES).update('\0')
    .digest('hex')

  /** Minimal in-memory FS over the injectable deps so the install logic runs
   *  without touching disk. `cp` flips dest into existence; `rm` clears it. */
  function fakeFs(initial: {
    destExists?: boolean
    marker?: string | null
    failCopy?: boolean
    destBytes?: Buffer
    copyCorrupt?: boolean
    signatureValid?: boolean
    copiedSignatureValid?: boolean
  } = {}) {
    const state = {
      destExists: initial.destExists ?? false,
      marker: (initial.marker ?? null) as string | null,
      destBytes: initial.destBytes ?? BYTES,
      signatureValid: initial.signatureValid ?? true,
      ops: [] as string[],
    }
    return {
      state,
      deps: {
        sourceApp: NESTED,
        configHome: CONFIG,
        exists: (p: string) => (p === DEST_INNER ? state.destExists : false),
        readFileBytes: (p: string) => p.startsWith(DEST_APP) || p.startsWith(STAGING_APP)
          ? state.destBytes
          : BYTES,
        readMarker: () => state.marker,
        copyApp: (_src: string, _dest: string) => {
          if (initial.failCopy) throw new Error('cp -R failed')
          state.ops.push('cp')
          state.destBytes = initial.copyCorrupt ? Buffer.from('corrupt') : BYTES
          state.signatureValid = initial.copiedSignatureValid ?? true
        },
        verifyPackagedSignatures: () => {
          state.ops.push('verify-signature')
          return state.signatureValid
        },
        writeMarker: (_p: string, v: string) => {
          state.ops.push('marker')
          state.marker = v
        },
        rm: (p: string) => {
          state.ops.push('rm')
          if (p === DEST_APP) state.destExists = false
        },
        mkdir: () => state.ops.push('mkdir'),
        stagingApp: STAGING_APP,
        withInstallLock: <T>(_path: string, operation: () => T) => {
          state.ops.push('lock')
          return operation()
        },
        replaceApp: () => {
          state.ops.push('replace')
          state.destExists = true
        },
      },
    }
  }

  test('returns null when no source .app resolves', () => {
    expect(ensureInstalledHelper({ sourceApp: null })).toBeNull()
  })

  test('standalone (dev) source is used IN PLACE — no copy', () => {
    let copied = false
    const r = ensureInstalledHelper({
      sourceApp: STANDALONE,
      configHome: CONFIG,
      copyApp: () => {
        copied = true
      },
    })
    expect(copied).toBe(false)
    expect(r).toEqual({ appBundle: STANDALONE, binary: path.join(STANDALONE, INNER) })
  })

  test('nested source + dest missing → copies, writes the hash marker, returns the installed path', () => {
    const { state, deps } = fakeFs({ destExists: false })
    const r = ensureInstalledHelper(deps)
    expect(state.ops).toContain('cp')
    expect(state.ops).toContain('replace')
    expect(state.marker).toBe(HASH)
    expect(r).toEqual({ appBundle: DEST_APP, binary: DEST_INNER })
  })

  test('installs and refreshes a canonical bundle through the real lock and recoverable replace path', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'cc-haha-cu-install-'))
    try {
      const sourceApp = path.join(
        tempRoot,
        'Host.app',
        'Contents',
        'Resources',
        'cc-haha-computer-use.app',
      )
      const configHome = path.join(tempRoot, 'config')
      const fixtureFiles = [
        INNER,
        path.join('Contents', 'Info.plist'),
        path.join('Contents', '_CodeSignature', 'CodeResources'),
      ]
      for (const relative of fixtureFiles) {
        const target = path.join(sourceApp, relative)
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, `signed fixture: ${relative}`)
      }

      let copyCount = 0
      const deps = {
        sourceApp,
        configHome,
        copyApp: (src: string, dest: string) => {
          copyCount += 1
          cpSync(src, dest, { recursive: true })
        },
        verifyPackagedSignatures: () => true,
      }
      const destApp = installedHelperAppBundle(configHome)
      const destInfo = path.join(destApp, 'Contents', 'Info.plist')

      expect(ensureInstalledHelper(deps)?.appBundle).toBe(destApp)
      expect(ensureInstalledHelper(deps)?.appBundle).toBe(destApp)
      expect(copyCount).toBe(1)

      writeFileSync(destInfo, 'tampered destination')
      expect(ensureInstalledHelper(deps)?.appBundle).toBe(destApp)
      expect(copyCount).toBe(2)
      expect(readFileSync(destInfo, 'utf8')).toBe(`signed fixture: ${path.join('Contents', 'Info.plist')}`)
      expect(existsSync(path.join(configHome, 'cu-helper', '.install.lock'))).toBe(false)
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test('restores the last working bundle when post-replacement verification fails', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'cc-haha-cu-rollback-'))
    try {
      const sourceApp = path.join(
        tempRoot,
        'Host.app',
        'Contents',
        'Resources',
        'cc-haha-computer-use.app',
      )
      const configHome = path.join(tempRoot, 'config')
      const destApp = installedHelperAppBundle(configHome)
      const fixtureFiles = [
        INNER,
        path.join('Contents', 'Info.plist'),
        path.join('Contents', '_CodeSignature', 'CodeResources'),
      ]
      for (const relative of fixtureFiles) {
        const source = path.join(sourceApp, relative)
        const destination = path.join(destApp, relative)
        mkdirSync(path.dirname(source), { recursive: true })
        mkdirSync(path.dirname(destination), { recursive: true })
        writeFileSync(source, `new signed fixture: ${relative}`)
        writeFileSync(destination, `last working fixture: ${relative}`)
      }

      const installed = ensureInstalledHelper({
        sourceApp,
        configHome,
        copyApp: (src, dest) => cpSync(src, dest, { recursive: true }),
        verifyPackagedSignatures: (_source, candidate) => candidate.includes('.staging-'),
      })

      expect(installed).toBeNull()
      expect(readFileSync(path.join(destApp, INNER), 'utf8'))
        .toBe(`last working fixture: ${INNER}`)
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test('nested source + dest present + marker matches → NO copy (idempotent)', () => {
    const { state, deps } = fakeFs({ destExists: true, marker: HASH })
    const r = ensureInstalledHelper(deps)
    expect(state.ops).not.toContain('cp')
    expect(state.ops.filter(op => op === 'verify-signature')).toHaveLength(1)
    expect(r).toEqual({ appBundle: DEST_APP, binary: DEST_INNER })
  })

  test('rechecks the destination after acquiring the install lock', () => {
    const { state, deps } = fakeFs({ destExists: false })
    deps.withInstallLock = <T>(_path: string, operation: () => T) => {
      state.ops.push('lock')
      state.destExists = true
      state.marker = HASH
      return operation()
    }

    expect(ensureInstalledHelper(deps)).toEqual({ appBundle: DEST_APP, binary: DEST_INNER })
    expect(state.ops).not.toContain('cp')
    expect(state.ops).not.toContain('replace')
  })

  test('matching marker does not hide destination bundle corruption', () => {
    const { state, deps } = fakeFs({
      destExists: true,
      marker: HASH,
      destBytes: Buffer.from('corrupt'),
    })
    const r = ensureInstalledHelper(deps)
    expect(state.ops).toContain('cp')
    expect(r).toEqual({ appBundle: DEST_APP, binary: DEST_INNER })
  })

  test('re-verifies and repairs a replaced destination on every launch', () => {
    const { state, deps } = fakeFs({ destExists: true, marker: HASH })
    expect(ensureInstalledHelper(deps)).toEqual({ appBundle: DEST_APP, binary: DEST_INNER })

    state.destBytes = Buffer.from('attacker-replacement')
    expect(ensureInstalledHelper(deps)).toEqual({ appBundle: DEST_APP, binary: DEST_INNER })
    expect(state.ops.filter(op => op === 'cp')).toHaveLength(1)
  })

  test('re-copies a byte-identical destination whose code signature no longer validates', () => {
    const { state, deps } = fakeFs({
      destExists: true,
      marker: HASH,
      signatureValid: false,
      copiedSignatureValid: true,
    })
    expect(ensureInstalledHelper(deps)).toEqual({ appBundle: DEST_APP, binary: DEST_INNER })
    expect(state.ops).toContain('cp')
    expect(state.ops.filter(op => op === 'verify-signature').length).toBeGreaterThanOrEqual(2)
  })

  test('nested source + dest present + marker STALE → re-copies (version refresh)', () => {
    const { state, deps } = fakeFs({ destExists: true, marker: 'an-old-hash' })
    const r = ensureInstalledHelper(deps)
    expect(state.ops).toContain('cp')
    expect(state.marker).toBe(HASH)
    expect(r).toEqual({ appBundle: DEST_APP, binary: DEST_INNER })
  })

  test('copy failure → fails closed instead of launching a nested TCC subject', () => {
    const { deps } = fakeFs({ destExists: false, failCopy: true })
    const r = ensureInstalledHelper(deps)
    expect(r).toBeNull()
  })

  test('a byte-mismatched copied bundle fails closed', () => {
    const { deps } = fakeFs({ destExists: false, copyCorrupt: true })
    expect(ensureInstalledHelper(deps)).toBeNull()
  })

  test('a copied bundle with a mismatched signer fails closed', () => {
    const { state, deps } = fakeFs({
      destExists: false,
      copiedSignatureValid: false,
    })
    expect(ensureInstalledHelper(deps)).toBeNull()
    expect(state.marker).toBeNull()
  })
})

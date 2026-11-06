import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { resolveCuHelperAppBundle } from './cuHelperBridge.js'

/**
 * Standalone install of the native `cu-helper.app`.
 *
 * WHY THIS EXISTS (the real Screen Recording root cause, proven by tccd logs):
 * macOS resolves the TCC *subject* for Screen Recording to the OUTERMOST `.app`
 * on the running binary's path. When packaged, `cc-haha-computer-use.app` is
 * NESTED inside the host Electron app (…/Contents/Resources/app.asar.unpacked/…),
 * so the helper's Screen Recording subject becomes the HOST bundle id — granting
 * the helper itself does nothing; only granting the host works. (Accessibility is
 * different: its subject is the process's own code identity = the helper, nested
 * or not.)
 *
 * The fix: COPY the helper `.app` OUT to a stable, host-independent path. A file
 * the app writes itself carries no `com.apple.quarantine` xattr, so it is NOT
 * App-Translocated to a randomized read-only mount (which would break the daemon
 * socket rendezvous) — verified on a real device. From a standalone path the
 * helper is its OWN Screen Recording subject, so the user grants the helper ONCE
 * and BOTH Screen Recording + Accessibility land on the same stable identity.
 * TCC matches the grant by the helper's certificate-based designated requirement
 * (Apple Development cert + `dev.cchaha.cu-helper`), so it survives rebuilds and
 * path changes (a fresh path immediately reads "allowed", authReason=4).
 *
 * Dev builds (`.build/release/cc-haha-computer-use.app`) are already standalone
 * (not nested), so they are used in place — no copy, no dev friction.
 */

const APP_NAME = 'cc-haha-computer-use.app'
const INNER_REL = path.join('Contents', 'MacOS', 'cc-haha-computer-use')
const HELPER_IDENTIFIER = 'dev.cchaha.cu-helper'
const SIDECAR_IDENTIFIER = 'com.claude-code-haha.desktop.sidecar'
const SIGNED_FINGERPRINT_FILES = [
  INNER_REL,
  path.join('Contents', 'Info.plist'),
  path.join('Contents', '_CodeSignature', 'CodeResources'),
] as const

export type InstalledHelper = { appBundle: string; binary: string }
export type CuHelperUnavailableReason =
  | 'helper_missing'
  | 'helper_signature_invalid'
  | 'helper_prepare_failed'

type HelperInstallResult =
  | { helper: InstalledHelper; reason: null }
  | { helper: null; reason: CuHelperUnavailableReason }

class HelperSignatureError extends Error {}

/** Stable, host-independent install root (honors CLAUDE_CONFIG_DIR via envUtils). */
export function installedHelperRoot(configHome: string = getClaudeConfigHomeDir()): string {
  return path.join(configHome, 'cu-helper')
}

/** The standalone helper `.app` bundle path. */
export function installedHelperAppBundle(configHome: string = getClaudeConfigHomeDir()): string {
  return path.join(installedHelperRoot(configHome), APP_NAME)
}

/**
 * Is `appBundle` nested inside an OUTER `.app` (i.e. shipped inside the host
 * Electron app)? True when any ancestor directory ABOVE the helper's own `.app`
 * is itself a `.app` bundle. This is what makes Screen Recording attribute to the
 * host instead of the helper, so it decides whether we relocate.
 */
export function isNestedInHostApp(appBundle: string): boolean {
  let dir = path.dirname(appBundle)
  let parent = path.dirname(dir)
  while (dir && dir !== parent) {
    if (dir.toLowerCase().endsWith('.app')) return true
    dir = parent
    parent = path.dirname(dir)
  }
  return false
}

type InstallDeps = {
  /** Source `.app` bundle. Defaults to `resolveCuHelperAppBundle()`. */
  sourceApp?: string | null
  configHome?: string
  exists?: (p: string) => boolean
  readFileBytes?: (p: string) => Buffer
  /** Copy `src` `.app` to (non-existent) `dest`; throws on failure. */
  copyApp?: (src: string, dest: string) => void
  rm?: (p: string) => void
  mkdir?: (p: string) => void
  writeMarker?: (p: string, v: string) => void
  readMarker?: (p: string) => string | null
  verifyPackagedSignatures?: (sourceApp: string, destApp: string) => boolean
  replaceApp?: (
    stagingApp: string,
    destApp: string,
    verifyInstalled: () => boolean,
  ) => void
  withInstallLock?: <T>(lockPath: string, operation: () => T) => T
  stagingApp?: string
}

/** Real-FS copy via the system `ditto --noqtn`: preserves the signed bundle and
 * explicitly strips quarantine metadata from the canonical runtime copy. */
function copyAppCommand(src: string, dest: string): {
  command: string
  args: string[]
} {
  return { command: '/usr/bin/ditto', args: ['--noqtn', src, dest] }
}

/** Focused security seam: production and the regression test share this spec. */
export function __copyAppCommandForTests(src: string, dest: string): {
  command: string
  args: string[]
} {
  return copyAppCommand(src, dest)
}

function dittoNoQuarantine(src: string, dest: string): void {
  const command = copyAppCommand(src, dest)
  const r = spawnSync(command.command, command.args, { stdio: 'ignore' })
  if (r.status !== 0) {
    throw new Error(`ditto --noqtn failed (status ${String(r.status)}): ${r.error?.message ?? 'unknown'}`)
  }
}

function withExclusiveInstallLock<T>(lockPath: string, operation: () => T): T {
  const deadline = Date.now() + 5_000
  const ownerToken = `${process.pid}:${Date.now()}:${randomUUID()}`
  let descriptor: number | null = null
  while (descriptor === null) {
    try {
      descriptor = openSync(lockPath, 'wx', 0o600)
      writeFileSync(descriptor, `${ownerToken}\n`, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      try {
        const oldEnough = Date.now() - statSync(lockPath).mtimeMs > 30_000
        const ownerText = readFileSync(lockPath, 'utf8').trim()
        const ownerPid = Number.parseInt(ownerText.split(':', 1)[0] ?? '', 10)
        let ownerAlive = Number.isFinite(ownerPid) && ownerPid > 0
        if (ownerAlive) {
          try {
            process.kill(ownerPid, 0)
          } catch (probeError) {
            ownerAlive = (probeError as NodeJS.ErrnoException).code === 'EPERM'
          }
        }
        if (oldEnough && !ownerAlive) {
          // Rename the stale inode out of the lock path atomically. Competing
          // recoverers can no longer unlink a fresh lock acquired afterward.
          const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`
          renameSync(lockPath, stalePath)
          rmSync(stalePath, { force: true })
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw new Error('timed out waiting for the cu-helper install lock')
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  try {
    return operation()
  } finally {
    closeSync(descriptor)
    try {
      // Only remove the lock inode we created. If an external repair replaced
      // the path, leave its owner's lock intact.
      if (readFileSync(lockPath, 'utf8').trim() === ownerToken) unlinkSync(lockPath)
    } catch {}
  }
}

function replaceAppRecoverably(
  stagingApp: string,
  destApp: string,
  verifyInstalled: () => boolean,
): void {
  const backupApp = `${destApp}.previous-${process.pid}`
  rmSync(backupApp, { recursive: true, force: true })
  const hadDestination = existsSync(destApp)
  if (hadDestination) renameSync(destApp, backupApp)
  try {
    renameSync(stagingApp, destApp)
    if (!verifyInstalled()) {
      throw new Error('installed cu-helper failed post-replacement verification')
    }
    rmSync(backupApp, { recursive: true, force: true })
  } catch (error) {
    rmSync(destApp, { recursive: true, force: true })
    if (hadDestination && existsSync(backupApp)) {
      renameSync(backupApp, destApp)
    }
    throw error
  }
}

function signedBundleFingerprint(
  appBundle: string,
  readBytes: (path: string) => Buffer,
): string {
  const hash = createHash('sha256')
  for (const relative of SIGNED_FINGERPRINT_FILES) {
    hash.update(relative)
    hash.update('\0')
    hash.update(readBytes(path.join(appBundle, relative)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

type CodeIdentity = {
  identifier?: string
  authority?: string
  team?: string
  leaf?: string
}

function codesignOutput(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' })
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

function leafCertificateFingerprint(target: string): string | undefined {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'cc-haha-cu-signature-'))
  try {
    const prefix = path.join(tempRoot, 'cert-')
    const extracted = codesignOutput([
      '-d', `--extract-certificates=${prefix}`, target,
    ])
    if (!extracted.ok) return undefined
    return createHash('sha256').update(readFileSync(`${prefix}0`)).digest('hex')
  } catch {
    return undefined
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function codeIdentity(target: string): CodeIdentity | null {
  const details = codesignOutput(['-dv', '--verbose=4', target])
  if (!details.ok) return null
  const rawTeam = details.output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim()
  return {
    identifier: details.output.match(/^Identifier=(.+)$/m)?.[1]?.trim(),
    authority: details.output.match(/^Authority=(.+)$/m)?.[1]?.trim(),
    team: rawTeam && rawTeam !== 'not set' ? rawTeam : undefined,
    leaf: leafCertificateFingerprint(target),
  }
}

function sameSigner(left: CodeIdentity, right: CodeIdentity): boolean {
  return Boolean(left.authority && left.team && left.leaf)
    && left.authority === right.authority
    && left.team === right.team
    && left.leaf === right.leaf
}

/**
 * Verify the whole signed install unit and pin it to the currently executing
 * packaged sidecar. Package smoke enforces the same invariant at build time;
 * this check repeats it immediately before each runtime launch because the
 * standalone TCC copy lives in a user-writable directory.
 */
function verifyPackagedHelperSignatures(sourceApp: string, destApp: string): boolean {
  if (process.platform !== 'darwin') return false
  const sourceStrict = codesignOutput([
    '--verify', '--deep', '--strict', '--verbose=2', sourceApp,
  ]).ok
  const destStrict = codesignOutput([
    '--verify', '--deep', '--strict', '--verbose=2', destApp,
  ]).ok
  const sidecarStrict = codesignOutput([
    '--verify', '--strict', '--verbose=2', process.execPath,
  ]).ok
  if (!sourceStrict || !destStrict || !sidecarStrict) return false

  const source = codeIdentity(sourceApp)
  const dest = codeIdentity(destApp)
  const sidecar = codeIdentity(process.execPath)
  return Boolean(
    source
      && dest
      && sidecar
      && source.identifier === HELPER_IDENTIFIER
      && dest.identifier === HELPER_IDENTIFIER
      && sidecar.identifier === SIDECAR_IDENTIFIER
      && sameSigner(source, dest)
      && sameSigner(source, sidecar),
  )
}

/**
 * Ensure a launch-ready cu-helper `.app` at a stable standalone path and return
 * `{ appBundle, binary }`. Idempotent + version-aware (re-copies only when the
 * source binary's hash differs from the installed marker). Returns the source in
 * place for dev/standalone builds. A packaged nested helper MUST be relocated;
 * if that fails we return `null` instead of launching the nested copy, because
 * macOS would attribute Screen Recording to the outer Electron app and the
 * helper's apparently-granted TCC row would be ineffective.
 *
 * Successful resolutions are deliberately not cached: the standalone copy is
 * user-writable, so every launch must re-check both its sealed bytes and exact
 * signer against the packaged source and current sidecar.
 */
export function ensureInstalledHelper(deps: InstallDeps = {}): InstalledHelper | null {
  return prepareInstalledHelper(deps).helper
}

/** Preserve a safe failure category for status without exposing paths or raw errors. */
export function prepareInstalledHelper(deps: InstallDeps = {}): HelperInstallResult {
  const exists = deps.exists ?? existsSync
  const sourceApp = deps.sourceApp !== undefined ? deps.sourceApp : resolveCuHelperAppBundle()
  if (!sourceApp) return { helper: null, reason: 'helper_missing' }
  const sourceInner = path.join(sourceApp, INNER_REL)

  // Dev / already-standalone: not nested in a host `.app` → its SR subject is
  // already the helper itself, so use it in place (no copy, no dev friction).
  if (!isNestedInHostApp(sourceApp)) {
    return { helper: { appBundle: sourceApp, binary: sourceInner }, reason: null }
  }

  // Packaged: relocate OUT of the host bundle to a stable standalone path.
  try {
    const configHome = deps.configHome ?? getClaudeConfigHomeDir()
    const root = installedHelperRoot(configHome)
    const destApp = installedHelperAppBundle(configHome)
    const destInner = path.join(destApp, INNER_REL)
    const markerPath = path.join(root, '.installed-version')

    const readBytes = deps.readFileBytes ?? ((p) => readFileSync(p))
    const verifySignatures = deps.verifyPackagedSignatures
      ?? verifyPackagedHelperSignatures
    const readMarker =
      deps.readMarker ??
      ((p) => {
        try {
          return readFileSync(p, 'utf8').trim()
        } catch {
          return null
        }
      })
    // The whole signed bundle is the install unit. Hash the executable,
    // Info.plist, and CodeResources seal so resource/permission-description
    // changes and destination corruption cannot hide behind an unchanged Mach-O.
    const srcHash = signedBundleFingerprint(sourceApp, readBytes)

    let destinationVerified = false
    const verifyDestination = () => {
      if (!exists(destInner) || readMarker(markerPath) !== srcHash) return false
      try {
        const fingerprintMatches = signedBundleFingerprint(destApp, readBytes) === srcHash
        destinationVerified = fingerprintMatches
          && verifySignatures(sourceApp, destApp)
        return fingerprintMatches && destinationVerified
      } catch {
        destinationVerified = false
        return false
      }
    }
    const upToDate = verifyDestination()
    if (!upToDate) {
      const rm = deps.rm ?? ((p) => rmSync(p, { recursive: true, force: true }))
      const mkdir = deps.mkdir ?? ((p) => mkdirSync(p, { recursive: true, mode: 0o700 }))
      const copyApp = deps.copyApp ?? dittoNoQuarantine
      const writeMarker = deps.writeMarker ?? ((p, v) => writeFileSync(p, `${v}\n`, 'utf8'))
      const replaceApp = deps.replaceApp ?? replaceAppRecoverably
      const withInstallLock = deps.withInstallLock ?? withExclusiveInstallLock
      const stagingApp = deps.stagingApp
        ?? path.join(root, `.${APP_NAME}.staging-${process.pid}`)
      mkdir(root)
      withInstallLock(path.join(root, '.install.lock'), () => {
        // Another sidecar may have completed the same install while this one
        // waited. Re-check under the cross-process lock before copying.
        if (verifyDestination()) return
        rm(stagingApp)
        try {
          copyApp(sourceApp, stagingApp)
          if (signedBundleFingerprint(stagingApp, readBytes) !== srcHash) {
            throw new Error('copied cu-helper bundle fingerprint does not match source')
          }
          if (!verifySignatures(sourceApp, stagingApp)) {
            throw new HelperSignatureError('copied cu-helper signature does not match the packaged sidecar')
          }
          const verifyInstalled = () => {
            try {
              if (signedBundleFingerprint(destApp, readBytes) !== srcHash) return false
            } catch {
              return false
            }
            if (!verifySignatures(sourceApp, destApp)) {
              throw new HelperSignatureError('installed cu-helper signature does not match the packaged sidecar')
            }
            return true
          }
          replaceApp(stagingApp, destApp, verifyInstalled)
          destinationVerified = verifyInstalled()
          if (!destinationVerified) {
            throw new Error('installed cu-helper bundle fingerprint does not match source')
          }
          writeMarker(markerPath, srcHash)
          logForDebugging(`installed cu-helper to standalone path: ${destApp}`, { level: 'debug' })
        } finally {
          rm(stagingApp)
        }
      })
    }
    if (exists(destInner) && destinationVerified) {
      return { helper: { appBundle: destApp, binary: destInner }, reason: null }
    }
    throw new Error('installed cu-helper is missing or failed verification')
  } catch (err) {
    logForDebugging(
      `cu-helper standalone install failed; refusing nested helper because Screen Recording would target the host: ${String(err)}`,
      { level: 'error' },
    )
    return {
      helper: null,
      reason: err instanceof HelperSignatureError ? 'helper_signature_invalid' : 'helper_prepare_failed',
    }
  }
}

/** Test hook: clear the cached install resolution. */
export function __resetInstalledHelperCache(): void {
  // Kept for compatibility with focused tests; successful installs are no
  // longer cached, so there is no mutable module state to reset.
}

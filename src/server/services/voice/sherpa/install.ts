/**
 * Installs a local model (sherpa-onnx runtime, model files and VAD) into its data directory.
 *
 * Every item is downloaded with resume/retry/mirror fallback, verified against
 * its pinned digest, and only then recorded in `verified.json`. Readiness is a
 * cheap check against that record, so nothing is re-hashed on startup.
 */
import { spawn } from 'node:child_process'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import {
  VoiceDownloadError,
  classifyError,
  downloadAsset,
  partPathFor,
  type DownloadOptions,
} from '../download/index.js'
import type { VoicePreparationState } from '../types.js'
import { totalDownloadBytes, type InstallItem } from './assets.js'
import {
  itemDownloadPath,
  itemManifestName,
  itemPath,
  itemProofPath,
  type ModelLayout,
} from './layout.js'
import {
  describeFile,
  forgetVerified,
  hashFile,
  matchesRecord,
  readManifest,
  recordVerified,
} from './manifest.js'

export type ExtractArchive = (input: {
  /** Working directory; both paths below are relative to it and use forward slashes. */
  cwd: string
  archive: string
  into: string
  signal: AbortSignal
}) => Promise<void>

export interface InstallContext {
  layout: ModelLayout
  items: InstallItem[]
  download: DownloadOptions
  extract?: ExtractArchive
}

function toPosix(path: string): string {
  return path.split(/[\\/]/).join('/')
}

/** Extracts an npm tarball, dropping its leading `package/` directory, using the system `tar`. */
export const extractWithSystemTar: ExtractArchive = ({ cwd, archive, into, signal }) =>
  new Promise((resolve, reject) => {
    // Relative paths keep GNU tar on Windows from reading `C:\...` as a remote host.
    const child = spawn('tar', ['-xzf', archive, '-C', into, '--strip-components=1'], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000) })
    const abort = (): void => {
      child.kill('SIGKILL')
      reject(signal.reason)
    }
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', error => {
      signal.removeEventListener('abort', abort)
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      reject(new VoiceDownloadError({
        reason: 'storage',
        resource: archive,
        message: missing ? 'The system "tar" command is required to unpack the speech runtime' : error.message,
      }, { cause: error }))
    })
    child.once('exit', code => {
      signal.removeEventListener('abort', abort)
      if (code === 0) resolve()
      else {
        reject(new VoiceDownloadError({
          reason: 'storage',
          resource: archive,
          message: `Could not unpack ${archive} (tar exit ${code}): ${stderr.trim()}`,
        }))
      }
    })
  })

async function installPackage(
  ctx: InstallContext,
  item: InstallItem,
  archivePath: string,
  signal: AbortSignal,
): Promise<void> {
  const { layout } = ctx
  const staging = join(layout.staging, item.target)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    await (ctx.extract ?? extractWithSystemTar)({
      cwd: layout.base,
      archive: toPosix(relative(layout.base, archivePath)),
      into: toPosix(relative(layout.base, staging)),
      signal,
    })
    const marker = await stat(join(staging, item.marker!)).catch(() => undefined)
    if (!marker?.isFile()) {
      throw new VoiceDownloadError({
        reason: 'integrity',
        resource: item.asset.name,
        message: `${item.asset.name} does not contain ${item.marker}`,
      })
    }
    const destination = itemPath(layout, item)
    await rm(destination, { recursive: true, force: true })
    await mkdir(dirname(destination), { recursive: true })
    await rename(staging, destination)
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
  await rm(archivePath, { force: true }).catch(() => {})
}

/** True when every item is recorded as verified and its file still matches the record. */
export async function isInstalled(layout: ModelLayout, items: InstallItem[]): Promise<boolean> {
  const recorded = new Map((await readManifest(layout.manifest)).map(file => [file.name, file]))
  for (const item of items) {
    const entry = recorded.get(itemManifestName(layout, item))
    const expectedBytes = item.kind === 'file' ? item.asset.bytes : undefined
    if (!await matchesRecord(entry, itemProofPath(layout, item), expectedBytes)) return false
  }
  return true
}

/** Bytes present on disk (installed items plus partial downloads), for resume hints. */
export async function bytesOnDisk(layout: ModelLayout, items: InstallItem[]): Promise<number> {
  const recorded = new Map((await readManifest(layout.manifest)).map(file => [file.name, file]))
  let total = 0
  for (const item of items) {
    const entry = recorded.get(itemManifestName(layout, item))
    if (await matchesRecord(entry, itemProofPath(layout, item), item.kind === 'file' ? item.asset.bytes : undefined)) {
      total += item.asset.bytes
      continue
    }
    total += await stat(partPathFor(itemDownloadPath(layout, item))).then(info => info.size, () => 0)
  }
  return total
}

type Report = (state: VoicePreparationState) => void

/** Installs whatever is missing. Throws VoiceDownloadError on failure; abort errors pass through. */
export async function installAll(ctx: InstallContext, signal: AbortSignal, report: Report): Promise<void> {
  const { layout, items } = ctx
  const totalBytes = totalDownloadBytes(items)
  const recorded = new Map((await readManifest(layout.manifest)).map(file => [file.name, file]))
  let base = 0

  for (const item of items) {
    signal.throwIfAborted()
    const name = itemManifestName(layout, item)
    const proof = itemProofPath(layout, item)
    const expectedBytes = item.kind === 'file' ? item.asset.bytes : undefined
    const current = { step: item.step, resource: item.asset.name } as const

    if (await matchesRecord(recorded.get(name), proof, expectedBytes)) {
      base += item.asset.bytes
      continue
    }

    // A complete file from a run that died before it could be recorded only needs its digest checked.
    if (item.kind === 'file' && await stat(proof).then(info => info.size === item.asset.bytes, () => false)) {
      report({ phase: 'verifying', ...current, completedBytes: base, totalBytes })
      if (await hashFile(proof) === item.asset.hash.value) {
        await recordVerified(layout.manifest, [await describeFile(name, proof, item.asset.hash.value)])
        base += item.asset.bytes
        continue
      }
      await rm(proof, { force: true })
    }

    report({ phase: 'downloading', ...current, completedBytes: base, totalBytes })
    await downloadAsset(item.asset, itemDownloadPath(layout, item), {
      ...ctx.download,
      signal,
      onProgress: progress => {
        report({
          phase: 'downloading',
          ...current,
          completedBytes: base + progress.completedBytes,
          totalBytes,
          source: progress.source,
          ...(progress.resumedFromBytes !== undefined ? { resumedFromBytes: base + progress.resumedFromBytes } : {}),
        })
      },
    })

    if (item.kind === 'package') {
      report({ phase: 'verifying', ...current, completedBytes: base + item.asset.bytes, totalBytes })
      await installPackage(ctx, item, itemDownloadPath(layout, item), signal)
      await recordVerified(layout.manifest, [await describeFile(name, proof)])
    } else {
      await recordVerified(layout.manifest, [await describeFile(name, proof, item.asset.hash.value)])
    }
    base += item.asset.bytes
  }

  report({ phase: 'verifying', step: 'verify', completedBytes: totalBytes, totalBytes })
  if (!await isInstalled(layout, items)) {
    throw new VoiceDownloadError({
      reason: 'integrity',
      message: 'Installed speech files did not pass the final check',
    })
  }
}

export async function removeInstall(layout: ModelLayout): Promise<void> {
  await forgetVerified(layout.manifest)
  await rm(layout.base, { recursive: true, force: true })
}

/** Converts any thrown value into the failure state shown to the user. */
export function failureState(
  error: unknown,
  fallback: Pick<VoicePreparationState, 'step' | 'resource' | 'completedBytes' | 'totalBytes'>,
): VoicePreparationState {
  const failure = error instanceof VoiceDownloadError
    ? error.failure
    : {
        reason: classifyError(error),
        message: error instanceof Error ? error.message : String(error),
      }
  return {
    phase: 'failed',
    ...fallback,
    ...(failure.source ? { source: failure.source } : {}),
    error: failure,
  }
}

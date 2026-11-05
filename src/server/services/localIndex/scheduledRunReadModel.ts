import * as fs from 'node:fs/promises'
import * as crypto from 'node:crypto'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import {
  openScheduledRunIndex,
  type ScheduledRunIndex,
  type ScheduledRunRecord,
  type ScheduledRunSummary,
} from './scheduledRunIndex.js'
import {
  deserializeSourceFingerprint,
  serializeSourceFingerprint,
  type SourceFingerprint,
} from './sourceFingerprint.js'
import { resolveLocalIndexMode } from './config.js'

type PageOptions = {
  taskId?: string
  limit?: number
  cursor?: string
  summaryOnly?: boolean
  nonterminalOnly?: boolean
  completedAfterMs?: number
}

export type ScheduledRunPage = {
  runs: Array<ScheduledRunRecord | ScheduledRunSummary>
  nextCursor?: string
  revision: number
  revisionToken: string
  reset?: boolean
}

export type ScheduledRunReadModelTarget = {
  scope: string
  sourcePath: string
  databasePath: string
}

let active: (ScheduledRunReadModelTarget & { index: ScheduledRunIndex }) | null = null
let projectionQueue = Promise.resolve()
let canonicalReadCount = 0
let rebuildCount = 0
let projectionBeforeCommitHookForTests: (() => Promise<void>) | null = null
let fingerprintAfterInitialStatHookForTests: (() => Promise<void>) | null = null
const latestProjectionGeneration = new Map<string, number>()
const busyCooldownUntil = new Map<string, number>()

const SCHEDULED_RUN_PARSER_VERSION = 1
const FINGERPRINT_WINDOW_BYTES = 64 * 1024
const SCHEDULED_RUN_FINGERPRINT_PREFIX = 'cc-haha-scheduled-run-fingerprint:v1:'

type SourceStats = Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs' | 'dev' | 'ino'>

type CanonicalSnapshot = {
  bytes: Buffer
  fingerprint: SourceFingerprint
  ctimeMs: number
  fingerprintJson: string
}

const SCHEDULED_RUN_BUSY_COOLDOWN_MS = 5_000

function targetKey(target: ScheduledRunReadModelTarget): string {
  return `${target.databasePath}\0${target.sourcePath}`
}

export function captureScheduledRunReadModelTarget(
  sourcePath: string,
): ScheduledRunReadModelTarget {
  const scope = getClaudeConfigHomeDir()
  return {
    scope,
    sourcePath,
    databasePath: join(scope, 'cc-haha', 'db', 'scheduled-runs-v1.sqlite'),
  }
}

function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && (
    code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')
  )
}

function enterBusyCooldown(target: ScheduledRunReadModelTarget): void {
  busyCooldownUntil.set(
    target.databasePath,
    Date.now() + SCHEDULED_RUN_BUSY_COOLDOWN_MS,
  )
  if (active?.databasePath === target.databasePath) {
    const previous = active
    active = null
    try { previous.index.close() } catch {}
  }
}

function fileIdentity(stats: Pick<Stats, 'dev' | 'ino'>): string | null {
  if (process.platform === 'win32' || stats.ino === 0) return null
  return `${stats.dev}:${stats.ino}`
}

function sameSnapshot(left: SourceStats, right: SourceStats): boolean {
  const leftIdentity = fileIdentity(left)
  const rightIdentity = fileIdentity(right)
  return left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    (leftIdentity === null || rightIdentity === null || leftIdentity === rightIdentity)
}

function serializeScheduledRunFingerprint(
  fingerprint: SourceFingerprint,
  ctimeMs: number,
): string {
  return `${SCHEDULED_RUN_FINGERPRINT_PREFIX}${Buffer.from(JSON.stringify([
    serializeSourceFingerprint(fingerprint),
    ctimeMs,
  ])).toString('base64url')}`
}

function deserializeScheduledRunFingerprint(value: string): {
  fingerprint: SourceFingerprint
  ctimeMs: number
} | null {
  if (!value.startsWith(SCHEDULED_RUN_FINGERPRINT_PREFIX)) return null
  try {
    const parsed = JSON.parse(Buffer.from(
      value.slice(SCHEDULED_RUN_FINGERPRINT_PREFIX.length),
      'base64url',
    ).toString('utf8')) as unknown
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'number' ||
      !Number.isFinite(parsed[1])
    ) return null
    const fingerprint = deserializeSourceFingerprint(parsed[0])
    return fingerprint ? { fingerprint, ctimeMs: parsed[1] } : null
  } catch {
    return null
  }
}

async function verifyScheduledRunFingerprint(
  sourcePath: string,
  expected: { fingerprint: SourceFingerprint; ctimeMs: number },
): Promise<boolean> {
  const handle = await fs.open(sourcePath, 'r')
  try {
    const before = await handle.stat()
    if (
      before.ctimeMs !== expected.ctimeMs ||
      before.size !== expected.fingerprint.size ||
      before.mtimeMs !== expected.fingerprint.mtimeMs ||
      expected.fingerprint.parserVersion !== SCHEDULED_RUN_PARSER_VERSION
    ) return false
    const expectedIdentity = expected.fingerprint.fileIdentity
    const currentIdentity = fileIdentity(before)
    if (
      expectedIdentity !== null &&
      currentIdentity !== null &&
      expectedIdentity !== currentIdentity
    ) return false

    await fingerprintAfterInitialStatHookForTests?.()
    const firstWindowHash = await hashHandleWindow(
      handle,
      Math.min(FINGERPRINT_WINDOW_BYTES, before.size),
    )
    const lastWindowHash = await hashHandleWindow(handle, before.size)
    const boundaryWindowHash = await hashHandleWindow(
      handle,
      expected.fingerprint.indexedBytes,
    )
    const after = await handle.stat()
    const currentPath = await fs.stat(sourcePath)
    if (!sameSnapshot(before, after) || !sameSnapshot(after, currentPath)) return false
    return firstWindowHash === expected.fingerprint.firstWindowHash &&
      lastWindowHash === expected.fingerprint.lastWindowHash &&
      boundaryWindowHash === expected.fingerprint.boundaryWindowHash
  } finally {
    await handle.close()
  }
}

async function hashHandleWindow(
  handle: Awaited<ReturnType<typeof fs.open>>,
  end: number,
): Promise<string> {
  const length = Math.min(FINGERPRINT_WINDOW_BYTES, end)
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const chunk = await handle.read(buffer, offset, length - offset, end - length + offset)
    if (chunk.bytesRead === 0) return ''
    offset += chunk.bytesRead
  }
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function hashWindow(bytes: Buffer, end: number): string {
  const length = Math.min(FINGERPRINT_WINDOW_BYTES, end)
  return crypto.createHash('sha256')
    .update(bytes.subarray(end - length, end))
    .digest('hex')
}

function fingerprintFromSnapshot(bytes: Buffer, stats: SourceStats): SourceFingerprint {
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    fileIdentity: fileIdentity(stats),
    firstWindowHash: hashWindow(bytes, Math.min(FINGERPRINT_WINDOW_BYTES, bytes.length)),
    lastWindowHash: hashWindow(bytes, bytes.length),
    boundaryWindowHash: hashWindow(bytes, bytes.length),
    indexedBytes: bytes.length,
    parserVersion: SCHEDULED_RUN_PARSER_VERSION,
  }
}

async function captureCanonicalSnapshot(
  sourcePath: string,
  expectedSerialized?: string,
): Promise<CanonicalSnapshot | null> {
  const expectedBytes = expectedSerialized === undefined
    ? null
    : Buffer.from(expectedSerialized)
  const handle = await fs.open(sourcePath, 'r')
  try {
    const before = await handle.stat()
    const bytes = await handle.readFile()
    const after = await handle.stat()
    const currentPath = await fs.stat(sourcePath)
    if (
      !sameSnapshot(before, after) ||
      !sameSnapshot(after, currentPath) ||
      before.size !== bytes.length ||
      (expectedBytes !== null && !bytes.equals(expectedBytes))
    ) {
      return null
    }
    const fingerprint = fingerprintFromSnapshot(bytes, before)
    return {
      bytes,
      fingerprint,
      ctimeMs: before.ctimeMs,
      fingerprintJson: serializeScheduledRunFingerprint(fingerprint, before.ctimeMs),
    }
  } finally {
    await handle.close()
  }
}

function getIndex(target: ScheduledRunReadModelTarget): ScheduledRunIndex | null {
  if ((busyCooldownUntil.get(target.databasePath) ?? 0) > Date.now()) return null
  if (
    active?.sourcePath === target.sourcePath &&
    active.databasePath === target.databasePath
  ) return active.index
  active?.index.close()
  active = null
  try {
    const index = openScheduledRunIndex({
      path: target.databasePath,
      scope: target.scope,
    })
    active = { ...target, index }
    return index
  } catch (error) {
    if (isSqliteBusy(error)) enterBusyCooldown(target)
    throw error
  }
}

async function replaceFromSnapshot(
  target: ScheduledRunReadModelTarget,
  snapshot: CanonicalSnapshot,
  runs: ScheduledRunRecord[],
): Promise<boolean> {
  const index = getIndex(target)
  if (!index) return false
  const current = index.getStatus()
  if (
    current.state === 'ready' &&
    current.sourcePath === target.sourcePath &&
    current.sourceFingerprint === snapshot.fingerprintJson
  ) {
    return false
  }
  rebuildCount += 1
  index.replaceAll({
    runs,
    source: {
      path: target.sourcePath,
      size: snapshot.fingerprint.size,
      mtimeMs: snapshot.fingerprint.mtimeMs,
      fingerprint: snapshot.fingerprintJson,
    },
  })
  return true
}

/**
 * Called only after the canonical rename succeeds. The queue preserves write
 * order while callers deliberately ignore failures: JSON remains authoritative.
 */
export function projectScheduledRunsAfterCanonicalWrite(
  sourcePath: string,
  serialized: string,
  runs: ScheduledRunRecord[],
  capturedTarget = captureScheduledRunReadModelTarget(sourcePath),
): Promise<void> {
  if (resolveLocalIndexMode().mode === 'off') return Promise.resolve()
  const projectionKey = targetKey(capturedTarget)
  const generation = (latestProjectionGeneration.get(projectionKey) ?? 0) + 1
  latestProjectionGeneration.set(projectionKey, generation)
  const project = async () => {
    try {
      if (resolveLocalIndexMode().mode === 'off') return
      const snapshot = await captureCanonicalSnapshot(
        capturedTarget.sourcePath,
        serialized,
      )
      if (
        resolveLocalIndexMode().mode === 'off' ||
        !snapshot ||
        latestProjectionGeneration.get(projectionKey) !== generation
      ) return
      await projectionBeforeCommitHookForTests?.()
      if (
        resolveLocalIndexMode().mode === 'off' ||
        latestProjectionGeneration.get(projectionKey) !== generation
      ) return
      if (!await verifyScheduledRunFingerprint(capturedTarget.sourcePath, snapshot)) return
      if (
        resolveLocalIndexMode().mode === 'off' ||
        latestProjectionGeneration.get(projectionKey) !== generation
      ) return
      await replaceFromSnapshot(capturedTarget, snapshot, runs)
    } catch (error) {
      if (isSqliteBusy(error)) enterBusyCooldown(capturedTarget)
      if (resolveLocalIndexMode().mode !== 'off') {
        try {
          if (active?.databasePath === capturedTarget.databasePath) {
            active.index.markDegraded('SCHEDULED_RUN_INDEX_WRITE_FAILED')
          }
        } catch {}
      }
      throw error
    }
  }
  const result = projectionQueue.then(project, project)
  projectionQueue = result.catch(() => {})
  return result
}

export function deactivateScheduledRunReadModel(sourcePath: string): void {
  for (const [key, generation] of latestProjectionGeneration) {
    if (key.endsWith(`\0${sourcePath}`)) {
      latestProjectionGeneration.set(key, generation + 1)
    }
  }
  const previous = active
  active = null
  try { previous?.index.close() } catch {}
}

/**
 * Returns null when the disposable projection is unavailable, instructing the
 * caller to use its existing canonical-file implementation.
 */
export async function readScheduledRunPage(
  sourcePath: string,
  options: PageOptions = {},
): Promise<ScheduledRunPage | null> {
  if (!options.summaryOnly) return null
  const target = captureScheduledRunReadModelTarget(sourcePath)
  try {
    const index = getIndex(target)
    if (!index) return null
    const status = index.getStatus()
    const previousFingerprint = deserializeScheduledRunFingerprint(status.sourceFingerprint)
    const verification = status.state === 'ready' &&
      status.sourcePath === sourcePath &&
      previousFingerprint !== null
      ? await verifyScheduledRunFingerprint(sourcePath, previousFingerprint)
      : null

    // Warm polls verify bounded source windows but never parse canonical JSON.
    if (verification !== true) {
      const snapshot = await captureCanonicalSnapshot(sourcePath)
      if (!snapshot) return null
      canonicalReadCount += 1
      const parsed = JSON.parse(snapshot.bytes.toString('utf8')) as { runs?: ScheduledRunRecord[] }
      if (!Array.isArray(parsed.runs)) return null
      await replaceFromSnapshot(target, snapshot, parsed.runs)
    }

    return index.list(options)
  } catch (error) {
    if (isSqliteBusy(error)) enterBusyCooldown(target)
    try {
      if (active?.databasePath === target.databasePath) {
        active.index.markDegraded('SCHEDULED_RUN_INDEX_READ_FAILED')
      }
    } catch {}
    return null
  }
}

export function markScheduledRunIndexDegraded(
  sourcePath: string,
  errorCode: string,
): void {
  if (active?.sourcePath !== sourcePath) return
  try { active.index.markDegraded(errorCode) } catch {}
}

export async function stopScheduledRunReadModel(): Promise<void> {
  await projectionQueue
  active?.index.close()
  active = null
}

export async function resetScheduledRunReadModelForTests(): Promise<void> {
  await stopScheduledRunReadModel()
  projectionQueue = Promise.resolve()
  canonicalReadCount = 0
  rebuildCount = 0
  latestProjectionGeneration.clear()
  busyCooldownUntil.clear()
  projectionBeforeCommitHookForTests = null
  fingerprintAfterInitialStatHookForTests = null
}

export function setScheduledRunProjectionBeforeCommitHookForTests(
  hook: (() => Promise<void>) | null,
): void {
  projectionBeforeCommitHookForTests = hook
}

export function setScheduledRunFingerprintAfterInitialStatHookForTests(
  hook: (() => Promise<void>) | null,
): void {
  fingerprintAfterInitialStatHookForTests = hook
}

export function getScheduledRunReadModelDiagnosticsForTests(): {
  canonicalReadCount: number
  rebuildCount: number
} {
  return { canonicalReadCount, rebuildCount }
}

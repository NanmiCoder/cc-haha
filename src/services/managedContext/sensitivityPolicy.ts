/** §8.4 / M8 sensitivity policy: persist-before-dispatch and fail closed. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { getCcHahaDir } from '../../utils/envUtils.js'

export type SensitivityMarkReason = 'secret-bearing-context-dispatched'

export type SensitivityMark = {
  reason: SensitivityMarkReason
  markedAt: string
}

type PersistedSensitivityMark = SensitivityMark & {
  schemaVersion: 1
  sessionId: string
}

const marks = new Map<string, SensitivityMark>()
let ignoreDiskForTests = false

function markFilePath(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex')
  return join(getCcHahaDir(), 'sensitive-sessions-v1', `${digest}.json`)
}

function failClosedMark(): SensitivityMark {
  return { reason: 'secret-bearing-context-dispatched', markedAt: '1970-01-01T00:00:00.000Z' }
}

function readDurableMark(sessionId: string): SensitivityMark | null {
  const cached = marks.get(sessionId)
  if (cached) return cached
  if (ignoreDiskForTests || sessionId.length === 0) return null
  try {
    const parsed = JSON.parse(readFileSync(markFilePath(sessionId), 'utf8')) as Partial<PersistedSensitivityMark>
    if (
      parsed.schemaVersion !== 1 ||
      parsed.sessionId !== sessionId ||
      parsed.reason !== 'secret-bearing-context-dispatched' ||
      typeof parsed.markedAt !== 'string'
    ) {
      const mark = failClosedMark()
      marks.set(sessionId, mark)
      return mark
    }
    const mark = { reason: parsed.reason, markedAt: parsed.markedAt } satisfies SensitivityMark
    marks.set(sessionId, mark)
    return mark
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    const mark = failClosedMark()
    marks.set(sessionId, mark)
    return mark
  }
}

/**
 * Persist the monotonic sensitivity mark before a secret-bearing turn may be
 * reserved/dispatched. One immutable file per session avoids replace races on
 * Windows. The filename is a SHA-256 of the session id; no secret is persisted.
 */
export async function persistSessionSensitive(
  sessionId: string,
  reason: SensitivityMarkReason = 'secret-bearing-context-dispatched',
  markedAt: string = new Date().toISOString(),
): Promise<void> {
  if (!sessionId) throw new Error('sessionId is required for sensitivity persistence')
  ignoreDiskForTests = false
  const existing = readDurableMark(sessionId)
  if (existing) return

  const filePath = markFilePath(sessionId)
  await mkdir(join(getCcHahaDir(), 'sensitive-sessions-v1'), { recursive: true })
  let handle
  try {
    handle = await open(filePath, 'wx', 0o600)
    const record: PersistedSensitivityMark = { schemaVersion: 1, sessionId, reason, markedAt }
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }

  const durable = readDurableMark(sessionId)
  if (!durable) throw new Error('Sensitivity policy did not persist')
  marks.set(sessionId, durable)
}

/**
 * The only classification input: the manifest's own counters. A public
 * manifest with `containsSecrets: false, secretFieldCount: 0` can never mark a
 * session, which is what keeps the plain managed-context path non-sensitive.
 */
export function isSecretBearingStagedContext(manifest: {
  containsSecrets: boolean
  secretFieldCount: number
}): boolean {
  return manifest.containsSecrets === true || manifest.secretFieldCount > 0
}

/** Monotonic: the first mark wins, later dispatches keep the earliest reason. */
export function markSessionSensitive(
  sessionId: string,
  reason: SensitivityMarkReason = 'secret-bearing-context-dispatched',
  markedAt: string = new Date().toISOString(),
): void {
  if (sessionId.length === 0 || marks.has(sessionId)) return
  marks.set(sessionId, { reason, markedAt })
}

export function isSessionSensitivityMarked(sessionId: string): boolean {
  return readDurableMark(sessionId) !== null
}

export function describeSensitivityMark(sessionId: string): SensitivityMark | null {
  return readDurableMark(sessionId)
}

/** The single decision the capture surfaces below share. */
export function shouldSuppressContentCapture(sessionId: string): boolean {
  return readDurableMark(sessionId) !== null
}

export function shouldSuppressTitleGeneration(sessionId: string): boolean {
  return shouldSuppressContentCapture(sessionId)
}

export function shouldSuppressTraceBodyCapture(sessionId: string): boolean {
  return shouldSuppressContentCapture(sessionId)
}

export function shouldSuppressSearchContentCapture(sessionId: string): boolean {
  return shouldSuppressContentCapture(sessionId)
}

export function shouldSuppressPromptDumpCapture(sessionId: string): boolean {
  return shouldSuppressContentCapture(sessionId)
}

/** Test seams: reset defaults to memory-only isolation; reload re-enables disk reads. */
export function resetSensitivityPolicyForTests(): void {
  marks.clear()
  ignoreDiskForTests = true
}

export function reloadSensitivityPolicyForTests(): void {
  marks.clear()
  ignoreDiskForTests = false
}

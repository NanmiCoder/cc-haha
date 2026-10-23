import type { UIAttachment, UIMessage } from '../types/chat'

export const PENDING_INPUT_RECOVERY_KEY = 'cc-haha-pending-input-recovery-v1'
export const PENDING_INPUT_RECOVERY_MAX_BYTES = 4 * 1024 * 1024
export const PENDING_INPUT_RECOVERY_MAX_ENTRIES = 64
type RecoveryInput = Extract<UIMessage, { type: 'user_text' }>
type RecoveryError = Pick<Extract<UIMessage, { type: 'error' }>, 'id' | 'message' | 'code' | 'timestamp'>
type Entry = { sessionId: string; input: RecoveryInput; error?: RecoveryError }
type Snapshot = { version: 1; entries: Entry[] }
type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function storage(): RecoveryStorage | null {
  try { return globalThis.localStorage ?? null } catch { return null }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function attachment(value: unknown): UIAttachment | null {
  if (!object(value) || (value.type !== 'file' && value.type !== 'image')) return null
  const result: Record<string, unknown> = { type: value.type, name: typeof value.name === 'string' ? value.name : '' }
  for (const key of ['path', 'data', 'mimeType', 'diffSide', 'hunkId', 'note', 'quote', 'referenceKind']) {
    if (typeof value[key] === 'string') result[key] = value[key]
  }
  for (const key of ['lineStart', 'lineEnd', 'selectionNumber']) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) result[key] = value[key]
  }
  if (typeof value.isDirectory === 'boolean') result.isDirectory = value.isDirectory
  return result as UIAttachment
}

/** Only human input fields cross this boundary, never runtime/provider settings. */
function input(value: unknown): RecoveryInput | null {
  if (!object(value) || value.type !== 'user_text' || typeof value.id !== 'string' ||
    typeof value.content !== 'string' || typeof value.timestamp !== 'number') return null
  return {
    id: value.id, type: 'user_text', content: value.content, timestamp: value.timestamp,
    localHistoryRecovery: 'input',
    ...(typeof value.modelContent === 'string' ? { modelContent: value.modelContent } : {}),
    ...(Array.isArray(value.attachments) ? { attachments: value.attachments.map(attachment).filter((item): item is UIAttachment => item !== null) } : {}),
    ...(Array.isArray(value.sessionReferences) ? {
      sessionReferences: value.sessionReferences.flatMap((item) =>
        object(item) && typeof item.sessionId === 'string' ? [{ sessionId: item.sessionId }] : []),
    } : {}),
  }
}

/** Missing storage is the pre-feature profile; unversioned entries upgrade forward. */
export function migratePendingInputRecovery(value: unknown): Snapshot | null {
  if (value === null || value === undefined) return { version: 1, entries: [] }
  if (!object(value) || (value.version !== undefined && value.version !== 0 && value.version !== 1) ||
    !Array.isArray(value.entries)) return null
  const entries: Entry[] = []
  for (const candidate of value.entries) {
    if (!object(candidate) || typeof candidate.sessionId !== 'string') return null
    const human = input(candidate.input)
    if (!human) return null
    const error = candidate.error
    entries.push({
      sessionId: candidate.sessionId,
      input: human,
      ...(object(error) && typeof error.message === 'string' && typeof error.id === 'string' &&
        typeof error.timestamp === 'number' ? { error: {
          id: error.id, message: error.message, timestamp: error.timestamp,
          code: typeof error.code === 'string' ? error.code : 'UNKNOWN_ERROR',
        } } : {}),
    })
  }
  return { version: 1, entries }
}

function read(target: RecoveryStorage | null): Snapshot | null {
  if (!target) return null
  try {
    const raw = target.getItem(PENDING_INPUT_RECOVERY_KEY)
    return migratePendingInputRecovery(raw === null ? null : JSON.parse(raw))
  } catch { return null }
}

function write(snapshot: Snapshot, target: RecoveryStorage | null): boolean {
  if (!target) return false
  const encoded = JSON.stringify(snapshot)
  // Never evict an older failed prompt or truncate a large new prompt to fit.
  if (snapshot.entries.length > PENDING_INPUT_RECOVERY_MAX_ENTRIES ||
    encoded.length * 2 > PENDING_INPUT_RECOVERY_MAX_BYTES) return false
  try {
    if (snapshot.entries.length === 0) target.removeItem(PENDING_INPUT_RECOVERY_KEY)
    else target.setItem(PENDING_INPUT_RECOVERY_KEY, encoded)
    return true
  } catch { return false }
}

export function savePendingInputRecovery(
  sessionId: string, message: RecoveryInput, target = storage(),
): boolean {
  const snapshot = read(target)
  const human = input(message)
  if (!snapshot || !human) return false
  const entries = snapshot.entries.filter((entry) => entry.sessionId !== sessionId || entry.input.id !== message.id)
  entries.push({ sessionId, input: human })
  return write({ version: 1, entries }, target)
}

export function savePendingInputError(
  sessionId: string, error: RecoveryError, inputId?: string, target = storage(),
): void {
  const snapshot = read(target)
  if (!snapshot) return
  const latest = [...snapshot.entries].reverse().find((entry) =>
    entry.sessionId === sessionId && (inputId === undefined || entry.input.id === inputId))
  if (!latest) return
  latest.error = { id: error.id, message: error.message, code: error.code, timestamp: error.timestamp }
  write(snapshot, target)
}

export function readPendingInputRecovery(sessionId: string, pendingMessage: string, target = storage()): UIMessage[] {
  return (read(target)?.entries ?? []).filter((entry) => entry.sessionId === sessionId).flatMap((entry): UIMessage[] => [
    entry.input,
    {
      id: entry.error?.id ?? `pending-input-${entry.input.id}`,
      type: 'error',
      message: entry.error?.message ?? pendingMessage,
      code: entry.error?.code ?? 'INPUT_DELIVERY_UNCONFIRMED',
      timestamp: entry.error?.timestamp ?? entry.input.timestamp,
      localHistoryRecovery: 'error',
    },
  ])
}

export function removePendingInputRecovery(sessionId: string, ids?: Set<string>, target = storage()): void {
  const snapshot = read(target)
  if (!snapshot) return
  const entries = snapshot.entries.filter((entry) =>
    entry.sessionId !== sessionId || (ids !== undefined && !ids.has(entry.input.id)))
  if (entries.length !== snapshot.entries.length) write({ version: 1, entries }, target)
}

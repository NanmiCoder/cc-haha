import * as fs from 'fs/promises'
import { randomBytes } from 'node:crypto'
import { ApiError } from '../middleware/errorHandler.js'

type RecoverableJsonFileOptions<T> = {
  filePath: string
  label: string
  defaultValue: T
  normalize: (value: unknown) => T | null
}

function cloneDefault<T>(value: T): T {
  if (value && typeof value === 'object') {
    return JSON.parse(JSON.stringify(value)) as T
  }
  return value
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

async function quarantineInvalidJsonFile(
  filePath: string,
  label: string,
  reason: string,
): Promise<void> {
  const backupPath = `${filePath}.invalid-${Date.now()}-${randomBytes(3).toString('hex')}`
  try {
    await fs.rename(filePath, backupPath)
    console.warn(`[desktop] Recovered invalid ${label}; moved ${filePath} to ${backupPath}: ${reason}`)
  } catch (error) {
    console.warn(
      `[desktop] Recovered invalid ${label} from ${filePath}, but failed to quarantine it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

export function normalizeJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

export async function readRecoverableJsonFile<T>({
  filePath,
  label,
  defaultValue,
  normalize,
}: RecoverableJsonFileOptions<T>): Promise<T> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return cloneDefault(defaultValue)
    }
    throw ApiError.internal(`Failed to read ${label} from ${filePath}: ${error}`)
  }

  if (raw.trim() === '') {
    return cloneDefault(defaultValue)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    await quarantineInvalidJsonFile(
      filePath,
      label,
      error instanceof Error ? error.message : String(error),
    )
    return cloneDefault(defaultValue)
  }

  const normalized = normalize(parsed)
  if (normalized === null) {
    await quarantineInvalidJsonFile(filePath, label, 'unexpected JSON shape')
    return cloneDefault(defaultValue)
  }

  return normalized
}

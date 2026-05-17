import { doctorApi, type DoctorReportRepairResponse } from '../api/doctor'
import { APP_ZOOM_STORAGE_KEY, LEGACY_UI_ZOOM_STORAGE_KEY } from './appZoom'
import { DESKTOP_PERSISTENCE_VERSION_KEY } from './persistenceMigrations'

export const SAFE_DOCTOR_STORAGE_KEYS = [
  'cc-haha-open-tabs',
  'cc-haha-session-runtime',
  'cc-haha-theme',
  'cc-haha-locale',
  APP_ZOOM_STORAGE_KEY,
  LEGACY_UI_ZOOM_STORAGE_KEY,
  DESKTOP_PERSISTENCE_VERSION_KEY,
] as const

type DoctorStorage = Pick<Storage, 'getItem' | 'removeItem'>

export type LocalDoctorRepairResult = {
  removedKeys: string[]
  missingKeys: string[]
  failedKeys: string[]
}

export type DoctorRepairResult = {
  local: LocalDoctorRepairResult
  server: DoctorReportRepairResponse | null
  serverError: string | null
}

function getDefaultDoctorStorage(): DoctorStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function runLocalDoctorRepair(storage: DoctorStorage | null = getDefaultDoctorStorage()): LocalDoctorRepairResult {
  if (!storage) {
    return {
      removedKeys: [],
      missingKeys: [...SAFE_DOCTOR_STORAGE_KEYS],
      failedKeys: [],
    }
  }

  const removedKeys: string[] = []
  const missingKeys: string[] = []
  const failedKeys: string[] = []

  for (const key of SAFE_DOCTOR_STORAGE_KEYS) {
    try {
      if (storage.getItem(key) === null) {
        missingKeys.push(key)
        continue
      }
      storage.removeItem(key)
      removedKeys.push(key)
    } catch {
      failedKeys.push(key)
    }
  }

  return { removedKeys, missingKeys, failedKeys }
}

export async function runDoctorRepair(options?: {
  includeServer?: boolean
  storage?: DoctorStorage | null
}): Promise<DoctorRepairResult> {
  const local = runLocalDoctorRepair(options?.storage)
  if (options?.includeServer === false) {
    return { local, server: null, serverError: null }
  }

  try {
    const server = await doctorApi.reportAndRepair()
    return { local, server, serverError: null }
  } catch (error) {
    return {
      local,
      server: null,
      serverError: error instanceof Error ? error.message : String(error),
    }
  }
}

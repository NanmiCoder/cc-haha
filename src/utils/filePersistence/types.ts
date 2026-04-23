// Local recovery stub for missing filePersistence types

export const DEFAULT_UPLOAD_CONCURRENCY = 5
export const FILE_COUNT_LIMIT = 100
export const OUTPUTS_SUBDIR = 'outputs'

export interface FailedPersistence {
  filePath: string
  error: string
}

export interface PersistedFile {
  filePath: string
  fileId?: string
}

export interface FilesPersistedEventData {
  persisted: PersistedFile[]
  failed: FailedPersistence[]
}

export type TurnStartTime = number

import { appendFileSync } from 'node:fs'
import type { ElectronUpdateCheckResult, ElectronUpdaterLike } from './updater'

type ProgressHandler = (progress: { transferred?: number, total?: number }) => void

export type UpdateSmokeEnv = {
  CC_HAHA_ELECTRON_UPDATE_SMOKE_VERSION?: string
  CC_HAHA_ELECTRON_UPDATE_SMOKE_BODY?: string
  CC_HAHA_ELECTRON_UPDATE_SMOKE_TOTAL_BYTES?: string
  CC_HAHA_ELECTRON_UPDATE_SMOKE_LOG?: string
}

type UpdateSmokeConfig = {
  version: string
  body: string | null
  totalBytes: number
  logPath?: string
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function parseUpdateSmokeEnv(env: UpdateSmokeEnv): UpdateSmokeConfig | null {
  const version = env.CC_HAHA_ELECTRON_UPDATE_SMOKE_VERSION?.trim()
  if (!version) return null
  return {
    version,
    body: env.CC_HAHA_ELECTRON_UPDATE_SMOKE_BODY ?? 'Electron update smoke release',
    totalBytes: parsePositiveInteger(env.CC_HAHA_ELECTRON_UPDATE_SMOKE_TOTAL_BYTES, 100),
    logPath: env.CC_HAHA_ELECTRON_UPDATE_SMOKE_LOG,
  }
}

function writeLog(logPath: string | undefined, payload: Record<string, unknown>) {
  if (!logPath) return
  appendFileSync(logPath, `${JSON.stringify({
    ts: new Date().toISOString(),
    ...payload,
  })}\n`)
}

class UpdateSmokeUpdater implements ElectronUpdaterLike {
  autoDownload = true
  autoInstallOnAppQuit = true
  logger: unknown = null
  private progressHandler: ProgressHandler | null = null

  constructor(private readonly config: UpdateSmokeConfig) {}

  async checkForUpdates(): Promise<ElectronUpdateCheckResult> {
    writeLog(this.config.logPath, {
      event: 'check',
      version: this.config.version,
    })
    return {
      updateInfo: {
        version: this.config.version,
        body: this.config.body,
      },
    }
  }

  async downloadUpdate(): Promise<unknown> {
    writeLog(this.config.logPath, {
      event: 'download-start',
      totalBytes: this.config.totalBytes,
    })
    const firstChunk = Math.max(1, Math.floor(this.config.totalBytes / 2))
    this.progressHandler?.({ transferred: firstChunk, total: this.config.totalBytes })
    this.progressHandler?.({ transferred: this.config.totalBytes, total: this.config.totalBytes })
    writeLog(this.config.logPath, {
      event: 'download-finish',
      totalBytes: this.config.totalBytes,
    })
    return undefined
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    writeLog(this.config.logPath, {
      event: 'quit-and-install',
      isSilent: isSilent ?? null,
      isForceRunAfter: isForceRunAfter ?? null,
    })
  }

  on(event: 'download-progress', handler: ProgressHandler): ElectronUpdaterLike {
    if (event === 'download-progress') this.progressHandler = handler
    return this
  }

  off(event: 'download-progress', handler: ProgressHandler): ElectronUpdaterLike {
    if (event === 'download-progress' && this.progressHandler === handler) {
      this.progressHandler = null
    }
    return this
  }
}

export function createUpdateSmokeUpdaterFromEnv(env: UpdateSmokeEnv): ElectronUpdaterLike | null {
  const config = parseUpdateSmokeEnv(env)
  return config ? new UpdateSmokeUpdater(config) : null
}

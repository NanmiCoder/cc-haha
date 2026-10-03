import { ApiError } from './middleware/errorHandler.js'

/** Tracks the work itself, including work whose HTTP client has disconnected. */
export class MigrationMaintenance {
  private active = false
  private validation = false
  private operations = new Set<Promise<unknown>>()

  get isActive(): boolean { return this.active }
  get isValidation(): boolean { return this.validation }

  begin(): void { this.active = true }

  beginValidation(): void {
    this.validation = true
    this.active = true
  }

  activateValidation(): void {
    if (!this.validation) throw new Error('Runtime is not awaiting migration validation')
    this.validation = false
    this.active = false
  }

  assertAvailable(): void {
    if (this.active) throw new ApiError(503, 'Data migration is in progress', 'MIGRATION_IN_PROGRESS')
  }

  track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation))
    return operation
  }

  async drain(): Promise<void> {
    while (this.operations.size > 0) await Promise.allSettled([...this.operations])
  }

  resetForTests(): void {
    this.active = false
    this.validation = false
    this.operations.clear()
  }
}

export const migrationMaintenance = new MigrationMaintenance()

export function waitForMigrationExit(exited: Promise<unknown>, timeoutMs = 15_000): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    void exited.then(() => {
      clearTimeout(timer)
      resolve(true)
    }, () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

export function migrationUnavailableResponse(): Response {
  return Response.json({ error: 'Data migration is in progress', code: 'MIGRATION_IN_PROGRESS' }, { status: 503 })
}

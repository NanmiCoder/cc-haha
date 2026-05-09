import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { randomBytes } from 'node:crypto'

export const CURRENT_PROVIDER_INDEX_SCHEMA_VERSION = 1

type MigrationReport = {
  migratedEntries: string[]
  failures: string[]
}

type JsonObject = Record<string, unknown>

let migrationPromise: Promise<MigrationReport> | null = null
let migrationConfigDir: string | null = null

function getConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isProviderModels(value: unknown): value is JsonObject {
  return (
    isRecord(value) &&
    typeof value.main === 'string' &&
    typeof value.haiku === 'string' &&
    typeof value.sonnet === 'string' &&
    typeof value.opus === 'string'
  )
}

function isSavedProvider(value: unknown): value is JsonObject {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.presetId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.apiKey === 'string' &&
    typeof value.baseUrl === 'string' &&
    isProviderModels(value.models)
  )
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

async function readJsonFile(filePath: string): Promise<{ missing: boolean; value: unknown; raw: string }> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return { missing: false, value: JSON.parse(raw), raw }
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return { missing: true, value: undefined, raw: '' }
    }
    throw error
  }
}

async function backupFile(filePath: string, suffix: string): Promise<void> {
  const backupPath = `${filePath}.${suffix}-${Date.now()}-${randomBytes(3).toString('hex')}`
  await fs.copyFile(filePath, backupPath)
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp.${Date.now()}-${randomBytes(3).toString('hex')}`
  try {
    await fs.writeFile(tmpPath, stableStringify(value), 'utf-8')
    await fs.rename(tmpPath, filePath)
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {})
    throw error
  }
}

async function quarantineMalformedFile(filePath: string): Promise<void> {
  const invalidPath = `${filePath}.invalid-${Date.now()}-${randomBytes(3).toString('hex')}`
  await fs.rename(filePath, invalidPath)
}

function migrateProvidersIndex(value: unknown): JsonObject {
  if (!isRecord(value) || !Array.isArray(value.providers)) {
    return {
      schemaVersion: CURRENT_PROVIDER_INDEX_SCHEMA_VERSION,
      activeId: null,
      providers: [],
    }
  }

  const { activeProviderId: _legacyActiveProviderId, ...rest } = value
  const providers = value.providers.filter(isSavedProvider)
  const rawActiveId =
    typeof value.activeId === 'string'
      ? value.activeId
      : typeof _legacyActiveProviderId === 'string'
        ? _legacyActiveProviderId
        : null
  const activeId = rawActiveId && providers.some((provider) => provider.id === rawActiveId)
    ? rawActiveId
    : null

  return {
    ...rest,
    schemaVersion: CURRENT_PROVIDER_INDEX_SCHEMA_VERSION,
    activeId,
    providers,
  }
}

function migrateManagedSettings(value: unknown): JsonObject {
  if (!isRecord(value)) return {}
  if (value.env !== undefined && !isRecord(value.env)) {
    return { ...value, env: {} }
  }
  return value
}

async function migrateJsonEntry(
  filePath: string,
  entryName: string,
  report: MigrationReport,
  migrate: (value: unknown) => JsonObject,
): Promise<void> {
  try {
    const current = await readJsonFile(filePath)
    if (current.missing) return

    const migrated = migrate(current.value)
    if (stableStringify(migrated) === stableStringify(current.value)) return

    await backupFile(filePath, 'bak-before-migration')
    await writeJsonFile(filePath, migrated)
    report.migratedEntries.push(entryName)
  } catch (error) {
    if (error instanceof SyntaxError) {
      try {
        await quarantineMalformedFile(filePath)
        await writeJsonFile(filePath, {})
        report.migratedEntries.push(entryName)
        return
      } catch (recoveryError) {
        report.failures.push(`${entryName}: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`)
        return
      }
    }

    report.failures.push(`${entryName}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function runPersistentStorageMigrations(configDir: string): Promise<MigrationReport> {
  const report: MigrationReport = { migratedEntries: [], failures: [] }
  const ccHahaDir = path.join(configDir, 'cc-haha')

  await migrateJsonEntry(
    path.join(ccHahaDir, 'providers.json'),
    'cc-haha/providers.json',
    report,
    migrateProvidersIndex,
  )
  await migrateJsonEntry(
    path.join(ccHahaDir, 'settings.json'),
    'cc-haha/settings.json',
    report,
    migrateManagedSettings,
  )

  return report
}

export function ensurePersistentStorageUpgraded(): Promise<MigrationReport> {
  const configDir = getConfigDir()
  if (!migrationPromise || migrationConfigDir !== configDir) {
    migrationConfigDir = configDir
    migrationPromise = runPersistentStorageMigrations(configDir)
  }
  return migrationPromise
}

export function resetPersistentStorageMigrationsForTests(): void {
  migrationPromise = null
  migrationConfigDir = null
}

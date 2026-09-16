import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { HostToolsPreferencesSchema, emptyHostToolsPreferences, type HostToolsPatch, type HostToolsPreferences, type HostToolsScope } from '../../../src/features/managed-resources/api/hostToolsApi.js'
import type { ResourceDocumentStore } from './repositories/resourceDocumentStore.js'

// A new, separately versioned preferences file: existing resource/vault documents are untouched.
const DocumentSchema = z.object({ schemaVersion: z.literal(3), entries: z.record(z.string(), HostToolsPreferencesSchema) }).passthrough()
const LegacySchema = DocumentSchema.extend({ schemaVersion: z.union([z.literal(1), z.literal(2)]) })
// Forward-only, read-only migration. A successful mutation atomically writes v3.
// Missing pins/search receive defaults; existing keywords, folds and users are preserved.
function decodeDocument(text: string) {
  const value = JSON.parse(text)
  return value?.schemaVersion === 1 || value?.schemaVersion === 2
    ? { ...LegacySchema.parse(value), schemaVersion: 3 as const }
    : DocumentSchema.parse(value)
}
const queues = new Map<string, Promise<unknown>>()
export function createHostToolsPreferences(store: ResourceDocumentStore) {
  const filePath = path.join(path.dirname(store.filePath), 'host-tools-preferences.json')
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = (queues.get(filePath) ?? Promise.resolve()).catch(() => undefined).then(task)
    queues.set(filePath, result)
    void result.finally(() => { if (queues.get(filePath) === result) queues.delete(filePath) }).catch(() => undefined)
    return result
  }
  async function scopeKey(scope: HostToolsScope) {
    const loaded = await store.load()
    if (loaded.status !== 'ready') throw new Error('RESOURCE_NOT_FOUND')
    const host = loaded.document.hosts.find(value => value.id === scope.hostId)
    if (!host) throw new Error('RESOURCE_NOT_FOUND')
    if (!scope.applicationId) return JSON.stringify([host.id])
    const app = host.applications.find(value => value.id === scope.applicationId)
    const root = app?.installPaths[scope.rootIndex!]
    if (!root || root !== scope.expectedRoot) throw new Error('APPLICATION_CHANGED')
    return JSON.stringify([host.id, app!.id, root])
  }
  async function read() {
    let bytes: Buffer
    try {
      const stat = await fs.stat(filePath)
      if (stat.size > 2 * 1024 * 1024) throw new Error('PREFERENCES_INVALID')
      bytes = await fs.readFile(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 3 as const, entries: {} as Record<string, HostToolsPreferences> }
      throw error
    }
    try { return decodeDocument(bytes.toString('utf8')) }
    catch { throw new Error('PREFERENCES_INVALID') }
  }
  return {
    filePath,
    get: (scope: HostToolsScope) => enqueue(async () => {
      const key = await scopeKey(scope)
      return structuredClone((await read()).entries[key] ?? emptyHostToolsPreferences())
    }),
    patch: (scope: HostToolsScope, patch: HostToolsPatch) => enqueue(async () => {
      const key = await scopeKey(scope)
      const document = await read()
      const current = document.entries[key] ?? emptyHostToolsPreferences()
      // Field-level patches prevent rapid collapse changes from overwriting the execution user.
      const next = { ...current, collapsed: { ...current.collapsed, ...patch.collapsed }, javaKeywords: [...current.javaKeywords], pinnedFiles: [...current.pinnedFiles] }
      if (patch.pinFile) {
        if (!scope.applicationId) throw new Error('INVALID_ARGUMENT')
        const { directory, relativePath, pinned } = patch.pinFile
        // Exact Linux paths are case sensitive; patch one identity instead of replacing a stale list.
        next.pinnedFiles = next.pinnedFiles.filter(pin => pin.directory !== directory || pin.relativePath !== relativePath)
        if (pinned) next.pinnedFiles.push({ directory, relativePath })
      }
      if (patch.runAsUser !== undefined) next.runAsUser = patch.runAsUser
      if (patch.lastJavaSearch !== undefined) {
        if (scope.applicationId) throw new Error('INVALID_ARGUMENT')
        next.lastJavaSearch = patch.lastJavaSearch
      }
      if (patch.addJavaKeyword && !next.javaKeywords.includes(patch.addJavaKeyword)) next.javaKeywords.push(patch.addJavaKeyword)
      if (patch.removeJavaKeyword) next.javaKeywords = next.javaKeywords.filter(value => value !== patch.removeJavaKeyword)
      const parsed = HostToolsPreferencesSchema.safeParse(next)
      if (!parsed.success) throw new Error('PREFERENCES_LIMIT')
      document.entries[key] = parsed.data
      if (Object.keys(document.entries).length > 2048) throw new Error('PREFERENCES_LIMIT')
      const text = JSON.stringify(document, null, 2) + '\n'
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('PREFERENCES_LIMIT')
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      const temporary = filePath + '.' + randomUUID() + '.tmp'
      try {
        const handle = await fs.open(temporary, 'wx', 0o600)
        try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
        await fs.rename(temporary, filePath)
      } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
      return structuredClone(parsed.data)
    }),
  }
}
export type HostToolsPreferencesRepository = ReturnType<typeof createHostToolsPreferences>

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { NetworkProfilesDocument, NetworkProfile } from '../../../src/features/network-manager/networkTypes'
import { createDefaultNetworkProfiles } from '../../../src/features/network-manager/networkTypes'
import { migrateNetworkProfiles, NetworkProfileSchema, NetworkProfilesDocumentSchema } from '../../../src/features/network-manager/networkSchemas'

export async function writePrivateJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, filePath)
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
}

export function createNetworkRepository(configDir: string) {
  const filePath = path.join(configDir, 'network-modes.json')
  let queue: Promise<unknown> = Promise.resolve()
  async function read(): Promise<NetworkProfilesDocument> {
    try {
      if ((await fs.stat(filePath)).size > 1_000_000) throw new Error('NETWORK_CONFIG_LIMIT')
      return migrateNetworkProfiles(JSON.parse(await fs.readFile(filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, revision: 0, profiles: createDefaultNetworkProfiles() }
      throw new Error('NETWORK_CONFIG_INVALID')
    }
  }
  return {
    read,
    save(profile: NetworkProfile, expectedRevision: number): Promise<NetworkProfilesDocument> {
      const task = queue.catch(() => undefined).then(async () => {
        const document = await read()
        if (document.revision !== expectedRevision) throw new Error('REVISION_CONFLICT')
        const parsed = NetworkProfileSchema.parse(profile)
        const index = document.profiles.findIndex(value => value.id === parsed.id)
        if (index >= 0) document.profiles[index] = parsed
        else document.profiles.push(parsed)
        if (document.profiles.length > 30) throw new Error('PROFILE_LIMIT')
        document.revision++
        NetworkProfilesDocumentSchema.parse(document)
        await writePrivateJson(filePath, document)
        return structuredClone(document)
      })
      queue = task
      return task
    },
  }
}

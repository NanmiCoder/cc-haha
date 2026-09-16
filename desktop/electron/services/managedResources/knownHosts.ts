import type { KnownHostKey, ResourceDocument } from '../../../src/features/managed-resources/types/resourceTypes.js'
import type { ResourceDocumentStore } from './repositories/resourceDocumentStore.js'

export type HostKeyVerificationStatus = 'trusted' | 'unknown' | 'changed'

export type KnownHostsService = {
  getKnownKey(endpoint: string, algorithm: string): Promise<KnownHostKey | null>
  verifyHostKey(endpoint: string, algorithm: string, sha256: string): Promise<HostKeyVerificationStatus>
  trustHostKey(endpoint: string, algorithm: string, sha256: string): Promise<void>
  canonicalizeEndpoint(address: string, port: number): string
}

export function canonicalizeEndpoint(address: string, port: number): string {
  const trimmed = address.trim()
  if (trimmed.includes(':') && !trimmed.startsWith('[')) {
    return `[${trimmed}]:${port}`
  }
  if (trimmed.startsWith('[') && !trimmed.includes(']:')) {
    return `${trimmed}:${port}`
  }
  if (trimmed.startsWith('[')) {
    return trimmed
  }
  return `${trimmed}:${port}`
}

export function createKnownHostsService(store: ResourceDocumentStore): KnownHostsService {
  return {
    canonicalizeEndpoint,

    async getKnownKey(endpoint: string, algorithm: string): Promise<KnownHostKey | null> {
      const loaded = await store.load()
      if (loaded.status !== 'ready') return null
      const match = loaded.document.knownHostKeys.find(
        (k) => k.endpoint === endpoint && k.algorithm === algorithm,
      )
      return match ? { ...match } : null
    },

    async verifyHostKey(
      endpoint: string,
      algorithm: string,
      sha256: string,
    ): Promise<HostKeyVerificationStatus> {
      const loaded = await store.load()
      if (loaded.status !== 'ready') {
        return 'unknown'
      }

      const existing = loaded.document.knownHostKeys.find(
        (k) => k.endpoint === endpoint && k.algorithm === algorithm,
      )

      if (!existing) {
        return 'unknown'
      }

      if (existing.sha256 === sha256) {
        return 'trusted'
      }

      return 'changed'
    },

    async trustHostKey(endpoint: string, algorithm: string, sha256: string): Promise<void> {
      const now = new Date().toISOString()
      const txResult = await store.transact({
        mutate(draft: ResourceDocument) {
          const index = draft.knownHostKeys.findIndex(
            (k) => k.endpoint === endpoint && k.algorithm === algorithm,
          )
          const newEntry: KnownHostKey = {
            endpoint,
            algorithm,
            sha256,
            trustedAt: now,
          }
          if (index >= 0) {
            draft.knownHostKeys[index] = newEntry
          } else {
            draft.knownHostKeys.push(newEntry)
          }
          return { commit: true, value: undefined }
        },
      })

      if (txResult.status !== 'committed') {
        throw new Error(`Failed to save trusted host key: ${txResult.status}`)
      }
    },
  }
}

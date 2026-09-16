import type { CredentialKind, ResourceDocument, Host } from '../../../../src/features/managed-resources/types/resourceTypes.js'
import { CredentialRecordSchema } from '../../../../src/features/managed-resources/types/resourceSchemas.js'
import type { HostCredentialWrite } from '../../../../src/features/managed-resources/api/credentialMutationContract.js'
import type { CredentialVault, TemporaryCredentialStore } from '../vault/credentialVault.js'
import { findResourceReferences } from './resourceDocumentIntegrity.js'

export class CredentialMutationError extends Error {
  constructor(readonly code: 'VAULT_UNAVAILABLE' | 'INVALID_CREDENTIAL_PAYLOAD' | 'INVALID_TEMPORARY_CREDENTIAL') {
    super(code)
  }
}

export type CredentialMutationDependencies = {
  vault?: CredentialVault
  temporaryCredentials?: TemporaryCredentialStore
  ownerId?: string
}

export function createBoundCredential(
  draft: ResourceDocument,
  vault: CredentialVault | undefined,
  kind: CredentialKind,
  secret: unknown,
  label: string,
): string {
  if (!vault) throw new CredentialMutationError('VAULT_UNAVAILABLE')
  const timestamp = new Date().toISOString()
  const metadata = {
    id: crypto.randomUUID(), revision: 1, createdAt: timestamp, updatedAt: timestamp,
    kind, label: label.slice(0, 120), backend: 'electron-safe-storage-v1' as const,
  }
  const encrypted = vault.encrypt(metadata, secret)
  if (encrypted.status !== 'encrypted') throw new CredentialMutationError(encrypted.code)
  const parsed = CredentialRecordSchema.safeParse({ ...metadata, ciphertextBase64: encrypted.ciphertextBase64 })
  if (!parsed.success) throw new CredentialMutationError('INVALID_CREDENTIAL_PAYLOAD')
  draft.credentials.push(parsed.data)
  return parsed.data.id
}

export function applyHostCredential(
  draft: ResourceDocument,
  host: Host,
  write: HostCredentialWrite | undefined,
  dependencies: CredentialMutationDependencies,
  afterCommit: Array<() => void>,
): Host {
  if (!write) return host
  const kind = host.auth.type === 'password' ? 'ssh-password' : 'ssh-private-key'
  if (write.secret.kind !== kind) throw new CredentialMutationError('INVALID_CREDENTIAL_PAYLOAD')
  if (write.storage === 'vault') {
    return { ...host, auth: { ...host.auth, credentialId: createBoundCredential(draft, dependencies.vault, kind, write.secret, host.name) } }
  }
  const prepared = dependencies.temporaryCredentials?.prepare({
    ownerId: dependencies.ownerId ?? '', hostId: host.id, payload: write.secret,
  })
  if (!prepared || prepared.status !== 'prepared') throw new CredentialMutationError('INVALID_TEMPORARY_CREDENTIAL')
  // Unpublished secrets are discarded on validation/write failure.
  afterCommit.push(prepared.publish)
  return { ...host, auth: { ...host.auth, credentialId: null } }
}

export function resourceCredentialIds(document: ResourceDocument): Set<string> {
  const ids = new Set<string>()
  for (const host of document.hosts) {
    if (host.auth.credentialId) ids.add(host.auth.credentialId)
    for (const app of host.applications) for (const account of app.accounts) {
      if (account.credentialId) ids.add(account.credentialId)
    }
  }
  for (const connection of document.dataConnections) {
    if (connection.credentialId) ids.add(connection.credentialId)
    if (connection.tls.clientKeyCredentialId) ids.add(connection.tls.clientKeyCredentialId)
  }
  return ids
}

/** Backward-compatible name for existing host mutations; now intentionally scans every resource. */
export const hostCredentialIds = resourceCredentialIds

export function removeNewlyUnreferencedCredentials(draft: ResourceDocument, before: Set<string>): void {
  // Never sweep unrelated orphans, or credentials still shared by a resource.
  const after = resourceCredentialIds(draft)
  const removed = [...before].filter(id => !after.has(id))
  const removable = new Set(removed.filter(id => findResourceReferences(draft, { resourceType: 'credential', id }).length === 0))
  draft.credentials = draft.credentials.filter(record => !removable.has(record.id))
}

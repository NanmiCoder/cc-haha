import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const CREDENTIAL_BACKEND = 'electron-safe-storage-v1'
const CREDENTIAL_PAYLOAD_SCHEMA_VERSION = 1
const SAFE_STORAGE_PROBE = 'cc-haha-managed-resources-safe-storage-v1'
const MAX_SECRET_CHARACTERS = 1024 * 1024

const CredentialKindSchema = z.enum([
  'ssh-password',
  'ssh-private-key',
  'application-password',
  'database-password',
  'redis-password',
  'tls-client-key',
])

const PasswordCredentialKindSchema = z.enum([
  'ssh-password',
  'application-password',
  'database-password',
  'redis-password',
])

const PrivateKeyCredentialKindSchema = z.enum(['ssh-private-key', 'tls-client-key'])

const SecretStringSchema = z.string().min(1).max(MAX_SECRET_CHARACTERS)

const CredentialBindingSchema = z
  .object({
    id: z.uuidv4(),
    kind: CredentialKindSchema,
    backend: z.literal(CREDENTIAL_BACKEND),
  })
  .strict()

const CredentialSecretInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: PasswordCredentialKindSchema,
      password: SecretStringSchema,
    })
    .strict(),
  z
    .object({
      kind: PrivateKeyCredentialKindSchema,
      privateKeyPem: SecretStringSchema,
      passphrase: SecretStringSchema.optional(),
    })
    .strict(),
])

const CredentialSecretPayloadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      schemaVersion: z.literal(CREDENTIAL_PAYLOAD_SCHEMA_VERSION),
      credentialId: z.uuidv4(),
      kind: PasswordCredentialKindSchema,
      password: SecretStringSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(CREDENTIAL_PAYLOAD_SCHEMA_VERSION),
      credentialId: z.uuidv4(),
      kind: PrivateKeyCredentialKindSchema,
      privateKeyPem: SecretStringSchema,
      passphrase: SecretStringSchema.optional(),
    })
    .strict(),
])

const TemporaryOwnerInputSchema = z.string().min(1).max(256)

const TemporaryHostInputSchema = z.string().min(1).max(256)

export type SafeStorageAdapter = {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(ciphertext: Buffer): string
}

export type CredentialRecordBinding = z.infer<typeof CredentialBindingSchema>

export type StoredCredentialRecord = CredentialRecordBinding & {
  ciphertextBase64: string
}

export type CredentialSecretInput = z.infer<typeof CredentialSecretInputSchema>

export type CredentialSecretPayload = z.infer<typeof CredentialSecretPayloadSchema>

export type VaultAvailability =
  | { status: 'available' }
  | { status: 'unavailable'; code: 'VAULT_UNAVAILABLE' }

export type EncryptCredentialResult =
  | { status: 'encrypted'; ciphertextBase64: string }
  | { status: 'failed'; code: 'VAULT_UNAVAILABLE' | 'INVALID_CREDENTIAL_PAYLOAD' }

export type DecryptCredentialResult =
  | { status: 'decrypted'; payload: CredentialSecretPayload }
  | {
      status: 'failed'
      code: 'VAULT_UNAVAILABLE' | 'DECRYPT_FAILED' | 'INVALID_CREDENTIAL_PAYLOAD'
    }

export type CredentialVault = {
  initialize(): VaultAvailability
  encrypt(record: CredentialRecordBinding, input: unknown): EncryptCredentialResult
  decrypt(record: StoredCredentialRecord): DecryptCredentialResult
}

export type CreateCredentialVaultOptions = {
  safeStorage: SafeStorageAdapter
}

function unavailable(): VaultAvailability {
  return { status: 'unavailable', code: 'VAULT_UNAVAILABLE' }
}

function invalidCredentialPayload(): Extract<EncryptCredentialResult, { status: 'failed' }> {
  return { status: 'failed', code: 'INVALID_CREDENTIAL_PAYLOAD' }
}

function decryptFailed(): Extract<DecryptCredentialResult, { status: 'failed' }> {
  return { status: 'failed', code: 'DECRYPT_FAILED' }
}

function decodeCanonicalBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    return null
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null

  let decoded: Buffer
  try {
    decoded = Buffer.from(value, 'base64')
  } catch {
    return null
  }

  if (decoded.byteLength === 0 || decoded.toString('base64') !== value) {
    decoded.fill(0)
    return null
  }

  return decoded
}

function clearBuffer(value: unknown): void {
  if (Buffer.isBuffer(value)) value.fill(0)
}

function parseBinding(value: unknown): CredentialRecordBinding | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const parsed = CredentialBindingSchema.safeParse({
    id: input.id,
    kind: input.kind,
    backend: input.backend,
  })
  return parsed.success ? parsed.data : null
}

function toCredentialPayload(
  binding: CredentialRecordBinding,
  input: unknown,
): CredentialSecretPayload | null {
  const parsed = CredentialSecretInputSchema.safeParse(input)
  if (!parsed.success || parsed.data.kind !== binding.kind) return null

  if ('password' in parsed.data) {
    return {
      schemaVersion: CREDENTIAL_PAYLOAD_SCHEMA_VERSION,
      credentialId: binding.id,
      kind: parsed.data.kind,
      password: parsed.data.password,
    }
  }

  return {
    schemaVersion: CREDENTIAL_PAYLOAD_SCHEMA_VERSION,
    credentialId: binding.id,
    kind: parsed.data.kind,
    privateKeyPem: parsed.data.privateKeyPem,
    ...(parsed.data.passphrase === undefined ? {} : { passphrase: parsed.data.passphrase }),
  }
}

export function createCredentialVault(options: CreateCredentialVaultOptions): CredentialVault {
  if (!options || typeof options !== 'object' || !options.safeStorage) {
    throw new TypeError('safeStorage is required')
  }

  const { safeStorage } = options
  let availability: VaultAvailability | null = null

  function initialize(): VaultAvailability {
    if (availability) return availability

    let probeCiphertext: unknown = null
    try {
      if (safeStorage.isEncryptionAvailable() !== true) {
        availability = unavailable()
        return availability
      }

      probeCiphertext = safeStorage.encryptString(SAFE_STORAGE_PROBE)
      if (!Buffer.isBuffer(probeCiphertext)) {
        availability = unavailable()
        return availability
      }
      const probePlaintext = safeStorage.decryptString(probeCiphertext)
      availability = probePlaintext === SAFE_STORAGE_PROBE ? { status: 'available' } : unavailable()
      return availability
    } catch {
      availability = unavailable()
      return availability
    } finally {
      clearBuffer(probeCiphertext)
    }
  }

  return {
    initialize,
    encrypt(record, input): EncryptCredentialResult {
      const binding = parseBinding(record)
      const payload = binding ? toCredentialPayload(binding, input) : null
      if (!payload) return invalidCredentialPayload()

      if (initialize().status !== 'available') {
        return { status: 'failed', code: 'VAULT_UNAVAILABLE' }
      }

      let encrypted: unknown = null
      try {
        encrypted = safeStorage.encryptString(JSON.stringify(payload))
        if (!Buffer.isBuffer(encrypted) || encrypted.byteLength === 0) {
          return { status: 'failed', code: 'VAULT_UNAVAILABLE' }
        }
        return { status: 'encrypted', ciphertextBase64: encrypted.toString('base64') }
      } catch {
        return { status: 'failed', code: 'VAULT_UNAVAILABLE' }
      } finally {
        clearBuffer(encrypted)
      }
    },
    decrypt(record): DecryptCredentialResult {
      const binding = parseBinding(record)
      if (!binding) return { status: 'failed', code: 'INVALID_CREDENTIAL_PAYLOAD' }

      if (initialize().status !== 'available') {
        return { status: 'failed', code: 'VAULT_UNAVAILABLE' }
      }

      const ciphertext = decodeCanonicalBase64(record.ciphertextBase64)
      if (!ciphertext) return decryptFailed()

      try {
        const plaintext = safeStorage.decryptString(ciphertext)
        if (typeof plaintext !== 'string') return decryptFailed()
        const parsed = CredentialSecretPayloadSchema.safeParse(JSON.parse(plaintext))
        if (!parsed.success) return { status: 'failed', code: 'INVALID_CREDENTIAL_PAYLOAD' }
        if (parsed.data.credentialId !== binding.id || parsed.data.kind !== binding.kind) {
          return { status: 'failed', code: 'INVALID_CREDENTIAL_PAYLOAD' }
        }
        return { status: 'decrypted', payload: parsed.data }
      } catch {
        return decryptFailed()
      } finally {
        ciphertext.fill(0)
      }
    },
  }
}

export type TemporaryCredentialResult =
  | { status: 'provided'; handle: string }
  | { status: 'failed'; code: 'INVALID_TEMPORARY_CREDENTIAL' }

export type ResolveTemporaryCredentialResult =
  | { status: 'resolved'; payload: CredentialSecretInput }
  | { status: 'not-found' }

export type TemporaryCredentialStore = {
  prepare(input: { ownerId: string; hostId: string; payload: unknown }):
    | { status: 'prepared'; publish: () => void }
    | { status: 'failed'; code: 'INVALID_TEMPORARY_CREDENTIAL' }
  provide(input: {
    ownerId: string
    hostId: string
    payload: unknown
  }): TemporaryCredentialResult
  resolve(input: {
    ownerId: string
    hostId: string
    handle: string
  }): ResolveTemporaryCredentialResult
  resolveLatestForOwnerHost(input: {
    ownerId: string
    hostId: string
  }): ResolveTemporaryCredentialResult
  clearOwner(ownerId: string): void
  dispose(): void
}

type TemporaryCredentialEntry = {
  ownerId: string
  hostId: string
  payload: CredentialSecretInput
}

function cloneTemporaryPayload(payload: CredentialSecretInput): CredentialSecretInput {
  if ('password' in payload) {
    return { kind: payload.kind, password: payload.password }
  }
  return {
    kind: payload.kind,
    privateKeyPem: payload.privateKeyPem,
    ...(payload.passphrase === undefined ? {} : { passphrase: payload.passphrase }),
  }
}

export function createTemporaryCredentialStore(): TemporaryCredentialStore {
  const entries = new Map<string, TemporaryCredentialEntry>()
  let generation = 0
  const ownerGenerations = new Map<string, number>()

  function prepare(input: { ownerId: string; hostId: string; payload: unknown }) {
    const owner = TemporaryOwnerInputSchema.safeParse(input?.ownerId)
    const host = TemporaryHostInputSchema.safeParse(input?.hostId)
    const payload = CredentialSecretInputSchema.safeParse(input?.payload)
    if (!owner.success || !host.success || !payload.success) {
      return { status: 'failed' as const, code: 'INVALID_TEMPORARY_CREDENTIAL' as const }
    }
    const handle = randomUUID()
    const entry = { ownerId: owner.data, hostId: host.data, payload: cloneTemporaryPayload(payload.data) }
    const epoch = generation
    const ownerEpoch = ownerGenerations.get(owner.data) ?? 0
    let published = false
    return {
      status: 'prepared' as const,
      handle,
      publish() {
        if (published || epoch !== generation || ownerEpoch !== (ownerGenerations.get(owner.data) ?? 0)) return
        published = true
        for (const [key, old] of entries) {
          if (old.ownerId === entry.ownerId && old.hostId === entry.hostId) entries.delete(key)
        }
        entries.set(handle, entry)
      },
    }
  }

  return {
    prepare,
    provide(input): TemporaryCredentialResult {
      const prepared = prepare(input)
      if (prepared.status !== 'prepared') return prepared
      prepared.publish()
      return { status: 'provided', handle: prepared.handle }
    },
    resolve(input): ResolveTemporaryCredentialResult {
      const owner = TemporaryOwnerInputSchema.safeParse(input?.ownerId)
      const host = TemporaryHostInputSchema.safeParse(input?.hostId)
      const handle = typeof input?.handle === 'string' ? input.handle : ''
      if (!owner.success || !host.success || handle.length === 0) return { status: 'not-found' }

      const entry = entries.get(handle)
      if (!entry || entry.ownerId !== owner.data || entry.hostId !== host.data) {
        return { status: 'not-found' }
      }
      return { status: 'resolved', payload: cloneTemporaryPayload(entry.payload) }
    },
    resolveLatestForOwnerHost(input): ResolveTemporaryCredentialResult {
      const owner = TemporaryOwnerInputSchema.safeParse(input?.ownerId)
      const host = TemporaryHostInputSchema.safeParse(input?.hostId)
      if (!owner.success || !host.success) return { status: 'not-found' }
      for (const entry of entries.values()) {
        if (entry.ownerId === owner.data && entry.hostId === host.data) {
          return { status: 'resolved', payload: cloneTemporaryPayload(entry.payload) }
        }
      }
      return { status: 'not-found' }
    },
    clearOwner(ownerId): void {
      const owner = TemporaryOwnerInputSchema.safeParse(ownerId)
      if (!owner.success) return
      ownerGenerations.set(owner.data, (ownerGenerations.get(owner.data) ?? 0) + 1)
      for (const [handle, entry] of entries) {
        if (entry.ownerId === owner.data) entries.delete(handle)
      }
    },
    dispose(): void {
      generation += 1
      entries.clear()
      ownerGenerations.clear()
    },
  }
}

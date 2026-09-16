import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import {
  createCredentialVault,
  createTemporaryCredentialStore,
  type SafeStorageAdapter,
} from './credentialVault'

const credential = {
  id: '50000000-0000-4000-8000-000000000001',
  kind: 'ssh-password' as const,
  backend: 'electron-safe-storage-v1' as const,
}

const otherCredential = {
  ...credential,
  id: '50000000-0000-4000-8000-000000000002',
}

function createFakeSafeStorage(options: {
  available?: boolean
  encryptThrows?: boolean
  decryptThrows?: boolean
  corruptRoundTrip?: boolean
} = {}): SafeStorageAdapter {
  return {
    isEncryptionAvailable: vi.fn(() => options.available ?? true),
    encryptString: vi.fn((plainText: string) => {
      if (options.encryptThrows) throw new Error('fake encrypt failure')
      return Buffer.from(`sealed:${plainText}`, 'utf8')
    }),
    decryptString: vi.fn((encrypted: Buffer) => {
      if (options.decryptThrows) throw new Error('fake decrypt failure')
      const value = encrypted.toString('utf8')
      if (!value.startsWith('sealed:')) throw new Error('invalid fake ciphertext')
      const plainText = value.slice('sealed:'.length)
      return options.corruptRoundTrip ? `${plainText}:corrupted` : plainText
    }),
  }
}

function fakeCiphertext(plaintext: string): string {
  return Buffer.from(`sealed:${plaintext}`, 'utf8').toString('base64')
}

describe('CredentialVault', () => {
  it('refuses persistent encryption when Windows safe storage is unavailable', () => {
    const safeStorage = createFakeSafeStorage({ available: false })
    const vault = createCredentialVault({ safeStorage })

    expect(vault.initialize()).toEqual({ status: 'unavailable', code: 'VAULT_UNAVAILABLE' })
    expect(vault.encrypt(credential, { kind: 'ssh-password', password: 'unit-password-secret' })).toEqual({
      status: 'failed',
      code: 'VAULT_UNAVAILABLE',
    })
    expect(safeStorage.encryptString).not.toHaveBeenCalled()
    expect(safeStorage.decryptString).not.toHaveBeenCalled()
  })

  it.each([
    ['encrypt throws', { encryptThrows: true }],
    ['decrypt throws', { decryptThrows: true }],
    ['round trip changes plaintext', { corruptRoundTrip: true }],
  ])('fails the availability self-check when %s', (_label, options) => {
    const safeStorage = createFakeSafeStorage(options)
    const vault = createCredentialVault({ safeStorage })

    expect(vault.initialize()).toEqual({ status: 'unavailable', code: 'VAULT_UNAVAILABLE' })
    expect(vault.encrypt(credential, { kind: 'ssh-password', password: 'unit-password-secret' })).toEqual({
      status: 'failed',
      code: 'VAULT_UNAVAILABLE',
    })
  })

  it('treats a malformed safe-storage ciphertext return as unavailable without throwing', () => {
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: () => 'not-a-buffer',
      decryptString: () => 'unreachable',
    } as unknown as SafeStorageAdapter
    const vault = createCredentialVault({ safeStorage })

    expect(vault.initialize()).toEqual({ status: 'unavailable', code: 'VAULT_UNAVAILABLE' })
  })

  it('round-trips a password payload bound to its credential record without exposing its secret in an error result', () => {
    const vault = createCredentialVault({ safeStorage: createFakeSafeStorage() })
    const encrypted = vault.encrypt(credential, {
      kind: 'ssh-password',
      password: 'unit-password-secret',
    })

    expect(encrypted.status).toBe('encrypted')
    if (encrypted.status !== 'encrypted') return
    expect(encrypted.ciphertextBase64).not.toContain('unit-password-secret')

    const decrypted = vault.decrypt({ ...credential, ciphertextBase64: encrypted.ciphertextBase64 })
    expect(decrypted).toEqual({
      status: 'decrypted',
      payload: {
        schemaVersion: 1,
        credentialId: credential.id,
        kind: 'ssh-password',
        password: 'unit-password-secret',
      },
    })
  })

  it('round-trips encrypted private keys with an optional passphrase', () => {
    const vault = createCredentialVault({ safeStorage: createFakeSafeStorage() })
    const privateKeyCredential = {
      ...credential,
      kind: 'ssh-private-key' as const,
    }
    const encrypted = vault.encrypt(privateKeyCredential, {
      kind: 'ssh-private-key',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----\\nunit-private-key-secret\\n-----END PRIVATE KEY-----',
      passphrase: 'unit-passphrase-secret',
    })

    expect(encrypted.status).toBe('encrypted')
    if (encrypted.status !== 'encrypted') return

    expect(vault.decrypt({ ...privateKeyCredential, ciphertextBase64: encrypted.ciphertextBase64 })).toEqual({
      status: 'decrypted',
      payload: {
        schemaVersion: 1,
        credentialId: credential.id,
        kind: 'ssh-private-key',
        privateKeyPem: '-----BEGIN PRIVATE KEY-----\\nunit-private-key-secret\\n-----END PRIVATE KEY-----',
        passphrase: 'unit-passphrase-secret',
      },
    })
  })

  it.each([
    ['empty password', { kind: 'ssh-password', password: '' }],
    ['wrong kind for record', { kind: 'redis-password', password: 'unit-password-secret' }],
    ['unexpected payload field', { kind: 'ssh-password', password: 'unit-password-secret', extra: true }],
    ['password on private-key record', { kind: 'ssh-private-key', password: 'unit-password-secret' }],
  ])('rejects an invalid credential payload: %s', (_label, input) => {
    const vault = createCredentialVault({ safeStorage: createFakeSafeStorage() })

    expect(vault.encrypt(credential, input)).toEqual({
      status: 'failed',
      code: 'INVALID_CREDENTIAL_PAYLOAD',
    })
  })

  it('rejects decrypted payloads bound to another credential and leaves the existing ciphertext untouched', () => {
    const vault = createCredentialVault({ safeStorage: createFakeSafeStorage() })
    const encrypted = vault.encrypt(credential, {
      kind: 'ssh-password',
      password: 'unit-password-secret',
    })
    expect(encrypted.status).toBe('encrypted')
    if (encrypted.status !== 'encrypted') return

    const stored = {
      ...otherCredential,
      ciphertextBase64: encrypted.ciphertextBase64,
    }
    const before = structuredClone(stored)

    expect(vault.decrypt(stored)).toEqual({
      status: 'failed',
      code: 'INVALID_CREDENTIAL_PAYLOAD',
    })
    expect(stored).toEqual(before)
  })

  it.each([
    ['unsupported payload schema version', {
      schemaVersion: 2,
      credentialId: credential.id,
      kind: 'ssh-password',
      password: 'unit-password-secret',
    }],
    ['unexpected decrypted payload field', {
      schemaVersion: 1,
      credentialId: credential.id,
      kind: 'ssh-password',
      password: 'unit-password-secret',
      unexpected: true,
    }],
  ])('rejects strict decrypted payload validation for %s without altering stored ciphertext', (_label, payload) => {
    const vault = createCredentialVault({ safeStorage: createFakeSafeStorage() })
    const stored = {
      ...credential,
      ciphertextBase64: fakeCiphertext(JSON.stringify(payload)),
    }
    const before = structuredClone(stored)

    expect(vault.decrypt(stored)).toEqual({
      status: 'failed',
      code: 'INVALID_CREDENTIAL_PAYLOAD',
    })
    expect(stored).toEqual(before)
  })

  it.each([
    ['non-canonical Base64', 'not Base64'],
    ['safe-storage decrypt failure', Buffer.from('wrong-format', 'utf8').toString('base64')],
    ['malformed decrypted JSON', fakeCiphertext('{not-json')],
  ])('returns a non-leaking decrypt failure for %s', (_label, ciphertextBase64) => {
    const vault = createCredentialVault({ safeStorage: createFakeSafeStorage() })
    const result = vault.decrypt({ ...credential, ciphertextBase64 })

    expect(result).toEqual({ status: 'failed', code: 'DECRYPT_FAILED' })
    expect(JSON.stringify(result)).not.toContain('unit-password-secret')
  })

  it('does not replace an existing ciphertext when encryption fails after a prior valid record exists', () => {
    const healthyVault = createCredentialVault({ safeStorage: createFakeSafeStorage() })
    const existing = healthyVault.encrypt(credential, {
      kind: 'ssh-password',
      password: 'old-unit-password-secret',
    })
    expect(existing.status).toBe('encrypted')
    if (existing.status !== 'encrypted') return

    const stored = { ...credential, ciphertextBase64: existing.ciphertextBase64 }
    const before = structuredClone(stored)
    const unavailableVault = createCredentialVault({
      safeStorage: createFakeSafeStorage({ encryptThrows: true }),
    })

    expect(unavailableVault.encrypt(credential, {
      kind: 'ssh-password',
      password: 'replacement-unit-password-secret',
    })).toEqual({ status: 'failed', code: 'VAULT_UNAVAILABLE' })
    expect(stored).toEqual(before)
  })
})

describe('TemporaryCredentialStore', () => {
  it('permits a one-session credential while the persistent vault is unavailable and never includes the secret in its public handle', () => {
    const unavailableVault = createCredentialVault({
      safeStorage: createFakeSafeStorage({ available: false }),
    })
    const temporaryCredentials = createTemporaryCredentialStore()

    expect(unavailableVault.encrypt(credential, {
      kind: 'ssh-password',
      password: 'unit-password-secret',
    })).toEqual({ status: 'failed', code: 'VAULT_UNAVAILABLE' })

    const provided = temporaryCredentials.provide({
      ownerId: 'window-1',
      hostId: credential.id,
      payload: { kind: 'ssh-password', password: 'unit-password-secret' },
    })
    expect(provided.status).toBe('provided')
    if (provided.status !== 'provided') return
    expect(JSON.stringify(provided)).not.toContain('unit-password-secret')

    expect(temporaryCredentials.resolve({
      ownerId: 'window-1',
      hostId: credential.id,
      handle: provided.handle,
    })).toEqual({
      status: 'resolved',
      payload: { kind: 'ssh-password', password: 'unit-password-secret' },
    })
  })

  it('binds temporary credentials to owner and host, and clears only the intended owner', () => {
    const temporaryCredentials = createTemporaryCredentialStore()
    const first = temporaryCredentials.provide({
      ownerId: 'window-1',
      hostId: credential.id,
      payload: { kind: 'ssh-password', password: 'first-unit-password-secret' },
    })
    const second = temporaryCredentials.provide({
      ownerId: 'window-2',
      hostId: credential.id,
      payload: { kind: 'ssh-password', password: 'second-unit-password-secret' },
    })
    expect(first.status).toBe('provided')
    expect(second.status).toBe('provided')
    if (first.status !== 'provided' || second.status !== 'provided') return

    expect(temporaryCredentials.resolve({
      ownerId: 'window-2',
      hostId: credential.id,
      handle: first.handle,
    })).toEqual({ status: 'not-found' })
    expect(temporaryCredentials.resolve({
      ownerId: 'window-1',
      hostId: otherCredential.id,
      handle: first.handle,
    })).toEqual({ status: 'not-found' })

    temporaryCredentials.clearOwner('window-1')
    expect(temporaryCredentials.resolve({
      ownerId: 'window-1',
      hostId: credential.id,
      handle: first.handle,
    })).toEqual({ status: 'not-found' })
    expect(temporaryCredentials.resolve({
      ownerId: 'window-2',
      hostId: credential.id,
      handle: second.handle,
    })).toEqual({
      status: 'resolved',
      payload: { kind: 'ssh-password', password: 'second-unit-password-secret' },
    })
  })

  it('rejects malformed temporary credential payloads and clears all credentials on dispose', () => {
    const temporaryCredentials = createTemporaryCredentialStore()

    expect(temporaryCredentials.provide({
      ownerId: 'window-1',
      hostId: credential.id,
      payload: { kind: 'ssh-password', password: '', unexpected: true },
    })).toEqual({ status: 'failed', code: 'INVALID_TEMPORARY_CREDENTIAL' })

    const provided = temporaryCredentials.provide({
      ownerId: 'window-1',
      hostId: credential.id,
      payload: { kind: 'ssh-password', password: 'unit-password-secret' },
    })
    expect(provided.status).toBe('provided')
    if (provided.status !== 'provided') return

    temporaryCredentials.dispose()
    expect(temporaryCredentials.resolve({
      ownerId: 'window-1',
      hostId: credential.id,
      handle: provided.handle,
    })).toEqual({ status: 'not-found' })
  })
})

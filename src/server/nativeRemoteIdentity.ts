import { constants, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { decodeRemoteBase64, parseRemoteOrigin, remoteCanonical, REMOTE_ANNOUNCEMENT_TTL_MS, type RemoteAnnouncement } from '../shared/remoteIdentityProtocol.js'

type StoredIdentity = Record<string, unknown> & {
  version: 1
  privateKey: string
  publicKey: string
  sequence: number
  directoryUrl: string
}

export function isNativeRemotePublicKey(value: unknown): value is string {
  try {
    if (typeof value !== 'string' || value.length !== 392) return false
    const key = createPublicKey({ key: Buffer.from(decodeRemoteBase64(value)), format: 'der', type: 'spki' })
    return key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails?.modulusLength === 2048 &&
      key.asymmetricKeyDetails.publicExponent === 65537n &&
      key.export({ format: 'der', type: 'spki' }).toString('base64url') === value
  } catch { return false }
}

/** Kept separately from device grants: a lost/corrupt identity must never silently become another host. */
export class NativeRemoteIdentity {
  private stored: StoredIdentity | null = null
  private privateKey: KeyObject | null = null

  constructor(private file: string) {}

  private persist(next: StoredIdentity) {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomBytes(16).toString('hex')}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.file)
    } finally {
      try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    this.stored = next
  }

  private load(create = true): StoredIdentity | null {
    if (this.stored) return this.stored
    let data: unknown
    try { data = JSON.parse(readFileSync(this.file, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!create) return null
      const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
      const identity: StoredIdentity = {
        version: 1,
        privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
        publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
        sequence: 0,
        directoryUrl: '',
      }
      this.persist(identity)
      this.privateKey = keys.privateKey
      return identity
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid remote identity')
    const identity = data as StoredIdentity
    if (identity.version !== 1 || !isNativeRemotePublicKey(identity.publicKey) || typeof identity.privateKey !== 'string' ||
      !Number.isSafeInteger(identity.sequence) || identity.sequence < 0 ||
      (identity.directoryUrl !== '' && !parseRemoteOrigin(identity.directoryUrl))) throw new Error('Invalid remote identity')
    const privateKey = createPrivateKey({ key: Buffer.from(decodeRemoteBase64(identity.privateKey)), format: 'der', type: 'pkcs8' })
    if (privateKey.asymmetricKeyType !== 'rsa' ||
      createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url') !== identity.publicKey) throw new Error('Remote identity keys do not match')
    this.privateKey = privateKey
    this.stored = identity
    return identity
  }

  metadata() {
    const identity = this.load()!
    return { version: 2 as const, hostId: createHash('sha256').update(Buffer.from(identity.publicKey, 'base64url')).digest('hex'), publicKey: identity.publicKey, directoryUrl: identity.directoryUrl }
  }

  /** Ordinary H5 pairing never creates a native identity as a side effect. */
  binding() {
    const identity = this.load(false)
    return identity?.directoryUrl ? this.metadata() : undefined
  }

  configure(directoryUrl: unknown) {
    if (directoryUrl !== '' && !parseRemoteOrigin(directoryUrl)) throw new Error('HTTPS directory origin required')
    const identity = this.load()!
    this.persist({ ...identity, directoryUrl: directoryUrl as string })
    return this.metadata()
  }

  sign(purpose: string, fields: readonly string[]) {
    this.load()
    return sign('sha256', remoteCanonical(purpose, fields), { key: this.privateKey!, padding: constants.RSA_PKCS1_PADDING }).toString('base64url')
  }

  announcement(origin: string, now: number): RemoteAnnouncement {
    const identity = this.load()!
    if (!identity.directoryUrl || !parseRemoteOrigin(origin) || !Number.isSafeInteger(identity.sequence + 1)) throw new Error('Remote announcement unavailable')
    const { hostId, publicKey } = this.metadata()
    const sequence = identity.sequence + 1
    const expiresAt = now + REMOTE_ANNOUNCEMENT_TTL_MS
    // Commit the monotonic sequence before exposing its signature to the publisher.
    this.persist({ ...identity, sequence })
    return { version: 2, hostId, publicKey, origin, sequence, expiresAt,
      signature: this.sign('announce', [hostId, origin, String(sequence), String(expiresAt)]) }
  }
}

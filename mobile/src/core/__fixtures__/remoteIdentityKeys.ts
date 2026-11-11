import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import type { RemoteIdentityKeys } from '../remoteIdentity'

/** Test-only RSA adapter. Production uses a non-exportable Android Keystore key. */
export function fixtureIdentityKeys(): RemoteIdentityKeys {
  const keys = new Map<string, { publicKey: KeyObject; privateKey: KeyObject }>()
  const bytes = (purpose: string, fields: string[]) => Buffer.from(['cc-haha-remote-v2', purpose, ...fields].join('\n'))
  const publicKey = (key: string) => createPublicKey({ key: Buffer.from(key, 'base64url'), format: 'der', type: 'spki' })
  return {
    hostId: async key => {
      const parsed = publicKey(key)
      if (parsed.asymmetricKeyDetails?.modulusLength !== 2048) throw new Error('invalid_public_key')
      return createHash('sha256').update(Buffer.from(key, 'base64url')).digest('hex')
    },
    nonce: async () => randomBytes(32).toString('base64url'),
    hashText: async value => createHash('sha256').update(value).digest('hex'),
    ensurePublicKey: async alias => {
      if (!keys.has(alias)) keys.set(alias, generateKeyPairSync('rsa', { modulusLength: 2048 }))
      return keys.get(alias)!.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
    },
    exists: async alias => keys.has(alias),
    sign: async (alias, purpose, fields) => sign('sha256', bytes(purpose, fields), keys.get(alias)!.privateKey).toString('base64url'),
    verify: async (key, signature, purpose, fields) => verify('sha256', bytes(purpose, fields), publicKey(key), Buffer.from(signature, 'base64url')),
    remove: async alias => { keys.delete(alias) },
  }
}

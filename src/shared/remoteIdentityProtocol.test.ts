import { describe, expect, test } from 'bun:test'
import { createPrivateKey, sign, verify } from 'node:crypto'
import fixture from './__fixtures__/remote-identity-v2.json'
import {
  announcementBytes, decodeRemoteBase64, encodeRemoteBase64, parseRemoteOrigin,
  remoteCanonical, remotePublicKeyId, validateRemoteAnnouncement, verifyRemoteSignature,
} from './remoteIdentityProtocol'

const privateKey = createPrivateKey({ key: Buffer.from(fixture.privateKeyPkcs8, 'base64url'), format: 'der', type: 'pkcs8' })
const now = 1_800_000_000_000
function announcement(overrides = {}) {
  const value = { version: 2, hostId: fixture.hostId, publicKey: fixture.publicKey, origin: 'https://computer-fixture.example', sequence: 17, expiresAt: now + 60_000, ...overrides }
  return { ...value, signature: sign('sha256', announcementBytes(value), privateKey).toString('base64url') }
}

describe('remote identity wire protocol', () => {
  for (const vector of fixture.examples) {
    test(`verifies the Android interoperability vector: ${vector.purpose}`, async () => {
      const message = remoteCanonical(vector.purpose, vector.fields)
      expect(new TextDecoder().decode(message)).toBe(vector.canonical)
      expect(await verifyRemoteSignature(fixture.publicKey, vector.signature, message)).toBe(true)
      expect(verify('sha256', message, { key: Buffer.from(fixture.publicKey, 'base64url'), format: 'der', type: 'spki' }, Buffer.from(vector.signature, 'base64url'))).toBe(true)
      expect(await verifyRemoteSignature(fixture.publicKey, vector.signature, remoteCanonical('other-purpose', vector.fields))).toBe(false)
    })
  }

  test('pins the key bytes and rejects ambiguous signature fields or encodings', async () => {
    expect(await remotePublicKeyId(fixture.publicKey)).toBe(fixture.hostId)
    expect(encodeRemoteBase64(decodeRemoteBase64(fixture.publicKey))).toBe(fixture.publicKey)
    for (const field of ['a\nb', 'a\rb', 'a\0b']) expect(() => remoteCanonical('test', [field])).toThrow()
    for (const encoded of ['', 'YQ==', 'YR', '+/8', 'a'.repeat(4097)]) expect(() => decodeRemoteBase64(encoded)).toThrow()
    expect(await verifyRemoteSignature('bad', fixture.examples[0]!.signature, new Uint8Array())).toBe(false)
  })

  test('accepts only canonical HTTPS origins', () => {
    expect(parseRemoteOrigin('https://computer.example:8443')).toBe('https://computer.example:8443')
    for (const origin of ['http://computer.example', 'https://computer.example/', 'https://a:b@computer.example', 'https://computer.example/path', 'https://computer.example?token=x', 'https://COMPUTER.example', 'https://computer.example#x', null]) expect(parseRemoteOrigin(origin)).toBeNull()
  })

  test('checks signed announcement identity, expiration, sequence and known fields', async () => {
    const valid = announcement()
    expect(await validateRemoteAnnouncement({ ...valid, cookie: 'never store this' }, now)).toEqual(valid)
    for (const overrides of [
      { version: 1 }, { hostId: 'a'.repeat(64) }, { sequence: 0 }, { sequence: 1.5 },
      { expiresAt: now }, { expiresAt: now + 660_001 }, { origin: 'http://computer.example' },
    ]) expect(await validateRemoteAnnouncement(announcement(overrides), now)).toBeNull()
    expect(await validateRemoteAnnouncement({ ...valid, origin: 'https://attacker.example' }, now)).toBeNull()
    expect(await validateRemoteAnnouncement({ ...valid, publicKey: 'invalid' }, now)).toBeNull()
    for (const invalid of [null, [], {}, 'x']) expect(await validateRemoteAnnouncement(invalid, now)).toBeNull()
  })
})

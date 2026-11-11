import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vector from '../shared/__fixtures__/remote-identity-v2.json'
import { NativeRemoteIdentity, isNativeRemotePublicKey } from './nativeRemoteIdentity.js'

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
function fixture(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'native-identity-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'identity.json')
  const stored = { version: 1, privateKey: vector.privateKeyPkcs8, publicKey: vector.publicKey, sequence: 0, directoryUrl: '', ...extra }
  writeFileSync(file, JSON.stringify(stored), { mode: 0o600 })
  return { file, stored, identity: new NativeRemoteIdentity(file) }
}

describe('native host identity persistence and interoperability', () => {
  test('Node signer matches every Android/WebCrypto protocol vector byte for byte', () => {
    const { identity } = fixture()
    expect(identity.metadata().hostId).toBe(vector.hostId)
    for (const example of vector.examples) {
      expect(identity.sign(example.purpose, example.fields)).toBe(example.signature)
    }
    expect(() => identity.sign('resume', ['unsafe\nfield'])).toThrow('Invalid remote signature field')
  })

  test('existing identity preserves unknown fields and monotonic sequence when configuration changes', () => {
    const { identity, file } = fixture({ futureField: { preserved: true }, sequence: 42 })
    identity.configure('https://directory.example.test')
    expect(identity.announcement('https://host.example.test', 1000).sequence).toBe(43)
    expect(new NativeRemoteIdentity(file).announcement('https://host.example.test', 2000).sequence).toBe(44)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ futureField: { preserved: true }, sequence: 44, publicKey: vector.publicKey })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('corrupt, future and inconsistent identity files fail closed without rewriting them', () => {
    for (const extra of [{ version: 2 }, { sequence: -1 }, { sequence: 1.5 }, { directoryUrl: 'http://directory.test' }, { publicKey: vector.publicKey + '=' }, { privateKey: vector.publicKey }]) {
      const { identity, file } = fixture(extra)
      const before = readFileSync(file, 'utf8')
      expect(() => identity.metadata()).toThrow()
      expect(readFileSync(file, 'utf8')).toBe(before)
    }
    expect(isNativeRemotePublicKey(vector.publicKey)).toBe(true)
    expect(isNativeRemotePublicKey(vector.publicKey + '=')).toBe(false)
    expect(isNativeRemotePublicKey(vector.privateKeyPkcs8)).toBe(false)
  })

  test('sequence exhaustion never wraps or changes the stored identity', () => {
    const { identity, file } = fixture({ sequence: Number.MAX_SAFE_INTEGER, directoryUrl: 'https://directory.test' })
    const before = readFileSync(file, 'utf8')
    expect(() => identity.announcement('https://host.test', 1000)).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})

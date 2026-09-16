import { generateKeyPairSync } from 'node:crypto'
import { Server as SshServer } from 'ssh2'

export { SshServer as SshFixtureServer }
export type { Connection as SshFixtureConnection } from 'ssh2'

export function createSshFixtureHostKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
}

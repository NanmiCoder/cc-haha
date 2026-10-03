import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { userInfo } from 'node:os'

export type MigrationCredentialReceipt = { service: string; digest: string }
export type MigrationCredentialStore = {
  read(service: string, signal?: AbortSignal): Promise<string | null>
  write(service: string, value: string, signal?: AbortSignal): Promise<void>
  remove(service: string, signal?: AbortSignal): Promise<void>
}

function security(args: string[], input?: string, signal?: AbortSignal): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, signal, timeout: 30_000 })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.once('error', () => reject(new Error('Cannot access macOS migration credentials')))
    child.stdin.on('error', () => reject(new Error('Cannot write macOS migration credentials')))
    child.once('close', code => resolve({ code, output: output.replace(/\r?\n$/, '') }))
    child.stdin.end(input)
  })
}

export function systemMigrationCredentialStore(username = process.env.USER || userInfo().username): MigrationCredentialStore {
  return {
    async read(service, signal) {
      const result = await security(['find-generic-password', '-a', username, '-s', service, '-w'], undefined, signal)
      if (result.code === 44) return null
      if (result.code !== 0) throw new Error('macOS keychain is unavailable; unlock it and retry migration')
      return result.output
    },
    async write(service, value, signal) {
      const quote = (text: string) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
      const command = `add-generic-password -a ${quote(username)} -s ${quote(service)} -X "${Buffer.from(value).toString('hex')}"\n`
      // Match secureStorage's platform contract: security -i truncates lines
      // above its 4096-byte buffer. Prefer stdin; large records use its hex
      // argument interface. Neither path logs payloads or uses plaintext files.
      const result = Buffer.byteLength(command) <= 4032
        ? await security(['-i'], command, signal)
        : await security(['add-generic-password', '-a', username, '-s', service, '-X', Buffer.from(value).toString('hex')], undefined, signal)
      if (result.code !== 0) throw new Error('Could not copy macOS migration credentials')
    },
    async remove(service) {
      if ((await security(['delete-generic-password', '-a', username, '-s', service])).code !== 0) throw new Error('Could not remove migration-created credential')
    },
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export async function copyMigrationCredentials(
  sourceDir: string, sourceDefault: boolean, targetDir: string,
  store: MigrationCredentialStore,
  beforeCreate: (receipt: MigrationCredentialReceipt) => Promise<void>,
  signal?: AbortSignal,
): Promise<MigrationCredentialReceipt[]> {
  const receipts: MigrationCredentialReceipt[] = []
  const sourceHash = sourceDefault ? '' : `-${digest(sourceDir.normalize('NFC')).slice(0, 8)}`
  const targetHash = `-${digest(targetDir.normalize('NFC')).slice(0, 8)}`
  for (const oauth of ['', '-custom-oauth', '-staging-oauth', '-local-oauth']) {
    for (const credentials of ['', '-credentials']) {
      const base = `Claude Code${oauth}${credentials}`
      signal?.throwIfAborted()
      const source = await store.read(`${base}${sourceHash}`, signal)
      if (source === null) continue
      const service = `${base}${targetHash}`
      const existing = await store.read(service, signal)
      if (existing !== null && existing !== source) throw new Error('Target directory has different macOS credentials; choose another directory')
      const receipt = { service, digest: digest(source) }
      if (existing === null) {
        await beforeCreate(receipt)
        signal?.throwIfAborted()
        await store.write(service, source, signal)
      }
      if (await store.read(service, signal) !== source) throw new Error('macOS credential verification failed')
      receipts.push(receipt)
    }
  }
  return receipts
}

export async function verifyMigrationCredentials(receipts: MigrationCredentialReceipt[], store: MigrationCredentialStore): Promise<void> {
  for (const receipt of receipts) {
    const value = await store.read(receipt.service)
    if (value === null || digest(value) !== receipt.digest) throw new Error('Migrated macOS credentials are unavailable')
  }
}

export async function removeMigrationCredentials(receipts: MigrationCredentialReceipt[], store: MigrationCredentialStore): Promise<void> {
  for (const receipt of receipts) {
    const value = await store.read(receipt.service)
    if (value !== null && digest(value) === receipt.digest) await store.remove(receipt.service)
  }
}

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createLocalPathService, createSftpService, createRemoteEditService } from './sftpService'
import type { SshSession } from './sshSessionService'
import { createSftpSaveProtocolFixture } from './sftpSaveProtocolFixture'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture(extension = true) {
  const peer = await createSftpSaveProtocolFixture(extension)
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-save-protocol-'))
  let generation = 1
  const resolveSession = () => ({ client: peer.client, generation, session: { status: 'ready' } as SshSession })
  const sftp = createSftpService({ resolveSession, tempDir: temp })
  const local = createLocalPathService({ userDataDir: temp })
  const edits = createRemoteEditService({ resolveSession, sftpService: sftp, localPathService: local })
  cleanups.push(async () => { sftp.dispose(); local.dispose(); await peer.close(); await fs.rm(temp, { recursive: true, force: true }) })
  const connectionId = randomUUID(); const ownerId = 'fixture-owner'
  const open = (file: string) => edits.open({ connectionId, ownerId, generation, absolutePath: file })
  return { ...peer, edits, open, ownerId, reconnect() { generation++ } }
}

// Bun 1.3.11 on Windows crashes in raw-channel socket teardown (integer overflow).
// Do not skip the protocol checks: execute this exact suite under Node, like Electron main.
if (process.versions.bun) {
  it('executes all five real SFTP protocol cases under Node', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-save-node-runner-'))
    const config = path.join(temporary, 'vitest.config.mjs')
    await fs.writeFile(config, 'export default ' + JSON.stringify({ root, test: { environment: 'node', include: ['electron/services/managedResources/remoteEditSaveProtocol.test.ts'], maxWorkers: 1, minWorkers: 1, pool: 'forks', testTimeout: 10000 } }))
    try {
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn('node', [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config], { cwd: root, windowsHide: true })
        let output = ''
        const timer = setTimeout(() => child.kill(), 25000)
        child.stdout.on('data', data => { output += String(data) })
        child.stderr.on('data', data => { output += String(data) })
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('close', code => { clearTimeout(timer); resolve({ code, output }) })
      })
      expect(result.code, result.output).toBe(0)
      expect(result.output.replace(/\u001b\[[0-9;]*m/g, '')).toContain('5 passed')
    } finally { await fs.rm(temporary, { recursive: true, force: true }) }
  }, 30000)
} else describe('remote save over real SSH/SFTP v3 loopback', () => {
  it('negotiates POSIX replacement, saves twice, retains executable mode and never unlinks the target', async () => {
    const f = await fixture()
    f.seed('/workspace/example.sh', '# original\n')
    const opened = await f.open('/workspace/example.sh')
    const saved = await f.edits.save({ editId: opened.edit.id, baseRevision: opened.edit.baseRevision, ownerId: f.ownerId, text: '# edited 中文\n' })
    expect(f.read('/workspace/example.sh')?.data.toString()).toBe('# edited 中文\n')
    expect(saved.metadata.mode & 0o777).toBe(0o755)
    await f.edits.save({ editId: saved.edit.id, baseRevision: saved.edit.baseRevision, ownerId: f.ownerId, text: '# again\n' })
    expect(f.events).toEqual(['posix-rename@openssh.com', 'posix-rename@openssh.com'])
    expect(f.names()).toEqual(['/workspace/example.sh'])
  })
  it('retains the source when the server does not advertise atomic replacement', async () => {
    const f = await fixture(false)
    f.seed('/workspace/file.txt', 'original')
    const opened = await f.open('/workspace/file.txt')
    await expect(f.edits.save({ editId: opened.edit.id, baseRevision: opened.edit.baseRevision, ownerId: f.ownerId, text: 'edited' })).rejects.toThrow('ATOMIC_REPLACE_UNSUPPORTED')
    expect(f.read('/workspace/file.txt')?.data.toString()).toBe('original')
    expect(f.names()).toEqual(['/workspace/file.txt'])
    expect(f.events).not.toContain('rename')
  })
  it('maps real status 3 without disconnecting and permits retry with the same draft revision', async () => {
    const f = await fixture()
    f.seed('/workspace/file.txt', 'original')
    const opened = await f.open('/workspace/file.txt')
    const input = { editId: opened.edit.id, baseRevision: opened.edit.baseRevision, ownerId: f.ownerId, text: 'edited' }
    f.denyReplacement(3)
    await expect(f.edits.save(input)).rejects.toThrow('PERMISSION_DENIED')
    expect(f.read('/workspace/file.txt')?.data.toString()).toBe('original')
    f.denyReplacement(0)
    expect((await f.edits.save(input)).edit.text).toBe('edited')
    expect(f.names()).toEqual(['/workspace/file.txt'])
  })
  it('preserves UTF-8 BOM and CRLF on successful save', async () => {
    const f = await fixture()
    f.seed('/workspace/bom.txt', Buffer.from('\ufefforiginal\r\n'))
    const opened = await f.open('/workspace/bom.txt')
    await f.edits.save({ editId: opened.edit.id, baseRevision: opened.edit.baseRevision, ownerId: f.ownerId, text: 'edited\r\n' })
    expect(f.read('/workspace/bom.txt')?.data).toEqual(Buffer.from('\ufeffedited\r\n'))
  })
  it('rejects an external same-size same-mtime edit rather than overwriting it', async () => {
    const f = await fixture()
    f.seed('/workspace/file.txt', 'original')
    const opened = await f.open('/workspace/file.txt')
    f.read('/workspace/file.txt')!.data = Buffer.from('external')
    await expect(f.edits.save({ editId: opened.edit.id, baseRevision: opened.edit.baseRevision, ownerId: f.ownerId, text: 'edited' })).rejects.toThrow('REVISION_CONFLICT')
    expect(f.read('/workspace/file.txt')?.data.toString()).toBe('external')
    expect(f.events).toEqual([])
  })
})

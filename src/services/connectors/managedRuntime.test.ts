import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONNECTORS } from './catalog.js'
import { getArtifactPins, downloadVerified, managedInstallation, prepareManagedRuntime, runConnectorProcess, verifyIntegrity, type RuntimeDependencies } from './managedRuntime.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function root() { const path = await mkdtemp(join(tmpdir(), '连接器 with spaces ')); roots.push(path); return path }
const signal = () => new AbortController().signal
function fakeRuntime(platform = 'darwin', arch = 'arm64'): RuntimeDependencies {
  return {
    platform, arch,
    binaryIntegrity: () => 'sha256-' + createHash('sha256').update('binary').digest('hex'),
    download: async () => new TextEncoder().encode('verified package fixture'),
    extract: async () => new TextEncoder().encode('binary'),
    run: async () => ({ code: 0, stdout: 'fixture 1.0.95 1.0.61 1.2.1', stderr: '' }),
  }
}

describe('managed connector artifacts', () => {
  test('supports exactly published platform binaries and no global npm or HOME overrides', async () => {
    const directory = await root()
    for (const def of CONNECTORS) {
      for (const platform of ['darwin', 'win32']) for (const arch of ['arm64', 'x64']) {
        if (def.id === 'wecom' && platform === 'win32' && arch === 'arm64') {
          expect(() => managedInstallation(def, directory, fakeRuntime(platform, arch))).toThrow('unavailable')
          continue
        }
        const dep = fakeRuntime(platform, arch)
        const members: string[] = []
        dep.extract = async (_file, member) => { members.push(member); return new TextEncoder().encode('binary') }
        const result = await prepareManagedRuntime(def, directory, signal(), () => {}, dep)
        expect(result.command.startsWith(directory)).toBe(true)
        expect(result.command.endsWith(platform === 'win32' ? '.exe' : def.id === 'feishu' ? 'lark-cli' : def.id === 'dingtalk' ? 'dws' : 'wecom-cli')).toBe(true)
        expect(await readFile(result.command, 'utf8')).toBe('binary')
        expect(result.env.HOME).toBeUndefined()
        expect(result.env.USERPROFILE).toBeUndefined()
        if (def.id === 'dingtalk') {
          expect(result.env.DWS_KEYCHAIN_DIR).toStartWith(directory)
          expect(members).toHaveLength(2)
        }
      }
    }
  })

  test('failed staging leaves installed runtime intact and cleans partial artifacts', async () => {
    const def = CONNECTORS[0]!
    const directory = await root()
    const dep = fakeRuntime()
    const installed = managedInstallation(def, directory, dep)
    await mkdir(installed.directory, { recursive: true })
    await writeFile(installed.command, 'old binary')
    dep.run = async () => ({ code: 1, stdout: '', stderr: 'bad version' })
    await expect(prepareManagedRuntime(def, directory, signal(), () => {}, dep)).rejects.toThrow('version check')
    expect(await readFile(installed.command, 'utf8')).toBe('old binary')
    expect(await readdir(join(directory, 'runtime', def.id))).toEqual(['1.0.95-darwin-arm64'])
  })

  test('cached binary checksum is checked before execution and incorrect versions cannot pass', async () => {
    const directory = await root()
    const def = CONNECTORS[0]!
    const dep = fakeRuntime()
    const installed = managedInstallation(def, directory, dep)
    await mkdir(installed.directory, { recursive: true })
    await writeFile(installed.command, 'tampered binary')
    const executed: string[] = []
    dep.run = async (command) => { executed.push(command); return { code: 0, stdout: 'lark-cli version 1.0.950', stderr: '' } }
    await expect(prepareManagedRuntime(def, directory, signal(), () => {}, dep)).rejects.toThrow('version check')
    expect(executed).toHaveLength(1)
    expect(executed[0]).toContain('.stage-')
    expect(await readFile(installed.command, 'utf8')).toBe('tampered binary')
  })

  test('account directory preparation failures also clean staging', async () => {
    const directory = await root()
    await writeFile(join(directory, 'accounts'), 'not a directory')
    await expect(prepareManagedRuntime(CONNECTORS[1]!, directory, signal(), () => {}, fakeRuntime())).rejects.toThrow()
    expect(await readdir(join(directory, 'runtime', 'dingtalk'))).toEqual([])
  })

  test('cancelled download cleans staging and never publishes runtime', async () => {
    const directory = await root()
    const controller = new AbortController()
    const dep = fakeRuntime()
    dep.download = async () => { controller.abort(); controller.signal.throwIfAborted(); return new Uint8Array() }
    await expect(prepareManagedRuntime(CONNECTORS[0]!, directory, controller.signal, () => {}, dep)).rejects.toThrow()
    expect(await readdir(join(directory, 'runtime', 'feishu'))).toEqual([])
  })

  test('checks pinned integrity, including mirror content, not just HTTP success', async () => {
    const bytes = new TextEncoder().encode('pinned content')
    const integrity = 'sha256-' + createHash('sha256').update(bytes).digest('hex')
    expect(() => verifyIntegrity(bytes, integrity)).not.toThrow()
    expect(() => verifyIntegrity(new Uint8Array(), integrity)).toThrow('checksum')
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) { return new Response(new URL(request.url).pathname === '/primary' ? 'corrupt' : bytes) } })
    try {
      expect(await downloadVerified([`${server.url}primary`, `${server.url}mirror`], integrity, signal())).toEqual(Buffer.from(bytes))
      await expect(downloadVerified([`${server.url}primary`], integrity, signal())).rejects.toThrow('checksum')
    } finally { server.stop(true) }
  })
})

describe('managed process boundary', () => {
  test('uses argv without shell interpolation', async () => {
    const literal = '中文 path $HOME `echo secret` ; &'
    const result = await runConnectorProcess(process.execPath, ['-e', 'process.stdout.write(process.argv.at(-1))', literal], { signal: signal() })
    expect(result.stdout).toBe(literal)
  })
  test('kills timeout, cancellation and excessive output', async () => {
    await expect(runConnectorProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: signal(), timeoutMs: 20 })).rejects.toThrow('timed out')
    const controller = new AbortController()
    const running = runConnectorProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal })
    controller.abort()
    await expect(running).rejects.toThrow('cancelled')
    await expect(runConnectorProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(300000))'], { signal: signal() })).rejects.toThrow('size limit')
  })
})

test('released pins remain addressable by their exact installed version, never catalog latest', async () => {
  const installedDefinition = { ...CONNECTORS[0]!, version: '1.0.95' }
  const futureCatalogDefinition = { ...installedDefinition, version: '9.9.9' }
  expect(getArtifactPins(installedDefinition, 'darwin-arm64')).toEqual({
    archiveIntegrity: 'sha256-7ae7241b7de5ebfe86aa6b2b24af3600bd5019ec5b6206ea3bfdc0894f6fd925',
    binaryIntegrity: 'sha256-11a8ea5fe04b7874f6212c5ff018ef2003e529784fb283d3b39f9e470aa093f0',
  })
  expect(getArtifactPins(installedDefinition, 'win32-x64').binaryIntegrity).toBe('sha256-403b56ab849b28b4072b46799bd898959dc55382c18d7f4e83cd65f49f570b3f')
  expect(() => getArtifactPins(futureCatalogDefinition, 'darwin-arm64')).toThrow('no pinned artifact')
  const directory = await root()
  await expect(prepareManagedRuntime(futureCatalogDefinition, directory, signal(), () => {})).rejects.toThrow('no pinned artifact')
  expect(await readdir(directory)).toEqual([])
  // Only an explicitly injected fixture checksum admits unpublished versions.
  expect(getArtifactPins(futureCatalogDefinition, 'darwin-arm64', fakeRuntime()).binaryIntegrity).toBe(fakeRuntime().binaryIntegrity!(futureCatalogDefinition, 'darwin-arm64'))
})

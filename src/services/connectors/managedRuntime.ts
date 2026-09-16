import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ConnectorDefinition, ConnectorInstallation, ConnectorProgress } from './types.js'

export type ProcessResult = { code: number, stdout: string, stderr: string }
export type RunOptions = { env?: Record<string, string>, signal: AbortSignal, timeoutMs?: number, onOutput?: (text: string) => void }
export type RuntimeDependencies = {
  platform: string
  arch: string
  download: (urls: string[], integrity: string, signal: AbortSignal) => Promise<Uint8Array>
  extract: (archive: string, member: string, signal: AbortSignal) => Promise<Uint8Array>
  readBinary?: (command: string) => Promise<Uint8Array>
  binaryIntegrity?: (definition: ConnectorDefinition, target: string) => string
  run: (command: string, args: string[], options: RunOptions) => Promise<ProcessResult>
}

// Do not execute npm lifecycle scripts: these packages wrap native programs, and
// their postinstall scripts also install skills into unrelated user directories.
const larkArchiveHashesV1_0_95: Record<string, string> = {
  'darwin-arm64': '7ae7241b7de5ebfe86aa6b2b24af3600bd5019ec5b6206ea3bfdc0894f6fd925',
  'darwin-x64': 'b8b817e7ffe793c9be2579e0b3f9165610b01ca3d425a7b8ee6fb4d528dc6cef',
  'win32-x64': 'f2d5c3d6316b19ceec0996871ca4cff89541b82ed0d90220b3643ee0e84890a8',
  'win32-arm64': '61df77e3692b304959de43950c1b3337ce3d08aef09f73ca936d3afd4e536b0f',
}
const wecomArchiveHashesV1_2_1: Record<string, string> = {
  'darwin-arm64': 'HGNAdyvF48ktcxLaGNcKaXu51k0Wz/GTM2DCr3LiB9QLdJMpVcl/8vsjaFZp6LK7x9K84+I50pOjIteUCxuacg==',
  'darwin-x64': 'ekrGOIxy7RUvIJ13TNqsxii+Vk29U5vyeBAO0VhTfZGQ2hwxknBXc5Iw5ue7UlKIV0B01uJga/etxbnNjiHZng==',
  'win32-x64': 'fDiaE3M+BFuGY/nWstbnHgXp3tpjI30IClmVyWmQ7GnMMRHYMGxcCuAbvBZa9q4lQduJyg2AcHRzKTc1FIgBwQ==',
}
// SHA-256 of native members from the pinned upstream release/npm archives.
const initialBinaryHashes: Record<string, Record<string, string>> = {
  feishu: {
    'darwin-arm64': '11a8ea5fe04b7874f6212c5ff018ef2003e529784fb283d3b39f9e470aa093f0',
    'darwin-x64': '845dad439b91e67e7154f7e8668ad7f55228578800938ccb68523483de300353',
    'win32-x64': '403b56ab849b28b4072b46799bd898959dc55382c18d7f4e83cd65f49f570b3f',
    'win32-arm64': '467578b20b6e0ba8c8512329e933f017474f591db0346403515a45e7415224f7',
  },
  dingtalk: {
    'darwin-arm64': 'b41b5d3250fc809dbb80e1471b9a3768e0df3af088e296b457bd381f5e1df3de',
    'darwin-x64': '9522cd8bb1930716ea48fa3a4e13d9d54db28bd19e6551d1d6f64c005d618526',
    'win32-x64': '134111858af3ed250d294c9ed9c4ccfb6c46dd70df3bc5cefe78bd8f06ca90ef',
    'win32-arm64': '03e34a3b0229f73f7691626de3cc3e44ed95907dc43ba7a74ad2681a88225674',
  },
  wecom: {
    'darwin-arm64': '1c9df0f8f928718e99562ccf10f00e8177e4096d744589290f92dc778d44b747',
    'darwin-x64': 'f3f52f7da19be2fcf68f5605b806cc03e3f94f37469f97b4fe941e78a3014e72',
    'win32-x64': 'ea916883a0e4f779dbacaf7fdf99df532b67863062cd1d1bb5a558473e804a89',
  },
}
const dingArchiveIntegrityV1_0_61 = 'sha512-lYLLqE3jDRqzf3ekjaOnBqD222fsbRkEiO4GsR6k8aMiybEUTQDr7BC9/4Wtm2KeL+PiukBqfZ9EFULS22jdBA=='

type ArtifactVersionPins = { archives: Record<string, string>, binaries: Record<string, string> }

// Keep released versions when adding a catalog update: installed versions may
// still be active after a failed update or while restoring a previous plugin.
const artifactVersions: Record<string, Record<string, ArtifactVersionPins>> = {
  feishu: {
    '1.0.95': {
      archives: Object.fromEntries(Object.entries(larkArchiveHashesV1_0_95).map(([target, hash]) => [target, `sha256-${hash}`])),
      binaries: initialBinaryHashes.feishu!,
    },
  },
  dingtalk: {
    '1.0.61': {
      archives: Object.fromEntries(Object.keys(initialBinaryHashes.dingtalk!).map(target => [target, dingArchiveIntegrityV1_0_61])),
      binaries: initialBinaryHashes.dingtalk!,
    },
  },
  wecom: {
    '1.2.1': {
      archives: Object.fromEntries(Object.entries(wecomArchiveHashesV1_2_1).map(([target, hash]) => [target, `sha512-${hash}`])),
      binaries: initialBinaryHashes.wecom!,
    },
  },
}

export function getArtifactPins(definition: ConnectorDefinition, target: string, dependencies?: Pick<RuntimeDependencies, 'binaryIntegrity'>): { archiveIntegrity: string, binaryIntegrity: string } {
  const fixtureIntegrity = dependencies?.binaryIntegrity?.(definition, target)
  if (fixtureIntegrity) return { archiveIntegrity: fixtureIntegrity, binaryIntegrity: fixtureIntegrity }
  const version = artifactVersions[definition.id]?.[definition.version]
  const archiveIntegrity = version?.archives[target]
  const binaryHash = version?.binaries[target]
  if (!archiveIntegrity || !binaryHash) throw new Error('Untrusted connector version or platform: no pinned artifact')
  return { archiveIntegrity, binaryIntegrity: `sha256-${binaryHash}` }
}

export function verifyIntegrity(bytes: Uint8Array, integrity: string): void {
  const separator = integrity.indexOf('-')
  const algorithm = integrity.slice(0, separator)
  if (!['sha256', 'sha512'].includes(algorithm)) throw new Error('Unsupported artifact checksum')
  const actual = createHash(algorithm).update(bytes).digest(algorithm === 'sha256' ? 'hex' : 'base64')
  if (actual !== integrity.slice(separator + 1)) throw new Error('Connector artifact checksum mismatch')
}

export async function downloadVerified(urls: string[], integrity: string, signal: AbortSignal): Promise<Uint8Array> {
  for (let index = 0; index < urls.length; index++) {
    signal.throwIfAborted()
    try {
      const response = await fetch(urls[index]!, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) })
      if (!response.ok || !response.body) throw new Error('Connector download unavailable')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const item = await reader.read()
          if (item.done) break
          size += item.value.byteLength
          if (size > 128 * 1024 * 1024) throw new Error('Connector download exceeds size limit')
          chunks.push(item.value)
        }
      } finally { await reader.cancel() }
      const bytes = Buffer.concat(chunks)
      verifyIntegrity(bytes, integrity)
      return bytes
    } catch (error) {
      signal.throwIfAborted()
      if (index === urls.length - 1) throw error
    }
  }
  throw new Error('No connector download source')
}

function spawnCaptured(command: string, args: string[], options: RunOptions, limit: number): Promise<{ code: number, stdout: Buffer, stderr: Buffer }> {
  options.signal.throwIfAborted()
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...options.env }, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let failure: Error | undefined
    const stop = (error: Error) => {
      if (failure) return
      failure = error
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      } else if (child.pid) {
        // /T only traverses this managed CLI's descendants, never another app's daemon.
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
        killer.once('error', () => child.kill('SIGKILL'))
      } else child.kill('SIGKILL')
    }
    const abort = () => stop(new Error('Connector operation cancelled'))
    const timer = setTimeout(() => stop(new Error('Connector operation timed out')), options.timeoutMs ?? 30_000)
    options.signal.addEventListener('abort', abort, { once: true })
    const cleanup = () => { clearTimeout(timer); options.signal.removeEventListener('abort', abort) }
    const receive = (target: Buffer[]) => (data: Buffer) => {
      size += data.length
      if (size > limit) { stop(new Error('Connector output exceeds size limit')); return }
      target.push(data)
      options.onOutput?.(data.toString('utf8'))
    }
    child.stdout.on('data', receive(stdout))
    child.stderr.on('data', receive(stderr))
    child.once('error', (error) => { cleanup(); reject(error) })
    child.once('close', (code) => {
      cleanup()
      if (failure) reject(failure)
      else accept({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
    if (options.signal.aborted) abort()
  })
}

export async function runConnectorProcess(command: string, args: string[], options: RunOptions): Promise<ProcessResult> {
  const result = await spawnCaptured(command, args, options, 256 * 1024)
  return { code: result.code, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') }
}

export const defaultRuntimeDependencies: RuntimeDependencies = {
  platform: process.platform,
  arch: process.arch,
  download: downloadVerified,
  run: runConnectorProcess,
  async extract(archive, member, signal) {
    // macOS bsdtar and Windows 10+ bundled tar both support zip/tgz. Extract only
    // the known member to stdout, never archive paths into the filesystem.
    const result = await spawnCaptured('tar', ['-xOf', archive, member], { signal, timeoutMs: 60_000 }, 128 * 1024 * 1024)
    if (result.code !== 0) throw new Error('Cannot extract connector runtime (tar required)')
    return result.stdout
  },
}

export function managedInstallation(definition: ConnectorDefinition, root: string, dependencies = defaultRuntimeDependencies): ConnectorInstallation {
  const target = `${dependencies.platform}-${dependencies.arch}`
  if (!definition.platforms.includes(target)) throw new Error('Connector is unavailable for this platform')
  getArtifactPins(definition, target, dependencies)
  const directory = join(resolve(root), 'runtime', definition.id, `${definition.version}-${target}`)
  const executable = definition.id === 'feishu' ? 'lark-cli' : definition.id === 'dingtalk' ? 'dws' : 'wecom-cli'
  const home = join(resolve(root), 'accounts', definition.id)
  const env: Record<string, string> = definition.id === 'dingtalk' ? {
    DWS_CONFIG_DIR: join(home, 'dws'), DWS_KEYCHAIN_DIR: join(home, 'keychain'), DWS_DISABLE_KEYCHAIN: '1',
  } : {}
  return { directory, command: join(directory, executable + (dependencies.platform === 'win32' ? '.exe' : '')), args: [], env }
}

export async function verifyManagedBinary(definition: ConnectorDefinition, installation: ConnectorInstallation, dependencies = defaultRuntimeDependencies): Promise<void> {
  const { binaryIntegrity } = getArtifactPins(definition, `${dependencies.platform}-${dependencies.arch}`, dependencies)
  const bytes = await (dependencies.readBinary ?? readFile)(installation.command)
  verifyIntegrity(bytes, binaryIntegrity)
}

export async function prepareManagedRuntime(definition: ConnectorDefinition, root: string, signal: AbortSignal, progress: ConnectorProgress, dependencies = defaultRuntimeDependencies): Promise<ConnectorInstallation> {
  const installation = managedInstallation(definition, root, dependencies)
  const target = `${dependencies.platform}-${dependencies.arch}`
  const executable = installation.command.slice(installation.directory.length + 1)
  const { archiveIntegrity, binaryIntegrity } = getArtifactPins(definition, target, dependencies)
  const probe = async (command: string) => {
    verifyIntegrity(await readFile(command), binaryIntegrity)
    const result = await dependencies.run(command, ['--version'], { signal, env: installation.env })
    if (result.code !== 0 || !result.stdout.split(/[^0-9.]+/).includes(definition.version)) throw new Error('Connector runtime version check failed')
  }
  try { await probe(installation.command); return installation } catch { signal.throwIfAborted() }
  const stage = `${installation.directory}.stage-${randomUUID()}`
  const backup = `${installation.directory}.backup-${randomUUID()}`
  await mkdir(stage, { recursive: true, mode: 0o700 })
  let replaced = false
  try {
    for (const key of ['DWS_CONFIG_DIR', 'DWS_KEYCHAIN_DIR']) {
      if (installation.env[key]) await mkdir(installation.env[key]!, { recursive: true, mode: 0o700 })
    }
    progress('downloading')
    const os = dependencies.platform === 'win32' ? 'windows' : 'darwin'
    const arch = dependencies.arch === 'x64' ? 'amd64' : 'arm64'
    const suffix = os === 'windows' ? '.zip' : '.tar.gz'
    let urls: string[]
    let member = executable
    if (definition.id === 'feishu') {
      const asset = `lark-cli-${definition.version}-${os}-${arch}${suffix}`
      urls = [`https://github.com/larksuite/cli/releases/download/v${definition.version}/${asset}`, `https://registry.npmmirror.com/-/binary/lark-cli/v${definition.version}/${asset}`]
    } else {
      const path = definition.id === 'dingtalk' ? `dingtalk-workspace-cli/-/dingtalk-workspace-cli-${definition.version}.tgz` : `@wecom/cli-${target}/-/cli-${target}-${definition.version}.tgz`
      urls = [`https://registry.npmjs.org/${path}`, `https://registry.npmmirror.com/${path}`]
      member = definition.id === 'dingtalk' ? `package/assets/dws-${os}-${arch}${suffix}` : `package/bin/${executable}`
    }
    const archive = join(stage, 'artifact')
    await writeFile(archive, await dependencies.download(urls, archiveIntegrity, signal))
    progress('extracting')
    let binary = await dependencies.extract(archive, member, signal)
    if (definition.id === 'dingtalk') {
      const nested = join(stage, 'native-archive')
      await writeFile(nested, binary)
      binary = await dependencies.extract(nested, executable, signal)
      await rm(nested)
    }
    const stagedCommand = join(stage, executable)
    await writeFile(stagedCommand, binary, { mode: 0o700 })
    await chmod(stagedCommand, 0o700)
    await rm(archive)
    progress('verifying')
    await probe(stagedCommand)
    signal.throwIfAborted()
    try { await rename(installation.directory, backup); replaced = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try { await rename(stage, installation.directory) } catch (error) { if (replaced) await rename(backup, installation.directory); throw error }
    // Keep a previous installation until publication succeeds, then discard it.
    if (replaced) await rm(backup, { recursive: true, force: true })
    return installation
  } finally { await rm(stage, { recursive: true, force: true }) }
}

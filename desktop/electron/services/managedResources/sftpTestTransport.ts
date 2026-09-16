import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Client as SshClient, SFTPWrapper } from 'ssh2'
import type { SshSession } from './sshSessionService.js'

/**
 * Test-only in-process SFTP transport.
 *
 * The M4 owner-isolation tests must obtain transfer jobs and remote-edit
 * sessions from the real service code path (`startDownload` / `startUpload` /
 * `remoteEditService.open`), not by injecting pre-authorized state into the
 * production maps. The audit finding F30-03 removed the two seed helpers that
 * did exactly that, so this adapter implements the subset of the ssh2
 * `SFTPWrapper` surface `sftpService.ts` actually calls — `stat`, `open`,
 * `close`, `fastGet`, `createReadStream`, `createWriteStream`, `rename`,
 * `unlink`, `readdir`, `end` — backed by a real temp directory.
 *
 * Nothing here touches the network: the "remote" filesystem is a local
 * directory under the OS temp dir that is removed by `dispose()`.
 *
 * Never import this from production code.
 */

export type FakeSftpTransport = {
  readonly remoteRoot: string
  /** Writes a file into the fake remote filesystem. */
  seedFile: (remotePath: string, content: string | Buffer) => Promise<void>
  /** Reads a file back from the fake remote filesystem. */
  readFile: (remotePath: string) => Promise<Buffer>
  fileExists: (remotePath: string) => Promise<boolean>
  /** Generation handed to the services; bump it to simulate a reconnect. */
  setGeneration: (generation: number) => void
  /** `resolveSession` implementation for the M4 services. */
  resolveSession: (input: { connectionId: string; ownerId: string }) => {
    session: SshSession
    client: SshClient
    generation: number
  }
  dispose: () => Promise<void>
}

export async function createFakeSftpTransport(): Promise<FakeSftpTransport> {
  const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fake-sftp-'))
  let generation = 1
  const modes = new Map<string, number>()

  function toLocal(remotePath: string): string {
    if (typeof remotePath !== 'string' || !remotePath.startsWith('/')) {
      throw new Error('EINVAL: not an absolute posix path')
    }
    const segments = remotePath.split('/').filter(s => s.length > 0 && s !== '.')
    if (segments.some(s => s === '..')) throw new Error('EINVAL: parent traversal')
    return path.join(remoteRoot, ...segments)
  }

  async function statRemote(remotePath: string, noFollow = false) {
    const stats = await (noFollow ? fsp.lstat(toLocal(remotePath)) : fsp.stat(toLocal(remotePath)))
    // Mirror the ssh2 Stats shape that sftpService.ts reads.
    return {
      size: stats.size,
      mode: modes.get(remotePath) ?? stats.mode,
      mtime: stats.mtimeMs / 1000,
      mtimeMs: stats.mtimeMs,
      uid: 0,
      gid: 0,
      isFile: () => stats.isFile(),
      isDirectory: () => stats.isDirectory(),
      isSymbolicLink: () => stats.isSymbolicLink(),
    }
  }

  function createSftpWrapper(): SFTPWrapper {
    const emitter = new EventEmitter()
    const wrapper = {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        emitter.on(event, listener)
        return wrapper
      },
      once: (event: string, listener: (...args: unknown[]) => void) => {
        emitter.once(event, listener)
        return wrapper
      },
      off: (event: string, listener: (...args: unknown[]) => void) => {
        emitter.off(event, listener)
        return wrapper
      },
      removeListener: (event: string, listener: (...args: unknown[]) => void) => {
        emitter.off(event, listener)
        return wrapper
      },
      lstat(remotePath: string, cb: (err: unknown, attrs?: unknown) => void) {
        statRemote(remotePath, true).then(attrs => cb(null, attrs), err => cb(err))
      },
      mkdir(remotePath: string, options: { mode?: number }, cb: (err?: unknown) => void) {
        fsp.mkdir(toLocal(remotePath), { mode: options.mode }).then(() => cb(), cb)
      },
      rmdir(remotePath: string, cb: (err?: unknown) => void) {
        fsp.rmdir(toLocal(remotePath)).then(() => cb(), cb)
      },
      stat(remotePath: string, cb: (err: unknown, attrs?: unknown) => void) {
        statRemote(remotePath).then(attrs => cb(null, attrs), err => cb(err))
      },
      open(remotePath: string, _flags: string, cb: (err: unknown, handle?: unknown) => void) {
        fsp.access(toLocal(remotePath)).then(
          () => cb(null, { close: (done?: () => void) => done?.() }),
          err => cb(err),
        )
      },
      close(handle: { close?: () => void } | null, cb?: (err: unknown) => void) {
        try {
          handle?.close?.()
        } catch {
          // best effort, mirrors ssh2
        }
        cb?.(null)
      },
      fastGet(
        remotePath: string,
        localPath: string,
        options: { step?: (totalTransferred: number) => void } | undefined,
        cb: (err: unknown) => void,
      ) {
        fsp.stat(toLocal(remotePath)).then(async stats => {
          await fsp.copyFile(toLocal(remotePath), localPath)
          options?.step?.(stats.size)
          cb(null)
        }, err => cb(err))
      },
      createWriteStream(remotePath: string, options?: { flags?: string; mode?: number; highWaterMark?: number }) {
        return fs.createWriteStream(toLocal(remotePath), {
          flags: options?.flags ?? 'w',
          mode: options?.mode ?? 0o644,
          highWaterMark: options?.highWaterMark,
        })
      },
      createReadStream(remotePath: string, options?: { highWaterMark?: number }) {
        return fs.createReadStream(toLocal(remotePath), {
          highWaterMark: options?.highWaterMark,
        })
      },
      rename(fromRemotePath: string, toRemotePath: string, cb: (err: unknown) => void) {
        // SFTP v3 rejects an existing target; a filesystem rename alone hid this regression.
        fsp.lstat(toLocal(toRemotePath)).then(
          () => cb(Object.assign(new Error('Target exists'), { code: 4 })),
          err => {
            if (err.code !== 'ENOENT') { cb(err); return }
            wrapper.ext_openssh_rename(fromRemotePath, toRemotePath, cb)
          },
        )
      },
      chmod(remotePath: string, mode: number, cb: (err?: unknown) => void) {
        fsp.chmod(toLocal(remotePath), mode).then(() => { modes.set(remotePath, 0o100000 | mode); cb() }, cb)
      },
      ext_openssh_rename(fromRemotePath: string, toRemotePath: string, cb: (err: unknown) => void) {
        fsp.rename(toLocal(fromRemotePath), toLocal(toRemotePath)).then(() => {
          const mode = modes.get(fromRemotePath)
          if (mode !== undefined) { modes.set(toRemotePath, mode); modes.delete(fromRemotePath) }
          cb(null)
        }, err => cb(err))
      },
      unlink(remotePath: string, cb?: (err: unknown) => void) {
        fsp.unlink(toLocal(remotePath)).then(() => cb?.(null), () => cb?.(null))
      },
      readdir(remotePath: string, cb: (err: unknown, items?: unknown) => void) {
        fsp.readdir(toLocal(remotePath)).then(async names => {
          const items = []
          for (const filename of names) {
            const base = remotePath.endsWith('/') ? remotePath.slice(0, -1) : remotePath
            items.push({
              filename,
              longname: filename,
              attrs: await statRemote(`${base}/${filename}`),
            })
          }
          cb(null, items)
        }, err => cb(err))
      },
      end() {
        emitter.emit('end')
      },
      destroy() {
        emitter.emit('close')
      },
    }
    return wrapper as unknown as SFTPWrapper
  }

  const client = {
    sftp: (cb: (err: unknown, sftp?: SFTPWrapper) => void) => cb(null, createSftpWrapper()),
  } as unknown as SshClient

  const session = { id: 'fake-session' } as unknown as SshSession

  return {
    remoteRoot,
    async seedFile(remotePath, content) {
      const target = toLocal(remotePath)
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.writeFile(target, content)
    },
    async readFile(remotePath) {
      return fsp.readFile(toLocal(remotePath))
    },
    async fileExists(remotePath) {
      try {
        const stats = await fsp.stat(toLocal(remotePath))
        return stats.isFile()
      } catch {
        return false
      }
    },
    setGeneration(next) {
      generation = next
    },
    resolveSession() {
      return { session, client, generation }
    },
    async dispose() {
      await fsp.rm(remoteRoot, { recursive: true, force: true })
    },
  }
}

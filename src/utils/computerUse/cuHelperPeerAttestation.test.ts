import { describe, expect, test } from 'bun:test'
import { EventEmitter, once } from 'node:events'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  readSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, createServer, type Socket } from 'node:net'
import {
  attestDaemonSocketPeer,
  runVerifierWithSocket,
  type UnixPeerIdentity,
} from './cuHelperPeerAttestation.js'

class FakeSocket extends EventEmitter {
  _handle = { fd: 91 }
}

describe('reverse cu-helper daemon attestation', () => {
  const peer: UnixPeerIdentity = { pid: 4242 }

  test('passes the connected socket to a packaged signed helper verifier', async () => {
    const calls: { file: string; args: string[]; peerFd: number }[] = []
    const pathRoot = mkdtempSync(join(tmpdir(), 'cc-haha-peer-path-'))
    const expectedPath = join(pathRoot, 'cc-haha-computer-use')
    writeFileSync(expectedPath, '')
    try {
      const result = await attestDaemonSocketPeer(
        new FakeSocket() as never,
        expectedPath,
        {
        resolveVerifierBinary: () => '/packaged/cc-haha-computer-use',
        runVerifier: async (file, args, peerFd) => {
          calls.push({ file, args, peerFd })
          return {
            code: 0,
            stdout: '{"ok":true,"result":{"trusted":true,"pid":4242}}',
            stderr: '',
          }
        },
        },
      )

      expect(result).toEqual(peer)
      expect(calls).toEqual([{
        file: '/packaged/cc-haha-computer-use',
        args: [
          'attest_daemon_peer',
          '--payload',
          JSON.stringify({ executablePath: realpathSync(expectedPath) }),
        ],
        peerFd: 91,
      }])
    } finally {
      rmSync(pathRoot, { recursive: true, force: true })
    }
  })

  test('fails closed for a missing descriptor, verifier, malformed output, or denied peer', async () => {
    const socket = new FakeSocket() as never

    await expect(attestDaemonSocketPeer(
      new EventEmitter() as never,
      '/installed/helper',
      { resolveVerifierBinary: () => '/packaged/helper' },
    )).resolves.toBeNull()

    await expect(attestDaemonSocketPeer(socket, '/installed/helper', {
      resolveVerifierBinary: () => null,
    })).resolves.toBeNull()

    await expect(attestDaemonSocketPeer(socket, '/installed/helper', {
      canonicalizeExpectedPath: value => value,
      resolveVerifierBinary: () => '/packaged/helper',
      runVerifier: async () => ({ code: 0, stdout: 'not-json', stderr: '' }),
    })).resolves.toBeNull()

    await expect(attestDaemonSocketPeer(socket, '/installed/helper', {
      canonicalizeExpectedPath: value => value,
      resolveVerifierBinary: () => '/packaged/helper',
      runVerifier: async () => ({
        code: 0,
        stdout: '{"ok":true,"result":{"trusted":false,"pid":4242}}',
        stderr: '',
      }),
    })).resolves.toBeNull()

    await expect(attestDaemonSocketPeer(socket, '/installed/helper', {
      canonicalizeExpectedPath: value => value,
      resolveVerifierBinary: () => '/packaged/helper',
      runVerifier: async () => ({
        code: 0,
        stdout: '{"ok":true,"result":{"trusted":true,"pid":4242}}',
        stderr: '',
        error: 'daemon peer verifier timed out',
      }),
    })).resolves.toBeNull()
  })

  test('hard timeout reaps the direct verifier without consuming the parent descriptor', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'cc-haha-peer-timeout-'))
    const socketPath = join(fixtureRoot, 'peer.sock')

    const server = createServer()
    let client: Socket | undefined
    let serverSocket: Socket | undefined
    let verifierPid: number | undefined
    let inheritedFile: number | undefined
    try {
      if (process.platform === 'win32') server.listen(0, '127.0.0.1')
      else server.listen(socketPath)
      await once(server, 'listening')
      const accepted = once(server, 'connection')
      const address = server.address()
      client = typeof address === 'object' && address
        ? createConnection({ host: '127.0.0.1', port: address.port })
        : createConnection(socketPath)
      await once(client, 'connect')
      const acceptedSockets = await accepted
      serverSocket = acceptedSockets[0] as Socket
      // Windows cannot inherit a socket as POSIX fd 3. Exercise the same
      // subprocess timeout and ownership contract with a real file descriptor.
      if (process.platform === 'win32') {
        const descriptorFixture = join(fixtureRoot, 'descriptor.txt')
        writeFileSync(descriptorFixture, 'parent-owned')
        inheritedFile = openSync(descriptorFixture, 'r')
      }
      const peerFd = inheritedFile ?? (client as unknown as { _handle: { fd: number } })._handle.fd

      const startedAt = performance.now()
      const result = await runVerifierWithSocket(
        process.execPath,
        ['--no-env-file', '-e', 'setInterval(() => {}, 60000)'],
        peerFd,
        50,
      )
      expect(performance.now() - startedAt).toBeLessThan(1_000)
      expect(result.error).toBe('daemon peer verifier timed out')
      verifierPid = result.pid ?? -1
      expect(Number.isSafeInteger(verifierPid)).toBe(true)
      let verifierExited = false
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          process.kill(verifierPid, 0)
        } catch {
          verifierExited = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(verifierExited).toBe(true)
      if (inheritedFile !== undefined) {
        const buffer = Buffer.alloc(12)
        expect(readSync(inheritedFile, buffer, 0, 12, 0)).toBe(12)
        expect(buffer.toString()).toBe('parent-owned')
      }

      const received = once(serverSocket, 'data')
      client.write('still-open')
      const [chunk] = await received
      expect(String(chunk)).toBe('still-open')

      const ended = once(serverSocket, 'end')
      client.end()
      await ended
    } finally {
      client?.destroy()
      serverSocket?.destroy()
      if (verifierPid && verifierPid > 0) {
        try {
          process.kill(verifierPid, 'SIGKILL')
        } catch {
          // Already reaped is the expected path.
        }
      }
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      if (inheritedFile !== undefined) closeSync(inheritedFile)
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  test('does not use Bun FFI inside the hardened signed sidecar', () => {
    const source = readFileSync(
      new URL('./cuHelperPeerAttestation.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toContain('bun:ffi')
    expect(source).not.toContain('dlopen')
  })
})

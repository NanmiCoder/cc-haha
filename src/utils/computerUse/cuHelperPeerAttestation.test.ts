import { describe, expect, test } from 'bun:test'
import { EventEmitter, once } from 'node:events'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
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
    const pathRoot = mkdtempSync('/tmp/cc-haha-peer-path-')
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

  test.skipIf(process.platform === 'win32')('hard timeout reaps the direct verifier without consuming the parent socket', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'cc-haha-peer-timeout-'))
    const socketPath = join(fixtureRoot, 'peer.sock')

    const server = createServer()
    let client: Socket | undefined
    let serverSocket: Socket | undefined
    let verifierPid: number | undefined
    try {
      server.listen(socketPath)
      await once(server, 'listening')
      const accepted = once(server, 'connection')
      client = createConnection(socketPath)
      await once(client, 'connect')
      const acceptedSockets = await accepted
      serverSocket = acceptedSockets[0] as Socket
      const peerFd = (client as unknown as { _handle: { fd: number } })._handle.fd

      const startedAt = performance.now()
      const result = await runVerifierWithSocket(
        '/bin/sleep',
        ['60'],
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
      if (server.listening) server.close()
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

import { generateKeyPairSync } from 'node:crypto'
import { Client, Server, type Connection, type ServerChannel } from 'ssh2'

// Test-only SFTP v3 peer: real SSH framing and extension negotiation, isolated in-memory files.
// It deliberately rejects ordinary RENAME when the destination exists, like OpenSSH.
export async function createSftpSaveProtocolFixture(advertiseExtension = true) {
  const files = new Map<string, { data: Buffer; mode: number; mtime: number }>()
  const events: string[] = []
  const peers = new Set<Connection>()
  let tick = 1_700_000_000
  let replacementError = 0
  const uint = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
  const str = (value: string | Buffer) => { const b = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([uint(b.length), b]) }
  const attrs = (mode: number, size: number, mtime: number) => {
    const b = Buffer.alloc(24)
    b.writeUInt32BE(13); b.writeBigUInt64BE(BigInt(size), 4); b.writeUInt32BE(mode, 12)
    b.writeUInt32BE(mtime, 16); b.writeUInt32BE(mtime, 20)
    return b
  }
  function serve(channel: ServerChannel) {
    let pending = Buffer.alloc(0)
    let nextHandle = 0
    const handles = new Map<string, { name: string; write: boolean }>()
    const send = (type: number, body: Buffer) => channel.write(Buffer.concat([uint(body.length + 1), Buffer.from([type]), body]))
    const status = (id: number, code = 0) => send(101, Buffer.concat([uint(id), uint(code), str('fixture status'), str('en')]))
    channel.on('error', () => {})
    channel.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
        const length = pending.readUInt32BE(0)
        const packet = pending.subarray(4, 4 + length)
        pending = pending.subarray(4 + length)
        let cursor = 1
        const number = () => { const n = packet.readUInt32BE(cursor); cursor += 4; return n }
        const bytes = () => { const length = number(); const b = packet.subarray(cursor, cursor + length); cursor += length; return b }
        const text = () => bytes().toString()
        const offset = () => { const n = Number(packet.readBigUInt64BE(cursor)); cursor += 8; return n }
        const type = packet[0]
        if (type === 1) {
          send(2, Buffer.concat([uint(3), ...(advertiseExtension ? [str('posix-rename@openssh.com'), str('1')] : [])]))
          continue
        }
        const id = number()
        try {
          if (type === 7 || type === 17) {
            const name = text(); const file = files.get(name)
            if (name === '/' || name === '/workspace') send(105, Buffer.concat([uint(id), attrs(0o040755, 0, tick)]))
            else if (file) send(105, Buffer.concat([uint(id), attrs(file.mode, file.data.length, file.mtime)]))
            else status(id, 2)
          } else if (type === 3) {
            const name = text(); const flags = number(); const attrFlags = number()
            if (attrFlags & 1) offset()
            if (attrFlags & 2) { number(); number() }
            const mode = attrFlags & 4 ? number() : 0o644
            const previous = files.get(name)
            if (previous && (flags & 32)) { status(id, 4); continue }
            if (!previous && !(flags & 8)) { status(id, 2); continue }
            if (!previous || flags & 16) files.set(name, { data: Buffer.alloc(0), mode: 0o100000 | mode, mtime: ++tick })
            const handle = String(++nextHandle)
            handles.set(handle, { name, write: Boolean(flags & 2) })
            send(102, Buffer.concat([uint(id), str(handle)]))
          } else if (type === 4) {
            const handle = text(); const held = handles.get(handle)
            if (held?.write) files.get(held.name)!.mtime = ++tick
            handles.delete(handle); status(id)
          } else if (type === 5 || type === 6) {
            const held = handles.get(text())
            if (!held) { status(id, 4); continue }
            const file = files.get(held.name)!
            const position = offset()
            if (type === 5) {
              const count = number()
              if (position >= file.data.length) status(id, 1)
              else send(103, Buffer.concat([uint(id), str(file.data.subarray(position, position + count))]))
            } else {
              const data = bytes()
              const result = Buffer.alloc(Math.max(file.data.length, position + data.length))
              file.data.copy(result); data.copy(result, position); file.data = result; status(id)
            }
          } else if (type === 9) {
            const file = files.get(text()); const flags = number()
            if (!file) { status(id, 2); continue }
            if (flags & 1) offset()
            if (flags & 2) { number(); number() }
            if (flags & 4) file.mode = 0o100000 | number()
            status(id)
          } else if (type === 13) {
            const name = text(); events.push('unlink:' + name); files.delete(name); status(id)
          } else if (type === 18 || type === 200) {
            const extension = type === 200 ? text() : ''
            const from = text(); const to = text()
            events.push(type === 18 ? 'rename' : extension)
            if (type === 200 && extension !== 'posix-rename@openssh.com') { status(id, 8); continue }
            if (replacementError) { status(id, replacementError); continue }
            if (type === 18 && files.has(to)) { status(id, 4); continue }
            const file = files.get(from)
            if (!file) { status(id, 2); continue }
            files.set(to, file); files.delete(from); status(id)
          } else status(id, 8)
        } catch { status(id, 4) }
      }
    })
  }
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs1' }, publicKeyEncoding: { format: 'pem', type: 'spki' } }).privateKey
  const server = new Server({ hostKeys: [key] }, peer => {
    peers.add(peer); peer.on('close', () => peers.delete(peer)); peer.on('error', () => {})
    peer.on('authentication', context => { if (context.method === 'password' && context.username === 'fixture' && context.password === 'fixture-only') context.accept(); else context.reject() })
    peer.on('ready', () => peer.on('session', accept => {
      const session = accept()
      // The generic subsystem event exposes a raw channel: no mocked client extension registry.
      session.on('subsystem', (acceptSubsystem, reject, info) => { if (info.name === 'sftp') serve(acceptSubsystem()); else reject() })
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = new Client()
  client.on('error', () => {})
  await new Promise<void>((resolve, reject) => {
    client.once('ready', resolve); client.once('error', reject)
    client.connect({ host: '127.0.0.1', port: (server.address() as { port: number }).port, username: 'fixture', password: 'fixture-only', readyTimeout: 5000 })
  })
  return {
    client, events,
    seed(name: string, data: string | Buffer, mode = 0o755) { files.set(name, { data: Buffer.from(data), mode: 0o100000 | mode, mtime: ++tick }) },
    read(name: string) { return files.get(name) },
    names() { return [...files.keys()].sort() },
    denyReplacement(code: number) { replacementError = code },
    async close() {
      client.destroy()
      // Raw subsystem channels can hold a graceful SSH close open under Bun. Destroy only this fixture's sockets.
      for (const peer of peers) {
        peer.end()
        ;(peer as Connection & { _sock: { destroy(): void } })._sock.destroy()
      }
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

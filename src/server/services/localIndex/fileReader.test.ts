import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SourceReadRetryError,
  readCompleteJsonlRange,
  type FileReaderIo,
  type ReadonlyFileHandle,
} from './fileReader.js'

const tempDirs: string[] = []

async function tempFile(contents: string | Buffer): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cc-haha-file-reader-'))
  tempDirs.push(root)
  const path = join(root, 'session.jsonl')
  await writeFile(path, contents)
  return path
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('readCompleteJsonlRange', () => {
  it('returns byte-exact contiguous chunks across UTF-8 buffer splits and CRLF', async () => {
    const prefixBytes = 64 * 1024 - 2
    const first = `${'x'.repeat(prefixBytes)}你\r\n`
    const second = '{"type":"assistant"}\n'
    const path = await tempFile(`${first}${second}`)
    const metrics = { filesOpened: 0, bytesRead: 0, statCalls: 0 }

    const result = await readCompleteJsonlRange({ path, start: 0, metrics })

    expect(result.chunks).toEqual([
      { text: first, byteStart: 0, completeLine: true },
      { text: second, byteStart: Buffer.byteLength(first), completeLine: true },
    ])
    expect(result.nextOffset).toBe(Buffer.byteLength(first) + Buffer.byteLength(second))
    expect(result.pendingTailBytes).toBe(0)
    expect(metrics).toEqual({
      filesOpened: 1,
      bytesRead: Buffer.byteLength(first) + Buffer.byteLength(second),
      statCalls: 3,
    })
  })

  it('starts at an exact byte offset and retains the incomplete tail', async () => {
    const skipped = '{"skip":true}\n'
    const complete = '{"type":"user","content":"你好"}\n'
    const partial = '{"type":"assistant"'
    const path = await tempFile(`${skipped}${complete}${partial}`)
    const start = Buffer.byteLength(skipped)

    const result = await readCompleteJsonlRange({ path, start })

    expect(result.chunks).toEqual([
      { text: complete, byteStart: start, completeLine: true },
      {
        text: partial,
        byteStart: start + Buffer.byteLength(complete),
        completeLine: false,
      },
    ])
    expect(result.nextOffset).toBe(start + Buffer.byteLength(complete))
    expect(result.pendingTailBytes).toBe(Buffer.byteLength(partial))
  })

  it('returns no chunks for an empty file', async () => {
    const path = await tempFile('')

    expect(await readCompleteJsonlRange({ path, start: 0 })).toEqual({
      chunks: [],
      nextOffset: 0,
      pendingTailBytes: 0,
    })
  })

  it('continues after deterministic short reads and closes the read-only handle', async () => {
    const payload = Buffer.from('{}\n{"tail":true}')
    let offset = 0
    let closeCalls = 0
    const handle: ReadonlyFileHandle = {
      async stat() {
        return { size: payload.length, mtimeMs: 1, dev: 2, ino: 3 }
      },
      async read(buffer, bufferOffset, length, position) {
        expect(position).toBe(offset)
        const bytesRead = Math.min(2, length, payload.length - offset)
        payload.copy(buffer, bufferOffset, offset, offset + bytesRead)
        offset += bytesRead
        return { bytesRead }
      },
      async close() {
        closeCalls += 1
      },
    }
    const io: FileReaderIo = {
      async openReadonly(_path, flags) {
        expect(flags).toBe('r')
        return handle
      },
      async statPath() {
        return { size: payload.length, mtimeMs: 1, dev: 2, ino: 3 }
      },
    }
    const metrics = { filesOpened: 0, bytesRead: 0, statCalls: 0 }

    const result = await readCompleteJsonlRange({ path: '/synthetic', start: 0, metrics }, io)

    expect(result).toEqual({
      chunks: [
        { text: '{}\n', byteStart: 0, completeLine: true },
        { text: '{"tail":true}', byteStart: 3, completeLine: false },
      ],
      nextOffset: 3,
      pendingTailBytes: Buffer.byteLength('{"tail":true}'),
    })
    expect(metrics).toEqual({ filesOpened: 1, bytesRead: payload.length, statCalls: 3 })
    expect(closeCalls).toBe(1)
  })

  it.each([
    ['is appended during the read', 'append'],
    ['is replaced after the read', 'replace'],
    ['is deleted after the read', 'delete'],
  ] as const)('requests a retry when the source %s', async (_label, race) => {
    const payload = Buffer.from('{}\n')
    let handleStatCalls = 0
    let closeCalls = 0
    const handle: ReadonlyFileHandle = {
      async stat() {
        handleStatCalls += 1
        return {
          size: race === 'append' && handleStatCalls > 1 ? payload.length + 1 : payload.length,
          mtimeMs: race === 'append' && handleStatCalls > 1 ? 2 : 1,
          dev: 2,
          ino: 3,
        }
      },
      async read(buffer, bufferOffset, length, position) {
        const bytesRead = Math.min(length, payload.length - position)
        payload.copy(buffer, bufferOffset, position, position + bytesRead)
        return { bytesRead }
      },
      async close() {
        closeCalls += 1
      },
    }
    const io: FileReaderIo = {
      async openReadonly() {
        return handle
      },
      async statPath() {
        if (race === 'delete') {
          const error = new Error('gone') as NodeJS.ErrnoException
          error.code = 'ENOENT'
          throw error
        }
        return {
          size: payload.length,
          mtimeMs: race === 'replace' ? 2 : 1,
          dev: 2,
          ino: race === 'replace' ? 4 : 3,
        }
      },
    }

    await expect(readCompleteJsonlRange({ path: '/synthetic', start: 0 }, io)).rejects.toMatchObject({
      name: SourceReadRetryError.name,
      change: { kind: 'retry', reason: 'changed-during-read' },
    })
    expect(closeCalls).toBe(1)
  })

  it('maps open and stat failures to transient retry and still closes opened handles', async () => {
    const openFailureIo: FileReaderIo = {
      async openReadonly() {
        const error = new Error('busy') as NodeJS.ErrnoException
        error.code = 'EBUSY'
        throw error
      },
      async statPath() {
        throw new Error('unreachable')
      },
    }

    await expect(readCompleteJsonlRange(
      { path: '/synthetic', start: 0 },
      openFailureIo,
    )).rejects.toMatchObject({
      change: { kind: 'retry', reason: 'transient-io' },
    })

    const payload = Buffer.from('{}\n')
    let closeCalls = 0
    const finalStatFailureIo: FileReaderIo = {
      async openReadonly() {
        return {
          async stat() {
            return { size: payload.length, mtimeMs: 1, dev: 2, ino: 3 }
          },
          async read(buffer, offset, length, position) {
            const bytesRead = Math.min(length, payload.length - position)
            payload.copy(buffer, offset, position, position + bytesRead)
            return { bytesRead }
          },
          async close() {
            closeCalls += 1
          },
        }
      },
      async statPath() {
        const error = new Error('busy') as NodeJS.ErrnoException
        error.code = 'EBUSY'
        throw error
      },
    }

    await expect(readCompleteJsonlRange(
      { path: '/synthetic', start: 0 },
      finalStatFailureIo,
    )).rejects.toMatchObject({
      change: { kind: 'retry', reason: 'transient-io' },
    })
    expect(closeCalls).toBe(1)
  })
})

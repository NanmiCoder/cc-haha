import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AttachmentStore } from '../../common/attachment/attachment-store.js'
import { collectWecomMediaCandidates, WecomMediaService } from '../media.js'

let tmpDir: string
let store: AttachmentStore

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-media-test-'))
  store = new AttachmentStore({ root: tmpDir })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('collectWecomMediaCandidates', () => {
  it('picks up an image with its per-download AES key', () => {
    const candidates = collectWecomMediaCandidates({
      msgid: 'm1',
      msgtype: 'image',
      image: { url: 'https://cdn.example/img', aeskey: 'key-1' },
    })

    expect(candidates).toEqual([
      { kind: 'image', name: 'wecom-image-m1.jpg', url: 'https://cdn.example/img', aesKey: 'key-1', mimeType: 'image/jpeg' },
    ])
  })

  it('picks up a file message', () => {
    const candidates = collectWecomMediaCandidates({
      msgid: 'm2',
      msgtype: 'file',
      file: { url: 'https://cdn.example/doc', aeskey: 'key-2' },
    })

    expect(candidates).toMatchObject([{ kind: 'file', url: 'https://cdn.example/doc', aesKey: 'key-2' }])
  })

  it('picks up every image inside a mixed message', () => {
    const candidates = collectWecomMediaCandidates({
      msgid: 'm3',
      msgtype: 'mixed',
      mixed: {
        msg_item: [
          { msgtype: 'text' },
          { msgtype: 'image', image: { url: 'https://cdn.example/a' } },
          { msgtype: 'image', image: { url: 'https://cdn.example/b' } },
        ],
      },
    })

    expect(candidates.map((item) => item.url)).toEqual(['https://cdn.example/a', 'https://cdn.example/b'])
  })

  // Voice arrives already transcribed, so downloading the audio would attach a
  // file the Agent cannot read.
  it('ignores a voice message', () => {
    expect(collectWecomMediaCandidates({ msgid: 'm4', msgtype: 'voice', voice: { content: 'hi' } }))
      .toEqual([])
  })

  it('ignores media entries with no download URL', () => {
    expect(collectWecomMediaCandidates({ msgid: 'm5', msgtype: 'image', image: { aeskey: 'k' } }))
      .toEqual([])
    expect(collectWecomMediaCandidates(undefined)).toEqual([])
  })
})

describe('WecomMediaService', () => {
  it('stages the decrypted bytes and prefers the name the download reports', async () => {
    const service = new WecomMediaService(store, async () => ({
      buffer: Buffer.from('file body'),
      filename: 'report.pdf',
    }))

    const local = await service.downloadCandidate(
      { kind: 'file', name: 'wecom-file-m1', url: 'https://cdn.example/doc', aesKey: 'k' },
      'session-1',
    )

    expect(local.name).toBe('report.pdf')
    expect(local.kind).toBe('file')
    expect(local.mimeType).toBe('application/pdf')
    expect(fs.readFileSync(local.path, 'utf8')).toBe('file body')
  })

  it('passes the AES key through to the download', async () => {
    const seen: Array<[string, string | undefined]> = []
    const service = new WecomMediaService(store, async (url, aesKey) => {
      seen.push([url, aesKey])
      return { buffer: Buffer.from('x') }
    })

    await service.downloadCandidate(
      { kind: 'image', name: 'a.jpg', url: 'https://cdn.example/img', aesKey: 'secret-key' },
      'session-1',
    )

    expect(seen).toEqual([['https://cdn.example/img', 'secret-key']])
  })

  // A `file` message carrying a PNG is an image to the Agent, and the size
  // limits differ, so the resolved MIME wins over the message's own shape.
  it('reclassifies a file message that turns out to be an image', async () => {
    const service = new WecomMediaService(store, async () => ({
      buffer: Buffer.from('png bytes'),
      filename: 'diagram.png',
    }))

    const local = await service.downloadCandidate(
      { kind: 'file', name: 'wecom-file-m1', url: 'https://cdn.example/doc' },
      'session-1',
    )

    expect(local.kind).toBe('image')
    expect(local.mimeType).toBe('image/png')
  })
})

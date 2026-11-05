import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { IMAGE_MAX_BYTES } from '../attachment-limits.js'
import { loadSafeOutboundImage, sendSafeOutboundImage } from '../outbound-image.js'

const temporaryRoots: string[] = []
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUioAAAAASUVORK5CYII=', 'base64')

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('loadSafeOutboundImage', () => {
  it('derives local image MIME from its signature instead of an Agent label or extension', async () => {
    const root = makeTempRoot('outbound-formats-')
    for (const [expected, buffer] of [
      ['image/png', png],
      ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
      ['image/gif', Buffer.from('GIF89afixture')],
      ['image/webp', Buffer.from('RIFF0000WEBPfixture')],
    ] as const) {
      const imagePath = path.join(root, '..image.dat')
      fs.writeFileSync(imagePath, buffer)
      const result = await loadSafeOutboundImage({ id: expected, source: { kind: 'path', path: imagePath } }, root)
      expect(result).toEqual({ ok: true, buffer, mime: expected })
    }
  })

  it('requires an active session work directory', async () => {
    const result = await loadSafeOutboundImage({
      id: 'missing-session',
      source: { kind: 'base64', data: 'cG5n', mime: 'image/png' },
    }, null)

    expect(result).toEqual({
      ok: false,
      reason: 'missing session work directory',
    })
  })

  it('loads a bounded image inside the active session work directory', async () => {
    const root = makeTempRoot('outbound-root-')
    const imagePath = path.join(root, 'result.png')
    fs.writeFileSync(imagePath, png)

    const result = await loadSafeOutboundImage({
      id: 'inside',
      source: { kind: 'path', path: imagePath, mime: 'image/png' },
    }, root)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.buffer).toEqual(png)
  })

  it('rejects paths outside the session root, including symlink escapes', async () => {
    const root = makeTempRoot('outbound-root-')
    const outside = makeTempRoot('outbound-outside-')
    const secretPath = path.join(outside, 'secret.png')
    const symlinkRoot = path.join(root, 'escape')
    const symlinkPath = path.join(symlinkRoot, 'secret.png')
    fs.writeFileSync(secretPath, Buffer.from('secret'))
    fs.symlinkSync(outside, symlinkRoot, process.platform === 'win32' ? 'junction' : 'dir')

    const direct = await loadSafeOutboundImage({
      id: 'outside',
      source: { kind: 'path', path: secretPath, mime: 'image/png' },
    }, root)
    const symlink = await loadSafeOutboundImage({
      id: 'symlink',
      source: { kind: 'path', path: symlinkPath, mime: 'image/png' },
    }, root)

    expect(direct).toEqual({
      ok: false,
      reason: 'image path is outside the active session work directory',
    })
    expect(symlink).toEqual(direct)
  })

  it('rejects missing paths and directories', async () => {
    const root = makeTempRoot('outbound-root-')
    const directory = path.join(root, 'directory.png')
    fs.mkdirSync(directory)

    const missing = await loadSafeOutboundImage({
      id: 'missing',
      source: { kind: 'path', path: path.join(root, 'missing.png'), mime: 'image/png' },
    }, root)
    const notFile = await loadSafeOutboundImage({
      id: 'directory',
      source: { kind: 'path', path: directory, mime: 'image/png' },
    }, root)

    expect(missing).toEqual({ ok: false, reason: 'image path does not exist' })
    expect(notFile).toEqual({ ok: false, reason: 'image path is not a regular file' })
  })

  it('never fetches remote URLs from Agent-authored markdown', async () => {
    const root = makeTempRoot('outbound-root-')
    const result = await loadSafeOutboundImage({
      id: 'url',
      source: { kind: 'url', url: 'http://127.0.0.1:3456/private' },
    }, root)

    expect(result).toEqual({
      ok: false,
      reason: 'remote image URLs are not fetched from Agent output',
    })
  })

  it('rejects oversized local files before buffering them', async () => {
    const root = makeTempRoot('outbound-root-')
    const imagePath = path.join(root, 'large.png')
    fs.writeFileSync(imagePath, Buffer.alloc(IMAGE_MAX_BYTES + 1))

    const result = await loadSafeOutboundImage({
      id: 'large',
      source: { kind: 'path', path: imagePath, mime: 'image/png' },
    }, root)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('图片过大')
  })

  it('preflights base64 size and MIME before decoding', async () => {
    const root = makeTempRoot('outbound-root-')
    const allowed = await loadSafeOutboundImage({
      id: 'base64',
      source: { kind: 'base64', data: 'cG5n', mime: 'image/png' },
    }, root)
    const unsupported = await loadSafeOutboundImage({
      id: 'svg',
      source: { kind: 'base64', data: 'AAAA', mime: 'image/svg+xml' },
    }, root)
    const oversized = await loadSafeOutboundImage({
      id: 'large-base64',
      source: {
        kind: 'base64',
        data: 'A'.repeat(Math.ceil((IMAGE_MAX_BYTES + 1) * 4 / 3)),
        mime: 'image/png',
      },
    }, root)

    expect(allowed.ok).toBe(true)
    if (allowed.ok) expect(allowed.buffer.toString()).toBe('png')
    expect(unsupported.ok).toBe(false)
    expect(oversized.ok).toBe(false)
  })

  it('only calls the platform sender after the image passes validation', async () => {
    const root = makeTempRoot('outbound-root-')
    const imagePath = path.join(root, 'result.png')
    fs.writeFileSync(imagePath, png)
    const sent: string[] = []

    const allowed = await sendSafeOutboundImage({
      id: 'inside',
      source: { kind: 'path', path: imagePath, mime: 'image/png' },
    }, root, async (buffer, mime) => {
      expect(buffer).toEqual(png)
      sent.push(mime)
    })
    const blocked = await sendSafeOutboundImage({
      id: 'url',
      source: { kind: 'url', url: 'http://127.0.0.1/private' },
    }, root, async () => {
      sent.push('unsafe')
    })

    expect(allowed.ok).toBe(true)
    expect(blocked.ok).toBe(false)
    expect(sent).toEqual(['image/png'])
  })
})

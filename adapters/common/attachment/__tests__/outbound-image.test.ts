import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { IMAGE_MAX_BYTES } from '../attachment-limits.js'
import { loadSafeOutboundImage, sendSafeOutboundImage } from '../outbound-image.js'

const temporaryRoots: string[] = []

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
    fs.writeFileSync(imagePath, Buffer.from('png'))

    const result = await loadSafeOutboundImage({
      id: 'inside',
      source: { kind: 'path', path: imagePath, mime: 'image/png' },
    }, root)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.buffer.toString()).toBe('png')
  })

  it('rejects paths outside the session root, including symlink escapes', async () => {
    const root = makeTempRoot('outbound-root-')
    const outside = makeTempRoot('outbound-outside-')
    const secretPath = path.join(outside, 'secret.png')
    const symlinkPath = path.join(root, 'escape.png')
    fs.writeFileSync(secretPath, Buffer.from('secret'))
    fs.symlinkSync(secretPath, symlinkPath)

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
    if (!result.ok) expect(result.reason).toContain('Image too large')
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
    fs.writeFileSync(imagePath, Buffer.from('png'))
    const sent: string[] = []

    const allowed = await sendSafeOutboundImage({
      id: 'inside',
      source: { kind: 'path', path: imagePath, mime: 'image/png' },
    }, root, async (buffer, mime) => {
      sent.push(`${buffer.toString()}:${mime}`)
    })
    const blocked = await sendSafeOutboundImage({
      id: 'url',
      source: { kind: 'url', url: 'http://127.0.0.1/private' },
    }, root, async () => {
      sent.push('unsafe')
    })

    expect(allowed.ok).toBe(true)
    expect(blocked.ok).toBe(false)
    expect(sent).toEqual(['png:image/png'])
  })
})

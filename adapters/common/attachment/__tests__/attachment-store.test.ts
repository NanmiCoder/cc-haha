import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { AttachmentStore } from '../attachment-store.js'

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'att-store-test-'))
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('AttachmentStore', () => {
  it('writes a buffer and returns the absolute path', async () => {
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const target = store.resolvePath('feishu', 'sess-1', 'hello.png')
    const written = await store.write(target, Buffer.from('PNGDATA'))
    expect(path.isAbsolute(written)).toBe(true)
    const content = await fs.readFile(written)
    expect(content.toString()).toBe('PNGDATA')
  })

  it('writes under {root}/{platform}/{sessionId}/', async () => {
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const target = store.resolvePath('telegram', 'sess-42', 'foo.pdf')
    expect(target).toContain(path.join('telegram', 'sess-42'))
    expect(target.endsWith('foo.pdf')).toBe(true)
  })

  it('sanitizes unsafe filenames (strips path separators and ..)', async () => {
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const target = store.resolvePath('feishu', 'sess-1', '../../etc/passwd')
    // The resulting target must still live inside the store root.
    const root = path.resolve(tmpRoot)
    expect(path.resolve(target).startsWith(root)).toBe(true)
    expect(path.basename(target)).not.toContain('..')
    expect(path.basename(target)).not.toContain('/')
  })

  it('collapses name collisions by prefixing timestamps', async () => {
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const a = store.resolvePath('feishu', 'sess-1', 'image.png')
    await store.write(a, Buffer.from('first'))
    const b = store.resolvePath('feishu', 'sess-1', 'image.png')
    expect(b).not.toBe(a)
    await store.write(b, Buffer.from('second'))
    const contentB = await fs.readFile(b)
    expect(contentB.toString()).toBe('second')
  })

  it('gc() removes files older than retentionMs and reports counts', async () => {
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 50 })
    const target = store.resolvePath('feishu', 'sess-1', 'stale.png')
    await store.write(target, Buffer.from('STALE'))
    // Age the file manually
    const past = new Date(Date.now() - 10_000)
    await fs.utimes(target, past, past)
    const result = await store.gc()
    expect(result.removed).toBe(1)
    expect(result.bytes).toBe(5)
    await expect(fs.access(target)).rejects.toThrow()
  })

  it('gc() keeps fresh files', async () => {
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    const target = store.resolvePath('feishu', 'sess-1', 'fresh.png')
    await store.write(target, Buffer.from('FRESH'))
    const result = await store.gc()
    expect(result.removed).toBe(0)
    await fs.access(target)
  })

  it('resolvePath under heavy collision pressure returns unique paths', () => {
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 60_000 })
    // First create a file so subsequent resolves hit the collision branch
    const a = store.resolvePath('feishu', 'sess-1', 'race.png')
    fsSync.writeFileSync(a, 'first')
    // Collect 50 resolved paths in a tight loop — none should clash
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      seen.add(store.resolvePath('feishu', 'sess-1', 'race.png'))
    }
    expect(seen.size).toBe(50)
    for (const p of seen) {
      expect(p).not.toBe(a)
    }
  })

  it('gc() cleans orphan .part files after a short grace period', async () => {
    const store = new AttachmentStore({ root: tmpRoot, retentionMs: 10_000, orphanGraceMs: 50 })
    // Simulate a crashed write — leave a .part tmp file behind
    const dir = path.join(tmpRoot, 'feishu', 'sess-1')
    await fs.mkdir(dir, { recursive: true })
    const orphan = path.join(dir, 'image.png.1234.5678.part')
    await fs.writeFile(orphan, 'ORPHAN')
    // Age the orphan so gc considers it stale
    const past = new Date(Date.now() - 1000)
    await fs.utimes(orphan, past, past)
    const result = await store.gc()
    expect(result.removed).toBeGreaterThanOrEqual(1)
    await expect(fs.access(orphan)).rejects.toThrow()
  })
})

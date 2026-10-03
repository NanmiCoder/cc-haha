import { describe, it, expect } from 'bun:test'
import { ImageBlockWatcher } from '../image-block-watcher.js'

describe('ImageBlockWatcher', () => {
  it('extracts a markdown image with an http URL for policy-checked loading', () => {
    const w = new ImageBlockWatcher()
    const out = w.feed('Here is ![alt](https://example.com/foo.png) an image.')
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      id: expect.any(String),
      source: { kind: 'url', url: 'https://example.com/foo.png' },
      alt: 'alt',
    })
  })

  it('extracts a markdown image with absolute local path', () => {
    const w = new ImageBlockWatcher()
    const out = w.feed('![cat](/tmp/cat.jpg)')
    expect(out.length).toBe(1)
    const source = out[0]!.source
    expect(source.kind).toBe('path')
    if (source.kind === 'path') {
      expect(source.path).toBe('/tmp/cat.jpg')
    }
  })

  it('recognizes Windows drive and UNC paths after a data directory move', () => {
    for (const sourcePath of [String.raw`D:\data\attachment.png`, 'D:/data/attachment.png', String.raw`\\server\share\attachment.png`]) {
      const watcher = new ImageBlockWatcher()
      expect(watcher.feed(`![moved](${sourcePath})`)[0]?.source).toEqual({ kind: 'path', path: sourcePath })
    }
    expect(new ImageBlockWatcher().feed('![relative](D:attachment.png)')).toEqual([])
  })

  it('extracts a markdown image with file:// URL as path', () => {
    const w = new ImageBlockWatcher()
    const out = w.feed('![x](file:///var/img/x.png)')
    const source = out[0]!.source
    expect(source.kind).toBe('path')
    if (source.kind === 'path') expect(source.path).toBe('/var/img/x.png')
  })

  it('extracts a data URI as base64', () => {
    const w = new ImageBlockWatcher()
    const out = w.feed('![inline](data:image/png;base64,AAAA)')
    const source = out[0]!.source
    expect(source.kind).toBe('base64')
    if (source.kind === 'base64') {
      expect(source.mime).toBe('image/png')
      expect(source.data).toBe('AAAA')
    }
  })

  it('deduplicates the same image across multiple feeds', () => {
    const w = new ImageBlockWatcher()
    const a = w.feed('![](/tmp/y.png)')
    const b = w.feed(' repeated ![](/tmp/y.png) again')
    expect(a.length).toBe(1)
    expect(b.length).toBe(0)
  })

  it('handles images split across feed boundaries', () => {
    const w = new ImageBlockWatcher()
    const a = w.feed('a ![al')
    const b = w.feed('t](/tmp/x.png) b')
    expect(a.length).toBe(0)
    expect(b.length).toBe(1)
    const source = b[0]!.source
    expect(source.kind).toBe('path')
    if (source.kind === 'path') expect(source.path).toBe('/tmp/x.png')
  })

  it('skips non-image markdown links', () => {
    const w = new ImageBlockWatcher()
    const out = w.feed('See [docs](https://example.com).')
    expect(out.length).toBe(0)
  })

  it('drain() returns all accumulated uploads', () => {
    const w = new ImageBlockWatcher()
    w.feed('![a](/tmp/a.png)')
    w.feed(' and ![b](/tmp/b.png)')
    const all = w.drain()
    expect(all.length).toBe(2)
  })

  it('reset() clears buffer, seen set, and accumulated list', () => {
    const w = new ImageBlockWatcher()
    w.feed('![a](/tmp/a.png)')
    w.reset()
    // After reset, drain() is empty
    expect(w.drain().length).toBe(0)
    // And re-feeding the same image yields a fresh emit (dedup state cleared)
    const out = w.feed('![a](/tmp/a.png)')
    expect(out.length).toBe(1)
  })

  it('skips relative paths (cannot be resolved safely)', () => {
    const w = new ImageBlockWatcher()
    const out = w.feed('![rel](relative/path.png) and ![ok](/tmp/ok.png)')
    expect(out.length).toBe(1)
    const source = out[0]!.source
    expect(source.kind).toBe('path')
    if (source.kind === 'path') expect(source.path).toBe('/tmp/ok.png')
  })

  it('extracts multiple images from a single feed chunk in order', () => {
    const w = new ImageBlockWatcher()
    const out = w.feed('![a](/tmp/a.png) ![b](https://x/b.png) ![c](data:image/png;base64,QQ==)')
    expect(out.length).toBe(3)
    expect(out[0]!.source.kind).toBe('path')
    expect(out[1]!.source.kind).toBe('url')
    expect(out[2]!.source.kind).toBe('base64')
  })

  it('rejects malformed data URI (not base64)', () => {
    const w = new ImageBlockWatcher()
    const out = w.feed('![bad](data:image/png,ABC)')
    // Not in `;base64,` form → classify returns null → skipped
    expect(out.length).toBe(0)
  })
})

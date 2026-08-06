import { afterAll, describe, expect, it } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { handleLocalFile, reconstructAbsolutePath } from '../localFile'
import { isAllowedFilesystemPath } from '../filesystem'

// Deterministic 256-byte payload (bytes 0..255) so range slices are checkable.
const VIDEO_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i)

// Build the work area under $HOME so it is inside isAllowedFilesystemPath's
// allow-list (HOME / tmp / registered roots). tmpdir() on macOS resolves to
// /private/tmp via realpath which is also allowed, but $HOME is the most
// portable choice across platforms for an "inside the sandbox" fixture.
const SANDBOX_ROOTS = mkdtempSync(path.join(homedir(), '.lf-test-'))

afterAll(() => {
  rmSync(SANDBOX_ROOTS, { recursive: true, force: true })
})

function setupFiles() {
  const root = mkdtempSync(path.join(SANDBOX_ROOTS, 'proj-'))
  writeFileSync(path.join(root, 'page.html'), '<h1>ok</h1>')
  mkdirSync(path.join(root, 'assets'))
  writeFileSync(path.join(root, 'assets', 'a.css'), 'body{}')
  writeFileSync(path.join(root, 'clip.mp4'), VIDEO_BYTES)
  writeFileSync(path.join(root, 'with space.html'), '<h1>spaced</h1>')
  return root
}

function makeExternalFixtureDir(): string | null {
  const candidates = ['/var/tmp', '/private/var/tmp', '/Users/Shared']
  for (const baseDir of candidates) {
    try {
      if (!statSync(baseDir).isDirectory()) continue
      const fixture = mkdtempSync(path.join(baseDir, 'local-file-symlink-test-'))
      if (!isAllowedFilesystemPath(fixture)) return fixture
      rmSync(fixture, { recursive: true, force: true })
    } catch {
      // Try the next common writable directory outside the default allow-list.
    }
  }
  return null
}

/** Build a /local-file/<abs> URL exactly the way the desktop helper does. */
function localFileRequestUrl(absPath: string): URL {
  const withForwardSlashes = absPath.replace(/\\/g, '/')
  const withLeading = withForwardSlashes.startsWith('/')
    ? withForwardSlashes
    : `/${withForwardSlashes}`
  const encoded = withLeading
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
  return new URL(`http://127.0.0.1/local-file${encoded}`)
}

describe('reconstructAbsolutePath', () => {
  it('re-roots a POSIX path (leading slash consumed by the prefix)', () => {
    expect(reconstructAbsolutePath('Users/me/page.html')).toBe('/Users/me/page.html')
  })
  it('decodes percent-encoded segments', () => {
    expect(reconstructAbsolutePath('Users/me/with%20space.html')).toBe('/Users/me/with space.html')
  })
  it('keeps a Windows drive path absolute', () => {
    expect(reconstructAbsolutePath('C:/Users/me/page.html')).toBe('C:/Users/me/page.html')
  })
  it('returns null for an empty remainder', () => {
    expect(reconstructAbsolutePath('')).toBeNull()
  })
})

describe('handleLocalFile', () => {
  it('serves an in-sandbox .html with text/html + Accept-Ranges', async () => {
    const root = setupFiles()
    const res = await handleLocalFile(localFileRequestUrl(path.join(root, 'page.html')))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    const csp = res.headers.get('content-security-policy')
    expect(csp).toContain('sandbox')
    expect(csp).toContain('allow-same-origin')
    expect(csp).toContain('allow-popups')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(await res.text()).toBe('<h1>ok</h1>')
  })

  it('serves nested assets with the right content-type', async () => {
    const root = setupFiles()
    const res = await handleLocalFile(localFileRequestUrl(path.join(root, 'assets', 'a.css')))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8')
  })

  it('serves a file whose name contains a space', async () => {
    const root = setupFiles()
    const res = await handleLocalFile(localFileRequestUrl(path.join(root, 'with space.html')))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>spaced</h1>')
  })

  it('honours a closed byte-range with 206 + Content-Range', async () => {
    const root = setupFiles()
    const res = await handleLocalFile(
      localFileRequestUrl(path.join(root, 'clip.mp4')),
      new Headers({ Range: 'bytes=0-9' }),
    )
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-9/256')
    expect(res.headers.get('content-length')).toBe('10')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body.length).toBe(10)
    expect(body).toEqual(VIDEO_BYTES.slice(0, 10))
  })

  it('serves video content-type + Accept-Ranges on a full 200', async () => {
    const root = setupFiles()
    const res = await handleLocalFile(localFileRequestUrl(path.join(root, 'clip.mp4')))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe('256')
  })

  it('rejects a path OUTSIDE the sandbox with 403', async () => {
    const res = await handleLocalFile(localFileRequestUrl('/etc/hosts'))
    expect(res.status).toBe(403)
  })

  it('rejects /etc/passwd with 403 (sandbox escape)', async () => {
    const res = await handleLocalFile(localFileRequestUrl('/etc/passwd'))
    expect(res.status).toBe(403)
  })

  it('rejects final and intermediate symlinks that escape an allowed root', async () => {
    if (process.platform === 'win32') return
    const outside = makeExternalFixtureDir()
    if (!outside) return
    const root = setupFiles()
    writeFileSync(path.join(outside, 'secret.txt'), 'outside')
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'final-link.txt'))
    symlinkSync(outside, path.join(root, 'linked-directory'), 'dir')

    try {
      const finalLink = await handleLocalFile(
        localFileRequestUrl(path.join(root, 'final-link.txt')),
      )
      const intermediateLink = await handleLocalFile(
        localFileRequestUrl(path.join(root, 'linked-directory', 'secret.txt')),
      )

      expect(finalLink.status).toBe(403)
      expect(intermediateLink.status).toBe(403)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('404s a missing in-sandbox file', async () => {
    const root = setupFiles()
    const res = await handleLocalFile(localFileRequestUrl(path.join(root, 'does-not-exist.html')))
    expect(res.status).toBe(404)
  })

  it('403s when the prefix was stripped by URL normalization (traversal)', async () => {
    // `..` collapsing removes the /local-file/ prefix → treated as escape.
    const res = await handleLocalFile(new URL('http://127.0.0.1/local-file/../../etc/passwd'))
    expect(res.status).toBe(403)
  })

  it('400s when no path follows the prefix', async () => {
    const res = await handleLocalFile(new URL('http://127.0.0.1/local-file/'))
    expect(res.status).toBe(400)
  })
})

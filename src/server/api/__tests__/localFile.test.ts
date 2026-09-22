import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import * as os from 'node:os'
import { homedir, tmpdir } from 'node:os'
import * as path from 'node:path'
import { handleLocalFile, reconstructAbsolutePath } from '../localFile'
import { isAllowedFilesystemPath } from '../filesystem'

// Deterministic 256-byte payload (bytes 0..255) so range slices are checkable.
const VIDEO_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i)

// Keep both home-relative files and any configuration reads in disposable state.
const SANDBOX_ROOTS = mkdtempSync(path.join(tmpdir(), 'lf-test-'))
const homeSpy = spyOn(os, 'homedir')
const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeAll(() => {
  homeSpy.mockReturnValue(SANDBOX_ROOTS)
  process.env.HOME = SANDBOX_ROOTS
  process.env.USERPROFILE = SANDBOX_ROOTS
  process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_ROOTS, '.claude')
})

afterAll(() => {
  homeSpy.mockRestore()
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
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
  it('expands home-relative paths after decoding', () => {
    expect(reconstructAbsolutePath('~/Desktop/page.html')).toBe(path.join(homedir(), 'Desktop/page.html'))
    expect(reconstructAbsolutePath('%7E/Desktop/with%20space.html')).toBe(path.join(homedir(), 'Desktop/with space.html'))
    expect(reconstructAbsolutePath('~other/page.html')).toBe('/~other/page.html')
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

  it('serves home-relative HTML and its relative assets', async () => {
    const root = setupFiles()
    const homePath = `~/${path.relative(SANDBOX_ROOTS, root).replace(/\\/g, '/')}/with space.html`
    const pageUrl = localFileRequestUrl(homePath)
    const page = await handleLocalFile(pageUrl)
    expect(page.status).toBe(200)
    expect(await page.text()).toBe('<h1>spaced</h1>')
    const asset = await handleLocalFile(new URL('./assets/a.css', pageUrl))
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await asset.text()).toBe('body{}')
  })

  it('rejects home-relative symlinks that escape the sandbox', async () => {
    if (process.platform === 'win32') return
    const root = setupFiles()
    symlinkSync('/etc', path.join(root, 'outside'), 'dir')
    const homePath = `~/${path.relative(SANDBOX_ROOTS, root)}/outside/hosts`
    const response = await handleLocalFile(localFileRequestUrl(homePath))
    expect(response.status).toBe(403)
  })

  it('decodes home-relative filenames only once and ignores URL query/hash when resolving assets', async () => {
    const root = setupFiles()
    const name = '发布清单 #100%25.html'
    writeFileSync(path.join(root, name), '<h1>encoded name</h1>')
    const homePath = `~/${path.relative(SANDBOX_ROOTS, root)}/${name}`
    const pageUrl = localFileRequestUrl(homePath)
    const page = await handleLocalFile(pageUrl)
    expect(page.status).toBe(200)
    expect(await page.text()).toBe('<h1>encoded name</h1>')
    const asset = await handleLocalFile(new URL('./assets/a.css?v=1#theme', pageUrl))
    expect(asset.status).toBe(200)
    expect(await asset.text()).toBe('body{}')
  })

  it('preserves media range responses and missing-file errors for home-relative paths', async () => {
    const root = setupFiles()
    const homeDir = `~/${path.relative(SANDBOX_ROOTS, root)}`
    const media = await handleLocalFile(localFileRequestUrl(`${homeDir}/clip.mp4`), new Headers({ Range: 'bytes=10-19' }))
    expect(media.status).toBe(206)
    expect(media.headers.get('content-range')).toBe('bytes 10-19/256')
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(VIDEO_BYTES.slice(10, 20))
    const missing = await handleLocalFile(localFileRequestUrl(`${homeDir}/missing.html`))
    expect(missing.status).toBe(404)
  })

  it('rejects encoded traversal outside the home sandbox', async () => {
    const escapedPath = encodeURIComponent(`~/${'../'.repeat(20)}etc/hosts`)
    const response = await handleLocalFile(new URL(`http://127.0.0.1/local-file/${escapedPath}`))
    expect(response.status).toBe(403)
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

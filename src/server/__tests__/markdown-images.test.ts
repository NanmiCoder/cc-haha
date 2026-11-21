import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment'

// Bun caches os.homedir() on startup. Give each child its HOME before imports;
// changing process.env.HOME in a test would still exercise the original home.
async function withTemporaryHome(scenario: string): Promise<void> {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'qa003-markdown-images-'))
  const temporaryHome = path.join(fixture, 'home', 'user')
  await fs.mkdir(temporaryHome, { recursive: true })
  const setup = `
    import assert from 'node:assert/strict'
    import * as fs from 'node:fs/promises'
    import * as os from 'node:os'
    import * as path from 'node:path'
    import { pathToFileURL } from 'node:url'
    import { createAssistantMarkdownImageResolver, normalizeMarkdownImageDestination } from './desktop/src/lib/markdownImages'
    import { handleFilesystemRoute } from './src/server/api/filesystem'
    import { registerFilesystemAccessRoot } from './src/server/services/filesystemAccessRoots'
    const fixture = ${JSON.stringify(fixture)}
    assert.equal(os.homedir(), ${JSON.stringify(temporaryHome)})
    const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63606060000000040001f61738550000000049454e44ae426082', 'hex')
    await fs.mkdir(path.join(os.homedir(), 'Pictures', '测试 pics'), { recursive: true })
    await fs.writeFile(path.join(os.homedir(), 'Pictures', '测试 pics', 'sample.png'), PNG)
    await fs.mkdir(path.join(fixture, 'tmp'))
    await fs.writeFile(path.join(fixture, 'tmp', 'sample.png'), PNG)
    registerFilesystemAccessRoot(fixture)
    const resolve = createAssistantMarkdownImageResolver({
      baseUrl: 'http://localhost:3456', sessionId: 'qa003', workDir: path.join(fixture, 'workspace'),
    })
    function imageUrl(destination) {
      const src = resolve(normalizeMarkdownImageDestination(destination))
      // QA-003 dropped the image here, before serving/authorization.
      assert.notEqual(src, null, destination)
      const url = new URL(src)
      assert.equal(url.pathname, '/api/filesystem/file')
      return url
    }
    async function serve(destination) {
      const url = imageUrl(destination)
      return handleFilesystemRoute(url.pathname, url)
    }
  `
  try {
    const proc = Bun.spawn(['bun', '--no-env-file', '-e', setup + scenario], {
      cwd: path.resolve(import.meta.dir, '../../..'),
      env: createSandboxedTestEnvironment(temporaryHome),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ])
    expect(exitCode, stdout + stderr).toBe(0)
  } finally {
    await fs.rm(fixture, { recursive: true, force: true })
  }
}

describe('assistant Markdown image paths → filesystem authorization', () => {
  it('serves a normal home subdirectory, its absolute path and file URL with encoded names', async () => {
    await withTemporaryHome(`
      const absolute = path.join(os.homedir(), 'Pictures', '测试 pics', 'sample.png')
      for (const destination of [
        '~/Pictures/%E6%B5%8B%E8%AF%95%20pics/sample.png',
        absolute.split(path.sep).map(encodeURIComponent).join('/'),
        pathToFileURL(absolute).href,
      ]) {
        const response = await serve(destination)
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('Content-Type'), 'image/png')
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG)
      }
    `)
  })

  it('serves the original ~/../../tmp shape after expanding a temporary HOME', async () => {
    await withTemporaryHome(`
      const response = await serve('~/../../tmp/sample.png')
      assert.equal(response.status, 200)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG)
    `)
  })

  it('keeps registered-root and canonical symlink checks after home expansion', async () => {
    if (process.platform === 'win32') return
    await withTemporaryHome(`
      const external = await fs.mkdtemp('/var/tmp/qa003-markdown-images-')
      try {
        const allowed = path.join(external, 'allowed')
        await fs.mkdir(allowed)
        const image = path.join(allowed, 'sample.png')
        const secret = path.join(external, 'secret.png')
        await fs.writeFile(image, PNG)
        await fs.writeFile(secret, PNG)
        await fs.symlink(secret, path.join(allowed, 'escape.png'))
        const homePath = (target) => '~/' + path.relative(os.homedir(), target)
        assert.equal((await serve(homePath(image))).status, 403)
        registerFilesystemAccessRoot(allowed)
        assert.equal((await serve(homePath(image))).status, 200)
        assert.equal((await serve(homePath(secret))).status, 403)
        assert.equal((await serve(homePath(path.join(allowed, 'escape.png')))).status, 403)
      } finally {
        await fs.rm(external, { recursive: true, force: true })
      }
    `)
  })

  it('decodes once and preserves missing-file and type refusals', async () => {
    await withTemporaryHome(`
      await fs.writeFile(path.join(os.homedir(), 'Pictures', 'a%20b.png'), PNG)
      assert.equal((await serve('~/Pictures/a%2520b.png')).status, 200)
      assert.equal((await serve('~/Pictures/missing.png')).status, 404)
      assert.equal(resolve('~/Pictures/note.txt'), null)
    `)
  })

  it('keeps home images behind H5 pairing and serves them through the authenticated boundary', async () => {
    await withTemporaryHome(`
      const { shouldRequireH5Token } = await import('./src/server/h5AccessPolicy')
      const { requireH5Token } = await import('./src/server/middleware/auth')
      const { H5AccessService } = await import('./src/server/services/h5AccessService')
      const { token } = await new H5AccessService().enable()
      for (const destination of ['~/Pictures/测试%20pics/sample.png', '~/../../tmp/sample.png']) {
        const url = imageUrl(destination)
        const request = new Request(url, { headers: { Origin: 'https://paired-phone.invalid' } })
        assert.equal(shouldRequireH5Token({
          request, url, h5Enabled: true, context: { clientAddress: '192.0.2.44' },
        }), true)
        assert.equal((await requireH5Token(request)).status, 401)
        request.headers.set('Authorization', 'Bearer invalid-fixture-token')
        assert.equal((await requireH5Token(request)).status, 401)
        request.headers.set('Authorization', 'Bearer ' + token)
        assert.equal(await requireH5Token(request), null)
        assert.equal((await handleFilesystemRoute(url.pathname, url)).status, 200)
      }
    `)
  })

  it('serves home audio files resolved by createAssistantMarkdownAudioResolver with byte-range support', async () => {
    await withTemporaryHome(`
      const { createAssistantMarkdownAudioResolver } = await import('./desktop/src/lib/markdownImages')
      const WAV = Uint8Array.from({ length: 64 }, (_, i) => i)
      const audioPath = path.join(os.homedir(), 'Pictures', '测试 pics', 'plane-crash.wav')
      await fs.writeFile(audioPath, WAV)
      const resolveAudio = createAssistantMarkdownAudioResolver({
        baseUrl: 'http://localhost:3456', sessionId: 'qa-audio', workDir: path.join(fixture, 'workspace'),
      })
      const src = resolveAudio(normalizeMarkdownImageDestination('~/Pictures/%E6%B5%8B%E8%AF%95%20pics/plane-crash.wav'))
      assert.notEqual(src, null)
      const url = new URL(src)
      assert.equal(url.pathname, '/api/filesystem/file')
      const res = await handleFilesystemRoute(url.pathname, url, undefined, new Headers({ Range: 'bytes=0-15' }))
      assert.equal(res.status, 206)
      assert.equal(res.headers.get('Content-Type'), 'audio/wav')
      assert.equal(res.headers.get('Content-Range'), 'bytes 0-15/64')
      assert.deepEqual(new Uint8Array(await res.arrayBuffer()), WAV.slice(0, 16))
    `)
  })
})

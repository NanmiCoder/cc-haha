import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  getProjectSearchFiles,
  handleFilesystemRoute,
} from '../api/filesystem.js'
import {
  clearFilesystemAccessRootsForTests,
  registerFilesystemAccessRoot,
} from '../services/filesystemAccessRoots.js'
import { getRepositoryContext } from '../services/repositoryLaunchService.js'

const cleanupDirs = new Set<string>()

function makeUrl(route: string, params: Record<string, string>): URL {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url
}

afterEach(async () => {
  for (const dir of cleanupDirs) {
    await fsp.rm(dir, { recursive: true, force: true })
  }
  cleanupDirs.clear()
  clearFilesystemAccessRootsForTests()
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
}

function isWithinPath(targetPath: string, rootPath: string): boolean {
  const target = path.resolve(targetPath)
  const root = path.resolve(rootPath)
  return target === root || target.startsWith(`${root}${path.sep}`)
}

async function makeExternalFixtureDir(): Promise<string | null> {
  const candidates = ['/var/tmp', '/private/var/tmp', '/Users/Shared']

  for (const baseDir of candidates) {
    try {
      const stat = await fsp.stat(baseDir)
      if (!stat.isDirectory()) continue
      const fixtureDir = await fsp.mkdtemp(path.join(baseDir, 'claude-filesystem-test-'))
      const isDefaultAllowed =
        isWithinPath(fixtureDir, os.homedir()) ||
        isWithinPath(fixtureDir, '/tmp') ||
        (process.platform === 'darwin' && isWithinPath(fixtureDir, '/private/tmp'))
      if (!isDefaultAllowed) return fixtureDir
      await fsp.rm(fixtureDir, { recursive: true, force: true })
    } catch {
      // Try the next common writable system directory.
    }
  }

  return null
}

describe('filesystem API', () => {
  it('allows browsing a directory under the user home directory', async () => {
    const homeFixtureDir = await fsp.mkdtemp(path.join(os.homedir(), 'claude-filesystem-test-'))
    cleanupDirs.add(homeFixtureDir)
    await fsp.mkdir(path.join(homeFixtureDir, '.config'))
    await fsp.mkdir(path.join(homeFixtureDir, '.git'))
    await fsp.writeFile(path.join(homeFixtureDir, 'note.txt'), 'hello')
    await fsp.writeFile(path.join(homeFixtureDir, '.env.local'), 'SECRET=example')

    const res = await handleFilesystemRoute(
      '/api/filesystem/browse',
      makeUrl('/api/filesystem/browse', {
        path: homeFixtureDir,
        includeFiles: 'true',
      }),
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { entries: Array<{ name: string }> }
    expect(body.entries.some((entry) => entry.name === '.config')).toBe(true)
    expect(body.entries.some((entry) => entry.name === '.env.local')).toBe(true)
    expect(body.entries.some((entry) => entry.name === '.git')).toBe(false)
    expect(body.entries.some((entry) => entry.name === 'note.txt')).toBe(true)
  })

  it('allows browsing a selected workspace outside the default home/tmp roots', async () => {
    const externalFixtureDir = await makeExternalFixtureDir()
    if (!externalFixtureDir) return

    cleanupDirs.add(externalFixtureDir)
    await fsp.writeFile(path.join(externalFixtureDir, 'note.txt'), 'hello')

    const deniedRes = await handleFilesystemRoute(
      '/api/filesystem/browse',
      makeUrl('/api/filesystem/browse', {
        path: externalFixtureDir,
        includeFiles: 'true',
      }),
    )
    expect(deniedRes.status).toBe(403)

    await getRepositoryContext(externalFixtureDir)

    const res = await handleFilesystemRoute(
      '/api/filesystem/browse',
      makeUrl('/api/filesystem/browse', {
        path: externalFixtureDir,
        includeFiles: 'true',
      }),
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { entries: Array<{ name: string }> }
    expect(body.entries.some((entry) => entry.name === 'note.txt')).toBe(true)
  })

  it('rejects final and intermediate file symlinks that escape a registered root', async () => {
    if (process.platform === 'win32') return
    const externalFixtureDir = await makeExternalFixtureDir()
    if (!externalFixtureDir) return

    cleanupDirs.add(externalFixtureDir)
    const allowedRoot = path.join(externalFixtureDir, 'allowed')
    const outsideRoot = path.join(externalFixtureDir, 'outside')
    await fsp.mkdir(allowedRoot)
    await fsp.mkdir(outsideRoot)
    await fsp.writeFile(path.join(outsideRoot, 'secret.png'), Buffer.from('outside'))
    await fsp.writeFile(path.join(allowedRoot, 'not-an-image.txt'), 'text')
    await fsp.symlink(
      path.join(outsideRoot, 'secret.png'),
      path.join(allowedRoot, 'final-link.png'),
    )
    await fsp.symlink(outsideRoot, path.join(allowedRoot, 'linked-directory'), 'dir')
    await fsp.symlink(
      path.join(allowedRoot, 'not-an-image.txt'),
      path.join(allowedRoot, 'pretend-image.png'),
    )
    registerFilesystemAccessRoot(allowedRoot)

    for (const candidate of [
      path.join(allowedRoot, 'final-link.png'),
      path.join(allowedRoot, 'linked-directory', 'secret.png'),
    ]) {
      const res = await handleFilesystemRoute(
        '/api/filesystem/file',
        makeUrl('/api/filesystem/file', { path: candidate }),
      )
      expect(res.status).toBe(403)
    }

    const browseEscape = await handleFilesystemRoute(
      '/api/filesystem/browse',
      makeUrl('/api/filesystem/browse', {
        path: path.join(allowedRoot, 'linked-directory'),
      }),
    )
    expect(browseEscape.status).toBe(403)

    const disguisedType = await handleFilesystemRoute(
      '/api/filesystem/file',
      makeUrl('/api/filesystem/file', {
        path: path.join(allowedRoot, 'pretend-image.png'),
      }),
    )
    expect(disguisedType.status).toBe(400)
  })

  it('fuzzy searches files and directories below the selected root', async () => {
    const homeFixtureDir = await fsp.mkdtemp(path.join(os.homedir(), 'claude-filesystem-test-'))
    cleanupDirs.add(homeFixtureDir)
    git(homeFixtureDir, 'init')
    await fsp.mkdir(path.join(homeFixtureDir, 'src', 'commands'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, 'src', 'commands', 'files'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, 'src', 'constants'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, 'src', 'hooks'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, 'desktop', 'src'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, 'scripts', 'quality-gate', 'baseline', 'fixtures', 'cross-module-refactor', 'src'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, '__pycache__'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, 'node_modules', 'pkg'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, '.venv', 'lib'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, 'tmp-ignore'), { recursive: true })
    await fsp.writeFile(path.join(homeFixtureDir, '.gitignore'), ['__pycache__/', 'node_modules/', '.venv/', 'venv/'].join('\n'))
    await fsp.writeFile(path.join(homeFixtureDir, '.ignore'), 'tmp-ignore/')
    await fsp.writeFile(path.join(homeFixtureDir, 'src', 'commands', 'files.ts'), 'export {}')
    await fsp.writeFile(path.join(homeFixtureDir, 'src', 'commands', 'files', 'index.ts'), 'export {}')
    await fsp.writeFile(path.join(homeFixtureDir, 'src', 'constants', 'fileSearch.ts'), 'export {}')
    await fsp.writeFile(path.join(homeFixtureDir, 'src', 'hooks', 'useFileSearch.ts'), 'export {}')
    await fsp.writeFile(path.join(homeFixtureDir, 'desktop', 'src', 'main.ts'), 'export {}')
    await fsp.writeFile(path.join(homeFixtureDir, 'scripts', 'quality-gate', 'baseline', 'fixtures', 'cross-module-refactor', 'src', 'index.ts'), 'export {}')
    await fsp.writeFile(path.join(homeFixtureDir, '__pycache__', 'fileSearch.cpython-311.pyc'), '')
    await fsp.writeFile(path.join(homeFixtureDir, 'node_modules', 'pkg', 'files.js'), '')
    await fsp.writeFile(path.join(homeFixtureDir, '.venv', 'lib', 'files.py'), '')
    await fsp.writeFile(path.join(homeFixtureDir, 'tmp-ignore', 'files.tmp'), '')

    const res = await handleFilesystemRoute(
      '/api/filesystem/browse',
      makeUrl('/api/filesystem/browse', {
        path: homeFixtureDir,
        search: 'files',
        includeFiles: 'true',
      }),
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { entries: Array<{ name: string; relativePath?: string; isDirectory: boolean }> }
    expect(body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'files.ts',
        relativePath: 'src/commands/files.ts',
        isDirectory: false,
      }),
    ]))
    expect(body.entries.some((entry) => entry.relativePath === 'src/constants/fileSearch.ts')).toBe(true)
    expect(body.entries.find((entry) => entry.relativePath === 'src/commands/files')?.isDirectory).toBe(true)
    expect(body.entries.some((entry) => entry.relativePath === '__pycache__/fileSearch.cpython-311.pyc')).toBe(false)
    expect(body.entries.some((entry) => entry.relativePath === 'node_modules/pkg/files.js')).toBe(false)
    expect(body.entries.some((entry) => entry.relativePath === '.venv/lib/files.py')).toBe(false)
    expect(body.entries.some((entry) => entry.relativePath === 'tmp-ignore/files.tmp')).toBe(false)

    const srcRes = await handleFilesystemRoute(
      '/api/filesystem/browse',
      makeUrl('/api/filesystem/browse', {
        path: homeFixtureDir,
        search: 'src',
        includeFiles: 'true',
      }),
    )

    expect(srcRes.status).toBe(200)
    const srcBody = await srcRes.json() as { entries: Array<{ relativePath?: string }> }
    const srcPaths = srcBody.entries.map(entry => entry.relativePath)
    expect(srcPaths[0]).toBe('src')
    expect(srcPaths.indexOf('src/hooks')).toBeGreaterThan(-1)
    expect(srcPaths.indexOf('desktop/src')).toBeGreaterThan(-1)
    expect(srcPaths.indexOf('scripts/quality-gate/baseline/fixtures/cross-module-refactor/src')).toBeGreaterThan(-1)
    expect(srcPaths.indexOf('src/hooks')).toBeLessThan(srcPaths.indexOf('desktop/src'))
    expect(srcPaths.indexOf('src/hooks')).toBeLessThan(srcPaths.indexOf('scripts/quality-gate/baseline/fixtures/cross-module-refactor/src'))
  })

  it('searches non-git trees without materializing every path and still respects ignore files', async () => {
    const homeFixtureDir = await fsp.mkdtemp(path.join(os.homedir(), 'claude-filesystem-test-'))
    cleanupDirs.add(homeFixtureDir)
    await fsp.mkdir(path.join(homeFixtureDir, 'app'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, 'node_modules', 'pkg'), { recursive: true })
    await fsp.writeFile(path.join(homeFixtureDir, '.gitignore'), 'node_modules/')
    await fsp.writeFile(path.join(homeFixtureDir, 'app', 'cache-result.ts'), 'export {}')
    await fsp.writeFile(path.join(homeFixtureDir, 'node_modules', 'pkg', 'cache-result.js'), '')

    const res = await handleFilesystemRoute(
      '/api/filesystem/browse',
      makeUrl('/api/filesystem/browse', {
        path: homeFixtureDir,
        search: 'cache',
        includeFiles: 'true',
      }),
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { entries: Array<{ relativePath?: string; isDirectory: boolean }> }
    expect(body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: 'app/cache-result.ts',
        isDirectory: false,
      }),
    ]))
    expect(body.entries.some((entry) => entry.relativePath === 'node_modules/pkg/cache-result.js')).toBe(false)
  })

  it('keeps non-git file suggestions working when ripgrep cannot start', async () => {
    const fixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-filesystem-fallback-'))
    cleanupDirs.add(fixtureDir)
    await fsp.mkdir(path.join(fixtureDir, 'app'), { recursive: true })
    await fsp.mkdir(path.join(fixtureDir, 'app', 'generated'), { recursive: true })
    await fsp.mkdir(path.join(fixtureDir, 'node_modules', 'pkg'), { recursive: true })
    await fsp.mkdir(path.join(fixtureDir, '.git', 'objects'), { recursive: true })
    await fsp.writeFile(path.join(fixtureDir, '.gitignore'), 'node_modules/\n')
    await fsp.writeFile(path.join(fixtureDir, 'app', '.gitignore'), 'generated/\n')
    await fsp.writeFile(path.join(fixtureDir, 'app', 'search-result.ts'), 'export {}')
    await fsp.writeFile(path.join(fixtureDir, 'app', 'generated', 'search-result.ts'), '')
    await fsp.writeFile(path.join(fixtureDir, 'node_modules', 'pkg', 'search-result.js'), '')
    await fsp.writeFile(path.join(fixtureDir, '.git', 'objects', 'search-result'), '')

    const files = await getProjectSearchFiles(fixtureDir, {
      ripGrepFn: async () => {
        throw new Error('ripgrep unavailable')
      },
    })

    expect(files).toContain('app/search-result.ts')
    expect(files).not.toContain('app/generated/search-result.ts')
    expect(files).not.toContain('node_modules/pkg/search-result.js')
    expect(files).not.toContain('.git/objects/search-result')
  })

  it('does not let unrelated files exhaust the fallback search budget', async () => {
    const fixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-filesystem-fair-fallback-'))
    cleanupDirs.add(fixtureDir)
    await fsp.mkdir(path.join(fixtureDir, 'a-target'), { recursive: true })
    await fsp.mkdir(path.join(fixtureDir, 'z-heavy'), { recursive: true })
    await fsp.writeFile(path.join(fixtureDir, 'a-target', 'needle.ts'), '')
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        fsp.writeFile(path.join(fixtureDir, 'z-heavy', `cache-${index}.tmp`), '')),
    )

    const files = await getProjectSearchFiles(fixtureDir, {
      ripGrepFn: async () => {
        throw new Error('ripgrep unavailable')
      },
      fallbackOptions: {
        searchQuery: 'needle',
        maxFiles: 1,
      },
    })

    expect(files).toEqual(['a-target/needle.ts'])
  })

  it('stops a bounded filesystem search when its caller is superseded', async () => {
    const fixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-filesystem-abort-'))
    cleanupDirs.add(fixtureDir)
    await fsp.mkdir(path.join(fixtureDir, 'nested'), { recursive: true })
    await fsp.writeFile(path.join(fixtureDir, 'nested', 'needle.ts'), '')
    const controller = new AbortController()
    controller.abort()

    await expect(getProjectSearchFiles(fixtureDir, {
      signal: controller.signal,
      fallbackOptions: { searchQuery: 'needle' },
    })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('accepts /private/tmp aliases on macOS for browsing and file serving', async () => {
    if (process.platform !== 'darwin') return

    const tmpFixtureDir = await fsp.mkdtemp('/tmp/claude-filesystem-test-')
    cleanupDirs.add(tmpFixtureDir)
    const canonicalTmpDir = fs.realpathSync(tmpFixtureDir)
    const imagePath = path.join(canonicalTmpDir, 'preview.png')
    await fsp.writeFile(
      imagePath,
      Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63606060000000040001f61738550000000049454e44ae426082', 'hex'),
    )

    const browseRes = await handleFilesystemRoute(
      '/api/filesystem/browse',
      makeUrl('/api/filesystem/browse', {
        path: canonicalTmpDir,
        includeFiles: 'true',
      }),
    )
    expect(browseRes.status).toBe(200)
    const browseBody = await browseRes.json() as { entries: Array<{ name: string }> }
    expect(browseBody.entries.some((entry) => entry.name === 'preview.png')).toBe(true)

    const fileRes = await handleFilesystemRoute(
      '/api/filesystem/file',
      makeUrl('/api/filesystem/file', {
        path: imagePath,
      }),
    )
    expect(fileRes.status).toBe(200)
    expect(fileRes.headers.get('Content-Type')).toBe('image/png')
  })
})

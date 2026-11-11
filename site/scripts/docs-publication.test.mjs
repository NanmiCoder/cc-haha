import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const siteDir = fileURLToPath(new URL('..', import.meta.url))
const repoDir = path.dirname(siteDir)
const internalNames = [
  'computer-use-cef-injection',
  'computer-use-codex-parity-review',
  'computer-use-codex-redesign',
  'computer-use-handoff',
  'computer-use-native-manual-qa',
  'computer-use-native-swift-design'
]
const exists = (filename) => fs.access(filename).then(() => true, () => false)
const digest = async (filename) => createHash('sha256').update(await fs.readFile(filename)).digest('hex')

test('internal Computer Use notes stay unpublished while their old URLs remain usable', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-publication-'))
  const fixtureSite = path.join(directory, 'site')
  let server

  try {
    await fs.cp(path.join(repoDir, 'docs'), path.join(directory, 'docs'), { recursive: true })
    await fs.mkdir(path.join(fixtureSite, 'scripts'), { recursive: true })
    await fs.mkdir(path.join(fixtureSite, 'src/content'), { recursive: true })
    await fs.mkdir(path.join(fixtureSite, 'dist'), { recursive: true })
    await fs.writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n')
    for (const script of ['generate-docs-manifest.mjs', 'image-size.mjs', 'prepare-static-output.mjs']) {
      await fs.copyFile(path.join(siteDir, 'scripts', script), path.join(fixtureSite, 'scripts', script))
    }
    await fs.copyFile(path.join(siteDir, 'src/content/docs.js'), path.join(fixtureSite, 'src/content/docs.js'))
    const shell = await fs.readFile(path.join(siteDir, 'index.html'), 'utf8')
    await fs.writeFile(path.join(fixtureSite, 'index.html'), shell)
    await fs.writeFile(path.join(fixtureSite, 'dist/index.html'), shell)
    const sourceHashes = await Promise.all(internalNames.map((name) => digest(path.join(directory, 'docs/internals', `${name}.md`))))
    const { generateDocsManifest } = await import(pathToFileURL(path.join(fixtureSite, 'scripts/generate-docs-manifest.mjs')).href)
    const { records } = await generateDocsManifest()
    server = await createServer({
      root: fixtureSite,
      configFile: false,
      envFile: false,
      cacheDir: path.join(directory, 'vite-cache'),
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false, watch: null },
      resolve: {
        alias: ['marked', 'dompurify'].map((name) => ({ find: name, replacement: fileURLToPath(import.meta.resolve(name)) }))
      }
    })
    const routes = await server.ssrLoadModule('/src/content/docs.js')
    const { default: search } = await server.ssrLoadModule('/src/generated/search-index.js')

    for (const name of internalNames) {
      await t.test(`old ${name} URL redirects in both languages`, () => {
        for (const prefix of ['', '/en']) {
          const oldRoute = `${prefix}/internals/${name}`
          const destination = `${prefix}/internals/computer-use`
          assert.equal(routes.resolveLegacyRoute(oldRoute), destination)
          assert.equal(routes.resolveLegacyRoute(`${oldRoute}/`), destination)
          assert.equal(routes.resolveLegacyRoute(`${oldRoute}.md`), destination)
          assert.ok(routes.findDoc(destination))
        }
      })
    }

    await t.test('internal bodies are absent from lookup, navigation, loaders and search', async () => {
      for (const name of internalNames) {
        for (const prefix of ['', '/en']) {
          const route = `${prefix}/internals/${name}`
          assert.equal(routes.findDoc(route), null)
          assert.equal(await routes.loadDocContent(route), null)
          assert.ok(!routes.docsIndex.some((doc) => doc.path === route))
          assert.ok(!search.some((entry) => entry.p === route))
          assert.ok(!routes.getDocNavigation(prefix ? 'en' : 'zh').some((section) => section.items.some((item) => item.route === route)))
        }
        assert.equal(await exists(path.join(fixtureSite, 'src/generated/content', `internals-${name}.js`)), false)
      }
    })

    await t.test('all formal pages retain metadata and a matching language version', () => {
      assert.ok(records.length > 0)
      assert.equal(records.filter((record) => record.locale === 'zh').length, records.filter((record) => record.locale === 'en').length)
      for (const record of records) {
        const frontmatter = record.content.match(/^---\n([\s\S]*?)\n---\n/)?.[1] || ''
        for (const key of ['title', 'nav_title', 'description', 'order']) {
          assert.match(frontmatter, new RegExp(`^${key}:\\s*.+$`, 'm'), record.sourcePath)
        }
        const other = record.locale === 'en'
          ? record.sourcePath.replace('docs/en/', 'docs/')
          : record.sourcePath.replace('docs/', 'docs/en/')
        assert.ok(records.some((candidate) => candidate.sourcePath === other), other)
      }
    })

    const output = spawnSync(process.execPath, [path.join(fixtureSite, 'scripts/prepare-static-output.mjs')], { encoding: 'utf8' })
    assert.equal(output.status, 0, output.stderr || output.stdout)
    await t.test('direct old URLs have static shells without publishing their bodies or sitemap entries', async () => {
      const sitemap = await fs.readFile(path.join(fixtureSite, 'dist/sitemap.xml'), 'utf8')
      for (const name of internalNames) {
        for (const prefix of ['', '/en']) {
          const route = `${prefix}/internals/${name}`
          assert.equal(await fs.readFile(path.join(fixtureSite, 'dist', route, 'index.html'), 'utf8'), shell)
          assert.ok(!sitemap.includes(`https://cchaha.ai${route}<`))
        }
      }
      for (const prefix of ['', '/en']) {
        const route = `${prefix}/internals/computer-use`
        const page = await fs.readFile(path.join(fixtureSite, 'dist', route, 'index.html'), 'utf8')
        assert.ok(page.includes(`https://cchaha.ai${route}`))
        assert.ok(sitemap.includes(`https://cchaha.ai${route}<`))
      }
      assert.deepEqual(await Promise.all(internalNames.map((name) => digest(path.join(directory, 'docs/internals', `${name}.md`)))), sourceHashes)
    })

    await t.test('existing redirects still work and unrelated URLs remain unknown', async () => {
      for (const prefix of ['', '/en']) {
        assert.equal(routes.resolveLegacyRoute(`${prefix}/features/computer-use-architecture`), `${prefix}/internals/computer-use`)
        assert.equal(await exists(path.join(fixtureSite, 'dist', prefix, 'features/computer-use-architecture/index.html')), true)
        const unknown = `${prefix}/internals/computer-use-unknown-design`
        assert.equal(routes.findDoc(unknown), null)
        assert.equal(routes.resolveLegacyRoute(unknown), null)
        assert.equal(await exists(path.join(fixtureSite, 'dist', unknown, 'index.html')), false)
      }
    })
  } finally {
    await server?.close()
    await fs.rm(directory, { force: true, recursive: true })
  }
})

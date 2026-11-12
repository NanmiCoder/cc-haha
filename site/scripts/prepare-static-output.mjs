import { promises as fs } from 'node:fs'
import path from 'node:path'

import { generateDocsManifest, paths } from './generate-docs-manifest.mjs'

const distDir = path.join(paths.siteDir, 'dist')
const expectedCustomDomain = 'cchaha.ai'

async function pathExists(targetPath) {
  return fs.access(targetPath).then(() => true, () => false)
}

async function copyDirectory(source, destination) {
  if (!await pathExists(source)) {
    return
  }

  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.cp(source, destination, { recursive: true, force: true })
}

const markdownImagePattern = /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
const htmlImagePattern = /<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi
const siteImagePattern = /["'(]\s*(\/[A-Za-z0-9_./-]+\.(?:avif|gif|jpe?g|png|svg|webp))/gi

function imageTargets(markdown) {
  const prose = markdown.replace(/```[\s\S]*?```/g, '')
  return [
    ...prose.matchAll(markdownImagePattern),
    ...prose.matchAll(htmlImagePattern),
  ].map((match) => match[1])
}

function isOutsideDocsPublic(relative) {
  return relative.startsWith('..')
    || path.isAbsolute(relative)
    || relative === 'public'
    || relative.startsWith(`public${path.sep}`)
}

async function copySources(sources) {
  for (const source of sources) {
    if (!await pathExists(source)) continue
    const destination = path.join(distDir, path.relative(paths.docsDir, source))
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(source, destination)
  }
}

async function copyReferencedDocImages(records) {
  const sources = new Set()

  for (const record of records) {
    const sourceDirectory = path.dirname(path.join(paths.repoDir, record.sourcePath))

    for (const target of imageTargets(record.content)) {
      const pathname = target.split(/[?#]/, 1)[0]
      if (!pathname || /^(?:[a-z]+:|\/\/|data:)/i.test(pathname)) continue

      const source = pathname.startsWith('/')
        ? path.join(paths.docsDir, pathname.replace(/^\/+/, ''))
        : path.resolve(sourceDirectory, pathname)
      const relative = path.relative(paths.docsDir, source)

      if (isOutsideDocsPublic(relative)) continue

      sources.add(source)
    }
  }

  await copySources(sources)
  console.log(`Copied ${sources.size} referenced documentation images.`)
}

async function siteSourceFiles() {
  const files = [path.join(paths.siteDir, 'index.html')]
  const srcDir = path.join(paths.siteDir, 'src')
  const entries = await fs.readdir(srcDir, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:jsx?|css)$/.test(entry.name)) continue

    const directory = entry.parentPath || entry.path
    // src/generated/ holds a "path → image size" table covering every image under docs/images.
    // It exists for the renderer to look up sizes and does not mean the pages reference them — scanning it would copy
    // unused images (sponsors, donations and the like) into the output.
    if (path.relative(srcDir, directory).split(path.sep)[0] === 'generated') continue

    files.push(path.join(directory, entry.name))
  }
  return files
}

async function copySiteReferencedImages() {
  const sources = new Set()
  const missing = []

  for (const file of await siteSourceFiles()) {
    const content = await fs.readFile(file, 'utf8')
    for (const match of content.matchAll(siteImagePattern)) {
      const pathname = match[1]
      const source = path.join(paths.docsDir, pathname.replace(/^\/+/, ''))
      const relative = path.relative(paths.docsDir, source)

      if (isOutsideDocsPublic(relative)) continue

      if (await pathExists(source)) sources.add(source)
      else missing.push(`${path.relative(paths.siteDir, file)}: ${pathname}`)
    }
  }

  if (missing.length > 0) {
    throw new Error(`Site-referenced images missing under docs/:\n- ${missing.join('\n- ')}`)
  }

  await copySources(sources)
  console.log(`Copied ${sources.size} site-referenced images.`)
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Each route's HTML shell gets its own title / description / canonical.
 * Crawlers that don't run JS no longer see 78 identical pages.
 */
function shellForRoute(shell, meta) {
  if (!meta) return shell

  const origin = `https://${expectedCustomDomain}`
  const canonical = `${origin}${meta.path}`

  const head = [
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`
  ].join('\n    ')

  return shell
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(meta.title)}</title>`)
    .replace(
      /<meta name="description" content="[^"]*">/,
      `<meta name="description" content="${escapeHtml(meta.description)}">`
    )
    .replace(
      /<meta property="og:title" content="[^"]*">/,
      `<meta property="og:title" content="${escapeHtml(meta.title)}">`
    )
    .replace(
      /<meta property="og:description" content="[^"]*">/,
      `<meta property="og:description" content="${escapeHtml(meta.description)}">`
    )
    .replace('</head>', `  ${head}\n  </head>`)
}

async function createRouteEntry(route, shell, meta) {
  const relativeRoute = route.replace(/^\/+|\/+$/g, '')
  if (!relativeRoute) {
    return
  }

  const routeDirectory = path.join(distDir, ...relativeRoute.split('/'))
  await fs.mkdir(routeDirectory, { recursive: true })
  await fs.writeFile(path.join(routeDirectory, 'index.html'), shellForRoute(shell, meta))
}

async function writeSitemap(records) {
  const origin = `https://${expectedCustomDomain}`
  const urls = ['/', ...records.map((record) => record.path)]
  const body = urls
    .map((url) => `  <url><loc>${origin}${url}</loc><changefreq>weekly</changefreq></url>`)
    .join('\n')

  await fs.writeFile(
    path.join(distDir, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
  )

  await fs.writeFile(
    path.join(distDir, 'robots.txt'),
    `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`
  )
}

/** Paths from before the 2026-07 information architecture reorganization. Ship a shell for each so the front end can redirect instead of a 404 at the CDN. */
const legacyRoutes = [
  '/agent', '/agent/01-usage-guide', '/agent/02-implementation', '/agent/03-agent-framework',
  '/channel', '/channel/01-channel-system', '/channel/02-im-gateway-proposal',
  '/desktop/01-quick-start', '/desktop/02-architecture', '/desktop/03-features',
  '/desktop/04-installation', '/desktop/05-FAQ', '/desktop/06-h5-access',
  '/desktop/07-electron-migration-research', '/desktop/08-electron-migration-tasks',
  '/desktop/09-electron-migration-validation-checklist', '/desktop/10-release-auto-update',
  '/docs', '/features/computer-use', '/features/computer-use-architecture',
  '/guide/cli-reference', '/guide/contributing', '/guide/env-vars', '/guide/faq',
  '/guide/global-usage', '/guide/quick-start', '/guide/third-party-models',
  '/internals/computer-use-cef-injection', '/internals/computer-use-codex-parity-review',
  '/internals/computer-use-codex-redesign', '/internals/computer-use-handoff',
  '/internals/computer-use-native-manual-qa', '/internals/computer-use-native-swift-design',
  '/memory', '/memory/01-usage-guide', '/memory/02-implementation', '/memory/03-autodream',
  '/reference/fixes', '/reference/local-server', '/reference/project-structure',
  '/skills', '/skills/01-usage-guide', '/skills/02-implementation'
]

async function main() {
  const { records } = await generateDocsManifest()
  const shellPath = path.join(distDir, 'index.html')
  const shell = await fs.readFile(shellPath, 'utf8')

  await copyDirectory(path.join(paths.docsDir, 'public'), distDir)
  await copyReferencedDocImages(records)
  await copySiteReferencedImages()

  const customDomain = (await fs.readFile(path.join(distDir, 'CNAME'), 'utf8')).trim()
  if (customDomain !== expectedCustomDomain) {
    throw new Error(`Expected CNAME to contain ${expectedCustomDomain}, received ${customDomain || 'an empty value'}.`)
  }

  for (const record of records) {
    await createRouteEntry(record.path, shell, {
      description: record.description,
      path: record.path,
      title: `${record.title} · cc-haha`
    })
  }

  // The docs used to be bilingual with English under /en. Old /en links get a bare shell
  // so the front end can redirect them to the unprefixed page.
  const localeRedirects = ['/en', ...records.map((record) => `/en${record.path}`)]
  for (const redirect of localeRedirects) {
    await createRouteEntry(redirect, shell, null)
  }

  for (const legacy of legacyRoutes) {
    await createRouteEntry(legacy, shell, null)
    await createRouteEntry(`/en${legacy}`, shell, null)
  }

  await writeSitemap(records)
  await fs.writeFile(path.join(distDir, '404.html'), shell)
  const redirects = localeRedirects.length + legacyRoutes.length * 2
  console.log(`Prepared static output for ${records.length} documentation routes and ${redirects} redirects.`)
}

await main()

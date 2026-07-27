import { promises as fs } from 'node:fs'
import path from 'node:path'

import { generateDocsManifest, paths } from './generate-docs-manifest.mjs'

const distDir = path.join(paths.siteDir, 'dist')
const expectedCustomDomain = 'claudecode-haha.relakkesyang.org'

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
    // src/generated/ 里有一张「路径 → 图片尺寸」表，覆盖 docs/images 下的每张图。
    // 那是给渲染器查尺寸用的，不代表页面引用了它们 —— 扫进来会把没人用的图
    // （赞助、打赏之类）全拷进产物。
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
 * 每条路由的 HTML 骨架都写进自己的 title / description / canonical / hreflang。
 * 不执行 JS 的爬虫看到的就不再是 78 个一模一样的页面。
 */
function shellForRoute(shell, meta) {
  if (!meta) return shell

  const origin = `https://${expectedCustomDomain}`
  const isEnglish = meta.path === '/en' || meta.path.startsWith('/en/')
  const canonical = `${origin}${meta.path}`
  const alternate = meta.alternate ? `${origin}${meta.alternate}` : null

  const head = [
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<link rel="alternate" hreflang="${isEnglish ? 'en' : 'zh-Hans'}" href="${escapeHtml(canonical)}">`,
    alternate
      ? `<link rel="alternate" hreflang="${isEnglish ? 'zh-Hans' : 'en'}" href="${escapeHtml(alternate)}">`
      : '',
    `<meta property="og:url" content="${escapeHtml(canonical)}">`
  ].filter(Boolean).join('\n    ')

  return shell
    .replace(/<html lang="[^"]*"/, `<html lang="${isEnglish ? 'en' : 'zh-CN'}"`)
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

function alternateFor(record, records) {
  const source = record.sourcePath.replace(/^docs\//, '')
  const target = record.locale === 'en' ? source.replace(/^en\//, '') : `en/${source}`
  return records.find((candidate) => candidate.sourcePath === `docs/${target}`)?.path || null
}

async function writeSitemap(records) {
  const origin = `https://${expectedCustomDomain}`
  const urls = ['/', '/en', ...records.map((record) => record.path)]
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

/** 2026-07 信息架构重组前的老路径，发一份骨架出去让前端接管重定向，别在 CDN 层就 404。 */
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
      alternate: alternateFor(record, records),
      description: record.description,
      path: record.path,
      title: `${record.title} · Claude Code Haha`
    })
  }

  await createRouteEntry('/en', shell, {
    alternate: '/',
    description: 'A local-first desktop client for Claude Code. Sessions, diffs, agents and scheduled runs all sit in the open.',
    path: '/en',
    title: 'Claude Code Haha — a local-first desktop client for Claude Code'
  })

  for (const legacy of legacyRoutes) {
    await createRouteEntry(legacy, shell, null)
    await createRouteEntry(`/en${legacy}`, shell, null)
  }

  await writeSitemap(records)
  await fs.writeFile(path.join(distDir, '404.html'), shell)
  console.log(`Prepared static output for ${records.length} documentation routes and ${legacyRoutes.length * 2} redirects.`)
}

await main()

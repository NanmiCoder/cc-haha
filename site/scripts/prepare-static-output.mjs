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
    if (entry.isFile() && /\.(?:jsx?|css)$/.test(entry.name)) {
      files.push(path.join(entry.parentPath || entry.path, entry.name))
    }
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

async function createRouteEntry(route, shell) {
  const relativeRoute = route.replace(/^\/+|\/+$/g, '')
  if (!relativeRoute) {
    return
  }

  const routeDirectory = path.join(distDir, ...relativeRoute.split('/'))
  await fs.mkdir(routeDirectory, { recursive: true })
  await fs.writeFile(path.join(routeDirectory, 'index.html'), shell)
}

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

  const routes = new Set(records.map((record) => record.path))
  routes.add('/en')
  routes.add('/docs')
  routes.add('/en/docs')

  for (const route of routes) {
    await createRouteEntry(route, shell)
  }

  await fs.writeFile(path.join(distDir, '404.html'), shell)
  console.log(`Prepared static output for ${routes.size} client-side routes.`)
}

await main()

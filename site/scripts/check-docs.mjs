import { promises as fs } from 'node:fs'
import path from 'node:path'

import { generateDocsManifest, paths } from './generate-docs-manifest.mjs'

const markdownTargetPattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
const htmlTargetPattern = /<(?:a|img)\b[^>]*?\b(?:href|src)=["']([^"']+)["'][^>]*>/gi

function withoutSuffix(target) {
  return target.split(/[?#]/, 1)[0]
}

function isExternal(target) {
  return /^(?:[a-z]+:|\/\/|#)/i.test(target)
}

function normalizeRoute(target) {
  const decoded = decodeURIComponent(withoutSuffix(target))
  const withoutExtension = decoded
    .replace(/(?:\/index)?\.html$/i, '')
    .replace(/\.md$/i, '')
  const normalized = `/${withoutExtension}`.replace(/\/+/g, '/').replace(/\/$/, '')
  return normalized || '/'
}

async function exists(targetPath) {
  return fs.access(targetPath).then(() => true, () => false)
}

function collectTargets(markdown) {
  const targets = []
  const prose = markdown.replace(/```[\s\S]*?```/g, '')

  for (const match of prose.matchAll(markdownTargetPattern)) {
    targets.push(match[1])
  }

  for (const match of prose.matchAll(htmlTargetPattern)) {
    targets.push(match[1])
  }

  return [...new Set(targets)]
}

function isImageTarget(target) {
  return /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(withoutSuffix(target))
}

async function main() {
  const { records } = await generateDocsManifest()
  const routes = new Set([
    '/',
    '/docs',
    '/en',
    '/en/docs',
    ...records.map((record) => record.path),
  ])
  const problems = []
  let checkedTargets = 0

  for (const record of records) {
    const sourceAbsolutePath = path.join(paths.repoDir, record.sourcePath)
    const sourceDirectory = path.dirname(sourceAbsolutePath)

    for (const target of collectTargets(record.content)) {
      if (!target || isExternal(target)) {
        continue
      }

      checkedTargets += 1
      const pathname = withoutSuffix(target)
      const image = isImageTarget(pathname)

      if (pathname.startsWith('/')) {
        const publicFile = path.join(paths.docsDir, 'public', pathname.replace(/^\//, ''))
        const docsFile = path.join(paths.docsDir, pathname.replace(/^\//, ''))
        const valid = image
          ? await exists(publicFile) || await exists(docsFile)
          : routes.has(normalizeRoute(pathname)) || await exists(publicFile)

        if (!valid) {
          problems.push(`${record.sourcePath}: unresolved ${image ? 'image' : 'link'} ${target}`)
        }
        continue
      }

      const resolvedFile = path.resolve(sourceDirectory, pathname)
      const markdownRoute = normalizeRoute(path.relative(paths.docsDir, resolvedFile))
      const valid = image
        ? await exists(resolvedFile)
        : await exists(resolvedFile)
          || routes.has(markdownRoute)
          || routes.has(normalizeRoute(`${path.relative(paths.docsDir, resolvedFile)}.md`))

      if (!valid) {
        problems.push(`${record.sourcePath}: unresolved ${image ? 'image' : 'link'} ${target}`)
      }
    }
  }

  if (problems.length > 0) {
    console.error(`Documentation check found ${problems.length} problem(s):`)
    for (const problem of problems) {
      console.error(`- ${problem}`)
    }
    process.exitCode = 1
    return
  }

  console.log(`Documentation check passed: ${records.length} pages, ${checkedTargets} local links and images.`)
}

await main()

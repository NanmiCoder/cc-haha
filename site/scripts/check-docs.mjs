import { promises as fs } from 'node:fs'
import path from 'node:path'

import { generateDocsManifest, paths } from './generate-docs-manifest.mjs'
import { readImageSize } from './image-size.mjs'

const markdownTargetPattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
const htmlTargetPattern = /<(?:a|img)\b[^>]*?\b(?:href|src)=["']([^"']+)["'][^>]*>/gi
const appImagesDirectory = path.join(paths.docsDir, 'images/app')
const appScreenshotDirectory = 'en'

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

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function resolveLocalTarget(sourceAbsolutePath, target) {
  const pathname = decodeURIComponent(withoutSuffix(target))

  if (!pathname.startsWith('/')) {
    return path.resolve(path.dirname(sourceAbsolutePath), pathname)
  }

  const repositoryRelative = pathname.replace(/^\/+/, '')
  if (repositoryRelative.startsWith('docs/')) {
    return path.join(paths.repoDir, repositoryRelative)
  }

  const sourceRelative = path.relative(paths.docsDir, sourceAbsolutePath)
  const sourceIsDocumentation = sourceRelative !== ''
    && sourceRelative !== '..'
    && !sourceRelative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(sourceRelative)

  return path.join(sourceIsDocumentation ? paths.docsDir : paths.repoDir, repositoryRelative)
}

function relativeToAppImages(targetPath) {
  const relativePath = path.relative(appImagesDirectory, targetPath)
  const outsideDirectory = relativePath === ''
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)

  return outsideDirectory ? null : toPosix(relativePath)
}

async function checkReadmeImages(readmes) {
  const problems = []

  for (const readme of readmes) {
    for (const target of collectTargets(readme.content)) {
      if (!target || isExternal(target) || !isImageTarget(target)) {
        continue
      }

      const resolvedFile = resolveLocalTarget(readme.absolutePath, target)
      if (!await exists(resolvedFile)) {
        problems.push(`${readme.sourcePath}: unresolved image ${target}`)
      }
    }
  }

  return problems
}

function checkAppScreenshotReferences(sources) {
  const problems = []

  for (const source of sources) {
    const expectedDirectory = appScreenshotDirectory

    for (const target of collectTargets(source.content)) {
      if (!target || isExternal(target) || !isImageTarget(target)) {
        continue
      }

      const resolvedFile = resolveLocalTarget(source.absolutePath, target)
      const appRelativePath = relativeToAppImages(resolvedFile)
      if (!appRelativePath) {
        continue
      }

      if (!appRelativePath.includes('/')) {
        problems.push(
          `${source.sourcePath}: legacy app screenshot path ${target}; use docs/images/app/${expectedDirectory}/...`
        )
        continue
      }

      if (!appRelativePath.startsWith(`${expectedDirectory}/`)) {
        problems.push(
          `${source.sourcePath}: app screenshot ${target} must use docs/images/app/${expectedDirectory}/`
        )
      }
    }
  }

  return problems
}

async function checkAppScreenshotFiles() {
  const problems = []
  const directory = path.join(appImagesDirectory, appScreenshotDirectory)
  let entries

  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch {
    problems.push(`docs/images/app/${appScreenshotDirectory}: screenshot directory is missing`)
    return { checked: 0, problems }
  }

  const seen = new Set()
  let checked = 0
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.webp') {
      continue
    }

    const basename = path.basename(entry.name, path.extname(entry.name))
    if (seen.has(basename)) {
      problems.push(`docs/images/app/${appScreenshotDirectory}: duplicate screenshot basename ${basename}`)
      continue
    }
    seen.add(basename)

    const size = await readImageSize(path.join(directory, entry.name))
    if (!size) {
      problems.push(`docs/images/app/${appScreenshotDirectory}/${basename}.webp: unreadable image dimensions`)
      continue
    }

    checked += 1
    const expectedWidth = basename.startsWith('h5-') ? 1206 : 2000
    if (size.width !== expectedWidth) {
      problems.push(
        `docs/images/app/${appScreenshotDirectory}/${basename}.webp: width ${size.width}, expected ${expectedWidth}`
      )
    }
  }

  if (seen.size === 0) {
    problems.push(`docs/images/app/${appScreenshotDirectory}: no WebP screenshots found`)
  }

  return { checked, problems }
}

/**
 * Docs routes and phone app download links hard-coded in the landing copy. Renaming a doc turns a route into a dead link;
 * the download links follow mobileAppLinks.ts on the desktop settings page, so change both when the TestFlight link changes.
 */
async function checkLandingContent(routes) {
  const problems = []
  const landingPath = 'site/src/pages/home/landingContent.ts'
  const appLinksPath = 'desktop/src/pages/settings/mobileAppLinks.ts'
  const landing = await fs.readFile(path.join(paths.repoDir, landingPath), 'utf8')
  const appLinks = await fs.readFile(path.join(paths.repoDir, appLinksPath), 'utf8')

  const landingRoutes = [...landing.matchAll(/\broute:\s*'([^']+)'/g)].map((match) => match[1])
  if (landingRoutes.length === 0) {
    problems.push(`${landingPath}: no route found; landing link check is ineffective`)
  }
  for (const route of landingRoutes) {
    if (!routes.has(normalizeRoute(route))) {
      problems.push(`${landingPath}: landing link ${route} has no matching doc page`)
    }
  }

  // The home page title and description are written in three places: the HTML shell, the page runtime and the landing copy.
  const shell = await fs.readFile(path.join(paths.siteDir, 'index.html'), 'utf8')
  const homePage = await fs.readFile(path.join(paths.siteDir, 'src/pages/home/HomePage.tsx'), 'utf8')
  const shellTitle = shell.match(/<title>([^<]+)<\/title>/)?.[1]
  const shellDescription = shell.match(/<meta name="description" content="([^"]+)">/)?.[1]
  if (!shellTitle || !shellDescription) {
    problems.push('site/index.html: cannot read <title> or description; home page meta drift check is ineffective')
  } else {
    if (!homePage.includes(`'${shellTitle}'`)) problems.push(`site/src/pages/home/HomePage.tsx: page title differs from index.html "${shellTitle}"`)
    const heroDescriptions = [...landing.matchAll(/description: \['([^']+)', '([^']+)'\]/g)].map((match) => `${match[1]} ${match[2]}`)
    if (!heroDescriptions.includes(shellDescription)) problems.push(`${landingPath}: hero description differs from the index.html description`)
  }

  for (const key of ['android', 'testFlight']) {
    const pattern = new RegExp(`\\b${key}:\\s*'([^']+)'`)
    const site = landing.match(pattern)?.[1]
    const app = appLinks.match(pattern)?.[1]
    if (!site || !app) {
      problems.push(`${landingPath} / ${appLinksPath}: cannot read the ${key} download link; drift check is ineffective`)
    } else if (site !== app) {
      problems.push(`${landingPath}: ${key} download link ${site} differs from ${app} in ${appLinksPath}`)
    }
  }

  return problems
}

async function main() {
  const { records } = await generateDocsManifest()
  const readmes = await Promise.all([
    { sourcePath: 'README.md' }
  ].map(async (readme) => {
    const absolutePath = path.join(paths.repoDir, readme.sourcePath)
    return {
      ...readme,
      absolutePath,
      content: await fs.readFile(absolutePath, 'utf8')
    }
  }))
  const routes = new Set([
    '/',
    '/docs',
    ...records.map((record) => record.path),
  ])
  const problems = [...await checkLandingContent(routes)]
  problems.push(...await checkReadmeImages(readmes))
  problems.push(...checkAppScreenshotReferences([
    ...readmes,
    ...records.map((record) => ({
      absolutePath: path.join(paths.repoDir, record.sourcePath),
      content: record.content,
      sourcePath: record.sourcePath
    }))
  ]))
  const screenshotCheck = await checkAppScreenshotFiles()
  problems.push(...screenshotCheck.problems)
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

  console.log(
    `Documentation check passed: ${records.length} pages, ${checkedTargets} local links and images, `
    + `${screenshotCheck.checked} app screenshots.`
  )
}

await main()

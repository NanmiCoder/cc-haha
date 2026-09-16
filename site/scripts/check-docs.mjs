import { promises as fs } from 'node:fs'
import path from 'node:path'

import { generateDocsManifest, paths } from './generate-docs-manifest.mjs'
import { readImageSize } from './image-size.mjs'

const markdownTargetPattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
const htmlTargetPattern = /<(?:a|img)\b[^>]*?\b(?:href|src)=["']([^"']+)["'][^>]*>/gi
const appImagesDirectory = path.join(paths.docsDir, 'images/app')
const appScreenshotDirectories = {
  en: 'en',
  zh: 'zh-CN'
}

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
    const expectedDirectory = appScreenshotDirectories[source.locale]

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

async function collectAppScreenshots(locale, problems) {
  const directoryName = appScreenshotDirectories[locale]
  const directory = path.join(appImagesDirectory, directoryName)
  let entries

  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch {
    problems.push(`docs/images/app/${directoryName}: screenshot directory is missing`)
    return new Map()
  }

  const screenshots = new Map()
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.webp') {
      continue
    }

    const basename = path.basename(entry.name, path.extname(entry.name))
    if (screenshots.has(basename)) {
      problems.push(`docs/images/app/${directoryName}: duplicate screenshot basename ${basename}`)
      continue
    }

    screenshots.set(basename, path.join(directory, entry.name))
  }

  if (screenshots.size === 0) {
    problems.push(`docs/images/app/${directoryName}: no WebP screenshots found`)
  }

  return screenshots
}

async function checkAppScreenshotFiles() {
  const problems = []
  const english = await collectAppScreenshots('en', problems)
  const chinese = await collectAppScreenshots('zh', problems)

  for (const basename of english.keys()) {
    if (!chinese.has(basename)) {
      problems.push(`docs/images/app/zh-CN: missing ${basename}.webp`)
    }
  }
  for (const basename of chinese.keys()) {
    if (!english.has(basename)) {
      problems.push(`docs/images/app/en: missing ${basename}.webp`)
    }
  }

  const sizes = { en: new Map(), zh: new Map() }
  for (const [locale, screenshots] of Object.entries({ en: english, zh: chinese })) {
    const directoryName = appScreenshotDirectories[locale]

    for (const [basename, screenshotPath] of screenshots) {
      const size = await readImageSize(screenshotPath)
      if (!size) {
        problems.push(`docs/images/app/${directoryName}/${basename}.webp: unreadable image dimensions`)
        continue
      }

      sizes[locale].set(basename, size)
      const expectedWidth = basename.startsWith('h5-') ? 1206 : 2000
      if (size.width !== expectedWidth) {
        problems.push(
          `docs/images/app/${directoryName}/${basename}.webp: width ${size.width}, expected ${expectedWidth}`
        )
      }
    }
  }

  let checkedPairs = 0
  for (const basename of english.keys()) {
    const englishSize = sizes.en.get(basename)
    const chineseSize = sizes.zh.get(basename)
    if (!englishSize || !chineseSize) {
      continue
    }

    checkedPairs += 1
    if (englishSize.width !== chineseSize.width || englishSize.height !== chineseSize.height) {
      problems.push(
        `docs/images/app/${basename}.webp: en is ${englishSize.width}x${englishSize.height}, `
        + `zh-CN is ${chineseSize.width}x${chineseSize.height}`
      )
    }
  }

  return { checkedPairs, problems }
}

/**
 * 语言分流的判定规则在两处各有一份：src/lib/locale.js（可测的模块）和 index.html 里的内联
 * 副本（首帧就要跳，等不到模块加载）。两处漂移不会报错，只会让首页悄悄按旧规则分流，所以
 * 在这里钉死：storage key 和中文判定正则必须逐字一致，且内联脚本必须只在根路径动手。
 */
async function checkLocaleRedirect() {
  const problems = []
  const moduleSource = await fs.readFile(path.join(paths.siteDir, 'src/lib/locale.js'), 'utf8')
  const shellSource = await fs.readFile(path.join(paths.siteDir, 'index.html'), 'utf8')

  const storageKey = moduleSource.match(/LOCALE_STORAGE_KEY\s*=\s*'([^']+)'/)?.[1]
  const chineseTag = moduleSource.match(/const CHINESE_TAG\s*=\s*(\/.+\/i)/)?.[1]

  if (!storageKey || !chineseTag) {
    problems.push('src/lib/locale.js: 读不出 LOCALE_STORAGE_KEY 或 CHINESE_TAG，防漂移校验失效')
    return problems
  }

  if (!shellSource.includes(`localStorage.getItem('${storageKey}')`)) {
    problems.push(`index.html: 内联语言脚本没有用 '${storageKey}'，与 src/lib/locale.js 不一致`)
  }

  if (!shellSource.includes(chineseTag)) {
    problems.push(`index.html: 内联语言脚本的中文判定与 src/lib/locale.js 的 ${chineseTag} 不一致`)
  }

  // 少了这道判断，/en/start 这类地址也会被卷进分流。
  if (!shellSource.includes("window.location.pathname.replace(/\\/+$/, '') !== ''")) {
    problems.push('index.html: 内联语言脚本缺少「只在根路径生效」的判断')
  }

  return problems
}

async function main() {
  const { records } = await generateDocsManifest()
  const readmes = await Promise.all([
    { locale: 'en', sourcePath: 'README.en.md' },
    { locale: 'zh', sourcePath: 'README.md' }
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
    '/en',
    '/en/docs',
    ...records.map((record) => record.path),
  ])
  const problems = [...await checkLocaleRedirect()]
  problems.push(...await checkReadmeImages(readmes))
  problems.push(...checkAppScreenshotReferences([
    ...readmes,
    ...records.map((record) => ({
      absolutePath: path.join(paths.repoDir, record.sourcePath),
      content: record.content,
      locale: record.locale,
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
    + `${screenshotCheck.checkedPairs} bilingual app screenshot pairs.`
  )
}

await main()

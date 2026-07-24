import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const siteDir = path.resolve(scriptDir, '..')
const repoDir = path.resolve(siteDir, '..')
const docsDir = path.join(repoDir, 'docs')
const outputPath = path.join(siteDir, 'src', 'generated', 'docs-manifest.js')

export const paths = {
  docsDir,
  outputPath,
  repoDir,
  siteDir
}

const excludedDirectoryNames = new Set(['superpowers', 'ui-clone'])
const excludedFiles = new Set(['index.md', 'en/index.md', 'AGENTS.md'])

const sectionLabels = {
  zh: {
    guide: '开始使用',
    desktop: '桌面应用',
    features: '核心能力',
    im: '消息接入',
    agent: '多 Agent',
    skills: '技能系统',
    memory: '记忆系统',
    channel: 'Channel 研究',
    reference: '参考资料'
  },
  en: {
    guide: 'Get started',
    desktop: 'Desktop app',
    features: 'Core capabilities',
    im: 'Messaging',
    agent: 'Multi-agent',
    skills: 'Skills',
    memory: 'Memory',
    channel: 'Channel research',
    reference: 'Reference'
  }
}

const sectionOrder = [
  'guide',
  'desktop',
  'features',
  'im',
  'agent',
  'skills',
  'memory',
  'channel',
  'reference'
]

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function shouldInclude(relativePath) {
  const normalized = toPosix(relativePath)
  const parts = normalized.split('/')

  return normalized.endsWith('.md')
    && !excludedFiles.has(normalized)
    && !parts.some((part) => excludedDirectoryNames.has(part))
}

async function listMarkdownFiles(directory, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = prefix ? path.join(prefix, entry.name) : entry.name
    const absolutePath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      if (!excludedDirectoryNames.has(entry.name)) {
        files.push(...await listMarkdownFiles(absolutePath, relativePath))
      }
      continue
    }

    if (entry.isFile() && shouldInclude(relativePath)) {
      files.push(toPosix(relativePath))
    }
  }

  return files
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith('---\n')) {
    return { body: markdown, attributes: {} }
  }

  const closingIndex = markdown.indexOf('\n---\n', 4)
  if (closingIndex === -1) {
    return { body: markdown, attributes: {} }
  }

  const rawFrontmatter = markdown.slice(4, closingIndex)
  const attributes = {}

  for (const line of rawFrontmatter.split('\n')) {
    const match = line.match(/^([A-Za-z][\w-]*):\s*(.+)$/)
    if (match) {
      attributes[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2').trim()
    }
  }

  return {
    body: markdown.slice(closingIndex + 5),
    attributes
  }
}

function plainText(value) {
  return value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractTitle(body, frontmatter, fallback) {
  if (frontmatter.title) {
    return plainText(frontmatter.title)
  }

  const heading = body.match(/^#\s+(.+)$/m)
  return heading ? plainText(heading[1]) : fallback
}

function extractDescription(body, frontmatter) {
  if (frontmatter.description) {
    return plainText(frontmatter.description).slice(0, 180)
  }

  const withoutFences = body.replace(/```[\s\S]*?```/g, '')
  const paragraphs = withoutFences.split(/\n\s*\n/)
  const paragraph = paragraphs.find((candidate) => {
    const value = candidate.trim()
    return value
      && !value.startsWith('#')
      && !value.startsWith('!')
      && !value.startsWith('<')
      && !value.startsWith('|')
      && !value.startsWith(':::')
  })

  return plainText(paragraph || '').slice(0, 180)
}

function routeFromRelativePath(relativePath) {
  const withoutExtension = relativePath.replace(/\.md$/i, '')
  const withoutIndex = withoutExtension.replace(/(^|\/)index$/i, '$1')
  return `/${withoutIndex}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
}

function sortKey(relativePath) {
  const basename = path.posix.basename(relativePath, '.md')
  if (basename === 'index') {
    return '0000-index'
  }

  return basename.replace(/^(\d+)-/, (_, value) => value.padStart(4, '0'))
}

function buildRecord(relativePath, markdown) {
  const { body, attributes } = parseFrontmatter(markdown)
  const segments = relativePath.split('/')
  const locale = segments[0] === 'en' ? 'en' : 'zh'
  const localeRelativePath = locale === 'en' ? segments.slice(1).join('/') : relativePath
  const section = localeRelativePath.split('/')[0]
  const route = routeFromRelativePath(relativePath)
  const basename = path.posix.basename(relativePath, '.md')
  const fallbackTitle = basename === 'index'
    ? section
    : basename.replace(/^\d+-/, '').replaceAll('-', ' ')

  return {
    slug: route.replace(/^\//, ''),
    path: route,
    locale,
    section,
    title: extractTitle(body, attributes, fallbackTitle),
    description: extractDescription(body, attributes),
    sourcePath: `docs/${relativePath}`,
    sortKey: sortKey(relativePath),
    content: markdown
  }
}

function buildNavigation(records, locale) {
  const localeRecords = records.filter((record) => record.locale === locale)
  const sections = [...new Set(localeRecords.map((record) => record.section))]
    .sort((left, right) => {
      const leftIndex = sectionOrder.indexOf(left)
      const rightIndex = sectionOrder.indexOf(right)
      return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
        - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
        || left.localeCompare(right)
    })

  return sections.map((section) => ({
    key: section,
    title: sectionLabels[locale][section] || section,
    items: localeRecords
      .filter((record) => record.section === section)
      .sort((left, right) => left.sortKey.localeCompare(right.sortKey))
      .map(({ content, sortKey: _sortKey, section: _section, ...item }) => item)
  }))
}

function serialize(value) {
  return JSON.stringify(value, null, 2)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

export async function generateDocsManifest() {
  const relativePaths = await listMarkdownFiles(docsDir)
  const records = await Promise.all(relativePaths.map(async (relativePath) => {
    const markdown = await fs.readFile(path.join(docsDir, relativePath), 'utf8')
    return buildRecord(relativePath, markdown)
  }))

  records.sort((left, right) => left.path.localeCompare(right.path))
  const navigation = {
    zh: buildNavigation(records, 'zh'),
    en: buildNavigation(records, 'en')
  }

  const moduleSource = `// Generated by site/scripts/generate-docs-manifest.mjs. Do not edit.
export const docsManifest = ${serialize(records)}

export const docsNavigation = ${serialize(navigation)}

export const docsBySlug = Object.fromEntries(
  docsManifest.flatMap((document) => [
    [document.slug, document],
    [document.path, document],
    [\`\${document.path}/\`, document]
  ])
)

export function normalizeDocsPath(value) {
  const pathname = String(value || '/').split(/[?#]/, 1)[0]
  const decoded = decodeURIComponent(pathname)
  const withoutHtml = decoded.replace(/(?:\\/index)?\\.html$/i, '')
  const withoutMarkdown = withoutHtml.replace(/\\.md$/i, '')
  const normalized = \`/\${withoutMarkdown}\`.replace(/\\/+/g, '/').replace(/\\/$/, '')
  return normalized || '/'
}

export function resolveDocsPath(value) {
  const normalized = normalizeDocsPath(value)
  return docsBySlug[normalized]
    || docsBySlug[normalized.replace(/^\\//, '')]
    || null
}

export function resolveDocsHref(href, sourcePath) {
  if (!href || /^(?:[a-z]+:|\\/\\/|#)/i.test(href)) {
    return href
  }

  const suffixIndex = href.search(/[?#]/)
  const pathname = suffixIndex === -1 ? href : href.slice(0, suffixIndex)
  const suffix = suffixIndex === -1 ? '' : href.slice(suffixIndex)
  if (pathname.startsWith('/')) {
    return \`\${normalizeDocsPath(pathname)}\${suffix}\`
  }

  const sourceRelative = sourcePath.replace(/^docs\\//, '')
  const resolved = new URL(pathname, \`https://docs.local/\${sourceRelative}\`).pathname
  const isMarkdown = /\\.md$/i.test(resolved)
  const target = isMarkdown ? normalizeDocsPath(resolved) : resolved
  return \`\${target}\${suffix}\`
}
`

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  const current = await fs.readFile(outputPath, 'utf8').catch(() => '')
  if (current !== moduleSource) {
    await fs.writeFile(outputPath, moduleSource)
  }

  return { records, navigation, outputPath }
}

const isDirectRun = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isDirectRun) {
  const { records } = await generateDocsManifest()
  console.log(`Generated ${records.length} documentation routes.`)
}

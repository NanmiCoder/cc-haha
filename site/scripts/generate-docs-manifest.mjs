import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readImageSize } from './image-size.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const siteDir = path.resolve(scriptDir, '..')
const repoDir = path.resolve(siteDir, '..')
const docsDir = path.join(repoDir, 'docs')
const generatedDir = path.join(siteDir, 'src', 'generated')
const contentDir = path.join(generatedDir, 'content')

export const paths = {
  contentDir,
  docsDir,
  generatedDir,
  repoDir,
  siteDir
}

const excludedDirectoryNames = new Set(['superpowers', 'ui-clone', 'public', 'images'])
const excludedFiles = new Set([
  'AGENTS.md',
  // Internal computer-use design notes and QA checklists: kept in the repo for
  // agents and maintainers, but not part of the published documentation tree.
  'computer-use-cef-injection.md',
  'computer-use-codex-parity-review.md',
  'computer-use-codex-redesign.md',
  'computer-use-handoff.md',
  'computer-use-native-manual-qa.md',
  'computer-use-native-swift-design.md'
])

/** Section order and titles. Register any new top-level docs/ directory here, or it sorts last and shows its bare directory name. */
export const sections = [
  { id: 'start', label: 'Get started' },
  { id: 'cases', label: 'Practical guides' },
  { id: 'desktop', label: 'Desktop app' },
  { id: 'im', label: 'Messaging' },
  { id: 'cli', label: 'Command line' },
  { id: 'internals', label: 'Internals' }
]

const sectionIndex = new Map(sections.map((section, index) => [section.id, index]))

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function shouldInclude(relativePath) {
  const normalized = toPosix(relativePath)
  const parts = normalized.split('/')

  return normalized.endsWith('.md')
    && !excludedFiles.has(path.posix.basename(normalized))
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
  if (frontmatter.title) return plainText(frontmatter.title)
  const heading = body.match(/^#\s+(.+)$/m)
  return heading ? plainText(heading[1]) : fallback
}

function extractDescription(body, frontmatter) {
  if (frontmatter.description) return plainText(frontmatter.description).slice(0, 180)

  const withoutFences = body.replace(/```[\s\S]*?```/g, '')
  const paragraph = withoutFences.split(/\n\s*\n/).find((candidate) => {
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

/** Body excerpt for search: strip code blocks and markup, keep readable text. */
function searchBody(body) {
  return plainText(body.replace(/```[\s\S]*?```/g, ' ')).slice(0, 1400)
}

function routeFromRelativePath(relativePath) {
  const withoutExtension = relativePath.replace(/\.md$/i, '')
  const withoutIndex = withoutExtension.replace(/(^|\/)index$/i, '$1')
  return `/${withoutIndex}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
}

function moduleIdFor(relativePath) {
  return relativePath.replace(/\.md$/i, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function buildRecord(relativePath, markdown) {
  const { body, attributes } = parseFrontmatter(markdown)
  const section = relativePath.split('/')[0]
  const route = routeFromRelativePath(relativePath)
  const basename = path.posix.basename(relativePath, '.md')
  const fallbackTitle = basename === 'index'
    ? section
    : basename.replace(/^\d+-/, '').replaceAll('-', ' ')

  const title = extractTitle(body, attributes, fallbackTitle)
  const explicitOrder = Number.parseInt(attributes.order ?? '', 10)

  return {
    body,
    content: markdown,
    description: extractDescription(body, attributes),
    moduleId: moduleIdFor(relativePath),
    navTitle: attributes.nav_title ? plainText(attributes.nav_title) : title,
    order: Number.isFinite(explicitOrder) ? explicitOrder : (basename === 'index' ? 0 : 900),
    path: route,
    search: searchBody(body),
    section,
    sectionRank: sectionIndex.has(section) ? sectionIndex.get(section) : 999,
    slug: route.replace(/^\//, ''),
    sourcePath: `docs/${relativePath}`,
    title
  }
}

function sortRecords(records) {
  return [...records].sort((left, right) => {
    if (left.sectionRank !== right.sectionRank) return left.sectionRank - right.sectionRank
    if (left.section !== right.section) return left.section.localeCompare(right.section)
    if (left.order !== right.order) return left.order - right.order
    return left.title.localeCompare(right.title)
  })
}

async function emptyDirectory(directory) {
  await fs.rm(directory, { force: true, recursive: true })
  await fs.mkdir(directory, { recursive: true })
}

const IMAGE_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg', '.gif'])

/**
 * Site asset path → pixel size. Written into <img width height> at render time so
 * the browser reserves the right space before the image loads and lazy loading no longer shifts the text.
 */
async function collectImageSizes(directory, prefix = '') {
  const sizes = {}
  let entries

  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch {
    return sizes
  }

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name)
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      Object.assign(sizes, await collectImageSizes(absolutePath, relativePath))
      continue
    }

    if (!IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue

    const size = await readImageSize(absolutePath)
    if (size?.width && size?.height) sizes[`/${relativePath}`] = [size.width, size.height]
  }

  return sizes
}

export async function generateDocsManifest() {
  const relativePaths = await listMarkdownFiles(docsDir)
  const records = []

  for (const relativePath of relativePaths) {
    const markdown = await fs.readFile(path.join(docsDir, relativePath), 'utf8')
    records.push(buildRecord(relativePath, markdown))
  }

  const sorted = sortRecords(records)

  await fs.mkdir(generatedDir, { recursive: true })
  await emptyDirectory(contentDir)

  // Each page body is its own module, loaded through a dynamic import in the route table — opening one page no longer downloads all 80.
  // The body is written without frontmatter so the renderer can parse it directly.
  for (const record of sorted) {
    await fs.writeFile(
      path.join(contentDir, `${record.moduleId}.js`),
      `export default ${JSON.stringify(record.body)}\n`,
      'utf8'
    )
  }

  const index = sorted.map((record) => ({
    description: record.description,
    navTitle: record.navTitle,
    order: record.order,
    path: record.path,
    section: record.section,
    slug: record.slug,
    sourcePath: record.sourcePath,
    title: record.title
  }))

  const loaders = sorted
    .map((record) => `  ${JSON.stringify(record.path)}: () => import('./content/${record.moduleId}.js'),`)
    .join('\n')

  const imageSizes = await collectImageSizes(path.join(docsDir, 'images'), 'images')

  await fs.writeFile(
    path.join(generatedDir, 'docs-index.js'),
    [
      '// Generated by scripts/generate-docs-manifest.mjs. Do not edit by hand.',
      `export const sections = ${JSON.stringify(sections, null, 2)}`,
      '',
      `export const docsIndex = ${JSON.stringify(index, null, 2)}`,
      '',
      `export const imageSizes = ${JSON.stringify(imageSizes)}`,
      '',
      'export const docsContent = {',
      loaders,
      '}',
      ''
    ].join('\n'),
    'utf8'
  )

  await fs.writeFile(
    path.join(generatedDir, 'search-index.js'),
    [
      '// Generated by scripts/generate-docs-manifest.mjs. Do not edit by hand.',
      `export default ${JSON.stringify(sorted.map((record) => ({
        d: record.description,
        p: record.path,
        s: record.section,
        t: record.title,
        x: record.search
      })))}`,
      ''
    ].join('\n'),
    'utf8'
  )

  return { records: sorted, sections }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  const { records } = await generateDocsManifest()
  console.log(`Generated docs index for ${records.length} pages.`)
}

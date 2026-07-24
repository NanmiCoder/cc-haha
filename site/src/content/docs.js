import { Marked, Renderer } from 'marked'
import DOMPurify from 'dompurify'
import { docsManifest } from '../generated/docs-manifest'

const EXTERNAL_PROTOCOL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i
const SITE_BASE = `/${String(import.meta.env.BASE_URL || '/').replace(/^\/+|\/+$/g, '')}`
  .replace(/\/{2,}/g, '/')
  .replace(/\/$/, '') || '/'

function cleanRoute(route) {
  const withoutQuery = route.split(/[?#]/, 1)[0]
  let normalized = decodeURIComponent(withoutQuery || '/')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/(?:\.md|\.html)$/i, '')

  if (!normalized.startsWith('/')) normalized = `/${normalized}`
  if (normalized !== '/') normalized = normalized.replace(/\/+$/, '')
  return normalized
}

export function toSiteHref(href) {
  if (!href || href.startsWith('#') || EXTERNAL_PROTOCOL.test(href)) return href

  const { path, suffix } = splitHref(href)
  const route = /\.html$/i.test(path)
    ? `/${decodeURIComponent(path).replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`
    : cleanRoute(path)
  if (SITE_BASE === '/') return `${route}${suffix}`
  if (route === SITE_BASE || route.startsWith(`${SITE_BASE}/`)) {
    return `${route}${suffix}`
  }
  return `${SITE_BASE}${route}${suffix}`
}

function withoutSiteBase(pathname) {
  const route = cleanRoute(pathname)
  if (SITE_BASE === '/') return route
  if (route === SITE_BASE) return '/'
  if (route.startsWith(`${SITE_BASE}/`)) return route.slice(SITE_BASE.length)
  return route
}

function routeFromSourcePath(sourcePath) {
  const withoutExtension = sourcePath.replace(/\.md$/i, '')

  if (withoutExtension === 'index') return '/docs'
  if (withoutExtension === 'en/index') return '/en/docs'
  if (withoutExtension.endsWith('/index')) {
    return cleanRoute(`/${withoutExtension.slice(0, -'/index'.length)}`)
  }

  return cleanRoute(`/${withoutExtension}`)
}

function parseFrontmatter(source) {
  if (!source.startsWith('---\n')) return { attributes: {}, body: source }

  const closingIndex = source.indexOf('\n---\n', 4)
  if (closingIndex === -1) return { attributes: {}, body: source }

  const attributes = {}
  const block = source.slice(4, closingIndex)
  for (const line of block.split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (!key || !value) continue
    value = value.replace(/^(['"])(.*)\1$/, '$2')
    attributes[key] = value
  }

  return {
    attributes,
    body: source.slice(closingIndex + 5),
  }
}

function plainText(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim()
}

function titleFromBody(body, sourcePath) {
  const match = body.match(/^#\s+(.+)$/m)
  if (match) return plainText(match[1])

  const filename = sourcePath.split('/').pop().replace(/\.md$/i, '')
  return filename
    .replace(/^\d+[-_.]?/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function descriptionFromBody(body) {
  const content = body
    .replace(/^#.*$/gm, '')
    .replace(/^>.*$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .split(/\n\s*\n/)
    .map(plainText)
    .find((paragraph) => paragraph.length > 30)

  return content ? content.slice(0, 180) : ''
}

function orderFromSourcePath(sourcePath) {
  const filename = sourcePath.split('/').pop()
  const match = filename.match(/^(\d+)/)
  return match ? Number(match[1]) : filename === 'index.md' ? 0 : 999
}

function sectionFromSourcePath(sourcePath) {
  const parts = sourcePath.split('/')
  const offset = parts[0] === 'en' ? 1 : 0
  return parts[offset] === 'index.md' ? 'guide' : parts[offset]
}

function preprocessDirectives(markdown) {
  return markdown.replace(
    /^(:{3,})\s*(info|tip|warning|danger)?\s*([^\n]*)\n([\s\S]*?)^\1\s*$/gm,
    (_, _fence, kind = 'info', label, content) => {
      const safeKind = kind || 'info'
      const heading = label.trim() || {
        danger: 'Danger',
        info: 'Info',
        tip: 'Tip',
        warning: 'Warning',
      }[safeKind]
      return `<aside class="doc-callout doc-callout--${safeKind}">\n<strong>${escapeAttribute(heading)}</strong>\n\n${content.trim()}\n</aside>\n\n`
    },
  )
}

const docs = docsManifest
  .map((record) => {
    const sourcePath = record.sourcePath.replace(/^docs\//, '')
    const { attributes, body } = parseFrontmatter(String(record.content))
    return {
      attributes,
      body,
      description: record.description || attributes.description || descriptionFromBody(body),
      locale: record.locale,
      order: orderFromSourcePath(sourcePath),
      route: record.path,
      section: record.section || sectionFromSourcePath(sourcePath),
      sourcePath,
      title: record.title || attributes.title || titleFromBody(body, sourcePath),
    }
  })
  .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))

const docsByRoute = new Map(docs.map((doc) => [doc.route.toLowerCase(), doc]))
const docsBySource = new Map(docs.map((doc) => [doc.sourcePath.toLowerCase(), doc]))

function normalizeRelativePath(basePath, targetPath) {
  const segments = basePath.split('/')
  segments.pop()

  for (const segment of targetPath.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }

  return segments.join('/')
}

function splitHref(href) {
  const match = href.match(/^([^?#]*)([?#].*)?$/)
  return {
    path: match?.[1] || '',
    suffix: match?.[2] || '',
  }
}

function resolveSourceReference(doc, href) {
  const { path, suffix } = splitHref(href)
  if (!path || path.startsWith('#') || EXTERNAL_PROTOCOL.test(path)) return href

  const sourcePath = path.startsWith('/')
    ? path.replace(/^\/+/, '')
    : normalizeRelativePath(doc.sourcePath, path)

  return { sourcePath, suffix }
}

export function resolveDocHref(doc, href) {
  const reference = resolveSourceReference(doc, href)
  if (typeof reference === 'string') return reference

  const { sourcePath, suffix } = reference
  if (/\.html$/i.test(sourcePath)) {
    return `/${sourcePath.replace(/^\/+/, '')}${suffix}`
  }

  const markdownPath = sourcePath.endsWith('.md')
    ? sourcePath
    : `${sourcePath.replace(/\/+$/, '')}.md`
  const indexPath = `${sourcePath.replace(/\/+$/, '')}/index.md`
  const target = docsBySource.get(markdownPath.toLowerCase())
    || docsBySource.get(indexPath.toLowerCase())

  if (target) return `${target.route}${suffix}`
  return `${cleanRoute(`/${sourcePath}`)}${suffix}`
}

export function resolveDocAsset(doc, href) {
  if (!href || EXTERNAL_PROTOCOL.test(href) || href.startsWith('data:')) return href

  const reference = resolveSourceReference(doc, href)
  if (typeof reference === 'string') return reference
  return `${toSiteHref(`/${reference.sourcePath}`)}${reference.suffix}`
}

function textFromTokens(tokens = []) {
  return tokens.map((token) => {
    if (typeof token.text === 'string') return plainText(token.text)
    if (Array.isArray(token.tokens)) return textFromTokens(token.tokens)
    return ''
  }).join('')
}

export function slugifyHeading(value) {
  return plainText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function renderMarkdown(doc) {
  const renderer = new Renderer()
  const headingCounts = new Map()
  const tableOfContents = []

  renderer.heading = function heading({ tokens, depth }) {
    const content = this.parser.parseInline(tokens)
    const text = textFromTokens(tokens) || plainText(content)
    const baseSlug = slugifyHeading(text) || 'section'
    const count = headingCounts.get(baseSlug) || 0
    const id = count === 0 ? baseSlug : `${baseSlug}-${count}`
    headingCounts.set(baseSlug, count + 1)

    if (depth >= 2 && depth <= 3) {
      tableOfContents.push({ depth, id, text })
    }

    return `<h${depth} id="${escapeAttribute(id)}">${content}<a class="doc-heading-anchor" href="#${escapeAttribute(id)}" aria-label="${escapeAttribute(`Link to ${text}`)}">#</a></h${depth}>`
  }

  renderer.link = function link({ href, title, tokens }) {
    const resolvedHref = resolveDocHref(doc, href)
    const isExternal = EXTERNAL_PROTOCOL.test(resolvedHref)
    const isStaticHtml = /\.html(?:[?#]|$)/i.test(resolvedHref)
    const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : ''
    const externalAttributes = isExternal
      ? ' target="_blank" rel="noreferrer noopener"'
      : isStaticHtml
        ? ''
        : ` data-doc-link data-doc-route="${escapeAttribute(resolvedHref)}"`
    const publicHref = isExternal ? resolvedHref : toSiteHref(resolvedHref)
    return `<a href="${escapeAttribute(publicHref)}"${titleAttribute}${externalAttributes}>${this.parser.parseInline(tokens)}</a>`
  }

  renderer.image = function image({ href, title, text }) {
    const resolvedHref = resolveDocAsset(doc, href)
    const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : ''
    return `<img src="${escapeAttribute(resolvedHref)}" alt="${escapeAttribute(text || '')}"${titleAttribute} loading="lazy" decoding="async">`
  }

  renderer.code = function code({ text, lang, escaped }) {
    const language = (lang || '').trim().split(/\s+/)[0]
    if (language === 'mermaid') {
      return `<div class="doc-mermaid" data-mermaid-pending="true"><pre>${escapeAttribute(text)}</pre></div>`
    }

    const className = language ? ` class="language-${escapeAttribute(language)}"` : ''
    const codeText = escaped ? text : escapeAttribute(text)
    return `<pre data-language="${escapeAttribute(language || 'text')}"><code${className}>${codeText}</code></pre>`
  }

  const parser = new Marked({
    gfm: true,
    renderer,
  })
  const html = DOMPurify.sanitize(parser.parse(preprocessDirectives(doc.body)), {
    ADD_ATTR: [
      'aria-label',
      'data-doc-link',
      'data-doc-route',
      'data-language',
      'data-mermaid-pending',
      'decoding',
      'loading',
      'target',
    ],
    FORBID_TAGS: ['embed', 'form', 'iframe', 'input', 'object', 'script', 'style', 'textarea'],
  })

  return {
    html,
    tableOfContents,
  }
}

function normalizeRequestedRoute(pathname) {
  let route = withoutSiteBase(pathname)

  if (route === '/docs') return '/desktop'
  if (route === '/en/docs') return '/en/desktop'
  if (route.startsWith('/docs/')) route = route.slice('/docs'.length)
  if (route.startsWith('/en/docs/')) route = `/en${route.slice('/en/docs'.length)}`
  return route
}

export function findDoc(pathname) {
  if (!pathname) return null
  const route = normalizeRequestedRoute(pathname)
  return docsByRoute.get(route.toLowerCase()) || null
}

export function getAllDocs(locale) {
  return docs.filter((doc) => !locale || doc.locale === locale)
}

export function getAdjacentDocs(doc, navigation) {
  const routes = navigation.flatMap((group) => group.items.map((item) => item.route))
  const index = routes.indexOf(doc.route)
  return {
    next: index >= 0 && index + 1 < routes.length ? findDoc(routes[index + 1]) : null,
    previous: index > 0 ? findDoc(routes[index - 1]) : null,
  }
}

export function isDocRoute(pathname) {
  return Boolean(findDoc(pathname))
    || cleanRoute(pathname) === '/docs'
    || cleanRoute(pathname) === '/en/docs'
}

export { docs }

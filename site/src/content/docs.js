import { Marked, Renderer } from 'marked'
import DOMPurify from 'dompurify'
import { docsContent, docsIndex, imageSizes, sections } from '../generated/docs-index'

const EXTERNAL_PROTOCOL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i
const SITE_BASE = `/${String(import.meta.env.BASE_URL || '/').replace(/^\/+|\/+$/g, '')}`
  .replace(/\/{2,}/g, '/')
  .replace(/\/$/, '') || '/'

/* ── 路由归一化 ─────────────────────────────────────────────── */

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

function splitHref(href) {
  const match = href.match(/^([^?#]*)([?#].*)?$/)
  return { path: match?.[1] || '', suffix: match?.[2] || '' }
}

export function toSiteHref(href) {
  if (!href || href.startsWith('#') || EXTERNAL_PROTOCOL.test(href)) return href

  const { path: rawPath, suffix } = splitHref(href)
  const route = /\.html$/i.test(rawPath)
    ? `/${decodeURIComponent(rawPath).replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`
    : cleanRoute(rawPath)

  if (SITE_BASE === '/') return `${route}${suffix}`
  if (route === SITE_BASE || route.startsWith(`${SITE_BASE}/`)) return `${route}${suffix}`
  return `${SITE_BASE}${route}${suffix}`
}

function withoutSiteBase(pathname) {
  const route = cleanRoute(pathname)
  if (SITE_BASE === '/') return route
  if (route === SITE_BASE) return '/'
  if (route.startsWith(`${SITE_BASE}/`)) return route.slice(SITE_BASE.length)
  return route
}

/* ── 索引 ───────────────────────────────────────────────────── */

const docsByRoute = new Map(docsIndex.map((doc) => [doc.path.toLowerCase(), doc]))
const docsBySource = new Map(
  docsIndex.map((doc) => [doc.sourcePath.replace(/^docs\//, '').toLowerCase(), doc])
)

/**
 * 2026-07 的信息架构重组把大部分文档挪了位置。老链接（README、外站、App 内）
 * 不能死在 404 上，这里做一次性重定向。
 */
const LEGACY_ROUTES = new Map(Object.entries({
  '/agent': '/internals/agent',
  '/agent/01-usage-guide': '/internals/agent',
  '/agent/02-implementation': '/internals/agent-internals',
  '/agent/03-agent-framework': '/internals/agent-framework',
  '/channel': '/internals/channel',
  '/channel/01-channel-system': '/internals/channel',
  '/channel/02-im-gateway-proposal': '/internals',
  '/desktop/01-quick-start': '/start/first-session',
  '/desktop/02-architecture': '/internals/desktop',
  '/desktop/03-features': '/desktop',
  '/desktop/04-installation': '/start/install',
  '/desktop/05-faq': '/start/troubleshooting',
  '/desktop/06-h5-access': '/desktop/remote',
  '/desktop/07-electron-migration-research': '/internals/desktop',
  '/desktop/08-electron-migration-tasks': '/internals/desktop',
  '/desktop/09-electron-migration-validation-checklist': '/internals/desktop',
  '/desktop/10-release-auto-update': '/internals/contributing',
  '/docs': '/start',
  '/features/computer-use': '/desktop/computer-use',
  '/features/computer-use-architecture': '/internals/computer-use',
  '/guide/cli-reference': '/cli/reference',
  '/guide/contributing': '/internals/contributing',
  '/guide/env-vars': '/cli/env',
  '/guide/faq': '/start/troubleshooting',
  '/guide/global-usage': '/cli',
  '/guide/quick-start': '/cli',
  '/guide/third-party-models': '/start/models',
  '/memory': '/internals/memory',
  '/memory/01-usage-guide': '/internals/memory',
  '/memory/02-implementation': '/internals/memory-internals',
  '/memory/03-autodream': '/internals/autodream',
  '/reference/fixes': '/internals',
  '/reference/local-server': '/internals/server',
  '/reference/project-structure': '/internals/structure',
  '/skills': '/internals/skills',
  '/skills/01-usage-guide': '/internals/skills',
  '/skills/02-implementation': '/internals/skills-internals'
}))

export function resolveLegacyRoute(pathname) {
  const route = withoutSiteBase(pathname)
  const isEnglish = route === '/en' || route.startsWith('/en/')
  const bare = isEnglish ? route.slice(3) || '/' : route
  const target = LEGACY_ROUTES.get(bare.toLowerCase())

  if (!target) return null
  const next = isEnglish ? `/en${target}` : target
  return docsByRoute.has(next.toLowerCase()) ? next : null
}

export function findDoc(pathname) {
  if (!pathname) return null
  return docsByRoute.get(withoutSiteBase(pathname).toLowerCase()) || null
}

export function getAllDocs(locale) {
  return docsIndex.filter((doc) => !locale || doc.locale === locale)
}

export function getSections() {
  return sections
}

/** 侧边栏：按登记好的分区顺序分组，组内按 frontmatter 的 order。 */
export function getDocNavigation(locale = 'zh') {
  const grouped = new Map()

  for (const doc of getAllDocs(locale)) {
    if (!grouped.has(doc.section)) grouped.set(doc.section, [])
    grouped.get(doc.section).push(doc)
  }

  const known = sections
    .filter((section) => grouped.has(section.id))
    .map((section) => ({ id: section.id, label: section[locale] || section.id }))
  const extras = [...grouped.keys()]
    .filter((id) => !sections.some((section) => section.id === id))
    .sort()
    .map((id) => ({ id, label: id }))

  return [...known, ...extras].map(({ id, label }) => ({
    id,
    items: grouped.get(id).map((doc) => ({
      label: doc.navTitle || doc.title,
      route: doc.path,
      title: doc.title
    })),
    label
  }))
}

export function alternateLocaleRoute(doc) {
  if (!doc) return '/'

  const source = doc.sourcePath.replace(/^docs\//, '')
  const target = doc.locale === 'en' ? source.replace(/^en\//, '') : `en/${source}`
  const alternate = docsBySource.get(target.toLowerCase())

  if (alternate) return alternate.path
  return doc.locale === 'en' ? '/start' : '/en/start'
}

export function getAdjacentDocs(doc, navigation) {
  const flat = navigation.flatMap((group) =>
    group.items.map((item) => ({ ...item, section: group.label }))
  )
  const index = flat.findIndex((item) => item.route === doc.path)

  return {
    next: index >= 0 && index + 1 < flat.length ? flat[index + 1] : null,
    previous: index > 0 ? flat[index - 1] : null
  }
}

/** 按需拉取一篇文档的正文，Vite 会把每篇切成独立 chunk。 */
export async function loadDocContent(route) {
  const load = docsContent[route]
  if (!load) return null
  const module = await load()
  return module.default
}

/* ── Markdown 渲染 ──────────────────────────────────────────── */

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

function resolveSourceReference(doc, href) {
  const { path: rawPath, suffix } = splitHref(href)
  if (!rawPath || rawPath.startsWith('#') || EXTERNAL_PROTOCOL.test(rawPath)) return href

  const source = doc.sourcePath.replace(/^docs\//, '')
  const sourcePath = rawPath.startsWith('/')
    ? rawPath.replace(/^\/+/, '')
    : normalizeRelativePath(source, rawPath)

  return { sourcePath, suffix }
}

export function resolveDocHref(doc, href) {
  const reference = resolveSourceReference(doc, href)
  if (typeof reference === 'string') return reference

  const { sourcePath, suffix } = reference
  if (/\.html$/i.test(sourcePath)) return `/${sourcePath.replace(/^\/+/, '')}${suffix}`

  const markdownPath = sourcePath.endsWith('.md') ? sourcePath : `${sourcePath.replace(/\/+$/, '')}.md`
  const indexPath = `${sourcePath.replace(/\/+$/, '')}/index.md`
  const target = docsBySource.get(markdownPath.toLowerCase())
    || docsBySource.get(indexPath.toLowerCase())

  if (target) return `${target.path}${suffix}`
  return `${cleanRoute(`/${sourcePath}`)}${suffix}`
}

export function resolveDocAsset(doc, href) {
  if (!href || EXTERNAL_PROTOCOL.test(href) || href.startsWith('data:')) return href

  const reference = resolveSourceReference(doc, href)
  if (typeof reference === 'string') return reference
  return `${toSiteHref(`/${reference.sourcePath}`)}${reference.suffix}`
}

function plainText(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim()
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

function preprocessDirectives(markdown) {
  return markdown.replace(
    /^(:{3,})\s*(info|tip|warning|danger)?\s*([^\n]*)\n([\s\S]*?)^\1\s*$/gm,
    (_, _fence, kind = 'info', label, content) => {
      const safeKind = kind || 'info'
      const heading = label.trim() || {
        danger: '注意',
        info: '说明',
        tip: '提示',
        warning: '当心'
      }[safeKind]
      return `<aside class="doc-callout doc-callout--${safeKind}">\n<strong>${escapeAttribute(heading)}</strong>\n\n${content.trim()}\n</aside>\n\n`
    }
  )
}

/** 语法高亮按需加载：首屏不为它买单，加载好之后重渲染一次。 */
let highlighter = null
let highlighterPromise = null

export function getHighlighter() {
  return highlighter
}

export function ensureHighlighter() {
  if (highlighter) return Promise.resolve(highlighter)
  if (highlighterPromise) return highlighterPromise

  highlighterPromise = (async () => {
    const [{ default: hljs }, ...languages] = await Promise.all([
      import('highlight.js/lib/core'),
      import('highlight.js/lib/languages/bash'),
      import('highlight.js/lib/languages/typescript'),
      import('highlight.js/lib/languages/javascript'),
      import('highlight.js/lib/languages/json'),
      import('highlight.js/lib/languages/yaml'),
      import('highlight.js/lib/languages/xml'),
      import('highlight.js/lib/languages/markdown'),
      import('highlight.js/lib/languages/powershell'),
      import('highlight.js/lib/languages/nginx'),
      import('highlight.js/lib/languages/css'),
      import('highlight.js/lib/languages/ini'),
      import('highlight.js/lib/languages/python'),
      import('highlight.js/lib/languages/diff')
    ])

    const names = [
      'bash', 'typescript', 'javascript', 'json', 'yaml', 'xml', 'markdown',
      'powershell', 'nginx', 'css', 'ini', 'python', 'diff'
    ]
    names.forEach((name, index) => hljs.registerLanguage(name, languages[index].default))
    hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' })
    hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
    hljs.registerAliases(['js', 'jsx', 'mjs'], { languageName: 'javascript' })
    hljs.registerAliases(['yml'], { languageName: 'yaml' })
    hljs.registerAliases(['html', 'svg'], { languageName: 'xml' })
    hljs.registerAliases(['md'], { languageName: 'markdown' })
    hljs.registerAliases(['toml', 'conf', 'env', 'dotenv'], { languageName: 'ini' })
    hljs.registerAliases(['py'], { languageName: 'python' })

    hljs.configure({ classPrefix: 'hljs-' })
    highlighter = hljs
    return hljs
  })()

  return highlighterPromise
}

export function renderMarkdown(doc, markdown) {
  const renderer = new Renderer()
  const headingCounts = new Map()
  const tableOfContents = []
  const hljs = highlighter

  renderer.heading = function heading({ tokens, depth }) {
    const content = this.parser.parseInline(tokens)
    const text = textFromTokens(tokens) || plainText(content)
    const baseSlug = slugifyHeading(text) || 'section'
    const count = headingCounts.get(baseSlug) || 0
    const id = count === 0 ? baseSlug : `${baseSlug}-${count}`
    headingCounts.set(baseSlug, count + 1)

    if (depth >= 2 && depth <= 3) tableOfContents.push({ depth, id, text })

    const anchor = depth >= 2 && depth <= 3
      ? `<a class="doc-anchor" href="#${escapeAttribute(id)}" aria-label="${escapeAttribute(text)}">#</a>`
      : ''

    return `<h${depth} id="${escapeAttribute(id)}">${content}${anchor}</h${depth}>`
  }

  renderer.link = function link({ href, title, tokens }) {
    const resolvedHref = resolveDocHref(doc, href)
    const isExternal = EXTERNAL_PROTOCOL.test(resolvedHref)
    const isStaticHtml = /\.html(?:[?#]|$)/i.test(resolvedHref)
    const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : ''
    const extra = isExternal
      ? ' target="_blank" rel="noreferrer noopener"'
      : isStaticHtml
        ? ''
        : ` data-doc-link data-doc-route="${escapeAttribute(resolvedHref)}"`
    const publicHref = isExternal ? resolvedHref : toSiteHref(resolvedHref)
    return `<a href="${escapeAttribute(publicHref)}"${titleAttribute}${extra}>${this.parser.parseInline(tokens)}</a>`
  }

  renderer.image = function image({ href, title, text }) {
    const resolvedHref = resolveDocAsset(doc, href)
    const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : ''
    // 带上真实像素尺寸，浏览器才能在图片下载完之前按比例留位，正文不会跳。
    const size = imageSizes[resolvedHref.split(/[?#]/, 1)[0]]
    const sizeAttributes = size ? ` width="${size[0]}" height="${size[1]}"` : ''
    // 竖图（手机截图、聊天软件的扫码页）在正文列宽下能铺满两屏，得单独限高。
    // 构建期就知道比例，所以这里标出来，CSS 不用去猜文件名。
    const tall = size ? ` data-tall="${size[1] / size[0] > 1.1}"` : ''
    return `<img src="${escapeAttribute(resolvedHref)}" alt="${escapeAttribute(text || '')}"${titleAttribute}${sizeAttributes}${tall} loading="lazy" decoding="async">`
  }

  // 宽表格在窄屏上必须自己横向滚动，不能把页面撑出横向滚动条。
  renderer.table = function table(token) {
    const header = `<tr>${token.header.map((cell, index) =>
      `<th${token.align[index] ? ` style="text-align:${token.align[index]}"` : ''}>${this.parser.parseInline(cell.tokens)}</th>`
    ).join('')}</tr>`

    const body = token.rows.map((row) =>
      `<tr>${row.map((cell, index) =>
        `<td${token.align[index] ? ` style="text-align:${token.align[index]}"` : ''}>${this.parser.parseInline(cell.tokens)}</td>`
      ).join('')}</tr>`
    ).join('')

    return `<div class="doc-table-wrap"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>`
  }

  renderer.code = function code({ text, lang }) {
    const language = (lang || '').trim().split(/\s+/)[0]
    if (language === 'mermaid') {
      return `<div class="doc-mermaid" data-mermaid-pending="true"><pre>${escapeAttribute(text)}</pre></div>`
    }

    let markup = escapeAttribute(text)
    if (hljs && language && hljs.getLanguage(language)) {
      try {
        markup = hljs.highlight(text, { ignoreIllegals: true, language }).value
      } catch {
        markup = escapeAttribute(text)
      }
    }

    const className = language ? ` class="language-${escapeAttribute(language)}"` : ''
    return `<pre data-language="${escapeAttribute(language || 'text')}"><code${className}>${markup}</code></pre>`
  }

  const parser = new Marked({ gfm: true, renderer })
  const html = DOMPurify.sanitize(parser.parse(preprocessDirectives(markdown)), {
    ADD_ATTR: [
      'aria-label',
      'data-doc-link',
      'data-doc-route',
      'data-language',
      'data-mermaid-pending',
      'data-tall',
      'decoding',
      'height',
      'loading',
      'target',
      'width'
    ],
    FORBID_TAGS: ['embed', 'form', 'iframe', 'input', 'object', 'script', 'style', 'textarea']
  })

  return { html, tableOfContents }
}

export function isDocRoute(pathname) {
  return Boolean(findDoc(pathname)) || Boolean(resolveLegacyRoute(pathname))
}

export { docsIndex }

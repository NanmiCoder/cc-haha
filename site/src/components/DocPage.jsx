import { useEffect, useMemo, useRef, useState } from 'react'
import {
  alternateLocaleRoute,
  ensureHighlighter,
  findDoc,
  getAdjacentDocs,
  getDocNavigation,
  getHighlighter,
  getSections,
  loadDocContent,
  renderMarkdown,
  toSiteHref
} from '../content/docs'
import { DocPager } from './DocPager'
import { DocSidebar } from './DocSidebar'
import { DocToc } from './DocToc'
import Icon from './icons'
import SiteHeader from './SiteHeader'
import { setPageMeta } from '../lib/meta'
import '../docs/doc.css'

const copy = {
  zh: { home: '首页', menu: '目录', reading: '正在打开…', sidebar: '文档目录' },
  en: { home: 'Home', menu: 'Contents', reading: 'Opening…', sidebar: 'Documentation' }
}

function defaultNavigate(href) {
  window.history.pushState({}, '', toSiteHref(href))
  window.dispatchEvent(new PopStateEvent('popstate'))
}

async function scrollToDocHeading(id) {
  const images = [...document.querySelectorAll('.prose img')]
  images.forEach((image) => { image.loading = 'eager' })
  await Promise.all(images.map((image) => {
    if (image.complete && image.naturalWidth > 0) return Promise.resolve()
    return image.decode?.().catch(() => undefined) || Promise.resolve()
  }))

  await new Promise((resolve) => requestAnimationFrame(resolve))
  document.getElementById(id)?.scrollIntoView()
}

export function DocPage({ onNavigate = defaultNavigate, onNotFound, path, pathname = path || window.location.pathname }) {
  const doc = useMemo(() => findDoc(pathname), [pathname])
  const [markdown, setMarkdown] = useState(null)
  const [highlightReady, setHighlightReady] = useState(() => Boolean(getHighlighter()))
  const [navOpen, setNavOpen] = useState(false)
  const mainRef = useRef(null)
  const firstRender = useRef(true)

  const locale = doc?.locale || 'zh'
  const c = copy[locale] || copy.zh
  const navigation = useMemo(() => getDocNavigation(locale), [locale])

  useEffect(() => {
    let cancelled = false
    setMarkdown(null)

    if (!doc) return undefined

    Promise.all([loadDocContent(doc.path), ensureHighlighter().catch(() => null)])
      .then(([content]) => {
        if (cancelled) return
        setHighlightReady(true)
        setMarkdown(content ?? '')
      })

    return () => { cancelled = true }
  }, [doc])

  const rendered = useMemo(
    () => (doc && markdown !== null ? renderMarkdown(doc, markdown) : null),
    // highlightReady 参与依赖：高亮器就绪后要用带高亮的结果重渲染一次
    [doc, markdown, highlightReady]
  )

  useEffect(() => {
    if (!doc) return
    const alternate = alternateLocaleRoute(doc)
    setPageMeta({
      canonical: doc.path,
      description: doc.description,
      lang: doc.locale === 'en' ? 'en' : 'zh-CN',
      alternate: alternate === doc.path ? null : alternate,
      title: `${doc.title} · Claude Code Haha`
    })
  }, [doc])

  useEffect(() => {
    if (!rendered) return
    const hash = window.location.hash
    if (hash) scrollToDocHeading(decodeURIComponent(hash.slice(1)))
    else requestAnimationFrame(() => window.scrollTo({ top: 0 }))
  }, [rendered])

  // 换页是客户端跳转，浏览器不会重置焦点。不把焦点搬进正文，读屏用户
  // 停在旧页面的某个链接上，也听不到新页面的标题。
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    if (!doc) return
    mainRef.current?.focus({ preventScroll: true })
  }, [doc])

  // 抽屉是覆盖在正文上的，Esc 得能关掉它。
  useEffect(() => {
    if (!navOpen) return undefined
    const onKeyDown = (event) => { if (event.key === 'Escape') setNavOpen(false) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navOpen])

  useEffect(() => {
    if (!rendered) return undefined
    const diagrams = [...document.querySelectorAll('.doc-mermaid[data-mermaid-pending="true"]')]
    if (diagrams.length === 0) return undefined

    let cancelled = false
    const styles = getComputedStyle(document.documentElement)
    const token = (name, fallback) => styles.getPropertyValue(name).trim() || fallback

    import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({
        securityLevel: 'strict',
        startOnLoad: false,
        theme: 'base',
        themeVariables: {
          fontFamily: token('--font-sans', 'Inter, sans-serif'),
          lineColor: token('--text-2', '#5d5850'),
          primaryBorderColor: token('--border-strong', '#d8d5cc'),
          primaryColor: token('--surface-muted', '#f6f6f3'),
          primaryTextColor: token('--text', '#1f1c17'),
          secondaryColor: token('--brand-soft', '#f6ece5'),
          tertiaryColor: token('--surface', '#ffffff')
        }
      })

      for (const [index, diagram] of diagrams.entries()) {
        if (cancelled) return
        const source = diagram.querySelector('pre')?.textContent || ''
        try {
          const { svg } = await mermaid.render(`doc-mermaid-${index}-${Math.random().toString(36).slice(2)}`, source)
          if (!cancelled) {
            diagram.innerHTML = svg
            diagram.dataset.mermaidPending = 'false'
          }
        } catch {
          diagram.dataset.mermaidPending = 'error'
        }
      }
    })

    return () => { cancelled = true }
  }, [rendered])

  if (!doc) return onNotFound ? onNotFound(pathname) : null

  const adjacent = getAdjacentDocs(doc, navigation)
  const sectionLabel = getSections().find((section) => section.id === doc.section)?.[locale] || doc.section

  function handleArticleClick(event) {
    const hashAnchor = event.target.closest('a[href^="#"]')
    if (hashAnchor && !event.defaultPrevented) {
      event.preventDefault()
      const id = decodeURIComponent(hashAnchor.hash.slice(1))
      window.history.pushState({}, '', hashAnchor.hash)
      scrollToDocHeading(id)
      return
    }

    const anchor = event.target.closest('a[data-doc-link]')
    if (!anchor || event.defaultPrevented) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

    event.preventDefault()
    onNavigate(anchor.dataset.docRoute)
  }

  return (
    <>
      <a className="u-skip" href="#doc-main">{locale === 'en' ? 'Skip to content' : '跳到正文'}</a>
      <SiteHeader
        activeSection={doc.section}
        locale={locale}
        localeHref={alternateLocaleRoute(doc)}
      />

      <div className="doc-mobilebar">
        <button
          aria-controls="doc-nav"
          aria-expanded={navOpen}
          onClick={() => setNavOpen((value) => !value)}
          type="button"
        >
          <Icon name="sidebar" size={16} />
          {c.menu}
        </button>
        <span className="doc-mobilebar__here">{sectionLabel} · {doc.navTitle || doc.title}</span>
      </div>

      <div className="doc-scrim" data-open={navOpen} onClick={() => setNavOpen(false)} />

      <div className="doc-layout">
        <DocSidebar
          activeRoute={doc.path}
          label={c.sidebar}
          navigation={navigation}
          onNavigate={onNavigate}
          onRequestClose={() => setNavOpen(false)}
          open={navOpen}
        />

        {/* tabIndex -1 让「跳到正文」和换页真的把焦点搬进来，而不是停在 body 上 */}
        <main className="doc-main" id="doc-main" ref={mainRef} tabIndex={-1}>
          <div className="doc-breadcrumb">
            <a
              href={toSiteHref(locale === 'en' ? '/en' : '/')}
              onClick={(event) => { event.preventDefault(); onNavigate(locale === 'en' ? '/en' : '/') }}
            >
              {c.home}
            </a>
            <span aria-hidden="true">/</span>
            <span>{sectionLabel}</span>
          </div>

          {rendered
            ? (
              <article
                className="prose"
                dangerouslySetInnerHTML={{ __html: rendered.html }}
                onClick={handleArticleClick}
              />
            )
            : <p className="doc-loading">{c.reading}</p>}

          <DocPager
            locale={locale}
            next={adjacent.next}
            onNavigate={onNavigate}
            previous={adjacent.previous}
          />
        </main>

        {rendered && (
          <DocToc
            headings={rendered.tableOfContents}
            locale={locale}
            onAnchorNavigate={(event, id) => {
              event.preventDefault()
              window.history.pushState({}, '', `#${encodeURIComponent(id)}`)
              scrollToDocHeading(id)
            }}
          />
        )}
      </div>
    </>
  )
}

export default DocPage

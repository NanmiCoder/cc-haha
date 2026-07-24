import React, { useEffect, useMemo } from 'react'
import {
  findDoc,
  getAdjacentDocs,
  renderMarkdown,
  toSiteHref,
} from '../content/docs'
import {
  alternateLocaleRoute,
  getDocNavigation,
} from '../content/navigation'
import { DocPager } from './DocPager'
import { DocSidebar } from './DocSidebar'
import { DocToc } from './DocToc'
import '../docs/doc.css'

function defaultNavigate(href) {
  window.history.pushState({}, '', toSiteHref(href))
  window.dispatchEvent(new PopStateEvent('popstate'))
}

async function scrollToDocHeading(id) {
  const images = [...document.querySelectorAll('.doc-content img')]
  images.forEach((image) => {
    image.loading = 'eager'
  })
  await Promise.all(images.map((image) => {
    if (image.complete && image.naturalWidth > 0) return Promise.resolve()
    return image.decode?.().catch(() => undefined) || Promise.resolve()
  }))

  await new Promise((resolve) => requestAnimationFrame(resolve))
  document.getElementById(id)?.scrollIntoView()
}

export function DocPage({
  onNavigate = defaultNavigate,
  onNotFound,
  path,
  pathname = path || window.location.pathname,
}) {
  const doc = useMemo(() => findDoc(pathname), [pathname])
  const navigation = useMemo(
    () => getDocNavigation(doc?.locale || 'zh'),
    [doc?.locale],
  )
  const rendered = useMemo(
    () => doc ? renderMarkdown(doc) : null,
    [doc],
  )
  const adjacent = useMemo(
    () => doc ? getAdjacentDocs(doc, navigation) : {},
    [doc, navigation],
  )

  useEffect(() => {
    if (!doc) return
    document.documentElement.lang = doc.locale === 'en' ? 'en' : 'zh-CN'
    document.title = `${doc.title} · Claude Code Haha`

    const hash = window.location.hash
    if (hash) scrollToDocHeading(decodeURIComponent(hash.slice(1)))
    else requestAnimationFrame(() => window.scrollTo({ top: 0 }))
  }, [doc])

  useEffect(() => {
    const diagrams = [...document.querySelectorAll('.doc-mermaid[data-mermaid-pending="true"]')]
    if (diagrams.length === 0) return undefined

    let cancelled = false
    async function renderDiagrams() {
      const { default: mermaid } = await import('mermaid')
      mermaid.initialize({
        securityLevel: 'strict',
        startOnLoad: false,
        theme: 'base',
        themeVariables: {
          fontFamily: 'Inter, PingFang SC, sans-serif',
          lineColor: '#1a1610',
          primaryColor: '#f3efe4',
          primaryBorderColor: '#1a1610',
          primaryTextColor: '#1a1610',
          secondaryColor: '#f6e6de',
          tertiaryColor: '#faf7ee',
        },
      })

      for (const [index, diagram] of diagrams.entries()) {
        if (cancelled) return
        const source = diagram.querySelector('pre')?.textContent || ''
        try {
          const id = `doc-mermaid-${Date.now()}-${index}`
          const { svg } = await mermaid.render(id, source)
          if (!cancelled) {
            diagram.innerHTML = svg
            diagram.dataset.mermaidPending = 'false'
          }
        } catch {
          diagram.dataset.mermaidPending = 'error'
        }
      }
    }

    renderDiagrams()
    return () => {
      cancelled = true
    }
  }, [doc, rendered])

  if (!doc) return onNotFound ? onNotFound(pathname) : null

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

  const alternateRoute = alternateLocaleRoute(doc)
  const localeLabel = doc.locale === 'en' ? '阅读中文' : 'Read in English'
  const homeRoute = doc.locale === 'en' ? '/en' : '/'
  const handleTocNavigate = (event, id) => {
    event.preventDefault()
    window.history.pushState({}, '', `#${encodeURIComponent(id)}`)
    scrollToDocHeading(id)
  }

  return (
    <>
      <header className="doc-site-header">
        <a
          className="doc-site-header__brand"
          href={toSiteHref(homeRoute)}
          onClick={(event) => {
            event.preventDefault()
            onNavigate(homeRoute)
          }}
        >
          <img src={toSiteHref('/images/app-icon.png')} alt="" />
          <span>Claude Code Haha</span>
          <small>Docs</small>
        </a>
        <div className="doc-site-header__marker" aria-hidden="true">
          Field manual · 2026
        </div>
        <nav className="doc-site-header__actions" aria-label="Documentation links">
          <a href="https://github.com/NanmiCoder/cc-haha" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a
            href={toSiteHref(alternateRoute)}
            onClick={(event) => {
              event.preventDefault()
              onNavigate(alternateRoute)
            }}
          >
            {localeLabel}
          </a>
        </nav>
      </header>

      <div className="doc-shell">
        <DocSidebar
          activeRoute={doc.route}
          navigation={navigation}
          onNavigate={onNavigate}
        />

        <main className="doc-main" id="main-content">
          <div className="doc-main__meta">
            <span>{doc.locale === 'en' ? 'DOCUMENTATION' : '使用手册'}</span>
            <a href={toSiteHref(alternateRoute)} onClick={(event) => {
              event.preventDefault()
              onNavigate(alternateRoute)
            }}>
              {localeLabel}
            </a>
          </div>

          <article
            className="doc-content"
            dangerouslySetInnerHTML={{ __html: rendered.html }}
            onClick={handleArticleClick}
          />

          <DocPager
            next={adjacent.next}
            onNavigate={onNavigate}
            previous={adjacent.previous}
          />
        </main>

        <DocToc
          headings={rendered.tableOfContents}
          locale={doc.locale}
          onAnchorNavigate={handleTocNavigate}
        />
      </div>
    </>
  )
}

export default DocPage

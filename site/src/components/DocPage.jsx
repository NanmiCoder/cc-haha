import { useEffect, useMemo, useRef, useState } from 'react'
import {
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
import ImageViewer from './ImageViewer'
import { readingProgress, copyCode } from '../lib/readingProgress'
import { setPageMeta } from '../lib/meta'
import '../docs/doc.css'
import '../docs/doc-wandor.css'

const copy = { home: 'Home', menu: 'Contents', reading: 'Opening…', sidebar: 'Documentation' }

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
  const [enlargedImage, setEnlargedImage] = useState(null)
  const [progress, setProgress] = useState(0)
  const [copyStatus, setCopyStatus] = useState('')
  const copyTimers = useRef(new Set())
  const mainRef = useRef(null)
  const firstRender = useRef(true)

  const c = copy
  const navigation = useMemo(() => getDocNavigation(), [])

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
    // highlightReady is a dependency: once the highlighter is ready, re-render once with highlighting
    [doc, markdown, highlightReady]
  )

  // Keep the HTML prop stable across progress, copy status and image-viewer updates.
  // Replacing innerHTML would discard enhanced code buttons and the focused image.
  const articleContent = useMemo(() => ({ __html: rendered?.html || '' }), [rendered])

  useEffect(() => {
    if (!doc) return
    setPageMeta({
      canonical: doc.path,
      description: doc.description,
      title: `${doc.title} · cc-haha`
    })
  }, [doc])

  useEffect(() => {
    if (!rendered) return
    document.querySelectorAll('.prose pre').forEach((pre) => {
      if (!pre.querySelector('code') || pre.querySelector('.doc-code-copy')) return
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'doc-code-copy'
      button.textContent = 'Copy'
      button.setAttribute('aria-label', 'Copy code')
      pre.append(button)
    })
    document.querySelectorAll('.prose img').forEach((image) => {
      image.tabIndex = 0
      image.setAttribute('role', 'button')
      image.setAttribute('aria-label', `Enlarge image: ${image.alt || ''}`)
    })
    const hash = window.location.hash
    if (hash) scrollToDocHeading(decodeURIComponent(hash.slice(1)))
    else requestAnimationFrame(() => window.scrollTo({ top: 0 }))
  }, [rendered])

  // Page changes are client-side, so the browser doesn't reset focus. Without moving focus into the content, screen reader users
  // stay on a link from the old page and never hear the new page's title.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    if (!doc) return
    mainRef.current?.focus({ preventScroll: true })
  }, [doc])

  // The drawer overlays the content, so Esc has to close it.
  useEffect(() => {
    if (!navOpen) return undefined
    const onKeyDown = (event) => { if (event.key === 'Escape') setNavOpen(false) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navOpen])

  useEffect(() => {
    if (!rendered) return undefined
    let frame
    const update = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = null
        const article = mainRef.current?.querySelector('article')
        if (!article) return
        const rect = article.getBoundingClientRect()
        const headerHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--h-header')) || 76
        setProgress(readingProgress({ top: rect.top, height: rect.height, viewportHeight: innerHeight, headerHeight }))
      })
    }
    const observer = new ResizeObserver(update)
    const article = mainRef.current?.querySelector('article')
    if (article) observer.observe(article)
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    update()
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      cancelAnimationFrame(frame)
    }
  }, [rendered])

  useEffect(() => {
    setCopyStatus('')
    return () => {
      copyTimers.current.forEach(clearTimeout)
      copyTimers.current.clear()
    }
  }, [doc])

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
  const sectionLabel = getSections().find((section) => section.id === doc.section)?.label || doc.section

  async function handleArticleClick(event) {
    const copyButton = event.target.closest('.doc-code-copy')
    if (copyButton) {
      const code = copyButton.closest('pre')?.querySelector('code')?.textContent || ''
      copyButton.disabled = true
      const copied = await copyCode(code, navigator.clipboard)
      if (!copyButton.isConnected) return
      copyButton.disabled = false
      copyButton.textContent = copied ? 'Copied ✓' : 'Try again'
      setCopyStatus(copied ? 'Code copied' : 'Clipboard unavailable. Select and copy the code manually.')
      const timer = setTimeout(() => {
        if (copyButton.isConnected) copyButton.textContent = 'Copy'
        copyTimers.current.delete(timer)
      }, 2000)
      copyTimers.current.add(timer)
      return
    }
    const image = event.target.closest('img')
    if (image?.closest('.prose')) {
      setEnlargedImage({ src: image.currentSrc || image.src, alt: image.alt, opener: image })
      return
    }
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

  function handleArticleKeyDown(event) {
    if (!['Enter', ' '].includes(event.key) || event.target.tagName !== 'IMG') return
    event.preventDefault()
    setEnlargedImage({ src: event.target.currentSrc || event.target.src, alt: event.target.alt, opener: event.target })
  }

  return (
    <div className="docs-site">
      <a className="u-skip" href="#doc-main">Skip to content</a>
      <SiteHeader activeSection={doc.section} />

      <div className="doc-read-progress" style={{ transform: `scaleX(${progress / 100})` }} aria-hidden="true" />
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

        {/* tabIndex -1 lets "Skip to content" and page changes actually move focus here instead of leaving it on body */}
        <main className="doc-main" id="doc-main" ref={mainRef} tabIndex={-1}>
          <div className="doc-reading-head">
            <span>cc-haha / FIELD GUIDE</span>
            <span>TAKE A CLOSER LOOK</span>
          </div>
          <div className="doc-cover" aria-hidden="true">
            <span>A GUIDE FOR CURIOUS MINDS</span>
            <span>YOUR NEXT CHAPTER STARTS HERE</span>
          </div>
          <div className="doc-breadcrumb">
            <a
              href={toSiteHref('/')}
              onClick={(event) => { event.preventDefault(); onNavigate('/') }}
            >
              {c.home}
            </a>
            <span aria-hidden="true">/</span>
            <span>{sectionLabel}</span>
          </div>

          <span className="u-sr-only" role="status">{copyStatus}</span>
          {rendered
            ? (
              <article
                className="prose"
                dangerouslySetInnerHTML={articleContent}
                onClick={handleArticleClick}
                onKeyDown={handleArticleKeyDown}
              />
            )
            : <p className="doc-loading">{c.reading}</p>}

          <DocPager
            next={adjacent.next}
            onNavigate={onNavigate}
            previous={adjacent.previous}
          />
        </main>

        {rendered && (
          <DocToc
            progress={progress}
            headings={rendered.tableOfContents}
            onAnchorNavigate={(event, id) => {
              event.preventDefault()
              window.history.pushState({}, '', `#${encodeURIComponent(id)}`)
              scrollToDocHeading(id)
            }}
          />
        )}
      </div>

      {enlargedImage && <ImageViewer image={enlargedImage} onClose={() => setEnlargedImage(null)} />}
      <button className="doc-back-top" data-visible={progress > 8} tabIndex={progress > 8 ? 0 : -1} aria-label="Back to top" type="button" onClick={() => { window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); mainRef.current?.focus({ preventScroll: true }) }}>↑</button>
    </div>
  )
}

export default DocPage

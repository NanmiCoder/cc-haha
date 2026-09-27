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
import ImageViewer from './ImageViewer'
import { readingProgress, copyCode } from '../lib/readingProgress'
import { setPageMeta } from '../lib/meta'
import '../docs/doc.css'
import '../docs/doc-wandor.css'

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
  const [enlargedImage, setEnlargedImage] = useState(null)
  const [progress, setProgress] = useState(0)
  const [copyStatus, setCopyStatus] = useState('')
  const copyTimers = useRef(new Set())
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

  // Keep the HTML prop stable across progress, copy status and image-viewer updates.
  // Replacing innerHTML would discard enhanced code buttons and the focused image.
  const articleContent = useMemo(() => ({ __html: rendered?.html || '' }), [rendered])

  useEffect(() => {
    if (!doc) return
    const alternate = alternateLocaleRoute(doc)
    setPageMeta({
      canonical: doc.path,
      description: doc.description,
      lang: doc.locale === 'en' ? 'en' : 'zh-CN',
      alternate: alternate === doc.path ? null : alternate,
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
      button.textContent = locale === 'en' ? 'Copy' : '复制'
      button.setAttribute('aria-label', locale === 'en' ? 'Copy code' : '复制代码')
      pre.append(button)
    })
    document.querySelectorAll('.prose img').forEach((image) => {
      image.tabIndex = 0
      image.setAttribute('role', 'button')
      image.setAttribute('aria-label', `${locale === 'en' ? 'Enlarge image' : '放大图片'}：${image.alt || ''}`)
    })
    const hash = window.location.hash
    if (hash) scrollToDocHeading(decodeURIComponent(hash.slice(1)))
    else requestAnimationFrame(() => window.scrollTo({ top: 0 }))
  }, [rendered, locale])

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
  const sectionLabel = getSections().find((section) => section.id === doc.section)?.[locale] || doc.section

  async function handleArticleClick(event) {
    const copyButton = event.target.closest('.doc-code-copy')
    if (copyButton) {
      const code = copyButton.closest('pre')?.querySelector('code')?.textContent || ''
      copyButton.disabled = true
      const copied = await copyCode(code, navigator.clipboard)
      if (!copyButton.isConnected) return
      copyButton.disabled = false
      copyButton.textContent = copied ? (locale === 'en' ? 'Copied ✓' : '已复制 ✓') : (locale === 'en' ? 'Try again' : '重试')
      setCopyStatus(copied ? (locale === 'en' ? 'Code copied' : '代码已复制') : (locale === 'en' ? 'Clipboard unavailable. Select and copy the code manually.' : '剪贴板不可用，请选中代码手动复制。'))
      const timer = setTimeout(() => {
        if (copyButton.isConnected) copyButton.textContent = locale === 'en' ? 'Copy' : '复制'
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
      <a className="u-skip" href="#doc-main">{locale === 'en' ? 'Skip to content' : '跳到正文'}</a>
      <SiteHeader
        activeSection={doc.section}
        locale={locale}
        localeHref={alternateLocaleRoute(doc)}
      />

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
          locale={locale}
          navigation={navigation}
          onNavigate={onNavigate}
          onRequestClose={() => setNavOpen(false)}
          open={navOpen}
        />

        {/* tabIndex -1 让「跳到正文」和换页真的把焦点搬进来，而不是停在 body 上 */}
        <main className="doc-main" id="doc-main" ref={mainRef} tabIndex={-1}>
          <div className="doc-reading-head">
            <span>cc-haha / {locale === 'en' ? 'FIELD GUIDE' : '使用指南'}</span>
            <span>{locale === 'en' ? 'TAKE A CLOSER LOOK' : '从这里，走进你的工作流'}</span>
          </div>
          <div className="doc-cover" aria-hidden="true">
            <span>{locale === 'en' ? 'A GUIDE FOR CURIOUS MINDS' : '给每一个好奇的你'}</span>
            <span>{locale === 'en' ? 'YOUR NEXT CHAPTER STARTS HERE' : '下一章，从这里开始'}</span>
          </div>
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
            locale={locale}
            next={adjacent.next}
            onNavigate={onNavigate}
            previous={adjacent.previous}
          />
        </main>

        {rendered && (
          <DocToc
            progress={progress}
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

      {enlargedImage && <ImageViewer image={enlargedImage} locale={locale} onClose={() => setEnlargedImage(null)} />}
      <button className="doc-back-top" data-visible={progress > 8} tabIndex={progress > 8 ? 0 : -1} aria-label={locale === 'en' ? 'Back to top' : '回到顶部'} type="button" onClick={() => { window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); mainRef.current?.focus({ preventScroll: true }) }}>↑</button>
    </div>
  )
}

export default DocPage

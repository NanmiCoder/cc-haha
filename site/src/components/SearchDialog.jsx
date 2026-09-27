import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './icons'
import { getAllDocs, getSections, toSiteHref } from '../content/docs'
import { highlightParts, queryTerms, searchEntries, shouldOpenSearchResult } from './searchResults'
import './search-dialog.css'

const copy = {
  zh: {
    close: '关闭搜索',
    clear: '清空搜索',
    loading: '正在载入文档…',
    failed: '搜索暂时无法加载，请关闭后重试。',
    popular: '从这里开始',
    title: '找到下一步',
    count: (total, shown) => total > shown ? `显示前 ${shown} 篇 · 共 ${total} 篇` : `${total} 篇文档`,
    empty: '没有匹配的文档',
    hint: '搜标题、摘要和正文',
    label: '搜索文档',
    placeholder: '搜索文档…',
    results: '搜索结果',
    tips: ['↑↓ 选择', '↵ 打开', 'Esc 关闭']
  },
  en: {
    close: 'Close search',
    clear: 'Clear search',
    loading: 'Loading documentation…',
    failed: 'Search could not load. Close and try again.',
    popular: 'Start exploring',
    title: 'Find your next step',
    count: (total, shown) => total > shown ? `Top ${shown} of ${total} results` : `${total} documents`,
    empty: 'Nothing matched',
    hint: 'Searches titles, summaries and body text',
    label: 'Search docs',
    placeholder: 'Search docs…',
    results: 'Search results',
    tips: ['↑↓ to move', '↵ to open', 'Esc to close']
  }
}

const FOCUSABLE = 'a[href], button:not([disabled]), input, [tabindex]'

function Highlight({ text, terms }) {
  return highlightParts(text, terms).map((part, index) => part.match
    ? <mark key={index}>{part.text}</mark>
    : part.text)
}

export default function SearchDialog({ locale = 'zh', onClose }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const dialogRef = useRef(null)
  const c = copy[locale] || copy.zh

  const sectionLabels = useMemo(() => {
    const map = new Map()
    for (const section of getSections()) map.set(section.id, section[locale] || section.id)
    return map
  }, [locale])

  useEffect(() => {
    let cancelled = false
    import('../generated/search-index').then((module) => {
      if (!cancelled) setIndex(module.default)
    }).catch(() => {
      if (!cancelled) setLoadFailed(true)
    })
    inputRef.current?.focus()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  // 关掉对话框要把焦点还给打开它的那个控件，否则键盘用户会被扔回文档开头。
  // 触发者要在首次渲染时就记下来 —— 等 effect 跑完，焦点已经被搬进输入框了。
  const openerRef = useRef(undefined)
  if (openerRef.current === undefined) openerRef.current = document.activeElement

  useEffect(() => () => {
    const opener = openerRef.current
    if (opener instanceof HTMLElement && document.contains(opener)) opener.focus()
  }, [])

  const terms = useMemo(() => queryTerms(query), [query])
  const searching = terms.length > 0
  const matches = useMemo(() => searchEntries(index, locale, terms), [index, locale, terms])
  const suggestions = useMemo(() => {
    const routes = ['/start/install', '/start/first-session', '/desktop', '/desktop/computer-use']
    const docs = getAllDocs(locale)
    return routes.map((route) => docs.find((doc) => doc.path === `${locale === 'en' ? '/en' : ''}${route}`))
      .filter(Boolean)
      .map((doc) => ({ path: doc.path, title: doc.title, section: doc.section, excerpt: doc.description || '' }))
  }, [locale])
  const results = searching ? matches.results : suggestions
  const selected = Math.min(active, Math.max(0, results.length - 1))

  useEffect(() => setActive(0), [query, locale])

  function clearQuery() {
    setQuery('')
    inputRef.current?.focus()
  }

  function open(path) {
    window.history.pushState({}, '', toSiteHref(path))
    window.dispatchEvent(new PopStateEvent('popstate'))
    onClose()
  }

  /** 挂在对话框根节点上：Esc 和方向键在关闭按钮、结果项上一样要管用。 */
  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }

    // 模态对话框必须困住 Tab，否则焦点会溜到背后被遮住的页面上。
    if (event.key === 'Tab') {
      const stops = [...(dialogRef.current?.querySelectorAll(FOCUSABLE) || [])]
        .filter((node) => node.tabIndex >= 0 && node.offsetParent !== null)
      if (stops.length === 0) return

      const first = stops[0]
      const last = stops[stops.length - 1]
      const current = document.activeElement

      if (event.shiftKey && (current === first || !dialogRef.current?.contains(current))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (current === last || !dialogRef.current?.contains(current))) {
        event.preventDefault()
        first.focus()
      }
      return
    }

    if (results.length === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      inputRef.current?.focus()
      setActive((value) => (value + 1) % results.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      inputRef.current?.focus()
      setActive((value) => (value - 1 + results.length) % results.length)
    } else if (shouldOpenSearchResult(event.key, event.target)) {
      event.preventDefault()
      open(results[selected].path)
    }
  }

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, results])

  const hasResults = results.length > 0

  return (
    <div className="search-scrim grove-search" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        aria-label={c.label}
        aria-modal="true"
        className="search-dialog"
        onKeyDown={onKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <div className="search-dialog__heading">
          <span className="search-dialog__eyebrow">cc-haha / {c.label}</span>
          <button aria-label={c.close} className="icon-btn" onClick={onClose} type="button">
            <Icon name="close" size={18} />
          </button>
          <h2>{c.title}</h2>
        </div>
        <div className="search-dialog__field">
          <Icon name="search" />
          <input
            aria-activedescendant={hasResults ? `search-result-${selected}` : undefined}
            aria-autocomplete="list"
            aria-controls="search-results"
            aria-expanded={hasResults}
            aria-label={c.label}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={c.placeholder}
            ref={inputRef}
            role="combobox"
            type="search"
            value={query}
          />
          {query && <button className="search-dialog__clear" onClick={clearQuery} type="button">{c.clear}</button>}
          <kbd aria-hidden="true">↵</kbd>
        </div>

        <div className="search-dialog__body" ref={listRef}>
          <div className="search-dialog__status" aria-live="polite" role="status">
            {!searching ? c.popular : loadFailed ? c.failed : !index ? c.loading : c.count(matches.total, results.length)}
          </div>
          {searching && index && !hasResults && (
            <div className="search-dialog__empty"><Icon name="search" size={28} /><strong>{c.empty}</strong><p>{c.hint}</p></div>
          )}
          {/* 选中项靠 aria-activedescendant 汇报，所以结果本身不进 Tab 序列。 */}
          <div aria-label={c.results} id="search-results" role="listbox">
            {results.map((result, position) => (
              <button
                aria-selected={position === selected}
                className="search-result"
                data-active={position === selected}
                id={`search-result-${position}`}
                key={result.path}
                onClick={() => open(result.path)}
                onMouseEnter={() => setActive(position)}
                role="option"
                tabIndex={-1}
                type="button"
              >
                <span className="search-result__section">{sectionLabels.get(result.section) || result.section}</span>
                <span className="search-result__title"><Highlight text={result.title} terms={terms} /></span>
                <span className="search-result__excerpt"><Highlight text={result.excerpt} terms={terms} /></span>
                <Icon className="search-result__arrow" name="arrow" size={18} />
              </button>
            ))}
          </div>
        </div>

        <div className="search-dialog__foot">
          {c.tips.map((tip) => <span key={tip}>{tip}</span>)}
        </div>
      </div>
    </div>
  )
}

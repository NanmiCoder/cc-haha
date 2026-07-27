import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './icons'
import { getSections, toSiteHref } from '../content/docs'

const copy = {
  zh: {
    close: '关闭搜索',
    empty: '没有匹配的文档',
    hint: '搜标题、摘要和正文',
    label: '搜索文档',
    placeholder: '搜索文档…',
    results: '搜索结果',
    tips: ['↑↓ 选择', '↵ 打开', 'Esc 关闭']
  },
  en: {
    close: 'Close search',
    empty: 'Nothing matched',
    hint: 'Searches titles, summaries and body text',
    label: 'Search docs',
    placeholder: 'Search docs…',
    results: 'Search results',
    tips: ['↑↓ to move', '↵ to open', 'Esc to close']
  }
}

const FOCUSABLE = 'a[href], button:not([disabled]), input, [tabindex]'

function score(entry, terms) {
  const title = entry.t.toLowerCase()
  const description = (entry.d || '').toLowerCase()
  const body = (entry.x || '').toLowerCase()
  let total = 0

  for (const term of terms) {
    if (title.includes(term)) total += title.startsWith(term) ? 12 : 8
    else if (description.includes(term)) total += 4
    else if (body.includes(term)) total += 2
    else return 0
  }

  return total
}

/** 取正文里第一处命中的上下文，让结果能自我解释。 */
function excerpt(entry, terms) {
  const body = entry.x || ''
  if (!body) return entry.d || ''

  const lower = body.toLowerCase()
  const at = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0]
  if (at === undefined) return entry.d || body.slice(0, 110)

  const start = Math.max(0, at - 40)
  return `${start > 0 ? '…' : ''}${body.slice(start, start + 120).trim()}…`
}

export default function SearchDialog({ locale = 'zh', onClose }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(null)
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

  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!index || terms.length === 0) return []

    return index
      .filter((entry) => entry.l === locale)
      .map((entry) => ({ entry, value: score(entry, terms) }))
      .filter((item) => item.value > 0)
      .sort((left, right) => right.value - left.value)
      .slice(0, 12)
      .map(({ entry }) => ({
        excerpt: excerpt(entry, terms),
        path: entry.p,
        section: sectionLabels.get(entry.s) || entry.s,
        title: entry.t
      }))
  }, [index, locale, query, sectionLabels])

  useEffect(() => setActive(0), [query])

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
      setActive((value) => (value + 1) % results.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((value) => (value - 1 + results.length) % results.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      open(results[active].path)
    }
  }

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, results])

  const hasResults = results.length > 0

  return (
    <div className="search-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        aria-label={c.label}
        aria-modal="true"
        className="search-dialog"
        onKeyDown={onKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <div className="search-dialog__field">
          <Icon name="search" />
          <input
            aria-activedescendant={hasResults ? `search-result-${active}` : undefined}
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
          <button aria-label={c.close} className="icon-btn" onClick={onClose} type="button">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="search-dialog__body" ref={listRef}>
          {query.trim() === '' && <p className="search-dialog__hint">{c.hint}</p>}
          {query.trim() !== '' && !hasResults && (
            <p className="search-dialog__hint">{c.empty}</p>
          )}
          {/* 选中项靠 aria-activedescendant 汇报，所以结果本身不进 Tab 序列。 */}
          <div aria-label={c.results} id="search-results" role="listbox">
            {results.map((result, position) => (
              <button
                aria-selected={position === active}
                className="search-result"
                data-active={position === active}
                id={`search-result-${position}`}
                key={result.path}
                onClick={() => open(result.path)}
                onMouseEnter={() => setActive(position)}
                role="option"
                tabIndex={-1}
                type="button"
              >
                <span className="search-result__section">{result.section}</span>
                <span className="search-result__title">{result.title}</span>
                <span className="search-result__excerpt">{result.excerpt}</span>
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

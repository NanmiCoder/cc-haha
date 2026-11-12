import { useEffect, useRef, useState } from 'react'

/** Highlight the section being read. Tracks headings entering and leaving with IntersectionObserver. */
function useActiveHeading(headings) {
  const [active, setActive] = useState(headings[0]?.id)

  useEffect(() => {
    if (headings.length === 0) return undefined
    setActive(headings[0].id)
    // Without IntersectionObserver, fall back to highlighting the first section rather than crashing the tree.
    if (typeof IntersectionObserver === 'undefined') return undefined

    const seen = new Map()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) seen.set(entry.target.id, entry.isIntersecting)
        const visible = headings.find((heading) => seen.get(heading.id))
        if (visible) setActive(visible.id)
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 }
    )

    for (const heading of headings) {
      const node = document.getElementById(heading.id)
      if (node) observer.observe(node)
    }

    return () => observer.disconnect()
  }, [headings])

  return active
}

export function DocToc({ headings, onAnchorNavigate, progress = 0 }) {
  const active = useActiveHeading(headings)
  const scope = useRef(null)

  // On long pages the table of contents itself overflows into a scroll area. Once the highlighted item scrolls out of view
  // the TOC stops showing "where am I" — the internals pages with forty-odd entries lose their place halfway down.
  useEffect(() => {
    if (!active) return
    const node = scope.current?.querySelector('[aria-current="true"]')
    const list = scope.current
    if (!node || !list || list.scrollHeight <= list.clientHeight) return

    // Set the container's scrollTop directly instead of scrollIntoView — the latter walks up every scrollable
    // ancestor and risks scrolling the whole page too, fighting the user's own scrolling.
    const item = node.getBoundingClientRect()
    const box = list.getBoundingClientRect()

    if (item.top < box.top) list.scrollTop -= box.top - item.top
    else if (item.bottom > box.bottom) list.scrollTop += item.bottom - box.bottom
  }, [active])

  if (headings.length < 2) return null

  const title = 'On this page'

  return (
    <nav aria-label={title} className="doc-toc" ref={scope}>
      <div className="doc-toc__reading"><span>READING PROGRESS</span><strong>{progress}<small>%</small></strong><div role="progressbar" aria-label="Reading progress" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${progress}%` }} /></div></div>
      <div className="doc-toc__title">{title}</div>
      <ul className="doc-toc__list">
        {headings.map((heading) => (
          <li key={heading.id}>
            <a
              aria-current={heading.id === active ? 'true' : undefined}
              className="doc-toc__link"
              data-depth={heading.depth}
              href={`#${encodeURIComponent(heading.id)}`}
              onClick={(event) => onAnchorNavigate(event, heading.id)}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export default DocToc

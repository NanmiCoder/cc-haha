import React, { useEffect, useState } from 'react'

export function DocToc({ headings, locale, onAnchorNavigate }) {
  const [activeId, setActiveId] = useState(null)

  useEffect(() => {
    if (!headings.length) return undefined

    const sections = headings
      .map((heading) => document.getElementById(heading.id))
      .filter(Boolean)
    if (!sections.length) return undefined

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) setActiveId(entry.target.id)
      })
    }, { rootMargin: '-72px 0px -68% 0px', threshold: 0 })

    sections.forEach((section) => observer.observe(section))
    return () => observer.disconnect()
  }, [headings])

  if (!headings.length) return null

  return (
    <aside className="doc-toc" aria-label="On this page">
      <p>{locale === 'en' ? 'On this page' : '本页内容'}</p>
      <ol>
        {headings.map((heading) => (
          <li className={`doc-toc__depth-${heading.depth}`} key={heading.id}>
            <a
              className={heading.id === activeId ? 'is-active' : undefined}
              href={`#${heading.id}`}
              onClick={(event) => onAnchorNavigate?.(event, heading.id)}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ol>
    </aside>
  )
}

import { useEffect, useRef, useState } from 'react'

/** 高亮当前正在读的小节。用 IntersectionObserver 跟踪标题的进出。 */
function useActiveHeading(headings) {
  const [active, setActive] = useState(headings[0]?.id)

  useEffect(() => {
    if (headings.length === 0) return undefined
    setActive(headings[0].id)
    // 没有 IntersectionObserver 就退化成「高亮第一节」，不能让整棵树炸掉。
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

export function DocToc({ headings, locale, onAnchorNavigate }) {
  const active = useActiveHeading(headings)
  const scope = useRef(null)

  // 长文的目录本身会溢出成滚动区。高亮项一旦滚出可视范围，目录就不再
  // 指示"我读到哪了" —— internals 那批四十来条的页面读到一半就失去定位。
  useEffect(() => {
    if (!active) return
    const node = scope.current?.querySelector('[aria-current="true"]')
    const list = scope.current
    if (!node || !list || list.scrollHeight <= list.clientHeight) return

    // 直接改容器的 scrollTop，不用 scrollIntoView —— 后者会向上遍历所有可
    // 滚动祖先，有把整个页面也滚一下的风险，那会和用户自己的滚动打架。
    const item = node.getBoundingClientRect()
    const box = list.getBoundingClientRect()

    if (item.top < box.top) list.scrollTop -= box.top - item.top
    else if (item.bottom > box.bottom) list.scrollTop += item.bottom - box.bottom
  }, [active])

  if (headings.length < 2) return null

  const title = locale === 'en' ? 'On this page' : '本页内容'

  return (
    <nav aria-label={title} className="doc-toc" ref={scope}>
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
